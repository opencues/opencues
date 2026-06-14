#!/usr/bin/env bash
# Gemini CLI integration setup.
#
# Clones google-gemini/gemini-cli at the pinned version, applies the
# OpenCues bootstrap patch, builds @opencues/{core,runtime}, and wires
# them in. Idempotent: re-runs sync the latest patch + rebuild without
# re-cloning.
#
# Usage: ./setup.sh [gemini-cli-dir] [--clean]
#   default gemini-cli-dir: $HOME/gemini-cli-cues
#   --clean: legacy alias — every install already runs from a clean
#            patched state (we re-apply patches on top of git-restored
#            sources), so the flag is a no-op kept for symmetry with
#            other host installers.
#
# Set OPENCUES_INSTALL_VERBOSE=1 to stream every command's output.
# Default is quiet — only progress lines + errors. Full log lives at
# the path printed on failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCUES_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
GEMINI_DIR=""
for arg in "$@"; do
  if [ "$arg" = "--clean" ]; then
    : # legacy alias — patches are always re-applied on top of clean sources
  elif [[ "$arg" != --* ]] && [ -z "$GEMINI_DIR" ]; then
    GEMINI_DIR="$arg"
  fi
done
GEMINI_DIR="${GEMINI_DIR:-$HOME/gemini-cli-cues}"
# Pin sourced from pin.json (structured) instead of inline vars, so
# `opencues update gemini-cli --to <version>` can rewrite it without
# regex'ing this script.
PIN_FILE="$OPENCUES_ROOT/integrations/gemini-cli/pin.json"
PINNED_VERSION=$(node -p "require('$PIN_FILE').version")
PINNED_SHA=$(node -p "require('$PIN_FILE').sha")

LOG="${OPENCUES_INSTALL_LOG:-/tmp/opencues-install-gemini.log}"
VERBOSE="${OPENCUES_INSTALL_VERBOSE:-0}"
: > "$LOG"

# ─── progress helpers (same shape as OC integration) ─────────────────
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
  if [[ -d "$GEMINI_DIR" ]]; then
    if [[ ! -d "$GEMINI_DIR/packages/cli" ]]; then
      echo "$GEMINI_DIR exists but is not a gemini-cli checkout" >&2
      return 1
    fi
    cd "$GEMINI_DIR"
    return 0
  fi
  git -c advice.detachedHead=false clone --quiet \
    https://github.com/google-gemini/gemini-cli.git "$GEMINI_DIR"
  cd "$GEMINI_DIR"
  git -c advice.detachedHead=false checkout --quiet "$PINNED_SHA"
}

build_runtime() {
  ( cd "$OPENCUES_ROOT" && pnpm --filter @opencues/runtime build )
}

build_core() {
  ( cd "$OPENCUES_ROOT" && pnpm --filter @opencues/core build )
}

install_into_fork() {
  # Runtime deps that npm install in the fork won't transitively
  # resolve (gemini doesn't list @opencues/runtime in its
  # package.json — we hot-copy the dist instead). Without these, the
  # user-blank loader's esm-rewrite.js (top-level `require('acorn-walk')`)
  # throws at module-load time and the host fails to boot whenever
  # any user-blank is registered. acorn alone is already a transitive
  # gemini dep, but acorn-walk isn't — install both to be safe across
  # version drift. `--no-save` keeps the fork's package.json untouched.
  #
  # Runs FIRST because npm install can prune "extraneous" packages
  # not in package.json — that includes our hot-copied
  # node_modules/@opencues/{core,runtime} from a prior run. By
  # ordering this BEFORE the cp steps below, the runtime/core copies
  # are guaranteed to survive.
  ( cd "$GEMINI_DIR" && npm install --no-save acorn acorn-walk >/dev/null 2>&1 )

  # @opencues/runtime
  local rt_dest="$GEMINI_DIR/node_modules/@opencues/runtime"
  rm -rf "$rt_dest"
  mkdir -p "$rt_dest"
  cp -r "$OPENCUES_ROOT/packages/opencues-runtime/dist" "$rt_dest/"
  cp "$OPENCUES_ROOT/packages/opencues-runtime/package.json" "$rt_dest/"

  # @opencues/core
  # Clean any prior install — without this, a stale layout from an
  # earlier setup.sh run can silently shadow the new install. We
  # preserve the `dist/` subdirectory shape (symmetric with runtime
  # above) so that `package.json main: "dist/index.js"` resolves
  # cleanly. The old setup.sh flattened `dist/*` into the package
  # root which left main pointing at a non-existent path — Node fell
  # back to index.js at root with a noisy DEP0128 deprecation warning
  # on every host launch.
  local core_dest="$GEMINI_DIR/node_modules/@opencues/core"
  rm -rf "$core_dest"
  mkdir -p "$core_dest"
  cp -r "$OPENCUES_ROOT/packages/opencues-core/dist" "$core_dest/"
  cp "$OPENCUES_ROOT/packages/opencues-core/package.json" "$core_dest/"
  # node-http-adapter.js isn't compiled by tsc but Resolver requires it
  # at runtime; copy explicitly so LLM resolution doesn't silently die.
  if [[ -f "$OPENCUES_ROOT/packages/opencues-core/node-http-adapter.js" ]]; then
    cp "$OPENCUES_ROOT/packages/opencues-core/node-http-adapter.js" "$core_dest/dist/"
  fi
}

