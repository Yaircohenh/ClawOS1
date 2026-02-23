#!/usr/bin/env bash
# test_fastpath.sh — wrapper that runs the fastpath unit tests via Node.js ESM
# Usage: bash clawos/scripts/test_fastpath.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec node "${ROOT}/clawos/scripts/test_fastpath.mjs" "$@"
