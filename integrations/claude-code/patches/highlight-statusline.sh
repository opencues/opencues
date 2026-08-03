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

# ─── Session-contradiction watchlist kick (Stage A trigger) ──────────────
# CC pipes a JSON blob {session_id, transcript_path, cwd, ...} to statusline
# commands on stdin. When `session-contradiction-mode: on` and the transcript
# has grown, fire-and-forget the watchlist producer (`opencues
# extract-commitments`). Everything here is best-effort, debounced, and
# detached — it never blocks the render or changes the printed line. Portable
# (bash 3.2 / BSD; no jq, no /proc dependency). See
# docs/architecture/session-contradiction.md.
OPENCUES_CLI_BAKED=""   # setup.sh rewrites this line with the resolved CLI invocation
if [ ! -t 0 ]; then _oc_stdin=$(cat 2>/dev/null); else _oc_stdin=""; fi
_oc_kick_commitments() {
  [ -n "$_oc_stdin" ] || return 0
  _oc_home="${OPENCUES_HOME:-$HOME/.cues}"
  # Cheap gate first — most users never enable this, so bail before any work.
  grep -qiE '^session-contradiction-mode:[[:space:]]*on([[:space:]]|$)' "$_oc_home/OPENCUES.md" 2>/dev/null || return 0
  _oc_tp=$(printf '%s' "$_oc_stdin" | grep -oE '"transcript_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')
  [ -n "$_oc_tp" ] || return 0
  # bash-level debounce — a SHORT spawn-gate (5s) so we don't launch node on
  # every redraw during streaming. This is deliberately shorter than the
  # producer's own extract cadence so the two don't "beat" against each other
  # (a mid-session decision then lands within ~one producer window, not two).
  # The FIRST kick of a session has no stamp, so the initial watchlist builds
  # promptly on the first activity.
  _oc_stamp="$_oc_home/.session-commitments.kick"
  _oc_now=$(date +%s 2>/dev/null || echo 0)
  if [ -f "$_oc_stamp" ]; then
    _oc_last=$(cat "$_oc_stamp" 2>/dev/null || echo 0)
    [ -n "$_oc_last" ] && [ "$((_oc_now - _oc_last))" -lt 5 ] 2>/dev/null && return 0
  fi
  printf '%s' "$_oc_now" > "$_oc_stamp" 2>/dev/null
  _oc_cli="$OPENCUES_CLI"
  [ -z "$_oc_cli" ] && [ -n "$OPENCUES_CLI_BAKED" ] && _oc_cli="$OPENCUES_CLI_BAKED"
  [ -z "$_oc_cli" ] && command -v opencues >/dev/null 2>&1 && _oc_cli="opencues"
  [ -n "$_oc_cli" ] || return 0
  # Detached fire-and-forget — quoted transcript path; output discarded.
  ( $_oc_cli extract-commitments "$_oc_tp" --quiet >/dev/null 2>&1 & ) >/dev/null 2>&1
}
_oc_kick_commitments 2>/dev/null

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

  # Kata mode is dominant: render "C_ Kata S/N: <coach>" and stop.
  tut_step=$(echo "$content" | sed -n 's/.*"kata":{[^}]*"step":\([0-9]*\).*/\1/p')
  if [ -n "$tut_step" ]; then
    tut_count=$(echo "$content" | sed -n 's/.*"kata":{[^}]*"stepCount":\([0-9]*\).*/\1/p')
    tut_coach=$(echo "$content" | sed -n 's/.*"kata":{[^}]*"coach":"\([^"]*\)".*/\1/p')
    if [ -n "$tut_count" ] && [ "$tut_count" != "0" ]; then
      printf 'C_ Kata %s/%s: %s\n' "$tut_step" "$tut_count" "$tut_coach"
    else
      printf 'C_ Kata: %s\n' "$tut_coach"
    fi
    exit 0
  fi

  # Undo/redo confirmation — transient (present for the journal's TTL after
  # an `undo _` / `redo _`). The universal feedback surface: an invisible
  # revert (a scalar or OS-value change) has no on-screen affordance, so we
  # echo what was undone. Dominant when present.
  undo_conf=$(echo "$content" | sed -n 's/.*"undoConfirmation":"\([^"]*\)".*/\1/p')
  if [ -n "$undo_conf" ]; then
    printf ' %s|%s %s%s%s\n' "$YELLOW" "$RESET" "$DIM" "$undo_conf" "$RESET"
    exit 0
  fi

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
