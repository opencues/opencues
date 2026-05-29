#!/usr/bin/env bash
# opencues-blank.sh — get/set OpenCues settings
#
# Commands:
#   get                        → "<firstSettingName>\t<currentValue>"  (tab-delimited)
#   get <settingName>          → "<currentValue>"
#   set <settingName> <value>  → (writes to OPENCUES.md frontmatter, no output)

# BSD sed (macOS) requires '' after -i; GNU sed (Linux/WSL) does not.
if sed --version 2>/dev/null | grep -q GNU; then
  sedi() { sed -i "$@"; }
else
  sedi() { sed -i '' "$@"; }
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Settings live in the user-level OPENCUES.md (markdown with frontmatter,
# system-wide, runtime-owned schema). This blank always lives at
# ~/.cues/blanks/opencues/ so the target file is deterministically
# two levels up at ~/.cues/OPENCUES.md.
OPENCUES_MD="$SCRIPT_DIR/../../OPENCUES.md"

cmd="${1:-get}"
setting="${2:-}"
value="${3:-}"

get_value() {
  grep -E "^${1}:" "$OPENCUES_MD" 2>/dev/null | head -1 | sed 's/^[^:]*:[[:space:]]*//'
}

set_value() {
  if grep -qE "^${1}:" "$OPENCUES_MD" 2>/dev/null; then
    sedi "s|^${1}:.*|${1}: ${2}|" "$OPENCUES_MD"
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
