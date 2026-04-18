#!/usr/bin/env bash
# Advance the opencues fork to a target commit + reapply the patch.
#
# Usage: ./advance.sh <commit-sha>
#   e.g.  ./advance.sh 97fe5dd  # → end of O.3
#         ./advance.sh 6d57e3f  # → end of O.4
#         ./advance.sh 0a1a9fd  # → end of O.5+O.6
#         ./advance.sh f5324c9  # → end of O.7
#         ./advance.sh 7b4e997  # → end of O.8 (latest)

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <commit-sha>" >&2
  echo "" >&2
  echo "Phase commits (from integrations/opencode/reintegration/O-review.md):" >&2
  echo "  ad6ff0e / f4d088b  → O.2 + backfill" >&2
  echo "  91e47f7 / 97fe5dd  → O.3 + backfill" >&2
  echo "  db27817 / 6d57e3f  → O.4 + backfill" >&2
  echo "  da46931 / 0a1a9fd  → O.5 + O.6 + backfill" >&2
  echo "  4078e94 / f5324c9  → O.7 + backfill" >&2
  echo "  6fc4b24 / 7b4e997  → O.8 + backfill" >&2
  exit 1
fi

TARGET="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCUES_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OPENCODE_DIR="${OPENCODE_DIR:-$HOME/opencode-cues}"

echo "=== Advance to $TARGET ==="
cd "$OPENCUES_ROOT"
git reset --hard "$TARGET"

# Apply live-fixes that were discovered during testing AFTER the
# original commits landed. These rewrite three files to fix bugs that
# would otherwise re-surface on every advance:
#
#   1. adapter.ts — onKey ignored its filter (every key triggered
#      every handler → can only type one char before nav swallows).
#   2. setup.sh   — `useTheme().syntax` is a SolidJS memo, not the
#      SyntaxStyle instance. Need the call: `useTheme().syntax()`.
#   3. opencuesBootstrap.ts — extmark API is `.delete(id)` not
#      `.remove(id)`. Old highlights stacked without this.
echo ""
echo "Applying live-fixes (filter wrap, syntax(), extmarks.delete)..."
ADAPTER="$OPENCUES_ROOT/packages/opencues-runtime/adapters/opencode/v1.4/adapter.ts"
BOOT="$OPENCUES_ROOT/packages/opencues-runtime/adapters/opencode/v1.4/boot.ts"
BOOTSTRAP="$SCRIPT_DIR/opencuesBootstrap.ts"
SETUP="$SCRIPT_DIR/setup.sh"

# 1. Filter wrap in adapter.ts (only if the broken line still exists).
if grep -q "onKey(_filter: KeyFilter | null" "$ADAPTER"; then
python3 - "$ADAPTER" <<'PY'
import sys
p = sys.argv[1]
src = open(p).read()
src = src.replace(
  '''  // ─── Events ────────────────────────────────────────────────────────────
  onKey(_filter: KeyFilter | null, handler: (e: KeyEvent) => boolean): Unsubscribe {
    // Filtering happens runtime-side in boot for now (CC pattern).
    return this.bindings.registerKeyHandler(handler);
  }''',
  '''  // ─── Events ────────────────────────────────────────────────────────────
  onKey(filter: KeyFilter | null, handler: (e: KeyEvent) => boolean): Unsubscribe {
    if (!filter) return this.bindings.registerKeyHandler(handler);
    const wrapped = (e: KeyEvent): boolean => {
      if (filter.keys && filter.keys.length > 0 && !filter.keys.includes(e.key)) return false;
      if (filter.requireModifiers) for (const m of filter.requireModifiers) if (!e.modifiers[m]) return false;
      if (filter.forbidModifiers) for (const m of filter.forbidModifiers) if (e.modifiers[m]) return false;
      return handler(e);
    };
    return this.bindings.registerKeyHandler(wrapped);
  }''',
)
open(p, 'w').write(src)
PY
fi

# 2. syntax() call in setup.sh.
sed -i 's|syntax: useTheme().syntax as any|syntax: useTheme().syntax() as any|' "$SETUP" || true

# 3. extmarks.delete in opencuesBootstrap.ts.
sed -i 's|(textarea.extmarks as any).remove?.(id)|(textarea.extmarks as any).delete?.(id)|' "$BOOTSTRAP" || true

# 4. cwd: must point at the opencues config root, not the TUI's cwd.
#    The TUI runs from ~/opencode-cues but cues + folder controls live
#    at ~/opencues. Without this, ConfigLoader.load returns no controls
#    and Cycling can't find any.
sed -i 's@cwd: process.cwd()@cwd: process.env.OPENCUES_HOME || "/home/wilfred/opencues"@' "$SETUP" || true

