#!/usr/bin/env bash
# sentinel-blank.sh — native-host fallback for `set sentinel _` /
# `remove sentinel _`.
#
# Routes every write back through `opencues identity set|remove` so
# the validator (validateSentinelWrite in @opencues/core) is the
# single chokepoint. Refuses to write directly. See
# docs/architecture/security-audit.md row #24.
#
# Invocation (mirrors the Blank.get/set dispatch):
#   get "set sentinel" <key> <value...>     → add or update
#   get "remove sentinel" <key>             → delete
#
# Returns the substitution string on stdout. Errors are prefixed
# `[err] ` so BlankFill paints them visibly into the buffer.

set -u

cmd="${1:-get}"
keyword="${2:-}"
shift 2 2>/dev/null || true

# Locate the opencues CLI. Prefer $PATH (handles installed npm),
# then a workspace-local build, then bail with a visible error.
OC_CLI=""
if command -v opencues >/dev/null 2>&1; then
  OC_CLI="opencues"
elif [ -n "${OPENCUES_REPO_ROOT:-}" ] && [ -f "${OPENCUES_REPO_ROOT}/packages/opencues-cli/bin/cli.cjs" ]; then
  OC_CLI="node ${OPENCUES_REPO_ROOT}/packages/opencues-cli/bin/cli.cjs"
else
  echo "[err] sentinel blank: opencues CLI not on PATH"
  exit 0
fi

case "$cmd" in
  get)
    case "$keyword" in
      "set sentinel"|"SET SENTINEL"|"Set Sentinel")
        key="${1:-}"; shift 2>/dev/null || true
        value="$*"
        if [ -z "$key" ] || [ -z "$value" ]; then
          echo "[err] set sentinel: usage is \`set sentinel <key> <value> _\`"
          exit 0
        fi
        out=$($OC_CLI identity set "$key" "$value" 2>&1)
        rc=$?
        if [ $rc -eq 0 ]; then
          token=$($OC_CLI identity list --json 2>/dev/null \
            | grep -E "\"key\":\s*\"$key\"" -A 1 \
            | grep -E '"token"' \
            | sed 's/.*"token":[[:space:]]*"\([^"]*\)".*/\1/')
          if [ -n "$token" ]; then
            echo "$token = $value"
          else
            echo "$key = $value"
          fi
        else
          detail=$(echo "$out" | grep -E 'must match|exceeds|forbidden|full|derives to|collision|no sentinel' | head -1 | sed 's/\[error\] //;s/\[warn\] //')
          echo "[err] ${detail:-write refused}"
        fi
        ;;
      "remove sentinel"|"REMOVE SENTINEL"|"Remove Sentinel")
        key="${1:-}"
        if [ -z "$key" ]; then
          echo "[err] remove sentinel: usage is \`remove sentinel <key> _\`"
          exit 0
        fi
        out=$($OC_CLI identity remove "$key" 2>&1)
        rc=$?
        if [ $rc -eq 0 ]; then
          echo "[removed $key]"
        else
          detail=$(echo "$out" | grep -E 'no sentinel|must match' | head -1 | sed 's/\[error\] //')
          echo "[err] ${detail:-remove refused}"
        fi
        ;;
      *)
        echo "[err] sentinel blank: unknown keyword \"$keyword\""
        ;;
    esac
    ;;
  set)
    # The runtime never invokes the script with action=set — `set` is
    # only used by selector-satellite blanks where the satellite paints
    # the current value. Sentinel writes are entirely contained in
    # action=get's invocation. Refuse loudly so a future change that
    # tries to route here gets a visible failure.
    echo "[err] sentinel blank does not support action=set; use \`set sentinel <key> <value> _\` in the buffer"
    ;;
  *)
    echo "[err] sentinel blank: unknown action \"$cmd\""
    ;;
esac