# Drops the bootstrap into packages/cli/src/ui/opencues.ts. The
# AppContainer + InputPrompt + Footer patches import from `./opencues.js`
# (resolved by Gemini's TS build to `./opencues.ts`).
copy_bootstrap() {
  local ui_dir="$GEMINI_DIR/packages/cli/src/ui"
  cp "$SCRIPT_DIR/opencuesBootstrap.ts" "$ui_dir/opencues.ts"
}

# ─── 4 in-place patches: AppContainer, InputPrompt, Footer ───────────
patch_app_container() {
  local app="$GEMINI_DIR/packages/cli/src/ui/AppContainer.tsx"
  if grep -q "startOpenCues" "$app"; then return 0; fi
  python3 - "$app" <<'PY'
import sys
p = sys.argv[1]
src = open(p).read()
if 'startOpenCues' in src: sys.exit(0)

# 1. Add opencues import right after the InputContext import. Don't
#    add KeypressPriority — Gemini already imports it from
#    ./contexts/KeypressContext.js earlier in the file (the patch
#    used to add it too, producing a TS2300 duplicate-identifier
#    error). The injected hook below references the existing import.
src = src.replace(
  "import { InputContext } from './contexts/InputContext.js';",
  "import { InputContext } from './contexts/InputContext.js';\n"
  "import { startOpenCues, dispatchOpenCuesKey } from './opencues.js';",
)

# 2. Mount + key-bus subscription right after `const settings = useSettings();`
#    (anchor is unique inside AppContainer.tsx — matches the destructure
#    region at lines 225–230 of the v0.41.2 source).
hook = """
  // OpenCues bootstrap (G.1) — mount the runtime once on AppContainer
  // mount + intercept key events at Critical priority so we pre-empt
  // every other subscriber. Returning true from the handler stops
  // dispatch to lower-priority subscribers (matches the
  // KeypressContext broadcast loop semantics).
  useEffect(() => {
    startOpenCues({
      cwd: process.env['OPENCUES_HOME'] || process.cwd(),
      hostVersion: '0.41.x',
    });
  }, []);
  useKeypress(
    (key) => dispatchOpenCuesKey(key) === true,
    { isActive: true, priority: KeypressPriority.Critical },
  );
"""
src = src.replace(
  "const settings = useSettings();",
  "const settings = useSettings();\n" + hook.rstrip() + "\n",
  1,
)
open(p, 'w').write(src)
PY
}

