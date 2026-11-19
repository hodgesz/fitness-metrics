import { Buffer } from "node:buffer";
// Pure, pinned native completion contract. No filesystem, process, auth or network.
import { isDeepStrictEqual } from "node:util";
const LIMIT = 1024 * 1024;
const SLUG = /^[a-z0-9][a-z0-9.-]{0,79}$/;
const check = (ok, message) => {
  if (!ok) throw new Error(message);
};
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const has = (object, key) => Object.hasOwn(object, key);

export function parseJsonStrict(raw) {
  const value = JSON.parse(raw);
  const stack = [];
  for (const token of raw.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g) || []) {
    const frame = stack.at(-1);
    if (token === "{") stack.push({ keys: new Set(), key: true });
    else if (token === "[") stack.push({ array: true });
    else if (token === "}" || token === "]") stack.pop();
    else if (token === "," && frame && !frame.array) frame.key = true;
    else if (token === ":" && frame) frame.key = false;
    else if (token.startsWith('"') && frame?.key) {
      const key = JSON.parse(token);
      check(!frame.keys.has(key), "Duplicate JSON key");
      frame.keys.add(key);
    }
  }
  return value;
}

export const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "completed",
    "head",
    "axes",
    "covered_files",
    "summary",
    "findings",
    "limitations",
  ],
  properties: {
    completed: { type: "boolean", const: true },
    head: { type: "string" },
    axes: { type: "array", items: { type: "string" }, const: ["correctness", "architecture", "security", "performance", "tests"] },
    covered_files: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    limitations: { type: "array", items: { type: "string" } },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "path", "line", "body"],
        properties: {
          severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
          path: { type: "string" },
          line: { type: "integer", minimum: 1 },
          body: { type: "string" },
        },
      },
    },
  },
};

export function reviewSchema(bundle) {
  return {
    ...outputSchema,
    required: [...outputSchema.required, ...(bundle.batch ? ["batch_id"] : [])],
    properties: {
      ...outputSchema.properties,
      head: { type: "string", const: bundle.head },
      ...(bundle.batch
        ? {
            batch_id: { type: "string", const: bundle.batch.batch_id },
            summary: { type: "string", maxLength: 400 },
          }
        : {}),
    },
  };
}

function fields(value, allowed, required = allowed) {
  check(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) => allowed.includes(key)) &&
      required.every((key) => has(value, key)),
    "Unexpected or missing completion fields",
  );
}

export const usageKeys = [
  "input_tokens",
  "output_tokens",
  "thinking_tokens",
  "cache_read_tokens",
  "total_tokens",
];
export function validateUsage(numTurns, usage, turnUsage, maxTurns = 2) {
  check(
    Number.isSafeInteger(numTurns) &&
      numTurns >= 1 &&
      numTurns <= maxTurns &&
      Array.isArray(turnUsage) &&
      turnUsage.length === numTurns,
    "Unsupported completion turn count",
  );
  for (const item of [usage, ...turnUsage]) {
    fields(item, usageKeys);
    check(
      usageKeys.every(
        (key) =>
          Number.isSafeInteger(item[key]) &&
          item[key] >= 0 &&
          item[key] <= 1e12,
      ),
      "Invalid completion usage",
    );
  }
  check(
    usageKeys.every(
      (key) =>
        turnUsage.reduce((sum, item) => sum + item[key], 0) === usage[key],
    ),
    "Completion usage differs from internal turns",
  );
}

