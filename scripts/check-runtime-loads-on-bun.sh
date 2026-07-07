#!/usr/bin/env bash
# check-runtime-loads-on-bun.sh — assert the runtime's user-blanks
# registry imports cleanly under Bun.
#
# Bug class this guards against: a Node-only native binding gets
# added to @opencues/runtime as a TOP-LEVEL import; opencode + shell
# (both Bun-based) then crash at host boot with an "undefined symbol"
# error before any try/catch can fire. Tests run on Node, so unit
# coverage stays green while every Bun host is broken in production.
#
# The b460076 isolated-vm migration (June 2026, INFOSEC F1) is the
# canonical incident — opencode + shell crashed at boot for hours
# before the agentic harness caught it.
#
# What this gate checks:
#   1. `bun` is available (skip with a warning if not — local devs
#      without bun shouldn't be blocked).
#   2. `bun -e "require('@opencues/runtime/dist/...registry')"`
#      exits 0. Loads the user-blanks registry which transitively
#      imports node-loader; if a top-level native import lurks,
#      Bun crashes here and the gate fails.
#
# The registry MUST be the entry — it's what the OC + shell
# bootstraps call at boot. The fact that node-loader is reachable
# from registry is exactly the chain we need to validate.
#
# Bypass: `OPENCUES_SKIP_BUN_LOAD_PROBE=1` for tight iteration.

set -euo pipefail

if [ -n "${OPENCUES_SKIP_BUN_LOAD_PROBE:-}" ]; then
  echo "  skipped (OPENCUES_SKIP_BUN_LOAD_PROBE=1)"
  exit 0
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "  ⚠ bun not on PATH — skipping (install via ~/.opencues/vendor/bun, or set OPENCUES_SKIP_BUN_LOAD_PROBE=1 to silence)"
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIST="$REPO_ROOT/packages/opencues-runtime/dist/src"

if [ ! -d "$RUNTIME_DIST" ]; then
  echo "  ⚠ $RUNTIME_DIST missing — run \`pnpm --filter @opencues/runtime build\` first"
  exit 0
fi

# Probe: load the registry under Bun. Any unhandled top-level error
# (e.g. an unresolvable .node binding) makes Bun exit non-zero.
out=$(bun -e "
const reg = require('$RUNTIME_DIST/user-blanks/registry.js');
if (typeof reg.buildUserBlankRegistry !== 'function') {
  console.error('registry shape unexpected — buildUserBlankRegistry missing');
  process.exit(2);
}
console.log('OK');
" 2>&1) || {
  echo "  ✗ Bun failed to load @opencues/runtime user-blanks registry:"
  echo "$out" | sed 's/^/    /'
  echo ""
  echo "  This means a top-level import in node-loader.ts (or anything"
  echo "  it transitively imports) pulled in a Node-V8 native binding"
  echo "  that Bun can't load. Convert the offending import to a lazy"
  echo "  getter (see node-loader.ts:getIvm for the pattern)."
  exit 1
}

echo "  [32m●[0m Bun loads @opencues/runtime user-blanks registry cleanly"
