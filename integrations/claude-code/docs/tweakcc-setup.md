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
cueControlOverrides?: { [word: string]: { control: string; scriptPath?: string; upArgs?: string[]; downArgs?: string[]; }; };
```

---

## 4. Add Cues default settings to `$TWEAKCC/src/defaultSettings.ts`

At the top of the `misc:` block in `DEFAULT_SETTINGS`, add:

```ts
misc: {
  // --- Cues Patches ---
  enableCursorStateExport: true,
  cursorStateExportPath: '/tmp/claude-cursor-state.json',
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
  highlightExportPath: '/tmp/claude-highlight-state.json',
  numberDimming: true,
  enableDynamicHighlight: true,
  dynamicHighlightScriptPath: '~/.claude/llm-analyze.sh',
  dynamicHighlightAutoSubmit: true,
  dynamicHighlightDebounceMs: 500,
  ttsSpeed: 2,
  ttsScript: '',
  cueControlOverrides: { volume: { control: 'volume', upArgs: ['up', '5'], downArgs: ['down', '5'] } },

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

### 3d. Comment out the Cues Patches block

Find the `// --- Cues Patches ---` block near the bottom of `applyCustomization()` and comment it out. During re-integration, patches are re-enabled one at a time as each is verified working.

```ts
// --- Cues Patches ---
// NOTE: Re-enable one at a time as each patch is verified for v2.1.110.
// {
//   let result: string | null;
//   if (config.settings.misc?.enableCursorStateExport) { ... }
//   if (config.settings.misc?.enableWordHighlight) { ... }
//   if (config.settings.misc?.enableDynamicHighlight ...) { ... }
// }
```

---

## 6. Build and apply

```bash
TWEAKCC=~/opencues/integrations/claude-code/tweakcc
cd $TWEAKCC && npm run build

CLI_JS=$(find ~/local-claude-code -name "cli.js" | head -1)
TWEAKCC_CC_INSTALLATION_PATH="$CLI_JS" node $TWEAKCC/dist/index.mjs --apply
```

Expected: `Customizations applied successfully!` with no `patch:` error lines.
The only acceptable warning is system prompt conflicts (upstream markdown version bumps — harmless).

---

## 7. Target install reminder

All tweakcc operations target `claude-cues` (`~/local-claude-code`) only.
Never point `TWEAKCC_CC_INSTALLATION_PATH` at the native `~/.local/bin/claude` install.

---

## 8. Pin the Claude Code version in `~/local-claude-code`

The re-integration patches are anchored to regex patterns in `claude-code@2.1.110`'s
minified `cli.js`. A caret range (`^2.1.110`) will drift to newer minors on
`npm install` and break the patches silently. Pin it exactly:

```json
// ~/local-claude-code/package.json
{
  "dependencies": {
    "@anthropic-ai/claude-code": "2.1.110"
  }
}
```

Then reinstall cleanly:

```bash
cd ~/local-claude-code && rm -rf node_modules package-lock.json && npm install
```

Verify: `wc -l ~/local-claude-code/node_modules/@anthropic-ai/claude-code/cli.js`
should report **17634** for v2.1.110.