// Parses only the pinned native protocol. Callers supply their OWN requested
// schema and typed content validator; captured/model-provided schemas are data.
export function validateCompletion(raw, { model, schema, validateOutput }) {
  check(
    typeof raw === "string" &&
      typeof model === "string" &&
      Buffer.byteLength(raw) <= LIMIT &&
      SLUG.test(model),
    "Invalid completion bound or model",
  );
  const rows = raw.trim().split("\n");
  check(
    rows.length >= 5 && rows.length <= 2048,
    "Invalid completion event count",
  );
  const events = rows.map((line) => parseJsonStrict(line));
  const first = events[0];
  fields(first, ["event", "conversation_id", "init"]);
  fields(
    first.init,
    ["model", "cwd", "tools", "permission_mode", "json_schema"],
    ["model", "permission_mode", "json_schema"],
  );
  check(
    first.event === "init" &&
      typeof first.conversation_id === "string" &&
      first.conversation_id.length > 0 &&
      first.conversation_id.length <= 128 &&
      first.init.model === model &&
      first.init.permission_mode === "request-review",
    "Missing observed model or permission identity",
  );
  check(
    isDeepStrictEqual(first.init.json_schema, schema),
    "Init schema differs from requested schema",
  );
  if (has(first.init, "cwd"))
    check(
      typeof first.init.cwd === "string" && first.init.cwd.length <= 4096,
      "Invalid init workspace metadata",
    );
  if (has(first.init, "tools"))
    check(
      Array.isArray(first.init.tools) &&
        first.init.tools.length <= 128 &&
        first.init.tools.every(
          (tool) => typeof tool === "string" && tool.length <= 128,
        ),
      "Invalid init tools metadata",
    );
  // An init.tools inventory is not tool execution or permission to use tools.
  const last = events.at(-1);
  fields(last, ["event", "result"]);
  fields(last.result, [
    "conversation_id",
    "status",
    "response",
    "duration_seconds",
    "num_turns",
    "structured_output",
    "json_schema",
    "usage",
  ]);
  const result = last.result;
  check(
    last.event === "result" &&
      result.status === "SUCCESS" &&
      [1, 2].includes(result.num_turns),
    "Review did not complete successfully",
  );
  check(
    result.conversation_id === first.conversation_id,
    "Conversation identity mismatch",
  );
  check(
    isDeepStrictEqual(result.json_schema, schema),
    "Terminal schema differs from requested schema",
  );
  check(
    Number.isFinite(result.duration_seconds) &&
      result.duration_seconds >= 0 &&
      result.duration_seconds <= 780,
    "Invalid completion duration",
  );
  const types =
    result.num_turns === 2
      ? [
          "user_input",
          "agent_response",
          "user_input",
          "agent_response",
          "finish",
        ]
      : ["user_input", "agent_response", "finish"];
  const texts = [];
  const turnUsage = [];
  let index = 0;
  let text = "";
  let activeFinish = false;
  for (const row of events.slice(1, -1)) {
    fields(row, ["event", "step_update"]);
    check(row.event === "step_update", "Unexpected completion event");
    const step = row.step_update;
    // Observed native1.4.2 one-turn structured completion control only.
    // This is never permission for an operational tool or a second finish.
    if (step?.step_type === "tool") {
      fields(step, [
        "conversation_id",
        "step_index",
        "state",
        "step_type",
        "tool_name",
        "tool_info",
      ]);
      check(
        result.num_turns === 1 &&
          !activeFinish &&
          index === types.length - 1 &&
          step.step_index === index &&
          step.conversation_id === first.conversation_id &&
          step.state === "ACTIVE" &&
          step.tool_name === "finish",
        "Unexpected active finish control",
      );
      fields(step.tool_info, ["name", "parameters"]);
      check(
        step.tool_info.name === "finish",
        "Unexpected completion tool name",
      );
      validateOutput(step.tool_info.parameters);
      check(
        isDeepStrictEqual(step.tool_info.parameters, result.structured_output),
        "Finish parameters differ from terminal structured output",
      );
      activeFinish = true;
      continue;
    }
    if (activeFinish)
      check(
        step?.step_type === "finish" &&
          step.state === "DONE" &&
          step.step_index === types.length - 1,
        "Active finish must immediately complete at the same final index",
      );
    fields(
      step,
      [
        "conversation_id",
        "step_index",
        "state",
        "step_type",
        "text_delta",
        "duration_seconds",
        "usage",
      ],
      ["conversation_id", "step_index", "state", "step_type"],
    );
    check(
      step.conversation_id === first.conversation_id &&
        step.step_index === index &&
        step.step_type === types[index],
      "Unexpected step progression or conversation",
    );
    check(
      ["ACTIVE", "DONE"].includes(step.state),
      "Unknown completion step state",
    );
    if (has(step, "duration_seconds"))
      check(
        Number.isFinite(step.duration_seconds) &&
          step.duration_seconds >= 0 &&
          step.duration_seconds <= 780,
        "Invalid step duration",
      );
    if (step.step_type === "agent_response") {
      check(
        typeof step.text_delta === "string" &&
          Buffer.byteLength(step.text_delta) <= LIMIT,
        "Missing or oversized agent text",
      );
      text += step.text_delta;
      check(Buffer.byteLength(text) <= LIMIT, "Agent text exceeds bound");
      if (step.state === "DONE") {
        texts.push(text);
        turnUsage.push(step.usage);
        text = "";
      } else
        check(
          !has(step, "usage") && !has(step, "duration_seconds"),
          "Unexpected active-step metadata",
        );
    } else
      check(
        step.state === "DONE" &&
          !has(step, "text_delta") &&
          !has(step, "usage"),
        "Unexpected non-agent activity",
      );
    if (step.state === "DONE") index++;
  }
  check(
    index === types.length && texts.length === result.num_turns,
    "Incomplete completion steps or missing final DONE finish",
  );
  check(
    typeof result.response === "string" && result.response === texts.join(""),
    "Terminal response differs from agent text",
  );
  validateUsage(result.num_turns, result.usage, turnUsage);
  validateOutput(result.structured_output);
  const reviews = texts.map((part, turn) => {
    let value;
    if (turn === 0) {
      const trimmed = part.trim();
      const fenced = /^```json\n([\s\S]*)\n```$/.exec(trimmed);
      value = parseJsonStrict(fenced ? fenced[1] : trimmed);
    } else value = parseJsonStrict(part.trim());
    const soleMetadata =
      texts.length === 1 &&
      !part.trim().startsWith("```") &&
      (has(value, "toolAction") || has(value, "toolSummary"));
    if (turn > 0 || soleMetadata) {
      check(
        typeof value.toolAction === "string" &&
          value.toolAction.trim() &&
          value.toolAction.length <= 512 &&
          typeof value.toolSummary === "string" &&
          value.toolSummary.trim() &&
          value.toolSummary.length <= 512,
        "Invalid completion metadata strings",
      );
      const review = { ...value };
      delete review.toolAction;
      delete review.toolSummary;
      value = review;
    }
    validateOutput(value);
    check(
      isDeepStrictEqual(value, result.structured_output),
      "Agent review content differs from terminal structured output",
    );
    return value;
  });
  return {
    output: reviews[0],
    conversation_id: first.conversation_id,
    num_turns: result.num_turns,
    usage: result.usage,
    turn_usage: turnUsage,
  };
}

