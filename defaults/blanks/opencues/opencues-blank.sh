#!/usr/bin/env bash
# opencues-blank.sh — get/set OpenCues settings
#
# Commands:
#   get                        → "<firstSettingName>\t<currentValue>"  (tab-delimited)
#   get <settingName>          → "<currentValue>"
#   set <settingName> <value>  → (writes to cues.md frontmatter, no output)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Settings live in the user-level cues.md frontmatter (system-wide,
# runtime-owned schema). This blank always lives at
# ~/.opencues/blanks/opencues/ so the target file is deterministically
# two levels up.
OPENCUES_MD="$SCRIPT_DIR/../../../.opencuesrc"

cmd="${1:-get}"
setting="${2:-}"
value="${3:-}"

get_value() {
  grep -E "^${1}:" "$OPENCUES_MD" 2>/dev/null | head -1 | sed 's/^[^:]*:[[:space:]]*//'
}

set_value() {
  if grep -qE "^${1}:" "$OPENCUES_MD" 2>/dev/null; then
    sed -i "s|^${1}:.*|${1}: ${2}|" "$OPENCUES_MD"
  fi
}

get_first_setting() {
  awk '/^settings:/{f=1;next} f && /^  [a-z]/{sub(/:.*/, ""); sub(/^[[:space:]]+/, ""); print; exit}' "$OPENCUES_MD" 2>/dev/null
}

case "$cmd" in
  get)
    if [[ -n "$setting" ]]; then
      val="$(get_value "$setting")"
      # If setting is a recognised current-value key (has a non-empty inline value), return it
      [[ -n "$val" ]] && echo "$val" && exit 0
    fi
    # Unrecognised or unset setting — return first setting + its current value (tab-delimited)
    first="$(get_first_setting)"
    [[ -z "$first" ]] && exit 1
    val="$(get_value "$first")"
    printf '%s\t%s\n' "$first" "$val"
    ;;
  set)
    [[ -z "$setting" || -z "$value" ]] && exit 1
    set_value "$setting" "$value"
    ;;
esac
