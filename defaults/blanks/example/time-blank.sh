#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# example/time-blank.sh — minimal hello-world blank script.
#
# Contract: `bash time-blank.sh <action> [args]`. The runtime
# invokes:
#   get          → print the current value to stdout (this script)
#   set <value>  → persist <value> to the underlying state (omitted
#                  here — example blank is read-only per
#                  blankReadOnly: true in BLANK.md)
#
# Exit code 0 + non-empty stdout = success. Anything else = the
# runtime logs and falls back to the literal `_`.
# ─────────────────────────────────────────────────────────────────

action="${1:-get}"

case "$action" in
  get)
    # Local time as HH:MM. The runtime takes whatever comes out of
    # stdout, trims trailing whitespace, and uses it as the
    # substitute. So a single `echo` is enough — no JSON, no
    # multi-line output, no parsing needed by the caller.
    date '+%H:%M'
    ;;
  set)
    # No-op for this example — blankReadOnly: true means the runtime
    # never sends `set`. If it did, we'd exit 1 to signal failure.
    echo "example blank is read-only" >&2
    exit 1
    ;;
  *)
    echo "unknown action: $action" >&2
    exit 2
    ;;
esac
