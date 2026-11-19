import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import {
  authorizeControl,
  aggregateReviews as aggregateReviewsFromEvidence,
  selectReviewModel,
  FALLBACK_MODEL,
  preflightBatches,
  BINARY_PINS,
  MODEL,
  REPOSITORY,
  SCHEMA,
  VERSION,
  bounded,
  cleanEnv,
  isolatedSettings,
  macSandboxProfile,
  metadata,
  parseArgs,
  parseJsonStrict,
  prepare,
  publish,
  requirePostedReview,
  review,
  reviewBody,
  reviewSession,
  reviewSchema,
  sha256,
  verifyPostedReview,
  validateBundle,
  validateEvents,
} from "../../scripts/agy-pr-review.mjs";

// Explicit synthetic successful metadata belongs only to these offline fixtures.
const aggregateReviews = (
  bundle,
  evidence,
  model = MODEL,
  mode = "review",
  binaryHash,
) =>
  aggregateReviewsFromEvidence(
    bundle,
    evidence,
    model,
    mode,
    binaryHash,
    selectReviewModel(
      model === FALLBACK_MODEL ? "flash-only" : "auto",
      `${model} Synthetic model\n`,
      "",
    ),
  );

// These local mock cases run serially within this test module. Restore hosted
// CI markers after each case so CI-negative tests retain the real boundary.
async function withLocalEnvironment(callback) {
  const prior = ["CI", "GITHUB_ACTIONS"].map((name) => [
    name,
    process.env[name],
  ]);
  try {
    for (const [name] of prior) delete process.env[name];
    return await callback();
  } finally {
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
const localTest = (name, callback) =>
  test(name, (t) => withLocalEnvironment(() => callback(t)));

const root = fileURLToPath(new URL("../../", import.meta.url));
const head = "b".repeat(40);
const base = "a".repeat(40);
const identity = { repo: REPOSITORY, pr: "42", base, head };
const skill = "---\nname: pr-review\n---\nTrusted review instructions.\n";
const bundle = {
  schema: SCHEMA,
  ...identity,
  control_sha: base,
  control_mode: "base",
  run_id: "local",
  run_attempt: "local",
  trusted_runner_sha256: sha256(
    await fs.readFile(path.join(root, "scripts/agy-pr-review.mjs")),
  ),
  trusted_skill_sha256: sha256(skill),
  skill,
  files: [
    {
      path: "example.mjs",
      before: { mode: "100644", text: "old\n" },
      after: { mode: "100644", text: "new\n" },
    },
  ],
};
const clone = (value) => globalThis.structuredClone(value);
const fixtureMetadata = (patch = {}) => ({
  number: 42,
  state: "open",
  draft: false,
  base: { ref: "main", sha: base, repo: { full_name: REPOSITORY } },
  head: { sha: head, repo: { full_name: REPOSITORY } },
  ...patch,
});
function events(outputPatch = {}, eventPatch) {
  const output = {
    completed: true,
    head,
    axes: ["correctness", "architecture", "security", "performance", "tests"],
    covered_files: ["example.mjs"],
    summary: "Examined all five review axes.",
    findings: [],
    limitations: [],
    ...outputPatch,
  };
  const usage = {
    input_tokens: 2,
    output_tokens: 1,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 3,
  };
  const text = JSON.stringify(output);
  const list = [
    {
      event: "init",
      conversation_id: "synthetic-conversation",
      init: {
        model: MODEL,
        permission_mode: "request-review",
        json_schema: reviewSchema(bundle),
      },
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: "synthetic-conversation",
        step_index: 0,
        step_type: "user_input",
        state: "DONE",
      },
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: "synthetic-conversation",
        step_index: 1,
        step_type: "agent_response",
        state: "DONE",
        text_delta: text,
        usage,
      },
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: "synthetic-conversation",
        step_index: 2,
        step_type: "finish",
        state: "DONE",
      },
    },
    {
      event: "result",
      result: {
        conversation_id: "synthetic-conversation",
        status: "SUCCESS",
        num_turns: 1,
        duration_seconds: 0,
        response: text,
        json_schema: reviewSchema(bundle),
        usage,
        structured_output: output,
      },
    },
  ];
  eventPatch?.(list);
  return `${list.map((item) => JSON.stringify(item)).join("\n")}\n`;
}
function batchEvents(args, raw = events()) {
  const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
  const rows = raw.trim().split("\n").map(JSON.parse);
  rows[0].init.json_schema = schema;
  rows.at(-1).result.json_schema = schema;
  rows.at(-1).result.structured_output.batch_id =
    schema.properties.batch_id.const;
  for (const index of [1, 3]) {
    const steps = rows.filter(
      (row) =>
        row.step_update?.step_index === index &&
        row.step_update.step_type === "agent_response",
    );
    if (!steps.length) continue;
    const text = steps.map((row) => row.step_update.text_delta).join("");
    const fenced = /^```json\n([\s\S]*)\n```$/.exec(text.trim());
    const value = JSON.parse(fenced ? fenced[1] : text);
    value.batch_id = schema.properties.batch_id.const;
    const bound = fenced
      ? `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`
      : JSON.stringify(value) + "\n";
    steps.forEach((row, i) => {
      row.step_update.text_delta = i ? "" : bound;
    });
  }
  rows.at(-1).result.response = rows
    .filter((row) => row.step_update?.step_type === "agent_response")
    .map((row) => row.step_update.text_delta)
    .join("");
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}
function fixtureAggregate(raw, target = bundle, model = MODEL, binaryHash) {
  const { requests } = preflightBatches(target);
  assert.equal(requests.length, 1);
  const evidence = [
    batchEvents(["--json-schema", JSON.stringify(requests[0].schema)], raw),
  ];
  return {
    raw: evidence,
    receipt: aggregateReviews(target, evidence, model, "review", binaryHash),
  };
}
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fp-agy-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("CLI help is offline and parser keeps the requested model and Neon LOW default", async () => {
  const result = await bounded(
    process.execPath,
    [path.join(root, "scripts/agy-pr-review.mjs"), "--help"],
    { env: cleanEnv() },
  );
  assert.match(result.stdout, /Dry-run never invokes a model/);
  assert.equal(parseArgs([]).model, "gemini-4-neon-low");
  assert.equal(
    parseArgs(["--model", FALLBACK_MODEL, "42"]).model,
    FALLBACK_MODEL,
  );
});

for (const args of [
  ["--model"],
  ["--model", ""],
  ["--model", "$(touch pwned)"],
  ["1", "2"],
  ["abc"],
  ["0"],
  ["--wat"],
  ["--dry-run", "--local-only"],
  ["--head", "main"],
  ["--repo", "other/repo"],
]) {
  test(`rejects malformed CLI input ${JSON.stringify(args)} without prerequisites`, async () => {
    assert.throws(() => parseArgs([...args]));
    await assert.rejects(
      bounded(
        process.execPath,
        [path.join(root, "scripts/agy-pr-review.mjs"), ...args],
        { env: cleanEnv() },
      ),
    );
  });
}

