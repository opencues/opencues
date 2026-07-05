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
# Adapter band = "v<major>.<minor>", e.g. "v1.4", "v1.14". The bootstrap
# import path templates this in so we can switch bands without touching
# bootstrap source (cross-minor bumps land a new band; we just bump pin
# and the install picks it up). Must match an existing directory under
# packages/opencues-runtime/adapters/oc/.
PINNED_BAND="v$(echo "$PINNED_VERSION" | awk -F. '{print $1 "." $2}')"

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
    # SHA-mismatch guard. The fork's HEAD must match pin.json. If it
    # doesn't, this is a version bump and the patched files + bootstrap
    # copy + node_modules entries from the previous version need to be
    # cleared out before `git checkout <new-sha>` will succeed cleanly.
    # That's `opencues uninstall opencode`'s job, not ours — failing loud
    # here keeps install.sh's blast radius tight (apply patches; never
    # touch the fork's git state).
    local current
    current=$(git rev-parse HEAD)
    if [[ "${current#$PINNED_SHA}" = "$current" ]]; then
      echo "" >&2
      echo "Fork SHA mismatch:" >&2
      echo "  $OPENCODE_DIR is at ${current:0:7}" >&2
      echo "  pin.json wants $PINNED_SHA" >&2
      echo "" >&2
      echo "This looks like a version bump. The pinned SHA changed but the" >&2
      echo "fork wasn't reset. Uninstall first, then re-run install:" >&2
      echo "  opencues uninstall opencode" >&2
      echo "  cd $OPENCODE_DIR && git fetch origin $PINNED_SHA && git checkout $PINNED_SHA && bun install" >&2
      echo "  opencues install opencode" >&2
      echo "" >&2
      echo "(See integrations/opencode/UPGRADING.md for the full workflow.)" >&2
      return 1
    fi
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
  # Clean any prior install — without this, a stale layout from an
  # earlier setup.sh run can silently shadow the new install. We
  # preserve the `dist/` subdirectory shape so that `package.json
  # main: "dist/index.js"` resolves cleanly. The old setup.sh
  # flattened `dist/*` into the package root which left main
  # pointing at a non-existent path — Node fell back to index.js at
  # root with a noisy DEP0128 deprecation warning on every launch.
  local core_dest="$OPENCODE_DIR/node_modules/@opencues/core"
  rm -rf "$core_dest"
  mkdir -p "$core_dest"
  cp -r "$OPENCUES_ROOT/packages/opencues-core/dist" "$core_dest/"
  cp "$OPENCUES_ROOT/packages/opencues-core/package.json" "$core_dest/"
  # node-http-adapter.js isn't compiled by tsc but Resolver requires it
  # at runtime; copy explicitly so LLM resolution doesn't silently die.
  if [[ -f "$OPENCUES_ROOT/packages/opencues-core/node-http-adapter.js" ]]; then
    cp "$OPENCUES_ROOT/packages/opencues-core/node-http-adapter.js" "$core_dest/dist/"
  fi

  # User-blank subprocess runner — Bun hosts can't load isolated-vm
  # in-process (V8 native binding vs JavaScriptCore). The runtime falls
  # back to spawning this CJS helper from ~/.opencues/vendor/ on the
  # first user-pack JS dispatch. CC + Gemini don't need this — their
  # in-process loader works — but it's harmless to install (no startup
  # cost; lazy-spawned on first need).
  install_user_blank_runner
}

# Copy the subprocess runner into ~/.opencues/vendor/ and seed a
# node_modules with isolated-vm so the runner can `require()` it. The
# vendor dir is shared across hosts (only one copy needed even if the
# user has CC + OC + shell all installed).
install_user_blank_runner() {
  local vendor_dir="$HOME/.opencues/vendor"
  local runner_src="$OPENCUES_ROOT/packages/opencues-runtime/dist/src/user-blanks/subprocess-runner.cjs"
  local runner_dst="$vendor_dir/user-blank-runner.cjs"
  local ivm_dst="$vendor_dir/node_modules/isolated-vm"
  local ivm_src="$OPENCUES_ROOT/node_modules/isolated-vm"

  if [[ ! -f "$runner_src" ]]; then
    # Source-build out-of-date copy fallback — runner is CJS, lives in src/.
    runner_src="$OPENCUES_ROOT/packages/opencues-runtime/src/user-blanks/subprocess-runner.cjs"
  fi
  if [[ ! -f "$runner_src" ]]; then
    echo "  ▸ subprocess-runner.cjs missing — skipping vendor install"
    return 0
  fi

  mkdir -p "$vendor_dir"
  cp "$runner_src" "$runner_dst"

  # isolated-vm: copy from the source workspace's already-installed
  # binding rather than re-running npm install (much faster, and
  # guarantees the exact same version the in-process loader would have
  # used on Node hosts).
  if [[ -d "$ivm_src" ]]; then
    mkdir -p "$vendor_dir/node_modules"
    if [[ ! -e "$ivm_dst" ]] || ! diff -rq "$ivm_src" "$ivm_dst" &>/dev/null; then
      rm -rf "$ivm_dst"
      cp -RL "$ivm_src" "$ivm_dst"
    fi
  else
    echo "  ▸ workspace isolated-vm not found at $ivm_src — vendor runner may fail at load time"
  fi
}