patch_input_prompt() {
  local prompt="$GEMINI_DIR/packages/cli/src/ui/components/InputPrompt.tsx"
  if grep -q "publishPromptAccess" "$prompt"; then return 0; fi
  python3 - "$prompt" <<'PY'
import sys
p = sys.argv[1]
src = open(p).read()
if 'publishPromptAccess' in src: sys.exit(0)

# 1. Add opencues import right after the useInputState import (last
#    component-level import per v0.41.2).
src = src.replace(
  "import { useInputState } from '../contexts/InputContext.js';",
  "import { useInputState } from '../contexts/InputContext.js';\n"
  "import { publishPromptAccess, notifyOpenCuesTextChange, notifyOpenCuesCursorChange, decorateOpenCuesLine, consumePendingOpenCues, useOpenCuesRenderTick } from '../opencues.js';",
)

# 2. Publish prompt access + observe buffer changes. Anchor on the
#    end of the inputState destructure (lines 222–230 in v0.41.2). The
#    `isHelpDismissKey` line that follows is unique within InputPrompt.
src = src.replace(
  "  } = inputState;\n  const isHelpDismissKey = useIsHelpDismissKey();",
  """  } = inputState;
  const isHelpDismissKey = useIsHelpDismissKey();

  // OpenCues render-kick — registers a state-bumper the runtime calls
  // via host.forceRender() to schedule a React re-render. Without this,
  // navigation/cycling updates the runtime's hlState but no React tree
  // re-renders until the user moves the cursor or types.
  useOpenCuesRenderTick();
  // OpenCues — publish read/write/cursor access of the TextBuffer for
  // the runtime, and observe text + cursor for change notifications.
  // Buffer is a stable identity (via useTextBuffer) so the publish
  // useEffect runs once per mount; the watcher useEffect re-fires
  // whenever buffer.text or cursor offset change.
  useEffect(() => {
    publishPromptAccess({
      read: () => buffer.text,
      write: (t) => buffer.setText(t),
      cursor: () => logicalPosToOffset(buffer.lines, buffer.cursor[0], buffer.cursor[1]),
      setCursor: (c) => buffer.setText(buffer.text, c),
    });
    return () => publishPromptAccess(null);
  }, [buffer]);
  const __ocText = buffer.text;
  const __ocCursorOffset = logicalPosToOffset(buffer.lines, buffer.cursor[0], buffer.cursor[1]);
  useEffect(() => {
    notifyOpenCuesTextChange(__ocText, __ocCursorOffset, 'user');
  }, [__ocText]);
  useEffect(() => {
    notifyOpenCuesCursorChange(__ocText, __ocCursorOffset, 'user');
  }, [__ocCursorOffset]);
  // OpenCues pull-model render gate. Each render: pull pending
  // setText/setCursorOffset/forceRender state from the runtime; if
  // any, write it back (triggers another render → another consume
  // → stable). When only forceRender was queued, the returned text
  // is a ZWS-toggled version of current — different string, same
  // visible content, fires React's useEffect on buffer.text and
  // re-runs renderItem so dim/highlight directives apply.
  useEffect(() => {
    const __ocPending = consumePendingOpenCues(__ocText, __ocCursorOffset);
    if (__ocPending && (__ocPending.text !== __ocText || __ocPending.cursor !== __ocCursorOffset)) {
      buffer.setText(__ocPending.text, __ocPending.cursor);
    }
  });""",
  1,
)

# 3. Per-visual-line decoration — CC-equivalent approach.
#
# Mirrors how Claude Code's S3 patch handles dim/highlight: take the
# already-rendered ANSI string (with cursor inverse + per-segment
# colors baked in by the host's renderer), pass it through
# applyDirectives (which is ANSI-aware — preserves existing escapes
# while inserting dim/highlight at the correct visible offsets), then
# replace the rendered line with the decorated string.
#
# In CC, S3 wraps `renderedValue: HOST.render(...)`. In Gemini there's
# no single string to wrap — renderItem builds an array of <Text>
# elements. We emulate the same pattern by concatenating the
# per-segment displays (which already include the cursor inverse char
# from chalk.inverse() splicing) into one ANSI string, decorating
# that, then collapsing renderedLine to one <Text>{decorated}.
#
# Cursor preservation: the cursor inverse char IS part of the segment
# `display` strings (when cursor is mid-line). applyDirectives walks
# the ANSI string preserving every escape and inserting dim/highlight
# at the right visible offsets. The cursor renders normally because
# its inverse code survives the decoration pass.
#
# Loss: when decoration applies, syntax-highlighting colors per
# segment are lost (display has the text but no color ANSI; we'd need
# chalk.hex(color)(display) to preserve them, which requires per-color
# chalk routing). Acceptable for MVP — dim/highlight beats colored
# unhighlighted text.
old_seg_push = """        renderedLine.push(
          <Text key={`token-${segIdx}`} color={color}>
            {display}
          </Text>,
        );
      });"""
new_seg_push = """        __ocAnsiLine += display;
        renderedLine.push(
          <Text key={`token-${segIdx}`} color={color}>
            {display}
          </Text>,
        );
      });

      // OpenCues — CC-equivalent post-render decoration. The
      // accumulated __ocAnsiLine contains all segment displays
      // including cursor inverse char (when the cursor is on this
      // line, mid-segment). decorateOpenCuesLine runs applyDirectives
      // on it, which is ANSI-aware: it walks the string preserving
      // existing escapes (cursor inverse) and inserts dim/highlight
      // ANSI at the correct visible offsets.
      try {
        const __ocFullText = buffer.text;
        const __ocCursor = logicalPosToOffset(buffer.lines, buffer.cursor[0], buffer.cursor[1]);
        const __ocVisualCol = (mapEntry as unknown as [number, number?])[1] ?? 0;
        const __ocLineStart = logicalPosToOffset(buffer.lines, logicalLineIdx, __ocVisualCol);
        const __ocLineEnd = __ocLineStart + cpLen(lineText);
        const __ocDecorated = decorateOpenCuesLine(
          __ocAnsiLine,
          __ocFullText,
          __ocCursor,
          __ocLineStart,
          __ocLineEnd,
        );
        if (__ocDecorated !== __ocAnsiLine) {
          // Preserve Gemini's per-line base colour (theme.text.accent
          // on the cursor line, theme.text.primary elsewhere) on the
          // replacement <Text>. Without this, replacing the colored
          // per-segment array with a single uncolored <Text> drops
          // the line to terminal-default fg — symptom: "the line is
          // our alt word colour and the cue itself is dimmed".
          // The directive ANSI (\\x1b[2m dim, \\x1b[7m inverse) layers
          // on top of Ink's color attribute correctly because the
          // close codes (\\x1b[22m, \\x1b[27m) reset their own
          // attribute only, leaving Ink's wrapping fg intact.
          const __ocBaseColor = isOnCursorLine ? theme.text.accent : theme.text.primary;
          renderedLine.length = 0;
          renderedLine.push(
            <Text key="oc-decorated" color={__ocBaseColor}>{__ocDecorated}</Text>,
          );
        }
      } catch { /* swallow — leave per-segment rendering unchanged */ }"""
if old_seg_push in src:
  src = src.replace(old_seg_push, new_seg_push, 1)
else:
  print("WARN: InputPrompt segment-push anchor not found — line decoration NOT applied.", file=sys.stderr)
  print("      Cycling + key dispatch + footer tip still work; visual dim won't.", file=sys.stderr)

# Initialize __ocAnsiLine before the segment loop. Anchor on the
# unique `let charCount = 0;` that immediately precedes the loop.
src = src.replace(
  "let charCount = 0;\n      segments.forEach",
  "let charCount = 0;\n      let __ocAnsiLine = '';\n      segments.forEach",
  1,
)

open(p, 'w').write(src)
PY
}