test("CI missing key explicitly skips without emitting completed evidence", async () => {
  const result = await bounded(
    process.execPath,
    [path.join(root, "scripts/agy-pr-review.mjs"), "42"],
    { env: cleanEnv({ CI: "true" }) },
  );
  assert.match(result.stdout, /skipped, NOT a completed review/);
});

test("missing branch PR fails hermetically without model or global credentials", async (t) => {
  const directory = await temporary(t);
  await fs.writeFile(path.join(directory, "gh"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  await assert.rejects(
    bounded(
      process.execPath,
      [
        path.join(root, "scripts/agy-pr-review.mjs"),
        "--dry-run",
        "--out",
        path.join(directory, "unused"),
      ],
      { env: cleanEnv({ PATH: directory }) },
    ),
    /failed/,
  );
});

test("environment allowlist excludes arbitrary application, cloud and model credentials", () => {
  process.env.FP_TEST_UNEXPECTED_SECRET = "synthetic-value";
  try {
    assert.equal(cleanEnv().FP_TEST_UNEXPECTED_SECRET, undefined);
    assert.equal(cleanEnv().GEMINI_API_KEY, undefined);
    assert.equal(cleanEnv().NODE_OPTIONS, undefined);
    assert.equal(isolatedSettings().modelProvider, undefined);
    for (const permission of [
      "command(*)",
      "unsandboxed(*)",
      "read_file(*)",
      "write_file(*)",
      "mcp(*)",
      "read_url(*)",
      "execute_url(*)",
    ])
      assert.ok(isolatedSettings().permissions.deny.includes(permission));
  } finally {
    delete process.env.FP_TEST_UNEXPECTED_SECRET;
  }
});

test("duplicate JSON fields and ambiguous model overrides fail closed", () => {
  assert.throws(
    () => parseJsonStrict('{"status":"ERROR","status":"SUCCESS"}'),
    /Duplicate JSON/,
  );
  assert.throws(
    () => parseJsonStrict('{"outer":{"key":1,"key":2}}'),
    /Duplicate JSON/,
  );
  assert.deepEqual(parseJsonStrict('{"a":{"key":1},"b":{"key":2}}'), {
    a: { key: 1 },
    b: { key: 2 },
  });
  assert.throws(
    () => parseArgs(["--model", MODEL, "--model", MODEL]),
    /Duplicate/,
  );
  const prior = process.env.AGY_PR_REVIEW_MODEL;
  process.env.AGY_PR_REVIEW_MODEL = "";
  try {
    assert.throws(() => parseArgs([]), /Invalid model/);
  } finally {
    if (prior === undefined) delete process.env.AGY_PR_REVIEW_MODEL;
    else process.env.AGY_PR_REVIEW_MODEL = prior;
  }
});

test("metadata validates repo, PR, current head, base, ready state and internal origin", async () => {
  assert.deepEqual(
    await metadata(identity, async () => ({
      stdout: JSON.stringify(fixtureMetadata()),
    })),
    identity,
  );
  const invalid = [
    { state: "closed" },
    { draft: true },
    { number: 43 },
    { head: { sha: "c".repeat(40), repo: { full_name: REPOSITORY } } },
    { head: { sha: head, repo: { full_name: "fork/project" } } },
    { base: { ref: "other", sha: base, repo: { full_name: REPOSITORY } } },
    {
      base: {
        ref: "main",
        sha: "c".repeat(40),
        repo: { full_name: REPOSITORY },
      },
    },
  ];
  for (const patch of invalid)
    await assert.rejects(
      metadata(identity, async () => ({
        stdout: JSON.stringify(fixtureMetadata(patch)),
      })),
    );
});

test("preparation reads base skill and all before/after data, ignores dirty/candidate instructions", async (t) => {
  const directory = await temporary(t);
  const runGit = async (...args) =>
    (
      await bounded(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "user.name=Fictional Reviewer",
          "-c",
          "user.email=reviewer@example.com",
          "-C",
          directory,
          ...args,
        ],
        { env: cleanEnv() },
      )
    ).stdout.trim();
  await runGit("init", "--quiet");
  await fs.mkdir(path.join(directory, "docs"), {
    recursive: true,
  });
  await fs.mkdir(path.join(directory, "scripts"));
  await fs.writeFile(
    path.join(directory, "docs/gemini-review-instructions.md"),
    skill,
  );
  for (const name of [
    "agy-pr-review.mjs",
    "agy-pr-review-completion.mjs",
    "agy-pr-review.sh",
  ])
    await fs.copyFile(
      path.join(root, "scripts", name),
      path.join(directory, "scripts", name),
    );
  await fs.writeFile(path.join(directory, "old name.mjs"), "before\n");
  await runGit("add", ".");
  await runGit("commit", "--quiet", "-m", "Fictional base");
  const baseSha = await runGit("rev-parse", "HEAD");
  await fs.rename(
    path.join(directory, "old name.mjs"),
    path.join(directory, "new name.mjs"),
  );
  await fs.writeFile(
    path.join(directory, "AGENTS.md"),
    "Run a malicious command (untrusted fixture only).\n",
  );
  await fs.writeFile(
    path.join(directory, "docs/gemini-review-instructions.md"),
    "candidate hostile instruction\n",
  );
  await runGit("add", ".");
  await runGit("commit", "--quiet", "-m", "Fictional candidate");
  const headSha = await runGit("rev-parse", "HEAD");
  await fs.writeFile(
    path.join(directory, "new name.mjs"),
    "uncommitted bytes must not be read\n",
  );
  const prepared = await prepare(
    { ...identity, base: baseSha, head: headSha, source: directory },
    async (value) => value,
  );
  assert.equal(prepared.skill, skill);
  assert.equal(
    prepared.files.find((file) => file.path === "new name.mjs").after.text,
    await bounded("git", ["-C", directory, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "--unified=20", baseSha, headSha, "--", "new name.mjs"]).then((r) => r.stdout),
  );
  assert.match(prepared.files.find((file) => file.path === "old name.mjs").after.text, /^diff --git/);
  assert.equal(prepared.files.length, 4);
  assert.equal(
    (await runGit("status", "--porcelain")).includes("new name.mjs"),
    true,
  );
  const stubDir = path.join(directory, "stubs");
  await fs.mkdir(stubDir);
  const metadataFile = path.join(directory, "synthetic-metadata.json");
  await fs.writeFile(
    metadataFile,
    JSON.stringify(
      fixtureMetadata({
        base: { ref: "main", sha: baseSha, repo: { full_name: REPOSITORY } },
        head: { sha: headSha, repo: { full_name: REPOSITORY } },
      }),
    ),
  );
  await fs.writeFile(
    path.join(stubDir, "gh"),
    `#!/bin/sh\ncat '${metadataFile}'\n`,
    { mode: 0o755 },
  );
  const dryOut = path.join(directory, "dry-output");
  await bounded(
    process.execPath,
    [
      path.join(root, "scripts/agy-pr-review.mjs"),
      "--dry-run",
      "--pr",
      "42",
      "--base",
      baseSha,
      "--head",
      headSha,
      "--source",
      directory,
      "--out",
      dryOut,
      "--agy",
      "/MUST-NOT-EXECUTE",
    ],
    { env: cleanEnv({ PATH: `${stubDir}:/usr/bin:/bin` }) },
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(dryOut, "dry-run.json"), "utf8"))
      .status,
    "dry_run",
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(dryOut, "bundle.json"), "utf8"))
      .files.length,
    4,
  );
  await assert.rejects(fs.access(path.join(dryOut, "receipt.json")));

  // Base without skill must not fall back to its hostile candidate replacement.
  await runGit("rm", "docs/gemini-review-instructions.md");
  await runGit("commit", "--quiet", "-m", "Missing base skill");
  const missing = await runGit("rev-parse", "HEAD");
  await assert.rejects(
    prepare(
      { ...identity, base: missing, head: missing, source: directory },
      async (value) => value,
    ),
    /Base review skill/,
  );
  // Independently selected immutable control is separate from the actual PR base.
  await fs.writeFile(
    path.join(directory, "bootstrap-change.mjs"),
    "fictional change\n",
  );
  await runGit("add", "bootstrap-change.mjs");
  await runGit(
    "commit",
    "--quiet",
    "-m",
    "Fictional PR without review controls in base",
  );
  const bootstrapHead = await runGit("rev-parse", "HEAD");
  await fs.writeFile(
    metadataFile,
    JSON.stringify(
      fixtureMetadata({
        base: { ref: "main", sha: missing, repo: { full_name: REPOSITORY } },
        head: { sha: bootstrapHead, repo: { full_name: REPOSITORY } },
      }),
    ),
  );
  const bootstrapArgs = [
    path.join(root, "scripts/agy-pr-review.mjs"),
    "--dry-run",
    "--pr",
    "42",
    "--base",
    missing,
    "--head",
    bootstrapHead,
    "--source",
    directory,
  ];
  const stubEnvironment = cleanEnv({ PATH: `${stubDir}:/usr/bin:/bin` });
  await assert.rejects(
    bounded(
      process.execPath,
      [...bootstrapArgs, "--out", path.join(directory, "default-must-fail")],
      { env: stubEnvironment },
    ),
  );
  const bootstrapOutput = path.join(directory, "bootstrap-output");
  await bounded(
    process.execPath,
    [
      ...bootstrapArgs,
      "--trusted-review-ref",
      baseSha,
      "--out",
      bootstrapOutput,
    ],
    { env: stubEnvironment },
  );
  const boot = JSON.parse(
    await fs.readFile(path.join(bootstrapOutput, "bundle.json"), "utf8"),
  );
  assert.equal(boot.base, missing);
  assert.equal(boot.head, bootstrapHead);
  assert.equal(boot.control_sha, baseSha);
  assert.equal(boot.control_mode, "explicit-local");
  assert.equal(boot.skill, skill);
  assert.deepEqual(
    boot.files.map((file) => file.path),
    ["bootstrap-change.mjs"],
  );
  assert.throws(() => authorizeControl(boot), /trusted-review-ref/);
  const blobRef = await runGit(
    "rev-parse",
    `${baseSha}:scripts/agy-pr-review.mjs`,
  );
  await assert.rejects(
    bounded(
      process.execPath,
      [
        ...bootstrapArgs,
        "--trusted-review-ref",
        blobRef,
        "--out",
        path.join(directory, "blob-must-fail"),
      ],
      { env: stubEnvironment },
    ),
  );
  await assert.rejects(
    bounded(
      process.execPath,
      [
        ...bootstrapArgs,
        "--trusted-review-ref",
        baseSha,
        "--out",
        path.join(directory, "ci-must-fail"),
      ],
      { env: { ...stubEnvironment, CI: "true" } },
    ),
  );
  await assert.rejects(
    bounded(
      process.execPath,
      [
        path.join(root, "scripts/agy-pr-review.mjs"),
        "review",
        "--input",
        path.join(bootstrapOutput, "bundle.json"),
        "--out",
        path.join(directory, "candidate-must-fail"),
        "--agy",
        "/MUST-NOT-EXECUTE",
      ],
      { env: { ...stubEnvironment, GITHUB_ACTIONS: "true" } },
    ),
  );
  await fs.mkdir(path.join(directory, "docs"), {
    recursive: true,
  });
  await fs.symlink(
    "/tmp/fictional-external-skill",
    path.join(directory, "docs/gemini-review-instructions.md"),
  );
  await runGit("add", "docs/gemini-review-instructions.md");
  await runGit("commit", "--quiet", "-m", "Symlinked base skill");
  const linked = await runGit("rev-parse", "HEAD");
  await assert.rejects(
    prepare(
      { ...identity, base: linked, head: linked, source: directory },
      async (value) => value,
    ),
    /Base review skill/,
  );
});