patch_app_tsx() {
  local app="$OPENCODE_DIR/packages/opencode/src/cli/cmd/tui/app.tsx"
  if grep -q "startOpenCues" "$app"; then return 0; fi
  OPENCUES_PINNED_VERSION="$PINNED_VERSION" python3 - "$app" <<'PY'
import os, sys
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
      cwd: process.env.OPENCUES_HOME || process.cwd(),
      hostVersion: "__OPENCUES_PINNED_VERSION__",
    })
  })
  useKeyboard((evt) => {
    if (dispatchOpenCuesKey(evt)) {
      evt.preventDefault?.()
      evt.stopPropagation?.()
    }
  })
'''.replace('__OPENCUES_PINNED_VERSION__', os.environ['OPENCUES_PINNED_VERSION'])
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
                    // opentui's setText AND replaceText both reset the
                    // cursor to 0 — neither d.ts entry promises cursor
                    // preservation. We capture cBefore and restore after
                    // so async writes that pass no cursor keep the prior
                    // position; the runtime's explicit setCursor (cycling,
                    // BlankFill repositioning) still overrides.
                    //
                    // We use setText (NOT replaceText) because OpenTUI's
                    // EditBuffer.replaceText registers a NEW mem buffer
                    // on every call without ever clearing the old one —
                    // the textBuffer registry is u16-bounded (~65k IDs)
                    // and overflows after a few minutes of cycling /
                    // blank-fill activity, throwing "Failed to register
                    // memory buffer" on every subsequent setText (silent
                    // dropped writes for the rest of the session). The
                    // earlier switch from setText to replaceText was
                    // motivated by undo-history preservation, but the
                    // tradeoff is unacceptable: programmatic writes from
                    // cycling / blank-fill / agent-rewrite happen often
                    // enough to fill the registry in normal use.
                    const cBefore = input.cursorOffset ?? 0
                    input.setText(t)
                    setStore("prompt", "input", t)
                    input.cursorOffset = Math.min(cBefore, t.length)
                    if (process.env.OPENCUES_TRACE_CURSOR !== "0") {
                      try {
                        const ts = new Date().toISOString().slice(11, 23)
                        require("fs").appendFileSync(
                          "/tmp/opencues-cursor-trace.log",
                          `[${ts}] promptAccess.write ${JSON.stringify({ len: t.length, cBefore, cAfter: input.cursorOffset ?? 0, preview: t.slice(0, 40) }).slice(0, 400)}\\n`,
                        )
                      } catch {}
                    }
                  },
                  cursor: () => input.cursorOffset ?? 0,
                  setCursor: (c) => {
                    const before = input.cursorOffset ?? 0
                    input.cursorOffset = c
                    if (process.env.OPENCUES_TRACE_CURSOR !== "0") {
                      try {
                        const ts = new Date().toISOString().slice(11, 23)
                        require("fs").appendFileSync(
                          "/tmp/opencues-cursor-trace.log",
                          `[${ts}] promptAccess.setCursor ${JSON.stringify({ request: c, before, after: input.cursorOffset ?? 0 }).slice(0, 400)}\\n`,
                        )
                      } catch {}
                    }
                  },
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
# Migration for installs patched with the leaky replaceText path.
# OpenTUI's EditBuffer.replaceText registers a NEW textBuffer mem-buffer
# on every call without ever clearing the old one; the registry is
# u16-bounded (~65k slots) and overflows after a few minutes of cycling /
# blank-fill activity, throwing "Failed to register memory buffer" on
# every subsequent setText (silent dropped writes for the rest of the
# session). setText caches a single memId and reuses it via
# replaceMemBuffer — no leak. We accept the loss of undo-history
# preservation for programmatic writes; user typing goes through the
# textarea's own key handlers, not promptAccess.write.
src = src.replace(
    'input.replaceText(t)\n                    setStore("prompt", "input", t)',
    'input.setText(t)\n                    setStore("prompt", "input", t)',
)
# Migration for installs that switched to replaceText but DIDN'T add
# cursor preservation. Cursor tracer revealed replaceText also resets
# cursor to 0 in opentui's actual implementation, despite the d.ts
# saying it preserves undo history. Capture+restore the cursor inside
# write() so async pushText (no follow-up setCursor) keeps the prior
# position. New write() body must include `input.cursorOffset = Math.min`.
if 'input.replaceText(t)\n                    setStore("prompt", "input", t)\n                  },' in src:
    src = src.replace(
      'input.replaceText(t)\n                    setStore("prompt", "input", t)\n                  },',
      '''const cBefore = input.cursorOffset ?? 0
                    input.replaceText(t)
                    setStore("prompt", "input", t)
                    input.cursorOffset = Math.min(cBefore, t.length)
                  },''',
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
  'import { Global } from "@/global"\nimport { opencuesTip, opencuesTutorial } from "../../opencues"',
)
src = src.replace(
  '''function View(props: { api: TuiPluginApi }) {
  return (''',
  '''function OpencuesTip(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  // Command spans (text the user should literally type/press) render in
  // the success colour + bold so they read as commands, not prose. The
  // step head goes error-coloured when the coach flags OFF_TRACK.
  const headFg = () => {
    const t = theme() as any
    return opencuesTutorial()!.offTrack ? (t.error ?? t.success) : t.success
  }
  return (
    <>
      <Show when={opencuesTutorial()}>
        <text>
          <span style={{ fg: theme().text, bold: true, reverse: true }}>C_</span>
          <span style={{ fg: headFg(), bold: true }}> {opencuesTutorial()!.head} </span>
          {opencuesTutorial()!.segments.map((seg) =>
            seg.command
              ? <span style={{ fg: theme().text, bold: true }}>{seg.text}</span>
              : <span style={{ fg: theme().textMuted }}>{seg.text}</span>,
          )}
        </text>
      </Show>
      <Show when={!opencuesTutorial() && opencuesTip()}>
        <text fg={theme().textMuted}>{opencuesTip()}</text>
      </Show>
    </>
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

patch_sidebar_footer_tsx() {
  # OpenCode's TUI has TWO footer surfaces:
  #   - feature-plugins/home/footer.tsx     → home_footer slot, rendered
  #     when the user is on the home route (composing the FIRST prompt)
  #   - feature-plugins/sidebar/footer.tsx  → sidebar_footer slot,
  #     rendered when the user is in a session view (any subsequent
  #     prompt input). Without patching BOTH, the OpenCues tip
  #     vanishes the moment the user submits their first prompt and
  #     starts a session — even though the prompt input is right there
  #     in the same window.
  local footer="$OPENCODE_DIR/packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/footer.tsx"
  [[ -f "$footer" ]] || return 0
  if grep -q "opencuesTip" "$footer"; then return 0; fi
  python3 - "$footer" <<'PY'
import sys
p = sys.argv[1]
src = open(p).read()
if 'opencuesTip' in src: sys.exit(0)
src = src.replace(
  'import { Global } from "@/global"',
  'import { Global } from "@/global"\nimport { opencuesTip, opencuesTutorial } from "../../opencues"',
)
# The sidebar footer's box stacks vertically (path → version). Insert
# the OpencuesTip line between them, mirroring the home footer's
# OpencuesTip block (Show-gated, textMuted styling).
src = src.replace(
  '''      <text>
        <span style={{ fg: theme().textMuted }}>{path().parent}/</span>
        <span style={{ fg: theme().text }}>{path().name}</span>
      </text>
      <text fg={theme().textMuted}>
        <span style={{ fg: theme().success }}>•</span> <b>Open</b>''',
  '''      <text>
        <span style={{ fg: theme().textMuted }}>{path().parent}/</span>
        <span style={{ fg: theme().text }}>{path().name}</span>
      </text>
      <Show when={opencuesTip()}>
        <text fg={theme().textMuted}>{opencuesTip()}</text>
      </Show>
      <text fg={theme().textMuted}>
        <span style={{ fg: theme().success }}>•</span> <b>Open</b>''',
)
open(p, 'w').write(src)
PY
}

patch_fork() {
  local tui_dir="$OPENCODE_DIR/packages/opencode/src/cli/cmd/tui"
  local band_dir="$OPENCUES_ROOT/packages/opencues-runtime/adapters/oc/$PINNED_BAND"
  if [[ ! -d "$band_dir" ]]; then
    echo "Adapter band '$PINNED_BAND' missing at $band_dir" >&2
    echo "(derived from pin.json version $PINNED_VERSION)" >&2
    echo "Either add a band directory or fix the pin." >&2
    return 1
  fi
  # Templated copy: substitute __OPENCUES_BAND__ with the resolved band
  # so the bootstrap imports from the right adapter directory.
  sed "s|__OPENCUES_BAND__|$PINNED_BAND|g" \
    "$SCRIPT_DIR/opencuesBootstrap.ts" > "$tui_dir/opencues.ts"
  patch_app_tsx
  patch_prompt_tsx
  patch_footer_tsx
  patch_sidebar_footer_tsx
}

# ─── go ──────────────────────────────────────────────────────────────
echo "Target: $OPENCODE_DIR (opencode v$PINNED_VERSION)"

build_both() { build_core && build_runtime; }

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
run_step "Patching fork (4 files + bootstrap)" patch_fork

echo ""
# Prefer the short form if `opencues` is on PATH; otherwise fall back
# to `pnpm exec` which always works from inside the clone.
if command -v opencues &>/dev/null; then
  echo "Done. Launch with: opencues run opencode"
else
  echo "Done. Launch with: pnpm exec opencues run opencode"
fi