export function validateReviewOutput(output, bundle) {
  check(
    output &&
      Object.keys(output).sort().join(",") ===
        (bundle.batch
          ? "axes,batch_id,completed,covered_files,findings,head,limitations,summary"
          : "axes,completed,covered_files,findings,head,limitations,summary"),
    "Unexpected structured review fields",
  );
  check(
    json(output.axes) ===
      json(["correctness", "architecture", "security", "performance", "tests"]),
    "All five review axes are required",
  );
  check(
    output?.completed === true &&
      output.head === bundle.head &&
      (!bundle.batch || output.batch_id === bundle.batch.batch_id) &&
      typeof output.summary === "string" &&
      output.summary.trim().length >= 8 &&
      output.summary.length <= (bundle.batch ? 400 : 8000),
    "Empty or incomplete review",
  );
  check(
    Array.isArray(output.limitations) && output.limitations.length === 0,
    "Review has incomplete context or limitations",
  );
  check(
    json(output.covered_files) === json(bundle.files.map((file) => file.path)),
    "Full changed-file coverage required",
  );
  check(
    Array.isArray(output.findings) && output.findings.length <= 100,
    "Invalid findings",
  );
  for (const finding of output.findings) {
    const file = bundle.files.find((file) => file.path === finding.path);
    check(
      file &&
        Object.keys(finding).sort().join(",") === "body,line,path,severity" &&
        ["P0", "P1", "P2", "P3"].includes(finding.severity) &&
        Number.isSafeInteger(finding.line) &&
        finding.line > 0 &&
        finding.line <= (file.after || file.before).text.split("\n").length &&
        typeof finding.body === "string" &&
        finding.body.trim().length >= 8 &&
        finding.body.length <= 4000,
      "Invalid finding location or description",
    );
  }
}

