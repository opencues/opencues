#!/usr/bin/env bash
# OpenCode integration setup.
#
# Clones sst/opencode at the pinned version, applies the OpenCues
# bootstrap patch, builds @opencues/{core,runtime}, and wires them in.
# Idempotent: re-runs sync the latest patch + rebuild without re-cloning.
#
# Usage: ./setup.sh [opencode-dir]
#   default opencode-dir: $HOME/opencode-cues
#
# Set OPENCUES_INSTALL_VERBOSE=1 to stream every command's output.
# Default is quiet — only progress lines + errors. Full log lives at
# the path printed on failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCUES_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OPENCODE_DIR="${1:-$HOME/opencode-cues}"
# Pin sourced from pin.json (structured) instead of inline vars, so
# `opencues update opencode --to <version>` can rewrite it without
# regex'ing this script. Mirrors CC's npm pin pattern.
PIN_FILE="$OPENCUES_ROOT/integrations/opencode/pin.json"
PINNED_VERSION=$(node -p "require('$PIN_FILE').version")
PINNED_SHA=$(node -p "require('$PIN_FILE').sha")

LOG="${OPENCUES_INSTALL_LOG:-/tmp/opencues-install-oc.log}"
VERBOSE="${OPENCUES_INSTALL_VERBOSE:-0}"
: > "$LOG"

# ─── progress helpers ────────────────────────────────────────────────
# run_step <label> <fn-name>
#   verbose=0 (default): prints "  ▸ <label> ✓" / "✗" + error excerpt
#   verbose=1:           streams everything live, still prints ✓/✗
run_step() {
  local label="$1"; shift
  if [[ "$VERBOSE" = "1" ]]; then
    printf '  ▸ %s\n' "$label"
    if "$@"; then
      printf '  ✓ %s\n' "$label"
    else
      local rc=$?
      printf '  ✗ %s (exit %d)\n' "$label" "$rc" >&2
      exit "$rc"
    fi
  else
    printf '  ▸ %s' "$label"
    if "$@" >>"$LOG" 2>&1; then
      printf ' ✓\n'
    else
      local rc=$?
      printf ' ✗\n' >&2
      echo "" >&2
      echo "Step failed: $label (exit $rc)" >&2
      echo "Last 30 lines of $LOG:" >&2
      tail -30 "$LOG" >&2
      echo "" >&2
      echo "Full log: $LOG  —  re-run with OPENCUES_INSTALL_VERBOSE=1 to stream live." >&2
      exit "$rc"
    fi
  fi
}

# ─── step bodies ─────────────────────────────────────────────────────
clone_fork() {
  if [[ -d "$OPENCODE_DIR" ]]; then
    if [[ ! -d "$OPENCODE_DIR/packages/opencode" ]]; then
      echo "$OPENCODE_DIR exists but is not an opencode checkout" >&2
      return 1
    fi
    cd "$OPENCODE_DIR"
    return 0
  fi
  # advice.detachedHead=false suppresses the 16-line lecture git emits
  # when checking out a SHA. --quiet trims clone progress; full output
  # still goes to the log.
  git -c advice.detachedHead=false clone --quiet \
    https://github.com/sst/opencode.git "$OPENCODE_DIR"
  cd "$OPENCODE_DIR"
  git -c advice.detachedHead=false checkout --quiet "$PINNED_SHA"
}

build_runtime() {
  ( cd "$OPENCUES_ROOT" && pnpm --filter @opencues/runtime build )
}

build_core() {
  # ALWAYS rebuild — skipping when dist/ exists silently drops source edits.
  ( cd "$OPENCUES_ROOT" && pnpm --filter @opencues/core build )
}

install_into_fork() {
  # @opencues/runtime
  local rt_dest="$OPENCODE_DIR/node_modules/@opencues/runtime"
  mkdir -p "$rt_dest"
  cp -r "$OPENCUES_ROOT/packages/opencues-runtime/dist" "$rt_dest/"
  cp "$OPENCUES_ROOT/packages/opencues-runtime/package.json" "$rt_dest/"

  # @opencues/core
  # Clean any prior install — without this, a stale dist/ subfolder from
  # an earlier setup.sh layout silently shadows the new top-level files
  # via package.json main: "dist/index.js". Symptom: code edits don't
  # take effect even though the redeploy "succeeded".
  local core_dest="$OPENCODE_DIR/node_modules/@opencues/core"
  rm -rf "$core_dest"
  mkdir -p "$core_dest"
  cp -r "$OPENCUES_ROOT/packages/opencues-core/dist/"* "$core_dest/"
  cp "$OPENCUES_ROOT/packages/opencues-core/package.json" "$core_dest/"
  # node-http-adapter.js isn't compiled by tsc but Resolver requires it
  # at runtime; copy explicitly so LLM resolution doesn't silently die.
  if [[ -f "$OPENCUES_ROOT/packages/opencues-core/node-http-adapter.js" ]]; then
    cp "$OPENCUES_ROOT/packages/opencues-core/node-http-adapter.js" "$core_dest/"
  fi
}

