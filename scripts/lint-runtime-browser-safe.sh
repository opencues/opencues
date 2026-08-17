#!/usr/bin/env bash
# lint-runtime-browser-safe.sh
#
# Catches runtime/core source that is silently DEAD in chrome's content
# script — the bug class that made the BlankIntent gate inert in the browser
# for a long debugging session (every failure was silent + chrome isn't in
# the agentic test loop). See docs/architecture/chrome-runtime-compat.md.
#
# It enforces the two things the chrome esbuild BUILD cannot catch:
#   1. Unguarded `process.X` — esbuild leaves it a live `process` reference,
#      which throws `ReferenceError: process is not defined` at runtime.
#   2. `new NodeHttpAdapter` — `node:https`, aliased to a no-op stub in the
#      bundle, so it BUILDS fine and silently never makes a request.
#
# Escape hatches (mirrors lint-legacy-names.sh):
#   - Node-only modules (sandbox, user-blank JS exec, subprocess, agentic
#     harness, CLI daemon, fs discovery, mac keyboard) are allowlisted — they
#     never load in a content script.
#   - `process.env.HOME` / `process.env.DEBUG_OPENCUES` are esbuild `define`d
#     to literals at bundle time — safe.
#   - A `// BROWSER-SAFE-ALLOW: <reason>` marker on the line opts a specific
#     access out (e.g. a NodeHttpAdapter that's only a native-host fallback).
set -uo pipefail
cd "$(dirname "$0")/.."

DIRS="packages/opencues-core/src packages/opencues-runtime/src"

# Node-only modules: legitimately use process / node:* and are never bundled
# into a content script's executed paths. Adding a new Node-only module? Add
# it here. Adding a SHARED module (boot/config/resolver/blank-fill/…)? It must
# follow the two rules instead.
NODE_ONLY='user-blanks/|security/|event-bridge\.ts|mac-keyboard\.ts|discover\.ts|claude-cli-daemon\.ts|node-http-adapter'

fail=0

candidates=$(grep -rlE "process\.(env|platform|cwd|argv|exit)|new NodeHttpAdapter" $DIRS --include="*.ts" 2>/dev/null \
  | grep -vE "\.test\.|\.stub\.|${NODE_ONLY}" || true)

for f in $candidates; do
  # ── Check 1: unguarded process.X ───────────────────────────────────────
  # Match only REAL property accesses: `process.env.X` / `process.env?.X` /
  # `process.env[`, or `process.platform|cwd|argv|exit`. This skips prose
  # mentions like "read from process.env" inside strings/comments.
  ACCESS='process\.(env[.?[]|platform|cwd|argv|exit)'
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    lineno="${hit%%:*}"
    content="${hit#*:}"
    trimmed="$(printf '%s' "$content" | sed -E 's/^[[:space:]]*//')"
    case "$trimmed" in '*'*|'//'*|'/*'*) continue;; esac           # pure comment
    code="$(printf '%s' "$content" | sed -E 's#//.*##')"
    printf '%s' "$code" | grep -qE "$ACCESS" || continue
    # `DEBUG_OPENCUES` is esbuild-`define`d by chrome's build. `HOME` used
    # to be exempted here too — that was wrong: the exemption silently
    # required every FUTURE browser host to replicate chrome's define list,
    # and DeepSeek Harness (which does not) crashed the whole text-change
    # handler on `process.env.HOME`, killing every script-backed blank with
    # no symptom but "nothing happens". Use `homeDir()` from lib/home-dir.
    printf '%s' "$code" | grep -qE "process\.env[.?[]?DEBUG_OPENCUES" && continue  # esbuild define
    printf '%s' "$content" | grep -qE "BROWSER-SAFE-ALLOW" && continue            # explicit opt-out
    # Guard can be on the access line OR a few lines above (multi-line `&&`
    # conditions, enclosing `if (typeof process !== 'undefined') { … }`).
    win_start=$(( lineno > 5 ? lineno - 5 : 1 ))
    if sed -n "${win_start},${lineno}p" "$f" | grep -qE "typeof process"; then continue; fi
    echo "✗ $f:$lineno — unguarded \`process\` (chrome content scripts have none)."
    echo "    $trimmed"
    echo "    → guard with \`typeof process !== 'undefined' && process.…\`, or add // BROWSER-SAFE-ALLOW: <reason>"
    fail=1
  done < <(grep -nE "$ACCESS" "$f" || true)

  # ── Check 2: NodeHttpAdapter construction without an allow marker ───────
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    lineno="${hit%%:*}"
    content="${hit#*:}"
    printf '%s' "$content" | grep -qE "BROWSER-SAFE-ALLOW" && continue
    echo "✗ $f:$lineno — \`new NodeHttpAdapter\` (node:https; a no-op stub in chrome)."
    echo "    $(printf '%s' "$content" | sed -E 's/^[[:space:]]*//')"
    echo "    → accept an \`httpAdapter\` param (chrome passes its fetch adapter) and mark the native fallback // BROWSER-SAFE-ALLOW: <reason>"
    fail=1
  done < <(grep -nE "new NodeHttpAdapter" "$f" || true)
done

if [ "$fail" -eq 0 ]; then
  echo "[32m●[0m runtime browser-safe: no unguarded process / unmarked NodeHttpAdapter in chrome-loaded src"
fi
exit "$fail"