patch_footer() {
  local footer="$GEMINI_DIR/packages/cli/src/ui/components/Footer.tsx"
  if grep -q "useOpenCuesTip" "$footer"; then return 0; fi
  python3 - "$footer" <<'PY'
import sys
p = sys.argv[1]
src = open(p).read()
if 'useOpenCuesTip' in src: sys.exit(0)

# 1. Import — append after the last footerItems import (unique anchor
#    that ends the import block per v0.41.2).
src = src.replace(
  "import { isDevelopment } from '../../utils/installationInfo.js';",
  "import { isDevelopment } from '../../utils/installationInfo.js';\n"
  "import { useOpenCuesTip } from '../opencues.js';",
)

# 2. Insert the useOpenCuesTip() hook call + addCol injection. Anchor
#    on the unique transients comment so we land between the existing
#    transient indicators and the width-fitting block. Hook MUST run
#    at the top of the Footer body (we anchor immediately before
#    "// 3. Transients"); the addCol then runs in flow order.
src = src.replace(
  "  // 3. Transients\n",
  """  // OpenCues tip — populated by the runtime's statusSnapshotHook
  // (see opencues.ts startOpenCues). Re-renders only when the tip
  // string actually changes (deduped at the publish step).
  const __ocTip = useOpenCuesTip();

  // 3. Transients
""",
  1,
)
src = src.replace(
  """  if (showErrorSummary) {
    addCol(
      'error-count',
      '',
      () => <ConsoleSummaryDisplay errorCount={errorCount} />,
      12,
      true,
    );
  }""",
  """  if (showErrorSummary) {
    addCol(
      'error-count',
      '',
      () => <ConsoleSummaryDisplay errorCount={errorCount} />,
      12,
      true,
    );
  }
  if (__ocTip) {
    addCol('opencues-tip', '', () => <Text>{__ocTip}</Text>, __ocTip.length);
  }""",
  1,
)
open(p, 'w').write(src)
PY
}