patch_app_tsx() {
  local app="$OPENCODE_DIR/packages/opencode/src/cli/cmd/tui/app.tsx"
  if grep -q "startOpenCues" "$app"; then return 0; fi
  python3 - "$app" <<'PY'
import sys
p = sys.argv[1]
src = open(p).read()
if 'startOpenCues' in src: sys.exit(0)
src = src.replace(
  'import { render, TimeToFirstDraw, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"',
  'import { render, TimeToFirstDraw, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"\nimport { startOpenCues, dispatchOpenCuesKey, holderBackedPromptAccess } from "./opencues"\n',
)
hook = '''
  // OpenCues bootstrap (Phase O.2 — holder-backed prompt access).
  const __ocRenderer = useRenderer()
  onMount(() => {
    startOpenCues({
      renderer: __ocRenderer,
      promptAccess: holderBackedPromptAccess(),
      cwd: process.env.OPENCUES_HOME || "/home/wilfred/opencues",
      hostVersion: "1.4.11",
    })
  })
  useKeyboard((evt) => {
    if (dispatchOpenCuesKey(evt)) {
      evt.preventDefault?.()
      evt.stopPropagation?.()
    }
  })
'''
src = src.replace('useKeyboard((evt) => {', hook + '\n  useKeyboard((evt) => {', 1)
open(p, 'w').write(src)
PY
}

patch_prompt_tsx() {
  local prompt="$OPENCODE_DIR/packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx"
  python3 - "$prompt" <<'PY'
import sys
p = sys.argv[1]
src = open(p).read()
# Per-edit idempotency: each block guarded by its own marker so adding
# new edits to existing patched files works without a full re-apply.
if 'publishPromptAccess' not in src:
    src = src.replace(
      'import { useArgs } from "@tui/context/args"',
      'import { useArgs } from "@tui/context/args"\nimport { publishPromptAccess, notifyOpenCuesTextChange, notifyOpenCuesCursorChange, triggerOpenCuesRender } from "../../opencues"',
    )
    src = src.replace(
      'ref={(r: TextareaRenderable) => {\n                input = r',
      '''ref={(r: TextareaRenderable) => {
                input = r
                publishPromptAccess({
                  read: () => input.plainText,
                  write: (t) => {
                    // Capture caret before replaceText (which resets it to 0,
                    // despite the d.ts comment about "preserves undo history"
                    // not extending to the cursor) and restore it after,
                    // clamped to new length. Sync runtime writes pair this
                    // with an explicit setCursor that overrides; async writes
                    // (Cycling/BlankFill script-result updates that don't
                    // pass a cursor) rely on the restore to keep cursor put.
                    const cBefore = input.cursorOffset ?? 0
                    input.replaceText(t)
                    setStore("prompt", "input", t)
                    input.cursorOffset = Math.min(cBefore, t.length)
                  },
                  cursor: () => input.cursorOffset ?? 0,
                  setCursor: (c) => { input.cursorOffset = c },
                  textarea: input,
                  syntax: useTheme().syntax() as any,
                })''',
    )
    src = src.replace(
      'onContentChange={() => {\n                const value = input.plainText\n                setStore("prompt", "input", value)',
      '''onContentChange={() => {
                const value = input.plainText
                setStore("prompt", "input", value)
                notifyOpenCuesTextChange(value, input.cursorOffset ?? 0, "user")
                triggerOpenCuesRender(value, input.cursorOffset ?? 0)''',
    )
# Add notifyOpenCuesCursorChange to the existing import if missing.
if 'notifyOpenCuesCursorChange' not in src:
    src = src.replace(
      'import { publishPromptAccess, notifyOpenCuesTextChange, triggerOpenCuesRender } from "../../opencues"',
      'import { publishPromptAccess, notifyOpenCuesTextChange, notifyOpenCuesCursorChange, triggerOpenCuesRender } from "../../opencues"',
    )
# Migration: setText → replaceText. setText is opentui's "clean slate"
# API that clears undo history; replaceText preserves it. Both reset
# the cursor (the cursor preservation lives in the next migration).
if 'input.setText(t)\n                    setStore' in src:
    src = src.replace(
      'write: (t) => {\n                    input.setText(t)\n                    setStore("prompt", "input", t)\n                  },',
      '''write: (t) => {
                    input.replaceText(t)
                    setStore("prompt", "input", t)
                  },''',
    )
# Migration: add cursor preservation around replaceText. opentui's
# replaceText resets the cursor to 0 in practice, regardless of what
# the d.ts hints about "preserves undo history". Capture+restore so
# async pushText (no follow-up setCursor) keeps cursor on the cycled
# word instead of snapping to 0.
if 'input.replaceText(t)\n                    setStore("prompt", "input", t)\n                  },' in src:
    src = src.replace(
      'input.replaceText(t)\n                    setStore("prompt", "input", t)\n                  },',
      '''const cBefore = input.cursorOffset ?? 0
                    input.replaceText(t)
                    setStore("prompt", "input", t)
                    input.cursorOffset = Math.min(cBefore, t.length)
                  },''',
    )
# Migration: strip the cursor tracer from installs that picked it up
# during the cursor-jumps debug session. The tracer served its purpose
# (root-caused replaceText resetting cursor) and is no longer needed
# in production. Idempotent: matches only when the trace block is
# present, no-op otherwise.
if 'OPENCUES_TRACE_CURSOR' in src:
    import re
    # Strip the if-block inside write() (after the Math.min cursor restore).
    src = re.sub(
        r'\n {20}if \(process\.env\.OPENCUES_TRACE_CURSOR.*?\n {20}\}',
        '',
        src,
        count=2,
        flags=re.DOTALL,
    )
    # Collapse the verbose setCursor body back to the one-liner.
    src = src.replace(
        '''setCursor: (c) => {
                    const before = input.cursorOffset ?? 0
                    input.cursorOffset = c
                  },''',
        'setCursor: (c) => { input.cursorOffset = c },',
    )
# Wire onCursorChange on the textarea so cursor-only moves (mouse click,
# arrow keys without typing) update the highlight when cursor-navigate
# is on. opentui's EditBufferRenderable exposes the prop directly.
if 'onCursorChange={' not in src:
    src = src.replace(
      'onContentChange={() => {\n                const value = input.plainText\n                setStore("prompt", "input", value)\n                notifyOpenCuesTextChange',
      '''onCursorChange={() => {
                notifyOpenCuesCursorChange(input.plainText, input.cursorOffset ?? 0, "user")
                triggerOpenCuesRender(input.plainText, input.cursorOffset ?? 0)
              }}
              onContentChange={() => {
                const value = input.plainText
                setStore("prompt", "input", value)
                notifyOpenCuesTextChange'''
    )
open(p, 'w').write(src)
PY
}