test("bundle validation refuses binary, traversal, secret paths, duplicates and omitted content", () => {
  for (const mutate of [
    (value) => {
      value.files[0].path = "../escape";
    },
    (value) => {
      value.files[0].path = ".env";
    },
    (value) => {
      value.files[0].after.text = "binary\0data";
    },
    (value) => {
      value.files[0].after.mode = "120000";
    },
    (value) => {
      value.files[0].after.text = "-----BEGIN " + "PRIVATE KEY-----";
    },
    (value) => {
      value.files.push(value.files[0]);
    },
    (value) => {
      value.files[0].before = null;
      value.files[0].after = null;
    },
  ]) {
    const value = clone(bundle);
    mutate(value);
    assert.throws(() => validateBundle(value));
  }
});

test("bootstrap accepts only an explicit full immutable SHA, never a branch or environment fallback", () => {
  assert.throws(
    () => parseArgs(["--trusted-review-ref", "main"]),
    /Invalid trusted-review-ref/,
  );
  assert.throws(
    () => parseArgs(["--trusted-review-ref", "abcd123"]),
    /Invalid trusted-review-ref/,
  );
  const prior = process.env.AGY_PR_REVIEW_TRUSTED_REF;
  process.env.AGY_PR_REVIEW_TRUSTED_REF = head;
  try {
    assert.equal(parseArgs([])["trusted-review-ref"], undefined);
  } finally {
    if (prior === undefined) delete process.env.AGY_PR_REVIEW_TRUSTED_REF;
    else process.env.AGY_PR_REVIEW_TRUSTED_REF = prior;
  }
  assert.throws(
    () =>
      authorizeControl({
        ...bundle,
        control_sha: head,
        control_mode: "explicit-local",
      }),
    /same explicit/,
  );
});

