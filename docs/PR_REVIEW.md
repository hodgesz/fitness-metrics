# Independent Gemini PR review

Use native Antigravity 1.4.2 with the existing Google-account sign-in and
`gemini-4-neon-low` at explicit low effort. The reviewer accepts only that
pair. The review runs locally with tools denied in an empty read-only workspace.
CI verifies the owner-posted receipt from the trusted PR base or `main`.
Generation uses the operator's sign-in and never requires a CI credential.

## Review a PR

Use Node 22.22.2 and the checksum-verified Antigravity executable. Work from a
clean checkout of the exact base, with both commits available locally.

```sh
scripts/agy-pr-review.sh --dry-run --out /private/new-input PR_NUMBER
scripts/agy-pr-review.sh --model gemini-4-neon-low --effort low   --agy /absolute/path/to/pinned/agy --out /private/new-review PR_NUMBER
```

Review covers every byte of the immutable unified diff, with 20 context lines
and deterministic segments for large changes. Inspect the native model identity,
usage, reported findings and full coverage. Keep raw output on the local
machine. A changed commit requires a new review. A failed or partial run
provides no clearance. Reconcile a failed dispatch before any fresh attempt.

After the complete owner review is published, dispatch **Gemini PR review**
from `main` with the PR number. Wait for successful `gemini-review` on the exact
head and inspect the existing project checks and review threads before merging.
The `review-protocol` job runs the offline tests on an unprivileged checkout and
never posts a review result. The verifier grants a status only after rebuilding
the input from Git objects and checking the genuine owner receipt.

## First adoption

For the first PR only, the trusted base predates the verifier. Use a separately
frozen Argon LOW control derived from the established Personal Website reviewer
at `92e0ce5dc6af9c20a642c0e47828fccc10a7f5ce`, adapted to this repository's
identity. Select that exact local control through `--trusted-review-ref`.
Record complete independent coverage, a clear review, and passing project and
review-protocol checks before merging. The explicit control is local-only and
carries no GitHub status authority. After adoption, use the normal exact-base
Neon reviewer and verifier.