patch_footer_tsx() {
  local footer="$OPENCODE_DIR/packages/opencode/src/cli/cmd/tui/feature-plugins/home/footer.tsx"
  # Older OpenCode layouts don't ship this file — skip silently.
  [[ -f "$footer" ]] || return 0
  if grep -q "opencuesTip" "$footer"; then return 0; fi
  python3 - "$footer" <<'PY'
import sys
p = sys.argv[1]
src = open(p).read()
if 'opencuesTip' in src: sys.exit(0)
src = src.replace(
  'import { Global } from "@/global"',
  'import { Global } from "@/global"\nimport { opencuesTip } from "../../opencues"',
)
src = src.replace(
  '''function View(props: { api: TuiPluginApi }) {
  return (''',
  '''function OpencuesTip(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  return (
    <Show when={opencuesTip()}>
      <text fg={theme().textMuted}>{opencuesTip()}</text>
    </Show>
  )
}

function View(props: { api: TuiPluginApi }) {
  return (''',
)
src = src.replace(
  '''      <Mcp api={props.api} />
      <box flexGrow={1} />
      <Version api={props.api} />''',
  '''      <Mcp api={props.api} />
      <box flexGrow={1} />
      <OpencuesTip api={props.api} />
      <Version api={props.api} />''',
)
open(p, 'w').write(src)
PY
}

patch_fork() {
  local tui_dir="$OPENCODE_DIR/packages/opencode/src/cli/cmd/tui"
  cp "$SCRIPT_DIR/opencuesBootstrap.ts" "$tui_dir/opencues.ts"
  patch_app_tsx
  patch_prompt_tsx
  patch_footer_tsx
}

# ─── go ──────────────────────────────────────────────────────────────
echo "Target: $OPENCODE_DIR (opencode v$PINNED_VERSION)"

build_both() { build_runtime && build_core; }

# Install the fork's own dependencies via bun. Required so `bun run dev`
# can resolve @opentui/solid/preload etc. — without this step the first
# launch explodes with "preload not found". Idempotent: bun skips
# unchanged installs.
bun_install_fork() {
  ( cd "$OPENCODE_DIR" && bun install )
}

if [[ -d "$OPENCODE_DIR/packages/opencode" ]]; then
  echo "  ▸ Fork already present — reusing"
else
  run_step "Cloning sst/opencode (~250MB)" clone_fork
fi
run_step "Installing fork dependencies (bun install)" bun_install_fork
run_step "Building @opencues/{runtime,core}" build_both
run_step "Installing runtime + core into fork" install_into_fork
run_step "Patching fork (3 files + bootstrap)" patch_fork

echo ""
# Prefer the short form if `opencues` is on PATH; otherwise fall back
# to `pnpm exec` which always works from inside the clone.
if command -v opencues &>/dev/null; then
  echo "Done. Launch with: opencues run opencode"
else
  echo "Done. Launch with: pnpm exec opencues run opencode"
fi