const recordedArgon = await fs.readFile(
  path.join(root, "tests/review/fixtures/agy-pr-review-native-1.4.2.ndjson"),
  "utf8",
);
const nativeRaw = recordedArgon.replace("gemini-4-argon-low", MODEL);
const nativeBundle = {
  ...bundle,
  files: Array.from({ length: 8 }, (_, i) => ({
    path: `examples/change-${i + 1}.mjs`,
    before: { mode: "100644", text: "old\n" },
    after: { mode: "100644", text: "new\n" },
  })),
};
function setAgentText(rows, index, text) {
  const steps = rows.filter((row) => row.step_update?.step_index === index);
  steps.forEach((row, i) => {
    row.step_update.text_delta = i === 0 ? text : "";
  });
  rows.at(-1).result.response = rows
    .filter((row) => row.step_update?.step_type === "agent_response")
    .map((row) => row.step_update.text_delta)
    .join("");
}
function replaceReview(rows, position, output) {
  if (position === "terminal") rows.at(-1).result.structured_output = output;
  else
    setAgentText(
      rows,
      position === "first" ? 1 : 3,
      position === "first"
        ? `\`\`\`json\n${JSON.stringify(output)}\n\`\`\`\n`
        : JSON.stringify({
            ...output,
            toolAction: "Finishing PR review",
            toolSummary: "PR review completion",
          }) + "\n",
    );
}
function native(mutator) {
  const rows = nativeRaw.trim().split("\n").map(JSON.parse);
  mutator?.(rows);
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

test("simulated Neon 1.4.2 two-turn completion retains exact eight-file coverage and usage without granting tool access", () => {
  const receipt = validateEvents(nativeRaw, nativeBundle, MODEL);
  assert.equal(receipt.num_turns, 2);
  assert.deepEqual(
    receipt.covered_files,
    nativeBundle.files.map((file) => file.path),
  );
  assert.equal(receipt.usage.input_tokens, 138748);
  assert.equal(receipt.usage.output_tokens, 474);
  assert.equal(receipt.usage.thinking_tokens, 0);
  assert.equal(receipt.turn_usage.length, 2);
  assert.equal(receipt.turn_usage[0].input_tokens, 69208);
  assert.equal(receipt.evidence_sha256, sha256(nativeRaw));
  assert.equal(
    requirePostedReview(
      [postedReview(fixtureAggregate(nativeRaw, nativeBundle).receipt)],
      nativeBundle,
    ).id,
    71,
  );
});

test("rejects an Argon LOW stream under the Neon review policy", () => {
  assert.throws(() => validateEvents(recordedArgon, nativeBundle, MODEL), /model/i);
});

test("native initial response may be one exact JSON document with the identical canonical completion", () => {
  const raw = native((rows) =>
    setAgentText(
      rows,
      1,
      JSON.stringify(rows.at(-1).result.structured_output) + "\n",
    ),
  );
  assert.equal(validateEvents(raw, nativeBundle, MODEL).num_turns, 2);
});

for (const [label, mutate] of [
  [
    "third internal turn",
    (r) => {
      r.at(-1).result.num_turns = 3;
    },
  ],
  [
    "boolean turn count",
    (r) => {
      r.at(-1).result.num_turns = true;
    },
  ],
  [
    "extra user input",
    (r) => {
      r.splice(-2, 0, clone(r[1]));
    },
  ],
  [
    "repeated DONE",
    (r) => {
      r.splice(2, 0, clone(r[1]));
    },
  ],
  [
    "wrong step index",
    (r) => {
      r[2].step_update.step_index = 2;
    },
  ],
  [
    "wrong step conversation",
    (r) => {
      r[2].step_update.conversation_id = "other";
    },
  ],
  [
    "wrong terminal conversation",
    (r) => {
      r.at(-1).result.conversation_id = "other";
    },
  ],
  [
    "missing finish",
    (r) => {
      r.splice(-2, 1);
    },
  ],
  [
    "unfinished finish",
    (r) => {
      r.at(-2).step_update.state = "ACTIVE";
    },
  ],
  [
    "unknown step state",
    (r) => {
      r[2].step_update.state = "PENDING";
    },
  ],
  [
    "unfinished first response",
    (r) => {
      r.find(
        (e) =>
          e.step_update?.step_index === 1 && e.step_update.state === "DONE",
      ).step_update.state = "ACTIVE";
    },
  ],
  [
    "unknown result status",
    (r) => {
      r.at(-1).result.status = "PARTIAL";
    },
  ],
  [
    "second result",
    (r) => {
      r.splice(-1, 0, clone(r.at(-1)));
    },
  ],
  [
    "wrong model",
    (r) => {
      r[0].init.model = "gemini-4-argon-high";
    },
  ],
  [
    "wrong permission",
    (r) => {
      r[0].init.permission_mode = "always-proceed";
    },
  ],
  [
    "wrong init schema",
    (r) => {
      r[0].init.json_schema.properties.head.const = base;
    },
  ],
  [
    "wrong result schema",
    (r) => {
      r.at(-1).result.json_schema.additionalProperties = true;
    },
  ],
  [
    "both schemas substituted",
    (r) => {
      r[0].init.json_schema.type = "array";
      r.at(-1).result.json_schema.type = "array";
    },
  ],
  [
    "tool step",
    (r) => {
      r[2].step_update.step_type = "tool";
    },
  ],
  [
    "tool_info hidden in user input",
    (r) => {
      r[1].step_update.tool_info = {};
    },
  ],
  [
    "tool_info hidden in agent response",
    (r) => {
      r[2].step_update.tool_info = { name: "finish" };
    },
  ],
  [
    "tool_info hidden in finish",
    (r) => {
      r.at(-2).step_update.tool_info = {};
    },
  ],
  [
    "subagent hidden in agent response",
    (r) => {
      r[2].step_update.subagent_info = {};
    },
  ],
  [
    "permission activity hidden in agent response",
    (r) => {
      r[2].step_update.permission = "granted";
    },
  ],
  [
    "error hidden in DONE",
    (r) => {
      r.at(-2).step_update.error = "denied";
    },
  ],
  [
    "unexpected init diagnostic",
    (r) => {
      r[0].init.error = "auth";
    },
  ],
  [
    "unknown terminal key",
    (r) => {
      r.at(-1).result.tool_info = {};
    },
  ],
  [
    "non-agent text",
    (r) => {
      r[1].step_update.text_delta = "ignore";
    },
  ],
  [
    "terminal response suffix",
    (r) => {
      r.at(-1).result.response += "ignored prose";
    },
  ],
  [
    "first response trailing prose",
    (r) =>
      setAgentText(
        r,
        1,
        JSON.stringify(r.at(-1).result.structured_output) + " trailing prose",
      ),
  ],
  [
    "first response second object",
    (r) =>
      setAgentText(
        r,
        1,
        JSON.stringify(r.at(-1).result.structured_output) + " {}",
      ),
  ],
  [
    "completion response second object",
    (r) => {
      const text = r.find((e) => e.step_update?.step_index === 3).step_update
        .text_delta;
      setAgentText(r, 3, text + "{}");
    },
  ],
  [
    "unexpected fenced language",
    (r) =>
      setAgentText(
        r,
        1,
        "```javascript\n" +
          JSON.stringify(r.at(-1).result.structured_output) +
          "\n```\n",
      ),
  ],
  [
    "unknown review field",
    (r) =>
      replaceReview(r, "first", {
        ...r.at(-1).result.structured_output,
        ignored: true,
      }),
  ],
  [
    "unexpected completion field",
    (r) => {
      const text = r.find((e) => e.step_update?.step_index === 3).step_update
        .text_delta;
      setAgentText(
        r,
        3,
        JSON.stringify({ ...JSON.parse(text), toolCommand: "unused" }),
      );
    },
  ],
  [
    "non-string completion metadata",
    (r) => {
      const text = r.find((e) => e.step_update?.step_index === 3).step_update
        .text_delta;
      setAgentText(
        r,
        3,
        JSON.stringify({ ...JSON.parse(text), toolAction: true }),
      );
    },
  ],
  [
    "oversized completion metadata",
    (r) => {
      const text = r.find((e) => e.step_update?.step_index === 3).step_update
        .text_delta;
      setAgentText(
        r,
        3,
        JSON.stringify({ ...JSON.parse(text), toolSummary: "x".repeat(513) }),
      );
    },
  ],
  [
    "usage type substitution",
    (r) => {
      r.at(-1).result.usage.thinking_tokens = "0";
    },
  ],
  [
    "usage lost from formatting turn",
    (r) => {
      r.at(-1).result.usage.input_tokens = 69208;
    },
  ],
  [
    "unbounded event count",
    (r) => {
      r.splice(2, 0, ...Array.from({ length: 2048 }, () => clone(r[2])));
    },
  ],
])
  test(`native completion rejects ${label}`, () =>
    assert.throws(() => validateEvents(native(mutate), nativeBundle, MODEL)));

for (const position of ["first", "completion", "terminal"]) {
  for (const [label, patch] of [
    ["wrong head", { head: base }],
    [
      "altered valid summary",
      { summary: "Different fictional review summary." },
    ],
    ["partial coverage", { covered_files: ["examples/change-1.mjs"] }],
    [
      "changed axis",
      {
        axes: [
          "correctness",
          "architecture",
          "security",
          "performance",
          "test_coverage",
        ],
      },
    ],
    ["boolean substituted with number", { completed: 1 }],
  ])
    test(`every ${position} review rejects ${label}`, () => {
      const raw = native((rows) =>
        replaceReview(rows, position, {
          ...rows.at(-1).result.structured_output,
          ...patch,
        }),
      );
      assert.throws(() => validateEvents(raw, nativeBundle, MODEL));
    });
}

for (const position of ["first", "completion", "terminal"])
  test(`formatter cannot erase findings from ${position} review`, () => {
    const rows = nativeRaw.trim().split("\n").map(JSON.parse);
    const output = {
      ...rows.at(-1).result.structured_output,
      findings: [
        {
          path: "examples/change-1.mjs",
          line: 1,
          severity: "P1",
          body: "Concrete fictional state loss.",
        },
      ],
    };
    for (const part of ["first", "completion", "terminal"])
      replaceReview(rows, part, output);
    const consistent = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    assert.equal(
      validateEvents(consistent, nativeBundle, MODEL).findings.length,
      1,
    );
    replaceReview(rows, position, { ...output, findings: [] });
    assert.throws(
      () =>
        validateEvents(
          rows.map((row) => JSON.stringify(row)).join("\n"),
          nativeBundle,
          MODEL,
        ),
      /differs/,
    );
  });

test("completed output binds full coverage, exact model and raw evidence digest", () => {
  const raw = events();
  const receipt = validateEvents(
    raw,
    bundle,
    MODEL,
    "review",
    undefined,
    selectReviewModel("auto", `${MODEL} Synthetic Neon\n`, ""),
  );
  assert.equal(receipt.head, head);
  assert.equal(receipt.evidence_sha256, sha256(raw));
  assert.equal(receipt.model, MODEL);
  assert.equal(receipt.effort, "low");
  assert.equal(receipt.provider, "google-account");
  assert.match(
    reviewBody(receipt),
    /Model: `gemini-4-neon-low` · Effort: low/,
  );
});

for (const [label, raw] of [
  ["empty", ""],
  ["plain text", "No findings"],
  ["partial", events().split("\n").slice(0, 2).join("\n")],
  ["incomplete coverage", events({ covered_files: [] })],
  [
    "repeated coverage",
    events({ covered_files: ["example.mjs", "example.mjs"] }),
  ],
  ["limitation", events({ limitations: ["Could not inspect context"] })],
  ["empty summary", events({ summary: "" })],
  [
    "finding with unknown field",
    events({
      findings: [
        {
          path: "example.mjs",
          line: 1,
          severity: "P1",
          body: "Concrete fictional defect.",
          ignored: true,
        },
      ],
    }),
  ],
  [
    "finding with boolean line",
    events({
      findings: [
        {
          path: "example.mjs",
          line: true,
          severity: "P1",
          body: "Concrete fictional defect.",
        },
      ],
    }),
  ],
  [
    "model substitution",
    events({}, (list) => {
      list[0].init.model = "other-model";
    }),
  ],
  [
    "Argon HIGH model substitution",
    events({}, (list) => {
      list[0].init.model = "gemini-4-argon-high";
    }),
  ],
  [
    "superseded Pro HIGH model substitution",
    events({}, (list) => {
      list[0].init.model = "gemini-3.1-pro-high";
    }),
  ],
  [
    "permission bypass",
    events({}, (list) => {
      list[0].init.permission_mode = "always-proceed";
    }),
  ],
  [
    "error status",
    events({}, (list) => {
      list.at(-1).result.status = "ERROR";
    }),
  ],
  [
    "tool soft denial",
    events({}, (list) => {
      list[1].step_update = {
        step_type: "tool",
        tool_info: { error: "denied" },
      };
    }),
  ],
  [
    "extra result",
    events({}, (list) => {
      list.splice(1, 0, list.at(-1));
    }),
  ],
  [
    "invalid finding",
    events({
      findings: [
        { path: "outside", line: 1, severity: "P1", body: "Bad behavior" },
      ],
    }),
  ],
])
  test(`never accepts ${label} as completed review`, () =>
    assert.throws(() => validateEvents(raw, bundle, MODEL)));

localTest(
  "review transport isolates HOME, denies tools, strips credentials, passes explicit LOW and cleans scratch",
  async (t) => {
    const directory = await temporary(t);
    const binary = path.join(directory, "fictional-agy");
    await fs.writeFile(binary, "not an executable: transport must be stubbed");
    const calls = [];
    const result = await reviewSession(
      bundle,
      { agy: binary, authSocket: "/tmp/fictional-private-bus" },
      async (command, args, options) => {
        assert.equal(command, process.platform === "darwin" ? "/usr/bin/sandbox-exec" : "bwrap");
        assert.equal(options.env.GH_TOKEN, undefined);
        assert.equal(options.env.GITHUB_TOKEN, undefined);
        assert.equal(options.env.GEMINI_API_KEY, undefined);
        assert.equal(options.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
        if (process.platform === "darwin") {
          assert.ok(options.env.HOME.endsWith("/home"));
          assert.equal(args[0], "-f");
        } else {
          assert.equal(options.env.HOME, "/home/reviewer");
          assert.ok(args.includes("--unshare-all"));
          assert.ok(args.includes("--ro-bind"));
        }
        assert.ok(!args.includes("--dangerously-skip-permissions"));
        calls.push({ args, cwd: options.cwd });
        if (args.at(-1) === "--version")
          return { stdout: `agy ${VERSION}\n`, stderr: "" };
        if (args.at(-1) === "models")
          return { stdout: `${MODEL}\tGemini 4 Neon (Low)\n`, stderr: "" };
        assert.equal(args[args.indexOf("--effort") + 1], "low");
        assert.equal(args[args.indexOf("--model") + 1], MODEL);
        assert.match(
          JSON.parse(options.input).message.content,
          /UNTRUSTED CANDIDATE DATA/,
        );
        return { stdout: batchEvents(args), stderr: "" };
      },
    );
    assert.equal(calls.length, 3);
    assert.equal(result.receipt.status, "completed");
    assert.equal(result.modelsStderr, "");
    await assert.rejects(fs.access(calls[0].cwd));
    await assert.rejects(review(bundle, { agy: binary }), /checksum/);
    let attempts = 0;
    await assert.rejects(
      reviewSession(
        bundle,
        { agy: binary, authSocket: "/tmp/fictional-private-bus" },
        async () => {
          attempts++;
          return { stdout: "not-the-model", stderr: "" };
        },
      ),
      /version/,
    );
    assert.equal(attempts, 1);
    const withoutModel = async (_command, args) => ({
      stdout:
        args.at(-1) === "--version"
          ? VERSION
          : "gemini-4-argon-high\tGemini 4 Argon (High)",
      stderr: "",
    });
    await assert.rejects(
      reviewSession(
        bundle,
        { agy: binary, authSocket: "/tmp/fictional-private-bus" },
        withoutModel,
      ),
      /model unavailable: gemini-3.8-flash-high; no fallback/,
    );
    if (process.platform !== "darwin") await assert.rejects(
      reviewSession(bundle, { agy: binary }, withoutModel),
      /account auth socket/,
    );
  },
);

localTest(
  "models preflight accepts only the exact observed status line and retains it privately",
  async (t) => {
    const directory = await temporary(t);
    const binary = path.join(directory, "fictional-agy");
    await fs.writeFile(binary, "transport stub only");
    const stderr = "Fetching available models...\n";
    let calls = 0;
    const result = await reviewSession(
      bundle,
      { agy: binary, authSocket: "/tmp/fictional-native-bus" },
      async (_command, args, options) => {
        calls++;
        if (args.at(-1) === "--version") return { stdout: VERSION, stderr: "" };
        if (args.at(-1) === "models") {
          assert.equal(options.retainStderr, true);
          return { stdout: `${MODEL}\tGemini 4 Neon (Low)\n`, stderr };
        }
        return { stdout: batchEvents(args), stderr: "" };
      },
    );
    assert.equal(calls, 3);
    assert.equal(result.modelsStderr, stderr);
    assert.equal(result.receipt.model, "gemini-4-neon-low");
    assert.equal(result.receipt.effort, "low");
    assert.ok(!reviewBody(result.receipt).includes(stderr));
  },
);

for (const stderr of [
  "Fetching available models...",
  "Fetching available models...\r\n",
  "Fetching available models...\n\n",
  "Fetching available models...\nAuthentication required\n",
  "Authentication required\n",
  "Unknown metadata diagnostic\n",
]) {
  localTest(
    `models preflight rejects unexpected diagnostics ${JSON.stringify(stderr)} without a model call or retry`,
    async (t) => {
      const directory = await temporary(t);
      const binary = path.join(directory, "fictional-agy");
      await fs.writeFile(binary, "transport stub only");
      let calls = 0;
      await assert.rejects(
        reviewSession(
          bundle,
          { agy: binary, authSocket: "/tmp/fictional-native-bus" },
          async (_command, args) => {
            calls++;
            if (args.at(-1) === "--version")
              return { stdout: VERSION, stderr: "" };
            assert.equal(args.at(-1), "models");
            return { stdout: `${MODEL}\tGemini 4 Neon (Low)\n`, stderr };
          },
        ),
        (error) => {
          assert.match(error.message, /unexpected diagnostics/);
          assert.equal(error.modelsStderr, stderr);
          return true;
        },
      );
      assert.equal(calls, 2);
    },
  );
}

localTest(
  "missing Neon fails after metadata without a generation or retry, even with harmless status",
  async (t) => {
    const directory = await temporary(t);
    const binary = path.join(directory, "fictional-agy");
    await fs.writeFile(binary, "transport stub only");
    let calls = 0;
    await assert.rejects(
      reviewSession(
        bundle,
        { agy: binary, authSocket: "/tmp/fictional-native-bus" },
        async (_command, args) => {
          calls++;
          if (args.at(-1) === "--version")
            return { stdout: VERSION, stderr: "" };
          assert.equal(args.at(-1), "models");
          return {
            stdout: "gemini-4-argon-high\tGemini 4 Argon (High)\n",
            stderr: "Fetching available models...\n",
          };
        },
      ),
      /model unavailable: gemini-3.8-flash-high; no fallback/,
    );
    assert.equal(calls, 2);
  },
);

localTest(
  "nonzero models exit retains private stderr and rejects even an exact model listing",
  async (t) => {
    const directory = await temporary(t);
    const binary = path.join(directory, "fictional-agy");
    await fs.writeFile(binary, "transport stub only");
    let calls = 0;
    await assert.rejects(
      reviewSession(
        bundle,
        { agy: binary, authSocket: "/tmp/fictional-native-bus" },
        async (_command, args, options) => {
          calls++;
          if (args.at(-1) === "--version")
            return { stdout: VERSION, stderr: "" };
          assert.equal(args.at(-1), "models");
          return bounded(
            process.execPath,
            [
              "-e",
              'process.stdout.write(process.argv[1]); process.stderr.write("Authentication required\\n"); process.exitCode = 1;',
              `${MODEL}\tGemini 4 Neon (Low)\n`,
            ],
            { env: cleanEnv(), retainStderr: options.retainStderr },
          );
        },
      ),
      (error) => {
        assert.match(error.message, /failed \(exit 1\); diagnostics withheld/);
        assert.equal(error.modelsStderr, "Authentication required\n");
        return true;
      },
    );
    assert.equal(calls, 2);
  },
);

localTest(
  "metadata status allowance never permits generation diagnostics",
  async (t) => {
    const directory = await temporary(t);
    const binary = path.join(directory, "fictional-agy");
    await fs.writeFile(binary, "transport stub only");
    let calls = 0;
    await assert.rejects(
      reviewSession(
        bundle,
        { agy: binary, authSocket: "/tmp/fictional-native-bus" },
        async (_command, args) => {
          calls++;
          if (args.at(-1) === "--version")
            return { stdout: VERSION, stderr: "" };
          if (args.at(-1) === "models")
            return { stdout: `${MODEL}\tGemini 4 Neon (Low)\n`, stderr: "" };
          return { stdout: events(), stderr: "Fetching available models...\n" };
        },
      ),
      /Reviewer emitted diagnostics/,
    );
    assert.equal(calls, 3);
  },
);

localTest("Fitness Metrics refuses a non-Neon selection before generation", async (t) => {
  const directory = await temporary(t);
  const binary = path.join(directory, "fictional-agy");
  await fs.writeFile(binary, "transport stub only");
  let generation = 0;
  await assert.rejects(reviewSession(bundle,
    {agy:binary,authSocket:"/tmp/fictional-native-bus",model:FALLBACK_MODEL},
    async (_command,args) => {
      if(args.at(-1)==="--version")return {stdout:VERSION,stderr:""};
      if(args.at(-1)==="models")return {stdout:`${FALLBACK_MODEL} Future`,stderr:""};
      generation++;
      throw new Error("wrong-model generation must never run");
    }), /Fitness Metrics requires Gemini Neon low/);
  assert.equal(generation,0);
});

for (const markers of [
  { CI: "true" },
  { GITHUB_ACTIONS: "true" },
  { CI: "true", GITHUB_ACTIONS: "true" },
]) {
  test(`mock local transport restores inherited ${Object.keys(markers).join("/")} after completion and rejection while real CI remains forbidden`, async (t) => {
    const prior = ["CI", "GITHUB_ACTIONS"].map((name) => [
      name,
      process.env[name],
    ]);
    const directory = await temporary(t);
    const binary = path.join(directory, "fictional-agy");
    await fs.writeFile(binary, "transport stub only");
    let calls = 0;
    const execute = async (_command, args) => {
      calls++;
      if (args.at(-1) === "--version") return { stdout: VERSION, stderr: "" };
      if (args.at(-1) === "models")
        return { stdout: `${MODEL}\tGemini 4 Neon (Low)`, stderr: "" };
      return { stdout: batchEvents(args), stderr: "" };
    };
    try {
      for (const [name] of prior) delete process.env[name];
      Object.assign(process.env, markers);
      const options = { agy: binary, authSocket: "/tmp/fictional-native-bus" };
      const result = await withLocalEnvironment(() =>
        reviewSession(bundle, options, execute),
      );
      assert.equal(result.receipt.status, "completed");
      assert.equal(calls, 3);
      // Rejection inside a local fixture must also restore the hosted context.
      await assert.rejects(
        withLocalEnvironment(() =>
          reviewSession(bundle, options, async (_command, args) => ({
            stdout:
              args.at(-1) === "--version"
                ? VERSION
                : "unknown-model Synthetic unavailable\n",
            stderr: "",
          })),
        ),
        /model unavailable/,
      );
      for (const [name] of prior)
        assert.equal(process.env[name], markers[name]);
      await assert.rejects(
        reviewSession(bundle, options, execute),
        /CI model generation is forbidden/,
      );
      await assert.rejects(
        review(bundle, options),
        /CI model generation is forbidden/,
      );
      assert.equal(calls, 3);
      assert.throws(
        () => parseArgs(["--trusted-review-ref", head]),
        /forbidden in CI/,
      );
    } finally {
      for (const [name, value] of prior) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
}

test("publication revalidates head immediately before post and after it and never grants CI success", async () => {
  const prior = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "synthetic-publication-token-not-a-credential";
  try {
    const { raw, receipt } = fixtureAggregate(events());
    const calls = [];
    const execute = async (_command, args, options) => {
      calls.push(args);
      assert.equal(options.env.GEMINI_API_KEY, undefined);
      if (!args.includes("POST"))
        return { stdout: JSON.stringify(fixtureMetadata()) };
      const request = JSON.parse(options.input);
      if (args.some((arg) => arg.endsWith("/reviews")))
        return {
          stdout: JSON.stringify({
            commit_id: head,
            state: "COMMENTED",
            body: request.body,
            submitted_at: "2026-10-18T00:00:00Z",
          }),
        };
      assert.equal(request.context, "gemini-review");
      assert.equal(request.state, "success");
      return { stdout: "{}" };
    };
    await publish(bundle, receipt, raw, { ...identity, model: MODEL }, execute);
    assert.equal(calls[0].at(-1), `repos/${REPOSITORY}/pulls/42`);
    assert.equal(calls[1].includes("POST"), true);
    const stale = async () => ({
      stdout: JSON.stringify(
        fixtureMetadata({
          head: { sha: "c".repeat(40), repo: { full_name: REPOSITORY } },
        }),
      ),
    });
    await assert.rejects(
      publish(bundle, receipt, raw, { ...identity, model: MODEL }, stale),
      /head changed/,
    );
    await assert.rejects(
      publish(
        bundle,
        { ...receipt, head: base },
        raw,
        { ...identity, model: MODEL },
        execute,
      ),
      /Receipt differs/,
    );
    await assert.rejects(
      publish(
        bundle,
        { ...receipt, effort: "high" },
        raw,
        { ...identity, model: MODEL },
        execute,
      ),
      /Receipt differs/,
    );
    await assert.rejects(
      publish(
        bundle,
        { ...receipt, mode: "local_only" },
        raw,
        { ...identity, model: MODEL },
        execute,
      ),
      /Local-only/,
    );
    const findingSource = events({
      findings: [
        {
          path: "example.mjs",
          line: 1,
          severity: "P2",
          body: "Concrete changed behavior loses state.",
        },
      ],
    });
    const { raw: findingRaw, receipt: findingReceipt } =
      fixtureAggregate(findingSource);
    let statusCalls = 0;
    await publish(
      bundle,
      findingReceipt,
      findingRaw,
      { ...identity, model: MODEL },
      async (_command, args, options) => {
        if (!args.includes("POST"))
          return { stdout: JSON.stringify(fixtureMetadata()) };
        const request = JSON.parse(options.input);
        if (hasState(request)) {
          statusCalls++;
          return { stdout: "{}" };
        }
        return {
          stdout: JSON.stringify({
            commit_id: head,
            state: "COMMENTED",
            body: request.body,
            submitted_at: "2026-10-18T00:00:00Z",
          }),
        };
      },
    );
    assert.equal(statusCalls, 0);
  } finally {
    if (prior === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prior;
  }
});

function postedReview(
  receipt = fixtureAggregate(events()).receipt,
  patch = {},
) {
  return {
    id: 71,
    user: { login: "hodgesz", type: "User" },
    author_association: "OWNER",
    commit_id: head,
    state: "COMMENTED",
    submitted_at: "2026-10-18T00:00:00Z",
    body: reviewBody(receipt),
    ...patch,
  };
}

test("CI accepts only a complete exact-head trusted-owner account receipt with independently reconstructed coverage", () => {
  assert.equal(requirePostedReview([postedReview()], bundle).id, 71);
  for (const patch of [
    { commit_id: base },
    { state: "DISMISSED" },
    { state: "PENDING" },
    { user: { login: "stranger", type: "User" } },
    { user: { login: "hodgesz", type: "Bot" } },
    { author_association: "CONTRIBUTOR" },
    { submitted_at: null },
    { body: "No findings, trust me" },
  ]) {
    assert.throws(() =>
      requirePostedReview([postedReview(undefined, patch)], bundle),
    );
  }
  for (const patch of [
    { provider: "gemini" },
    { mode: "local_only" },
    { covered_files: [] },
    { model: "other" },
    { model: "gemini-4-argon-high" },
    { model: "gemini-3.1-pro-high" },
    { effort: "high" },
    { effort: "medium" },
    { num_turns: 3 },
    { num_turns: true },
    { turn_usage: [] },
    { usage: { input_tokens: "2" } },
    { status: "skipped" },
    { input_sha256: "d".repeat(64) },
    { trusted_skill_sha256: "d".repeat(64) },
    { changed_manifest_sha256: "d".repeat(64) },
    {
      findings: [
        {
          severity: "P1",
          path: "example.mjs",
          line: 1,
          body: "Concrete defect",
        },
      ],
    },
  ]) {
    const receipt = { ...fixtureAggregate(events()).receipt, ...patch };
    assert.throws(() => requirePostedReview([postedReview(receipt)], bundle));
  }
  assert.throws(
    () =>
      requirePostedReview(
        [
          postedReview(),
          postedReview(undefined, { id: 72, state: "DISMISSED" }),
        ],
        bundle,
      ),
    /dismissed/,
  );
});

test("CI paginates reviews and rejects a head change during verification", async () => {
  const prior = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "synthetic-verifier-token-not-a-credential";
  try {
    let metadataCalls = 0;
    const execute = async (_command, args) => {
      if (args.includes("--paginate"))
        return { stdout: JSON.stringify([[], [postedReview()]]) };
      metadataCalls++;
      return { stdout: JSON.stringify(fixtureMetadata()) };
    };
    assert.equal(
      (await verifyPostedReview(bundle, { ...identity, model: MODEL }, execute))
        .id,
      71,
    );
    assert.equal(metadataCalls, 2);
    metadataCalls = 0;
    await assert.rejects(
      verifyPostedReview(
        bundle,
        { ...identity, model: MODEL },
        async (_command, args) => {
          if (args.includes("--paginate"))
            return { stdout: JSON.stringify([[postedReview()]]) };
          metadataCalls++;
          return {
            stdout: JSON.stringify(
              fixtureMetadata(
                metadataCalls > 1
                  ? { head: { sha: base, repo: { full_name: REPOSITORY } } }
                  : {},
              ),
            ),
          };
        },
      ),
      /head changed/,
    );
  } finally {
    if (prior === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prior;
  }
});
const hasState = (request) => Object.hasOwn(request, "state");

test("process limits bound wall time and output without echoing child data", async () => {
  await assert.rejects(
    bounded(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeout: 50,
    }),
    /time limit/,
  );
  await assert.rejects(
    bounded(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(50000))"],
      { limit: 1024 },
    ),
    /output limit/,
  );
});

test("Mac pins are platform-specific and sandbox paths are data with immutable workspace/config", () => {
  assert.equal(new Set(Object.values(BINARY_PINS)).size, 3);
  const profile = macSandboxProfile(
    '/tmp/verified"agy',
    "/private/tmp/fp-review",
    "/Users/example/Library/Keychains/login.keychain-db",
  );
  assert.ok(profile.includes('verified\\"agy'));
  assert.ok(profile.includes("(deny default)"));
  assert.ok(
    profile.includes(
      '(deny file-write* (subpath "/private/tmp/fp-review/workspace")',
    ),
  );
  assert.ok(profile.includes('(literal "/usr/bin/security")'));
  assert.ok(profile.includes('(allow file-read* (literal "/"))'));
  assert.ok(profile.includes('(allow file-read* (literal "/Users/example/Library/Keychains/login.keychain-db"))'));
  assert.ok(!profile.includes('(subpath "/Users/example"'));
  assert.ok(!profile.includes('(subpath "/Users/example/Library/Keychains"'));
  assert.throws(() => macSandboxProfile("/tmp/agy", "/tmp/review", "relative"));
  assert.throws(() => macSandboxProfile("relative", "/tmp/review"));
  const receipt = validateEvents(
    events(),
    bundle,
    MODEL,
    "review",
    BINARY_PINS["darwin-arm64"],
  );
  assert.equal(receipt.cli_binary_sha256, BINARY_PINS["darwin-arm64"]);
  assert.equal(
    requirePostedReview(
      [
        postedReview(
          fixtureAggregate(events(), bundle, MODEL, BINARY_PINS["darwin-arm64"])
            .receipt,
        ),
      ],
      bundle,
    ).id,
    71,
  );
  assert.throws(
    () => validateEvents(events(), bundle, MODEL, "review", "f".repeat(64)),
    /binary pin/,
  );
});

localTest(
  "full input above 90 KiB uses stdin, while model argv stays small",
  async (t) => {
    const directory = await temporary(t);
    const binary = path.join(directory, "fictional-agy");
    await fs.writeFile(binary, "transport stub only");
    const large = clone(bundle);
    large.files[0].after.text = "x".repeat(150000);
    await reviewSession(
      large,
      { agy: binary, authSocket: "/tmp/fictional-native-bus" },
      async (_command, args, options) => {
        if (args.at(-1) === "--version") return { stdout: VERSION, stderr: "" };
        if (args.at(-1) === "models")
          return { stdout: `${MODEL}\tGemini 4 Neon (Low)`, stderr: "" };
        assert.ok(Buffer.byteLength(options.input) > 90000);
        assert.ok(Buffer.byteLength(JSON.stringify(args)) < 10000);
        return { stdout: batchEvents(args), stderr: "" };
      },
    );
  },
);

test("installer pin drift fails before payload/installer execution with an offline curl stub", async (t) => {
  const directory = await temporary(t);
  const output = path.join(directory, "cli");
  const calls = path.join(directory, "curl-calls");
  const marker = path.join(directory, "MUST-NOT-EXECUTE");
  await fs.writeFile(
    path.join(directory, "curl"),
    `#!/bin/sh\nprintf 'called\\n' >> '${calls}'\nwhile [ "$#" -gt 0 ]; do\n if [ "$1" = -o ]; then shift; printf '#!/bin/sh\\ntouch ${marker}\\n' > "$1"; exit 0; fi\n shift\ndone\nexit 1\n`,
    { mode: 0o755 },
  );
  await assert.rejects(
    bounded(
      "/bin/bash",
      [path.join(root, "scripts/install-agy-review.sh"), output],
      { env: cleanEnv({ PATH: `${directory}:/usr/bin:/bin` }) },
    ),
  );
  assert.equal((await fs.readFile(calls, "utf8")).trim(), "called");
  await assert.rejects(fs.access(marker));
  await assert.rejects(fs.access(path.join(output, "agy")));
});
