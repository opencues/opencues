---
last_updated: 2026-03-31
---

# Injected Variable Dependency Map

Maps every variable injected into cli.js by the three custom patch files, focusing on cross-function dependencies and runtime safety.

## Cross-Patch Dependencies (Highest Risk)

These variables are SET in one patch file and READ in another. If the defining patch fails, the reading patch may crash.

```
wordHighlight.ts SETS:              dynamicHighlight.ts READS:
  globalThis._hlState       ─────→   cycle handlers, rendering
  globalThis._hlText        ─────→   submit trigger, auto-submit, cycle handlers
  globalThis._parentValue   ─────→   (not cross-file, only wordHighlight)
  globalThis._actionWordOverrides ──→ cycle handlers, rendering
  globalThis._triggerStatusLineRefresh ──→ submit trigger, auto-submit
  globalThis._forceInputRefresh ────→ submit trigger, auto-submit

dynamicHighlight.ts SETS:           wordHighlight.ts READS:
  globalThis._dynDefs       ─────→   rendering (span-aware highlight/dim)
  globalThis._dynSpans      ─────→   rendering (span highlighting)
```

## Global Variables (globalThis._*)

### Always Safe (properly guarded at every read)

| Variable | Set By | Read By | Guard Pattern |
|----------|--------|---------|---------------|
| `_hlState` | wordHighlight: KeyHandler, ClearOnEscape | wordHighlight + dynamicHighlight | `if(!globalThis._hlState)globalThis._hlState={...}` |
| `_hlText` | wordHighlight: ClearOnTyping, KeyHandler | everywhere | `globalThis._hlText\|\|""` |
| `_triggerStatusLineRefresh` | wordHighlight: StatusLineTrigger | wordHighlight + dynamicHighlight | `if(globalThis._triggerStatusLineRefresh)` |
| `_forceInputRefresh` | wordHighlight: ClearOnTyping | dynamicHighlight: all trigger modes | `if(globalThis._forceInputRefresh)` |
| `_dynDefs` | dynamicHighlight: triggers/polling | wordHighlight + dynamicHighlight | `globalThis._dynDefs&&globalThis._dynDefs.words` |
| `_dynSpans` | dynamicHighlight: CycleHandlers | dynamicHighlight: Navigation, Rendering | `globalThis._dynSpans&&globalThis._dynSpans[i]` |
| `_dynPending` | dynamicHighlight: triggers | dynamicHighlight: triggers | boolean flag, no guard needed |
| `_cwt` | cursorStateExport | cursorStateExport | `clearTimeout(globalThis._cwt)` (safe on undefined) |

### Conditionally Safe (guarded by upstream logic, not direct null check)

| Variable | Set By | Read By | Why Safe |
|----------|--------|---------|----------|
| `_cueResolver` | dynamicHighlight: CuesCoreInit | dynamicHighlight: AutoSubmit | Guards `resolve()`; downstream checks prevent calls when null |
| `_tipsMap` | dynamicHighlight: CuesCoreInit | dynamicHighlight: AutoSubmit | Same guard chain as `_cueResolver` |
| `_tipsData` | dynamicHighlight: CuesCoreInit | (not actively read) | Stored but unused |
| `_httpAdapter` | dynamicHighlight: CuesCoreInit | dynamicHighlight: AutoSubmit (via CueResolver) | Created once at init; used by cues-core's GroqSource for LLM calls |
| `_cycleAlt` | dynamicHighlight: CycleHandlers | dynamicHighlight: AutoSubmit | Tracks current cycling state |

### Serialized from Config (set once at startup)

| Variable | Set By | Read By | Guard Pattern |
|----------|--------|---------|---------------|
| `_actionWordOverrides` | wordHighlight: ClearOnTyping | dynamicHighlight: CycleHandlers, Rendering; wordHighlight: Navigation, Rendering | `if(!globalThis._actionWordOverrides)globalThis._actionWordOverrides=...` + `(globalThis._actionWordOverrides\|\|{})` at every read |

## Bugs Found and Fixed

### 1. `_actOvr` ReferenceError (FIXED)

**Problem**: `writeActionOvrVariable` (step 5) injects `var _actOvr=globalThis._actionWordOverrides||{}` after `_rootPat`. In numbers mode (default), there's no `_rootPat` in rendering code → step 5 fails → step 6 (`writeDynamicRendering`) injects code referencing undefined `_actOvr` → **ReferenceError crashes Claude Code**.

**Fix**: Replaced `_actOvr[_wLower]` with `(globalThis._actionWordOverrides||{})[_wLower]` in the rendering code, making it self-contained. Also added numbers mode pattern matching to `writeDynamicRendering` (previously only matched gender/both mode patterns).

### 2. `_actionWordOverrides` Never Initialized in Source (FIXED)

