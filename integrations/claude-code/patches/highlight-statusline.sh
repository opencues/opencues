#!/bin/bash
# Cues status line script for Claude Code
# Shows: user@host:dir | highlighted word info + tip
#
# Install: Copy to ~/.claude/ and configure settings.json:
#   { "statusLine": { "type": "command", "command": "/full/path/highlight-statusline.sh" } }

# Find Claude Code PID by walking up the process tree.
# Match either:
#   - cmdline starting with `claude` (the native install or `claude-cues` shim)
#   - cmdline containing `claude-code/cli.js` (when invoked as `node .../cli.js`,
#     e.g. the local install used during integration development)
CLAUDE_PID=""
WALK_PID=$$
while [ "$WALK_PID" != "1" ] && [ -n "$WALK_PID" ]; do
  CMDLINE=$(cat /proc/$WALK_PID/cmdline 2>/dev/null | tr '\0' ' ')
  if echo "$CMDLINE" | grep -qE '^claude|claude-code/cli\.js'; then
    CLAUDE_PID=$WALK_PID
    break
  fi
  WALK_PID=$(awk '{print $4}' /proc/$WALK_PID/stat 2>/dev/null)
done

HIGHLIGHT_FILE="/tmp/opencues-highlight-state-${CLAUDE_PID:-unknown}.json"

# PS1-style prefix
BOLD=$(tput bold 2>/dev/null)
GREEN=$(tput setaf 2 2>/dev/null)
BLUE=$(tput setaf 4 2>/dev/null)
YELLOW=$(tput setaf 3 2>/dev/null)
CYAN=$(tput setaf 6 2>/dev/null)
DIM=$(tput dim 2>/dev/null)
RESET=$(tput sgr0 2>/dev/null)

printf '%s' "${BOLD}${GREEN}$(whoami)@$(hostname -s)${RESET}:${BOLD}${BLUE}$(pwd)${RESET}"

# Show highlight state if active
if [ -f "$HIGHLIGHT_FILE" ]; then
  content=$(cat "$HIGHLIGHT_FILE" 2>/dev/null)

  if echo "$content" | grep -q '"active":true'; then
    word=$(echo "$content" | sed -n 's/.*"highlightedWord":"\([^"]*\)".*/\1/p')
    tip=$(echo "$content" | sed -n 's/.*"cueTip":"\([^"]*\)".*/\1/p')

    if [ -n "$word" ]; then
      is_cue_control=$(echo "$content" | grep -o '"cueControl":true')
      altcount=$(echo "$content" | sed -n 's/.*"alts":\[\([^]]*\)\].*/\1/p' | tr ',' '\n' | wc -l)
      # Show if word has alts OR is a cue-control with a tip
      if [ "$altcount" -gt 0 ] 2>/dev/null || [ -n "$is_cue_control" -a -n "$tip" ]; then
        # Inline (no newline) — CC v2.1.x renders only the first line of the
        # status command output. Use a separator instead of a newline.
        printf ' %s|%s ' "$YELLOW" "$RESET"
        if [ -n "$is_cue_control" ]; then
          printf '%s' "$tip"
        else
          altidx=$(echo "$content" | sed -n 's/.*"currentAltIndex":\([0-9]*\).*/\1/p')
          altidx=${altidx:-0}
          altpos=$((altidx + 1))
          printf '%s%s%s (%d/%d)' "${BOLD}${CYAN}" "$word" "$RESET" "$altpos" "$altcount"
          if [ -n "$tip" ]; then
            printf ' - %s' "$tip"
          fi
        fi
      fi
    fi
  fi
fi

printf '%s' "${RESET}"