# 5. Tag runtime-driven setText so onContentChange routes the right
#    source. Without this, Cycling.setText fires onContentChange →
#    notifyOpenCuesTextChange("user") → Navigation clears highlight.
if ! grep -q "lastRuntimeSetText" "$BOOTSTRAP"; then
python3 - "$BOOTSTRAP" <<'PY'
import sys
p = sys.argv[1]
src = open(p).read()
if 'lastRuntimeSetText' in src: sys.exit(0)
src = src.replace(
  'let bootResult: BootResult | undefined',
  'let bootResult: BootResult | undefined\nlet lastRuntimeSetText: string | null = null',
)
src = src.replace(
  'setText: (text) => opts.promptAccess.write(text),',
  'setText: (text) => { lastRuntimeSetText = text; opts.promptAccess.write(text) },',
)
src = src.replace(
  '''export function notifyOpenCuesTextChange(text: string, cursor: number, source: "user" | "runtime" = "user"): void {
  bootResult?.notifyTextChange(text, cursor, source)
}''',
  '''export function notifyOpenCuesTextChange(text: string, cursor: number, source: "user" | "runtime" = "user"): void {
  let actualSource = source
  if (lastRuntimeSetText !== null && text === lastRuntimeSetText) {
    actualSource = "runtime"
    lastRuntimeSetText = null
  }
  bootResult?.notifyTextChange(text, cursor, actualSource)
}''',
)
open(p, 'w').write(src)
PY
fi


# 6. Resolver must subscribe AFTER ConfigLoader.load resolves — otherwise
#    rebuildResolver runs with no cuesConfig/blanksConfig and bails with
#    "Resolver: no cuesConfig/blanksConfig, skipping build". Mirrors the
#    CC v2.1 boot pattern. Only applies once Resolver is wired (≥ O.7).
if grep -q "resolver.subscribe();" "$BOOT" && ! grep -q "configLoader.load().then(() => resolver.subscribe())" "$BOOT"; then
python3 - "$BOOT" <<'PY'
import sys
p = sys.argv[1]
src = open(p).read()
old = '''    });
    resolver.subscribe();
  }'''
new = '''    });
    // Subscribe AFTER ConfigLoader.load — otherwise rebuildResolver sees
    // no cuesConfig/blanksConfig and bails. Mirrors CC v2.1 boot.
    configLoader.load().then(() => resolver.subscribe()).catch(() => { /* logged by ConfigLoader */ });
  }'''
if old in src:
  src = src.replace(old, new)
  open(p, 'w').write(src)
PY
fi

# 7. setup.sh must also copy cues-core/node-http-adapter.js — it's a
#    standalone CommonJS file at the cues-core package root (not under
#    dist/), and Resolver does require('cues-core/node-http-adapter')
#    at runtime. Without this copy, NodeHttpAdapter load fails and LLM
#    resolution silently dies. Idempotent: only injects if absent.
if ! grep -q "node-http-adapter.js" "$SETUP"; then
python3 - "$SETUP" <<'PY'
import sys
p = sys.argv[1]
src = open(p).read()
old = 'cp "$OPENCUES_ROOT/packages/cues-core/package.json" "$CUES_CORE_DEST/"'
new = '''cp "$OPENCUES_ROOT/packages/cues-core/package.json" "$CUES_CORE_DEST/"
# Standalone files not compiled by tsc (e.g. node-http-adapter.js).
# Resolver does `require('cues-core/node-http-adapter')` — without this
# copy the require fails at runtime and LLM resolution silently dies.
[ -f "$OPENCUES_ROOT/packages/cues-core/node-http-adapter.js" ] && \\
  cp "$OPENCUES_ROOT/packages/cues-core/node-http-adapter.js" "$CUES_CORE_DEST/"'''
if old in src and 'node-http-adapter.js' not in src:
  src = src.replace(old, new)
  open(p, 'w').write(src)
PY
fi

# 8. opencuesBootstrap.ts must expose pushText to the host. BlankFill
#    relies on adapter.pushText to land async script results back into
#    the textarea — without it scripts run, return data, and the value
#    silently never appears. Mirrors setText plumbing + cursor reposition.
if ! grep -q "pushText:" "$BOOTSTRAP"; then
python3 - "$BOOTSTRAP" <<'PY'
import sys
p = sys.argv[1]
src = open(p).read()
old = '''    setText: (text) => { lastRuntimeSetText = text; opts.promptAccess.write(text) },
    setCursorOffset: (offset) => opts.promptAccess.setCursor(offset),
    forceRender: () => opts.renderer.requestRender(),'''
