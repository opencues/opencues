# tweakcc Setup Notes

Steps to configure tweakcc from a fresh clone for OpenCues development.
tweakcc lives at `integrations/claude-code/tweakcc/` (gitignored).

```bash
# Canonical path — use this variable in all commands
TWEAKCC=~/opencues/integrations/claude-code/tweakcc
```

---

## 1. Clone tweakcc

tweakcc is gitignored, so it must be cloned on a fresh machine:

```bash
TWEAKCC=~/opencues/integrations/claude-code/tweakcc
git clone https://github.com/Piebald-AI/tweakcc $TWEAKCC
cd $TWEAKCC && npm install
```

---

## 2. Copy OpenCues patch files

```bash
TWEAKCC=~/opencues/integrations/claude-code/tweakcc
PATCHES=~/opencues/integrations/claude-code/patches

cp $PATCHES/cursorStateExport.ts $TWEAKCC/src/patches/
cp $PATCHES/wordHighlight.ts $TWEAKCC/src/patches/
cp $PATCHES/dynamicHighlight.ts $TWEAKCC/src/patches/
```

---

## 3. Add Cues type definitions to `$TWEAKCC/src/types.ts`

In the `MiscConfig` interface, append the cues fields:

```ts
// --- Cues Patches ---
enableCursorStateExport?: boolean;
cursorStateExportPath?: string;
enableWordHighlight?: boolean;
highlightColor?: 'white' | 'cyan' | 'yellow' | 'inverse' | 'underline';
highlightIndexFromLeft?: boolean;
highlightWrap?: boolean;
highlightAutoScroll?: boolean;
highlightClearOnEscape?: boolean;
highlightClearOnNavigation?: boolean;
highlightWordPattern?: 'whitespace' | 'alphanum' | string;
highlightMode?: 'words' | 'numbers';
highlightExportEnabled?: boolean;
highlightExportPath?: string;
numberDimming?: boolean;
enableDynamicHighlight?: boolean;
dynamicHighlightScriptPath?: string;
dynamicHighlightAutoSubmit?: boolean;
dynamicHighlightDebounceMs?: number;
ttsSpeed?: number;
ttsScript?: string;
// (Cue-blanks are loaded from .opencues/blanks/<name>/cue.md at runtime — no settings.json entry)
```

---

## 4. Add Cues default settings to `$TWEAKCC/src/defaultSettings.ts`

At the top of the `misc:` block in `DEFAULT_SETTINGS`, add:

```ts
misc: {
  // --- Cues Patches ---
  enableCursorStateExport: true,
  cursorStateExportPath: '/tmp/opencues-cursor-state.json',
  enableWordHighlight: true,
  highlightColor: 'white',
  highlightIndexFromLeft: false,
  highlightWrap: false,
  highlightAutoScroll: true,
  highlightClearOnEscape: true,
  highlightClearOnNavigation: false,
  highlightWordPattern: 'whitespace',
  highlightMode: 'words',
  highlightExportEnabled: true,
  highlightExportPath: '/tmp/opencues-highlight-state.json',
  numberDimming: true,
  enableDynamicHighlight: true,
  dynamicHighlightScriptPath: '~/.claude/llm-analyze.sh',
  dynamicHighlightAutoSubmit: true,
  dynamicHighlightDebounceMs: 500,
  ttsSpeed: 2,
  ttsScript: '',
  // Cue-blanks load from .opencues/blanks/<name>/cue.md at runtime — no defaultSettings entry.

  // ... rest of existing misc defaults
```

---

## 5. Edit `$TWEAKCC/src/patches/index.ts`


### 3a. Remove `verbose-property`

Fails on v2.1.110 (pattern changed upstream). Remove in three places:

**Import** (~line 44):
```ts
// DELETE this line:
import { writeVerboseProperty } from './verboseProperty';
```

**PATCH_DEFINITIONS** (~line 152):
```ts
// DELETE this block:
{
  id: 'verbose-property',
  name: 'Verbose property',
  group: PatchGroup.ALWAYS_APPLIED,
  description: 'Token counter will show (2s · ↓ 169 tokens · thinking)',
},
```

**patchImplementations** (~line 643):
```ts
// DELETE this block:
'verbose-property': {
  fn: c => writeVerboseProperty(c),
},
```

---

### 3b. Remove `thinker-format`

Fails on v2.1.110 (pattern changed upstream). Remove in three places:

**Import** (~line 36):
```ts
// DELETE this line:
import { writeThinkerFormat } from './thinkerFormat';
```

**PATCH_DEFINITIONS** (~line 227):
```ts
// DELETE this block:
{
  id: 'thinker-format',
  name: 'Thinker format',
  group: PatchGroup.MISC_CONFIGURABLE,
  description: 'Your custom format string that thinking verbs are wrapped in will be applied',
},
```

**patchImplementations** (~line 707):
```ts
// DELETE this block:
'thinker-format': {
  fn: c => writeThinkerFormat(c, config.settings.thinkingVerbs!.format),
  condition: !!config.settings.thinkingVerbs,
},
```

