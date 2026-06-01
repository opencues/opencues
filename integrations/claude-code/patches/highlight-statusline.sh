#!/usr/bin/env bash
# Cues status line script for Claude Code
# Shows: user@host:dir | highlighted word info + tip
#
# Install: Copy to ~/.claude/ and configure settings.json:
#   { "statusLine": { "type": "command", "command": "/full/path/highlight-statusline.sh" } }
#
# lint: no-pipefail (statusline runs on every CC redraw; probe pipes
# legitimately fall through on failure and the script degrades to a
# minimal line rather than aborting. Aborting would mean an empty
# statusline which is a worse user experience than partial info.)

# Find Claude Code PID by walking up the process tree.
# Match any of:
#   - cmdline starting with `claude` (the system install or a `claude-cues` shim)
#   - cmdline containing `claude-code/cli.js` (cli.js fork — CC 2.1.111 and earlier;
#     invoked as `node .../@anthropic-ai/claude-code/cli.js`)
#   - cmdline containing `claude-code/bin/claude` (native bun-binary fork —
#     CC 2.1.113+ including 2.1.150; invoked as the absolute path to claude.exe.
#     We match `bin/claude` rather than `bin/claude.exe` because the bun-compile
#     output also spawns child processes via the same binary path, sometimes
#     without the `.exe` suffix on linux builds.)
#
# Linux exposes per-PID cmdline + parent at /proc/$PID/{cmdline,stat}.
# macOS has no /proc — fall back to `ps -o command=` for cmdline and
# `ps -o ppid=` for the parent walk. Both branches yield the same
# semantics; the Linux path is kept first because it's ~5× faster
# (zero exec per probe) and statusline runs on every CC redraw.
CLAUDE_PID=""
WALK_PID=$$
HAS_PROC=0
[ -d /proc ] && HAS_PROC=1
while [ "$WALK_PID" != "1" ] && [ -n "$WALK_PID" ]; do
  if [ "$HAS_PROC" = "1" ]; then
    CMDLINE=$(cat /proc/$WALK_PID/cmdline 2>/dev/null | tr '\0' ' ')
  else
    CMDLINE=$(ps -o command= -p "$WALK_PID" 2>/dev/null)
  fi
  if echo "$CMDLINE" | grep -qE '^claude|claude-code/cli\.js|claude-code/bin/claude'; then
    CLAUDE_PID=$WALK_PID
    break
  fi
  if [ "$HAS_PROC" = "1" ]; then
    WALK_PID=$(awk '{print $4}' /proc/$WALK_PID/stat 2>/dev/null)
  else
    WALK_PID=$(ps -o ppid= -p "$WALK_PID" 2>/dev/null | tr -d ' ')
  fi
done

# Canonical per-host status path — same filename every host adapter writes
# (oc, gemini, terminal). Aligned 2026-05-25; legacy
# `/tmp/opencues-highlight-state-<pid>.json` is no longer emitted.
HIGHLIGHT_FILE="/tmp/opencues-status-${CLAUDE_PID:-unknown}.json"

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

  # Agent-task indicator. Renders even when no word is highlighted —
  # the agent ticks across the whole session, not per-word. Stable
  # display: no in-flight spinner toggle (would jitter on every tick).
  agent_task=$(echo "$content" | sed -n 's/.*"agentTask":"\([^"]*\)".*/\1/p')
  if [ -n "$agent_task" ]; then
    printf ' %s|%s %s[task: %s]%s' "$YELLOW" "$RESET" "$DIM" "$agent_task" "$RESET"
  fi

  if echo "$content" | grep -q '"active":true'; then
    word=$(echo "$content" | sed -n 's/.*"highlightedWord":"\([^"]*\)".*/\1/p')
    tip=$(echo "$content" | sed -n 's/.*"cueTip":"\([^"]*\)".*/\1/p')

    if [ -n "$word" ]; then
      is_cue_blank=$(echo "$content" | grep -o '"cueBlank":true')
      altcount=$(echo "$content" | sed -n 's/.*"alts":\[\([^]]*\)\].*/\1/p' | tr ',' '\n' | wc -l)
      altidx=$(echo "$content" | sed -n 's/.*"currentAltIndex":\([0-9]*\).*/\1/p')
      altidx=${altidx:-0}
      altpos=$((altidx + 1))
      # Show if word has alts OR is a cue-blank with a tip OR cue-blank
      # with no tip but a substituted alt (sentence cues, transform
      # blanks, etc. — the alt text IS the content the user cares about,
      # even when cueTip is null).
      if [ "$altcount" -gt 0 ] 2>/dev/null || [ -n "$is_cue_blank" ]; then
        # Inline (no newline) — CC v2.1.x renders only the first line of the
        # status command output. Use a separator instead of a newline.
        printf ' %s|%s ' "$YELLOW" "$RESET"
        if [ -n "$is_cue_blank" ]; then
          # Cue-blank: prefer tip if present; otherwise show the alt
          # text (truncated) + position so the user sees what's currently
          # selected. Sentence cues (cueBlank=true, cueTip=null) hit
          # this branch — without it the statusline rendered as just
          # "user@host:dir | " which looked broken.
          if [ -n "$tip" ]; then
            printf '%s' "$tip"
          else
            # Truncate long sentence-cue substitutions to ~70 chars so
            # the statusline doesn't blow past the terminal width.
            truncated=$(printf '%s' "$word" | cut -c1-70)
            if [ "${#word}" -gt 70 ]; then truncated="${truncated}…"; fi
            printf '%s%s%s' "${DIM}" "$truncated" "$RESET"
            if [ "$altcount" -gt 1 ] 2>/dev/null; then
              printf ' (%d/%d)' "$altpos" "$altcount"
            fi
          fi
        else
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