// Review-only model policy. Successful native metadata is an owner attestation,
// not cryptographic model identity or a weekly-budget/quota measurement.
export const PRIMARY_MODEL = "gemini-4-neon-low";
export const FALLBACK_MODEL = "gemini-3.8-flash-high";
export function modelEffort(model) {
  check(
    [PRIMARY_MODEL, FALLBACK_MODEL].includes(model),
    "Unsupported review model",
  );
  return model === PRIMARY_MODEL ? "low" : "high";
}
export function requestedPolicy(options = {}) {
  if (options.model !== undefined) modelEffort(options.model);
  const policy =
    options.policy ??
    (options.model === FALLBACK_MODEL ? "flash-only" : "auto");
  check(
    ["auto", "primary-only", "flash-only"].includes(policy),
    "Invalid review policy",
  );
  check(
    !options.model ||
      options.model ===
        (policy === "flash-only" ? FALLBACK_MODEL : PRIMARY_MODEL),
    "Conflicting review model/policy",
  );
  if (options.effort !== undefined)
    check(
      policy !== "auto" &&
        options.effort ===
          modelEffort(policy === "flash-only" ? FALLBACK_MODEL : PRIMARY_MODEL),
      "Unsupported review model/effort pair",
    );
  return policy;
}
export function selectReviewModel(policy, stdout, stderr) {
  requestedPolicy({ policy });
  check(
    typeof stdout === "string" &&
      Buffer.byteLength(stdout) <= 32768 &&
      stdout.length > 0,
    "Invalid authenticated model listing",
  );
  check(
    stderr === "" || stderr === "Fetching available models...\n",
    "Model preflight emitted unexpected diagnostics; no review attempted",
  );
  const lines = stdout.trimEnd().split("\n");
  check(
    lines.every((line) =>
      /^[a-z0-9][a-z0-9.-]{0,79}[ \t]+[^\x00-\x1f]+$/.test(line),
    ),
    "Malformed authenticated model listing",
  );
  const slugs = lines.map((line) => line.split(/[ \t]+/)[0]);
  check(
    new Set(slugs).size === slugs.length,
    "Duplicate authenticated model listing",
  );
  const primary = slugs.includes(PRIMARY_MODEL);
  const model =
    policy === "flash-only" || (policy === "auto" && !primary)
      ? FALLBACK_MODEL
      : PRIMARY_MODEL;
  check(
    slugs.includes(model),
    `Configured model unavailable: ${model}; no fallback available`,
  );
  return {
    schema: "agy-review-selection/v1",
    policy,
    reason:
      policy === "auto"
        ? primary
          ? "primary-available"
          : "primary-absent"
        : policy === "primary-only"
          ? "operator-primary"
          : "operator-flash",
    model,
    effort: modelEffort(model),
    models_stdout: stdout,
    models_stderr: stderr,
  };
}
export function validateSelection(selection, model) {
  check(
    selection && typeof selection === "object" && !Array.isArray(selection),
    "Missing authenticated review selection",
  );
  const expected = selectReviewModel(
    selection.policy,
    selection.models_stdout,
    selection.models_stderr,
  );
  check(
    isDeepStrictEqual(selection, expected) &&
      (model === undefined || model === expected.model),
    "Review selection evidence/policy/model mismatch",
  );
  return expected;
}

const escapeMarkdown = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\`*_[\]{}()!|#~]/g, "\\$&")
    .replaceAll("@", "&#64;");
export function renderReviewBody(receipt, VERSION) {
  const findings = receipt.findings.map((finding) => {
    const url = `https://github.com/${receipt.repo}/blob/${receipt.head}/${finding.path.split("/").map(encodeURIComponent).join("/")}#L${finding.line}`;
    return `- **${finding.severity}** [${escapeMarkdown(finding.path)}:${finding.line}](${url}): ${escapeMarkdown(finding.body)}`;
  });
  const encoded = Buffer.from(json(receipt)).toString("base64url");
  return `### Gemini PR review (complete diff)\n\nScope: Complete unified diff with context; unchanged whole source was not inspected. Numbered records partition large patches without omitting bytes.\n\nHead: \`${receipt.head}\` · Base: \`${receipt.base}\`\nControl: \`${receipt.control_sha}\` (${receipt.control_mode})\nModel: \`${receipt.model}\` · Effort: ${receipt.effort} · Policy: ${receipt.selection.policy} (${receipt.selection.reason}) · Account: Google sign-in · CLI: ${VERSION}\nInput SHA-256: \`${receipt.input_sha256}\`\nEvidence SHA-256: \`${receipt.evidence_sha256}\`\n\n${escapeMarkdown(receipt.summary)}\n\n${findings.length ? findings.join("\n") : "No actionable findings reported."}\n\nCoverage (${receipt.covered_files.length} diff records):\n${receipt.covered_files.map((file) => `- ${escapeMarkdown(file)}`).join("\n")}\n\n<!-- agy-pr-review/v1 head=${receipt.head} -->\n<!-- agy-pr-review-receipt:${encoded} -->\n`;
}