patch_esbuild_config() {
  local cfg="$GEMINI_DIR/esbuild.config.js"
  # Mark @opencues/{core,runtime} as external so esbuild leaves the
  # imports in place instead of trying to bundle them. Both packages
  # live in node_modules at runtime — bundling would force esbuild to
  # resolve every dist/.../*.js subpath at build time, which it can't
  # for our path-style imports (the install path's tsc handles them
  # under nodenext but esbuild needs them external). Without this the
  # bundle step fails with "Could not resolve
  # @opencues/runtime/dist/...".
  if grep -q "'@opencues/runtime'" "$cfg"; then return 0; fi
  python3 - "$cfg" <<'PY'
import sys, re
p = sys.argv[1]
src = open(p).read()
if "'@opencues/runtime'" in src: sys.exit(0)
src = re.sub(
  r"(const external = \[)",
  r"\1\n  '@opencues/core',\n  '@opencues/runtime',",
  src, count=1,
)
open(p, 'w').write(src)
PY
}

patch_fork() {
  copy_bootstrap
  patch_app_container
  patch_input_prompt
  patch_footer
  patch_esbuild_config
}

# Build the fork itself so the patched .tsx files get compiled into
# packages/cli/dist/. Without this step, the `gemini` bin (which runs
# `node packages/cli/dist/index.js`) executes pre-patch sources.
build_fork() {
  ( cd "$GEMINI_DIR" && npm run build )
}

# Install fork dependencies via npm. Required so `npm run build` can
# resolve all the gemini-cli internals (ink, react, etc.) and so our
# build_fork step compiles cleanly. Idempotent: npm skips unchanged.
npm_install_fork() {
  ( cd "$GEMINI_DIR" && npm install --no-audit --no-fund )
}

# ─── prerequisites ────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "Error: Node.js is not installed. Gemini CLI requires Node 22+." >&2
  exit 1
fi
NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Error: Node.js 22+ required (found $(node --version))." >&2
  exit 1
fi

# ─── go ──────────────────────────────────────────────────────────────
echo "Target: $GEMINI_DIR (gemini-cli v$PINNED_VERSION)"

build_both() { build_runtime && build_core; }

if [[ -d "$GEMINI_DIR/packages/cli" ]]; then
  echo "  ▸ Fork already present — reusing"
else
  run_step "Cloning google-gemini/gemini-cli (~120MB)" clone_fork
fi
run_step "Installing fork dependencies (npm install)" npm_install_fork
run_step "Building @opencues/{runtime,core}" build_both
run_step "Installing runtime + core into fork" install_into_fork
run_step "Patching fork (3 files + bootstrap)" patch_fork
run_step "Building fork (npm run build)" build_fork

echo ""
if command -v opencues &>/dev/null; then
  echo "Done. Launch with: opencues run gemini-cli"
else
  echo "Done. Launch with: pnpm exec opencues run gemini-cli"
fi