new = '''    setText: (text) => { lastRuntimeSetText = text; opts.promptAccess.write(text) },
    setCursorOffset: (offset) => opts.promptAccess.setCursor(offset),
    // BlankFill needs pushText to deposit async script results back into
    // the prompt. Same plumbing as setText + cursor reposition.
    pushText: (text: string, cursor?: number) => {
      lastRuntimeSetText = text
      opts.promptAccess.write(text)
      if (cursor !== undefined) opts.promptAccess.setCursor(cursor)
    },
    forceRender: () => opts.renderer.requestRender(),'''
if old in src and 'pushText:' not in src:
  src = src.replace(old, new)
  open(p, 'w').write(src)
PY
fi

# Sanity check: every fix MUST be present after the patches. If we
# advance past a commit that introduced new patterns the sed/python
# rules don't recognise, fail loudly instead of producing a silently-
# broken build.
verify() {
  local file="$1" expect="$2" name="$3"
  if ! grep -qF "$expect" "$file"; then
    echo "" >&2
    echo "✗ FIX MISSING after advance: $name" >&2
    echo "  expected substring not found in $file" >&2
    echo "  search: $expect" >&2
    echo "  this means the patch rule didn't match — STOPPING before" >&2
    echo "  you build a regressed runtime. Inspect the file and update" >&2
    echo "  advance.sh's fix block." >&2
    exit 2
  fi
  echo "  ✓ $name"
}
echo ""
echo "Verifying live-fixes survived the advance..."
# Each verify is gated on the feature it fixes being present at this commit.
# Earlier phases legitimately don't have the target code — silently skipping
# keeps the harness usable for walking history while still catching real rot.
verify "$ADAPTER" "if (!filter) return this.bindings.registerKeyHandler(handler);" "filter wrap (adapter.ts)"
# LF-2 / LF-3 / LF-5 are for prompt+extmark code that lands in O.4 (prompt
# patch in setup.sh; extmark applier + lastRuntimeSetText in bootstrap).
if grep -q "publishPromptAccess" "$SETUP"; then
  verify "$SETUP" "useTheme().syntax() as any" "syntax() call (setup.sh)"
fi
if grep -q "textarea.extmarks" "$BOOTSTRAP"; then
  verify "$BOOTSTRAP" "(textarea.extmarks as any).delete?.(id)" "extmarks.delete (opencuesBootstrap.ts)"
fi
if grep -q "startOpenCues" "$SETUP"; then
  verify "$SETUP" "process.env.OPENCUES_HOME" "cwd→OPENCUES_HOME (setup.sh)"
fi
if grep -q "notifyOpenCuesTextChange" "$BOOTSTRAP"; then
  verify "$BOOTSTRAP" "lastRuntimeSetText" "runtime-source tagging (opencuesBootstrap.ts)"
fi
# LF-6 only applies once Resolver is wired (O.7+).
if grep -q "const resolver = new Resolver" "$BOOT"; then
  verify "$BOOT" "configLoader.load().then(() => resolver.subscribe())" "resolver subscribe-after-load (boot.ts)"
fi
# LF-7 needs cues-core install block (landed when ConfigLoader did, O.5).
if grep -q "cues-core/dist" "$SETUP"; then
  verify "$SETUP" "node-http-adapter.js" "cues-core node-http-adapter copy (setup.sh)"
fi
# LF-8 needs the bootstrap's boot() bindings object (from O.2).
if grep -q "setText:" "$BOOTSTRAP"; then
  verify "$BOOTSTRAP" "pushText:" "pushText binding (opencuesBootstrap.ts)"
fi

echo ""
echo "Rebuilding opencues-runtime (clean — tsc incremental cache lies)..."
( cd "$OPENCUES_ROOT/packages/opencues-runtime" \
  && rm -rf dist \
  && npm run build )
echo ""
echo "Reverting fork patches + reapplying..."
( cd "$OPENCODE_DIR" \
  && git checkout packages/opencode/src/cli/cmd/tui/app.tsx packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx 2>/dev/null \
  && rm -f packages/opencode/src/cli/cmd/tui/opencues.ts \
  && rm -rf node_modules/opencues-runtime/dist node_modules/cues-core )
"$SCRIPT_DIR/setup.sh" "$OPENCODE_DIR"
echo ""
echo "✓ Now at $(git log --oneline -1)"
echo ""
echo "Test: cd $OPENCODE_DIR && bun run dev"
echo "Logs: tail -f /tmp/opencues.log"
echo "Review: $OPENCUES_ROOT/integrations/opencode/reintegration/O-review.md"