---

### 3c. Remove `patches-applied-indication`

Injects a large startup banner listing every applied prompt. Remove in three places:

**Import** (~line 47):
```ts
// DELETE this line:
import { writePatchesAppliedIndication } from './patchesAppliedIndication';
```

**PATCH_DEFINITIONS** (~line 195):
```ts
// DELETE this block:
{
  id: 'patches-applied-indication',
  name: 'Patches applied indication',
  group: PatchGroup.MISC_CONFIGURABLE,
  description: 'Show "tweakcc patches applied" and tweakcc version inside CC',
},
```

**patchImplementations** (~line 654):
```ts
// DELETE this block:
'patches-applied-indication': {
  fn: c =>
    writePatchesAppliedIndication(
      c,
      '4.0.11',
      legacyItems,
      showTweakccVersion,
      showPatchesApplied
    ),
},
```

---

### 3d. Wire up the Cues Patches block (re-integration WIP)

Find the `// --- Cues Patches ---` block near the bottom of `applyCustomization()`. During re-integration, patches are enabled one at a time as each is verified against v2.1.110. Current state — Steps 1-3 enabled; Step 3 is just a hardcoded number-dim regex inside `wordHighlight.ts` (no opencues-core IIFE yet), so no extra orchestration is needed here:

```ts
// Imports at the top of the file (writeDynamicHighlight stays imported for Steps 4+ but isn't called yet):
import { writeCursorStateExport } from './cursorStateExport';
import { writeWordHighlight } from './wordHighlight';
import { writeDynamicHighlight } from './dynamicHighlight';
```

```ts
// --- Cues Patches ---
{
  let result: string | null;

  // Step 1: cursorStateExport — verified working on v2.1.110
  if (config.settings.misc?.enableCursorStateExport) {
    const exportPath = config.settings.misc?.cursorStateExportPath || '/tmp/opencues-cursor-state.json';
    if ((result = writeCursorStateExport(content, exportPath))) content = result;
  }

  // Step 2: wordHighlight — navigation + dim rendering
  if (config.settings.misc?.enableWordHighlight) {
    const highlightConfig = {
      enableWordHighlight: config.settings.misc.enableWordHighlight,
      highlightColor: config.settings.misc.highlightColor,
      highlightIndexFromLeft: config.settings.misc.highlightIndexFromLeft,
      highlightWrap: config.settings.misc.highlightWrap,
      highlightAutoScroll: config.settings.misc.highlightAutoScroll,
      highlightClearOnEscape: config.settings.misc.highlightClearOnEscape,
      highlightClearOnNavigation: config.settings.misc.highlightClearOnNavigation,
      highlightWordPattern: config.settings.misc.highlightWordPattern,
      highlightMode: config.settings.misc.highlightMode,
      highlightExportEnabled: config.settings.misc.highlightExportEnabled,
      highlightExportPath: config.settings.misc.highlightExportPath,
      numberDimming: config.settings.misc.numberDimming,
      // Cue-blanks load from .opencues/blanks/<name>/cue.md at runtime
    };
    if ((result = writeWordHighlight(content, highlightConfig))) content = result;
  }

  // Steps 4+: dynamicHighlight / opencues-core IIFE / LLM — still TODO, nothing wired.
}
```

**Escape-level gotcha** (burned once already): the Step 3 regex lives inside a TypeScript template literal (`` ` ``) in `wordHighlight.ts`. Use `\\d` / `\\.` in source — a single `\d` gets consumed by the template-literal parser and lands in `cli.js` as a bare `d`, which silently matches nothing.

---

## 6. Build and apply

```bash
TWEAKCC=~/opencues/integrations/claude-code/tweakcc
cd $TWEAKCC && npm run build

CLI_JS=$(find ~/claude-code-cues -name "cli.js" | head -1)
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node $TWEAKCC/dist/index.mjs --apply
```

Expected: `Customizations applied successfully!` with no `patch:` error lines.
The only acceptable warning is system prompt conflicts (upstream markdown version bumps — harmless).

---

## 7. Target install reminder

All tweakcc operations target `claude-cues` (`~/claude-code-cues`) only.
Never point `TWEAKCC_CC_INSTALLATION_PATH` at the native `~/.local/bin/claude` install.

---

## 8. Pin the Claude Code version in `~/claude-code-cues`

The re-integration patches are anchored to regex patterns in `claude-code@2.1.110`'s
minified `cli.js`. A caret range (`^2.1.110`) will drift to newer minors on
`npm install` and break the patches silently. Pin it exactly:

```json
// ~/claude-code-cues/package.json
{
  "dependencies": {
    "@anthropic-ai/claude-code": "2.1.110"
  }
}
```

Then reinstall cleanly:

```bash
cd ~/claude-code-cues && rm -rf node_modules package-lock.json && npm install
```

Verify: `wc -l ~/claude-code-cues/node_modules/@anthropic-ai/claude-code/cli.js`
should report **17634** for v2.1.110.
