#!/usr/bin/env bash
# OpenCode integration setup — Phase O.0 + O.1.
#
# Clones sst/opencode at the pinned version into a working directory,
# applies the OpenCues bootstrap patch, and builds. Idempotent:
# re-runs sync the latest patch + rebuild without re-cloning.
#
# Usage: ./setup.sh [opencode-dir]
#   default opencode-dir: $HOME/opencode-cues

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCUES_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OPENCODE_DIR="${1:-$HOME/opencode-cues}"
PINNED_VERSION="1.4.11"
PINNED_SHA="5e9d5c7"

echo "=== OpenCues × OpenCode setup ==="
echo "Target: $OPENCODE_DIR"
echo "Pinned to opencode v$PINNED_VERSION ($PINNED_SHA)"

# 1. Clone or reuse the fork.
if [[ ! -d "$OPENCODE_DIR" ]]; then
  echo "Cloning sst/opencode..."
  git clone https://github.com/sst/opencode.git "$OPENCODE_DIR"
  cd "$OPENCODE_DIR"
  git checkout "$PINNED_SHA"
elif [[ ! -d "$OPENCODE_DIR/packages/opencode" ]]; then
  echo "Error: $OPENCODE_DIR exists but doesn't look like an opencode checkout."
  exit 1
else
  cd "$OPENCODE_DIR"
fi

# 2. Build opencues-runtime.
echo ""
echo "Building opencues-runtime..."
cd "$OPENCUES_ROOT/packages/opencues-runtime"
npm install --silent
npm run build

# 3. Wire opencues-runtime into the fork's node_modules.
#    Bun resolves from the same node_modules as npm, so a directory
#    copy is the simplest portable route.
echo "Installing opencues-runtime into fork..."
DEST="$OPENCODE_DIR/node_modules/opencues-runtime"
mkdir -p "$DEST"
cp -r "$OPENCUES_ROOT/packages/opencues-runtime/dist" "$DEST/"
cp "$OPENCUES_ROOT/packages/opencues-runtime/package.json" "$DEST/"

# 4. Copy the bootstrap patch into the fork's TUI source.
echo "Copying opencuesBootstrap.ts into fork..."
TUI_DIR="$OPENCODE_DIR/packages/opencode/src/cli/cmd/tui"
cp "$SCRIPT_DIR/opencuesBootstrap.ts" "$TUI_DIR/opencues.ts"

# 5. Apply edits to app.tsx and prompt/index.tsx.
#    These are sed-based for now; if the upstream files diverge enough
#    we'll switch to AST patching.
APP="$TUI_DIR/app.tsx"
PROMPT="$TUI_DIR/component/prompt/index.tsx"

if ! grep -q "startOpenCues" "$APP"; then
  echo "Patching app.tsx (mount bootstrap)..."
  # Add import after the @opentui/solid import line.
  python3 - "$APP" <<'PY'
import sys, re
p = sys.argv[1]
src = open(p).read()
if 'startOpenCues' in src: sys.exit(0)
inj = (
  '\nimport { startOpenCues, dispatchOpenCuesKey } from "./opencues"\n'
)
src = src.replace(
  'import { render, TimeToFirstDraw, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"',
  'import { render, TimeToFirstDraw, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"' + inj,
)
# Insert OpenCues bootstrap + keyboard forwarder. Stub prompt access at
# O.1 (just proves the seam fires); O.2 wires the real Prompt ref.
hook = '''
  // OpenCues bootstrap (Phase O.1 — stub prompt access).
  const __ocRenderer = useRenderer()
  onMount(() => {
    let __ocText = ""
    let __ocCursor = 0
    startOpenCues({
      renderer: __ocRenderer,
      promptAccess: {
        read: () => __ocText,
        write: (t) => { __ocText = t },
        cursor: () => __ocCursor,
        setCursor: (c) => { __ocCursor = c },
      },
      cwd: process.cwd(),
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
else
  echo "app.tsx already patched."
fi

# Note: prompt/index.tsx wiring (text-change forwarder + adapter readback)
# lands in O.2. Phase O.1 only mounts the runtime and proves the seam.

echo ""
echo "✓ Setup complete."
echo ""
echo "Next steps:"
echo "  cd $OPENCODE_DIR && bun install && bun run dev"
echo ""
echo "Watch /tmp/opencues.log for the boot line:"
echo "  [HH:MM:SS][info] OpenCues runtime starting (OpenCode v1.4)"
