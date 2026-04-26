#!/bin/bash
# display-blank.sh — selector + satellite stub for the demo `display` control.
# Stores state in a colocated JSON next to this script (~/.opencues/controls/display/display.state.json).
# A real production control would either back this with proper config or implement
# OpenCuesSettingsControl-style routing in @opencues/runtime/src/controls/display.ts.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="${SCRIPT_DIR}/display.state.json"

# Initialize state on first call.
[ ! -f "$STATE" ] && cat > "$STATE" << 'JSON'
{ "settings": { "theme": "dark", "font-size": "14", "line-spacing": "1.5" } }
JSON

cmd="${1:-get}"; setting="${2:-}"; value="${3:-}"

case "$cmd" in
  get)
    if [ -n "$setting" ]; then
      node -p "JSON.parse(require('fs').readFileSync('$STATE','utf8')).settings['$setting'] || ''"
    else
      # First setting + its value, tab-delimited (selector+satellite contract).
      node -p "const s=JSON.parse(require('fs').readFileSync('$STATE','utf8')).settings; const k=Object.keys(s)[0]; k+'\t'+s[k]"
    fi
    ;;
  set)
    [ -z "$setting" ] || [ -z "$value" ] && exit 1
    node -e "const fs=require('fs'); const o=JSON.parse(fs.readFileSync('$STATE','utf8')); o.settings['$setting']='$value'; fs.writeFileSync('$STATE', JSON.stringify(o,null,2));"
    ;;
esac