**Problem**: `globalThis._actionWordOverrides` was read in ~15 locations across dynamicHighlight.ts and wordHighlight.ts, but the source `writeWordHighlightClearOnTyping` never injected the assignment into cli.js. The config value was passed from index.ts to `highlightConfig` but stopped there — it was available at TypeScript build time but never serialized to runtime. The `||{}` fallback at every read site masked the error — action words silently behaved as normal words with dynamic alternatives instead of triggering scripts. (Note: the reimplementation copy already had this assignment at line 695; the bug was only in the source.)

**Fix**: Added `if(!globalThis._actionWordOverrides)globalThis._actionWordOverrides=${actionOvrJson}` in `writeWordHighlightClearOnTyping`, serializing the config at build time. Also added `actionWordOverrides` to the `WordHighlightConfig` interface and defaults. Also added the config entry to `~/.tweakcc/config.json` which was documented but never present.

### 3. Numbers Mode Rendering Never Patched (FIXED)

**Problem**: `writeDynamicRendering` only searched for the `_dimRanges` pattern used in gender/both mode. In numbers mode (default), the rendering uses `_numRanges` with a different code pattern → regex never matched → step 6 returned null → **dynamic words never dimmed gray in numbers mode**.

**Fix**: Added a second pattern in `writeDynamicRendering` that matches the numbers mode `_numRanges.push` code and extends it to dim action words and dynamic alt words.

## Patch Application Order

The order matters because later patches modify code injected by earlier patches.

### wordHighlight.ts → `writeWordHighlight()` applies:
1. `writeWordHighlightKeyHandler` — Left/Right/Up/Down key detection
2. `writeWordHighlightRawSequence` — Terminal escape sequence fallback
3. `writeWordHighlightClearOnEscape` — Reset on Escape
4. `writeWordHighlightClearOnTyping` — Reset on text change, defines `_forceInputRefresh`
5. `writeWordHighlightRendering` — Dim numbers/gender, highlight selected
6. `writeStatusLineTriggerExport` — Expose status line refresh

### dynamicHighlight.ts → `writeDynamicHighlight()` applies:
0. `writeCuesCoreInit` — Load tips file, init CueResolver + NodeHttpAdapter (optional, try/catch)
1. (removed — classification now via cues-core's looksLikeMath/looksLikeFactual, no wink-pos-tagger)
2. `writeAutoSubmitDebounced` — Trigger mode (always auto-submit)
3. `writeDynamicCycleHandlers` — Up/Down cycling through alts
4. `writeDynamicRawSequenceHandlers` — Terminal escape fallback (optional)
5. `writeActionOvrVariable` — Inject `_actOvr` local var (optional)
6. `writeDynamicRendering` — Dim words with alts gray (optional but critical)
7. `writeDynamicClearOnChange` — Word-level invalidation (optional)
8. `writeDynamicNavigation` — Add dynamic words to navigation filter (optional)

### Gating condition (index.ts:654):
```typescript
const dynamicConfig = (enableDynamic && config.settings.misc?.enableWordHighlight) ? {...} : null;
```
Both `enableDynamicHighlight` and `enableWordHighlight` must be true, otherwise ALL dynamic patches are skipped.

## Local Variables (within injected code)

These are defined and used within a single injected code block. Low risk.

| Variable | Scope | Used In |
|----------|-------|---------|
| `_allW`, `_targetIdx` | Navigation handler | `filterCode` in KeyHandler |
| `_numP`, `_rootPat` | Navigation handler | Mode-dependent word filtering |
| `_hlWordIdx` | Rendering IIFE | Highlight position lookup |
| `_numRanges`, `_dimRanges` | Rendering IIFE | Numbers mode / gender-both mode |
| `_hlStart`, `_hlEnd` | Rendering IIFE | Character range for highlight |
| `_rv`, `_clean`, `_words` | Rendering IIFE | Parsed renderedValue |
| `_dWord`, `_dIdx` | Cycle handler | Current word definition lookup |
| `_actOvrChk` | Cycle handler | Action word check (safe: `globalThis._actionWordOverrides\|\|{}`) |

## Runtime Dependencies (external)

| Dependency | Required By | Fallback |
|-----------|-------------|----------|
| `~/.claude/node_modules/cues-core` | CuesCoreInit | `_tipsMap = null`, falls back to LLM via CueResolver |
| `~/.claude/claude-code-tips.json` | CuesCoreInit | No tips, all words go to LLM |
| `GROQ_API_KEY` / `CEREBRAS_API_KEY` | cues-core NodeHttpAdapter | LLM calls return empty result |
| `fs` module | CursorExport, Dynamic | Always available in Node.js |
| `child_process` module | Action word scripts (spawn) | Always available in Node.js |
