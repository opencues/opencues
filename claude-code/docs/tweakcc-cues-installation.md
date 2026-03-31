---
last_updated: 2026-03-31
---

# tweakcc + cues-core Installation Guide

Complete installation guide for adding LLM-powered word alternatives to Claude Code.

---

## What You Get

After installation:
- **Word navigation** — Ctrl+Alt+Left/Right to highlight words
- **Number increment** — Ctrl+Alt+Up/Down on numbers
- **Gender flip** — "boy" ↔ "girl", "he" ↔ "she"
- **LLM alternatives** — words dim gray when alternatives available, cycle with Up/Down
- **Fill-in-the-blank** — type `_` for LLM to suggest completions
- **Action words** — "volume" triggers system volume control

---

## Prerequisites

| Requirement | Check |
|-------------|-------|
| Node.js 18+ | `node --version` |
| npm | `npm --version` |
| Claude Code installed | `which claude` |
| Groq API key | [console.groq.com](https://console.groq.com) |

---

## Quick Install (Recommended)

```bash
# 1. Clone cues-system
git clone https://github.com/wkasekende/cues-system ~/cues-system

# 2. Run setup (does everything)
~/cues-system/packages/cues-patches/setup.sh

# 3. Set API key (add to ~/.bashrc for persistence)
export GROQ_API_KEY="your-key"

# 4. Restart Claude Code
claude
```

That's it! The setup script:
- Clones tweakcc from upstream
- Installs dependencies
- Patches source files (types.ts, defaultSettings.ts, index.ts)
- Builds cues-core and installs to ~/.claude/node_modules/
- Copies tips file and action scripts
- Builds tweakcc and applies patches to Claude Code

---

## Manual Installation

If the setup script doesn't work, follow these detailed steps:

### Step 1: Clone Base tweakcc

```bash
cd ~
git clone https://github.com/anthropics/tweakcc
cd tweakcc
npm install
```

Verify base tweakcc works:
```bash
npm run build
node dist/index.mjs --help
```

---

### Step 2: Get Custom Patches

Clone the cues-system repo:
```bash
cd ~
git clone https://github.com/wkasekende/cues-system
```

Copy patch files:
```bash
CUES_PATCHES=~/cues-system/packages/cues-patches

cp $CUES_PATCHES/cursorStateExport.ts ~/tweakcc/src/patches/
cp $CUES_PATCHES/wordHighlight.ts ~/tweakcc/src/patches/
cp $CUES_PATCHES/dynamicHighlight.ts ~/tweakcc/src/patches/
```

You should now have these files in `~/tweakcc/src/patches/`:
- `cursorStateExport.ts`
- `wordHighlight.ts`
- `dynamicHighlight.ts`

---

## Step 3: Modify tweakcc Source Files

### 3a. Add Type Definitions

Open `~/tweakcc/src/types.ts` and add to the `MiscSettings` interface:

```typescript
// Word highlight settings
enableWordHighlight?: boolean;
highlightMode?: 'numbers' | 'words' | 'gender' | 'both';

// Dynamic highlight settings
enableDynamicHighlight?: boolean;
dynamicHighlightDebounceMs?: number;

// Cursor state export
enableCursorStateExport?: boolean;
cursorStateExportPath?: string;

// Action word overrides
actionWordOverrides?: Record<string, { script: string }>;
```

### 3b. Add Default Settings

Open `~/tweakcc/src/defaultSettings.ts` and add to the `misc` object:

```typescript
// Word highlight
enableWordHighlight: true,
highlightMode: 'both',

// Dynamic highlight
enableDynamicHighlight: true,
dynamicHighlightDebounceMs: 300,

// Cursor state export
enableCursorStateExport: true,
cursorStateExportPath: '/tmp/claude-cursor-state.json',

// Action word overrides
actionWordOverrides: {
  volume: { script: '~/.claude/actions/volume.sh' }
},
```

### 3c. Add Integration Code

Open `~/tweakcc/src/patches/index.ts` and add at the top with other imports:

```typescript
import { writeCursorStateExport } from './cursorStateExport';
import { writeWordHighlight } from './wordHighlight';
import { writeDynamicHighlight } from './dynamicHighlight';
```

Inside the `applyCustomization()` function, before the final file write, add:

```typescript
// Apply custom patches
if (config.misc?.enableCursorStateExport) {
  source = writeCursorStateExport(source, config);
}

if (config.misc?.enableWordHighlight) {
  source = writeWordHighlight(source, config);
}

if (config.misc?.enableDynamicHighlight) {
  source = writeDynamicHighlight(source, config);
}
```

---

## Step 4: Install cues-core

Build from source (not yet on npm):

```bash
cd ~/cues-system/packages/cues-core
npm install
npm run build

# Copy to Claude's node_modules
mkdir -p ~/.claude/node_modules/cues-core
cp dist/*.js dist/*.d.ts ~/.claude/node_modules/cues-core/
cp -r dist/sources ~/.claude/node_modules/cues-core/

# Create package.json
cat > ~/.claude/node_modules/cues-core/package.json << 'EOF'
{
  "name": "cues-core",
  "version": "1.0.0",
  "main": "index.js",
  "types": "index.d.ts"
}
EOF
```

Verify:
```bash
node -e "require(process.env.HOME+'/.claude/node_modules/cues-core'); console.log('OK')"
```

---

## Step 5: Set Up Tips File (Optional)

Copy the tips file from cues-patches:

```bash
cp $CUES_PATCHES/claude-code-tips.json ~/.claude/
```

Or create your own `~/.claude/claude-code-tips.json`:

```json
{
  "groups": {
    "function": {
      "members": ["function", "method", "procedure", "routine"],
      "tip": "A reusable block of code",
      "alts": ["class", "module"]
    }
  },
  "words": {
    "async": {
      "tip": "Marks a function as asynchronous",
      "alts": ["sync", "blocking"]
    }
  }
}
```

Tips provide instant (~0ms) alternatives without LLM calls.

---

## Step 6: Set Up Action Scripts (Optional)

Copy action scripts from cues-patches:

```bash
mkdir -p ~/.claude/actions
cp $CUES_PATCHES/actions/* ~/.claude/actions/
chmod +x ~/.claude/actions/*.sh
```

---

## Step 7: Set API Key

Add to your shell profile (`~/.bashrc` or `~/.zshrc`):

```bash
export GROQ_API_KEY="your-groq-api-key"
```

Reload:
```bash
source ~/.bashrc  # or ~/.zshrc
```

---

## Step 8: Build and Apply

```bash
cd ~/tweakcc
npm run build

# Find your Claude Code cli.js
CLI_JS=$(find ~/.claude -name "cli.js" -path "*claude-code*" | head -1)
echo "Found: $CLI_JS"

# Apply patches
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply

# Verify syntax
node --check "$CLI_JS"
```

No output from `node --check` means success.

---

## Step 9: Verify Installation

```bash
CLI_JS=$(find ~/.claude -name "cli.js" -path "*claude-code*" | head -1)

# Check each feature
grep -q 'claude-cursor-state.json' "$CLI_JS" && echo "✓ Cursor export"
grep -c '_hlState' "$CLI_JS" | xargs -I{} sh -c '[ {} -gt 50 ] && echo "✓ Word highlight"'
grep -c '_dynDefs' "$CLI_JS" | xargs -I{} sh -c '[ {} -gt 5 ] && echo "✓ Dynamic highlight"'
grep -q '_cuesCore' "$CLI_JS" && echo "✓ cues-core wiring"
```

---

## Step 10: Test Features

Start Claude Code:
```bash
claude
```

Test each feature:

| Test | Expected |
|------|----------|
| Type `42`, press Ctrl+Alt+Left, then Ctrl+Alt+Up | Number becomes `43` |
| Type `the boy ran`, navigate to "boy", press Up | Becomes `the girl ran` |
| Type any sentence, wait 500ms | Words with alternatives turn gray |
| Navigate to gray word, press Up | Word cycles to alternative |
| Type `The capital of France is _` | Blank fills with "Paris" |

---

## Troubleshooting

### "Cannot find module 'cues-core'"

cues-core not installed. Rebuild and copy from source:
```bash
cd ~/cues-system/packages/cues-core
npm run build
cp dist/*.js dist/*.d.ts ~/.claude/node_modules/cues-core/
```

### Words don't turn gray

1. Check API key is set: `echo $GROQ_API_KEY`
2. Check cues-core is working: `node -e "require(process.env.HOME+'/.claude/node_modules/cues-core')"`
3. Check debug logs: `DEBUG=cues* claude`

### Syntax error after patching

Restore from backup and re-apply:
```bash
cp ~/.tweakcc/cli.js.backup "$CLI_JS"
cd ~/tweakcc && npm run build
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply
```

### Patches don't apply (pattern not found)

Claude Code updated and minified names changed. Check pattern matching:
```bash
grep '_hlState' "$CLI_JS"  # Should find matches
```

If no matches, patterns in patch files need updating for the new version.

---

## Updating

When Claude Code updates:

```bash
# Re-apply patches
cd ~/tweakcc
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply

# Verify
node --check "$CLI_JS"
```

When cues-system updates:

```bash
cd ~/cues-system && git pull

# Update patches
CUES_PATCHES=~/cues-system/packages/cues-patches
cp $CUES_PATCHES/*.ts ~/tweakcc/src/patches/

# Rebuild cues-core
cd ~/cues-system/packages/cues-core
npm run build
cp dist/*.js dist/*.d.ts ~/.claude/node_modules/cues-core/

# Rebuild and apply tweakcc
cd ~/tweakcc && npm run build
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node dist/index.mjs --apply
```

---

## Quick Reference

| Command | Purpose |
|---------|---------|
| `npm run build` | Rebuild tweakcc after changes |
| `node dist/index.mjs --apply` | Apply patches to cli.js |
| `node --check "$CLI_JS"` | Verify syntax after patching |
| `cp ~/.tweakcc/cli.js.backup "$CLI_JS"` | Restore original cli.js |

| Env Variable | Purpose |
|--------------|---------|
| `GROQ_API_KEY` | API key for LLM calls |
| `TWEAKCC_CC_INSTALLATION_PATH` | Override cli.js location |
| `DEBUG=cues*` | Enable debug logging |

| File | Purpose |
|------|---------|
| `~/.claude/node_modules/cues-core/` | LLM analysis module |
| `~/.claude/claude-code-tips.json` | Per-word tips (optional) |
| `~/.claude/actions/*.sh` | Action word scripts (optional) |
| `~/.tweakcc/cli.js.backup` | Backup of original cli.js |

---

## Summary

```
1. Clone base tweakcc          → ~/tweakcc
2. Clone cues-system           → ~/cues-system
3. Copy patches from cues-patches → ~/tweakcc/src/patches/
4. Edit types/defaults/index   → 3 files modified
5. Build cues-core from source → ~/.claude/node_modules/cues-core/
6. Set GROQ_API_KEY            → ~/.bashrc
7. npm run build && --apply    → patches applied
8. Restart Claude Code         → features active
```

Total time: ~10 minutes (assuming API key already obtained).
