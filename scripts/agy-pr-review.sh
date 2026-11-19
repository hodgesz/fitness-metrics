#!/usr/bin/env bash
set -euo pipefail
# No shell evaluation of PR identifiers, model names or review text.
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
exec node "$script_dir/agy-pr-review.mjs" "$@"
