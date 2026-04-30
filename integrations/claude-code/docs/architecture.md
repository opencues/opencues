---
last_updated: 2026-04-07
---

# Architecture — Claude Code

This document explains how the patched Claude Code system works, tracing the flow from user input through each component.

---

## High-Level Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLAUDE CODE (cli.js)                              │
│                                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐  │
│  │   Input     │    │    Key      │    │  Rendering  │    │   Status    │  │
│  │  Handler    │───▶│  Handler    │───▶│   Engine    │───▶│    Line     │  │
│  └─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘  │
│        │                  │                  │                  │          │
│        │                  │                  │                  │          │
│  ┌─────▼─────┐      ┌─────▼─────┐      ┌─────▼─────┐      ┌─────▼─────┐   │
│  │  PATCH:   │      │  PATCH:   │      │  PATCH:   │      │  PATCH:   │   │
│  │  cursor   │      │  word     │      │  word     │      │  word     │   │
│  │  State    │      │  Highlight│      │  Highlight│      │  Highlight│   │
│  │  Export   │      │  (keys)   │      │  (render) │      │  (status) │   │
│  └───────────┘      └─────┬─────┘      └───────────┘      └───────────┘   │
│                           │                                                │
│                     ┌─────▼─────┐                                          │
│                     │  PATCH:   │                                          │
│                     │  dynamic  │                                          │
│                     │  Highlight│                                          │
│                     └─────┬─────┘                                          │
│                           │                                                │
└───────────────────────────┼────────────────────────────────────────────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │ External Scripts│
                   │ (~/.claude/)    │
                   └─────────────────┘
```

---

## The User Typing Flow

### Phase 1: Keystroke Entry

```
User types: "The boy has 3 dogs"
                │
                ▼
┌───────────────────────────────────────────────────────────────┐
│                    INPUT HANDLER (React/Ink)                   │
│                                                                │
│  Receives keystroke → Updates internal text state              │
│                                                                │
│  PATCHED BY: cursorStateExport.ts                             │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ • Extracts cursor position, current word, text length    │ │
│  │ • Debounces writes (100ms)                               │ │
│  │ • Async writes to /tmp/opencues-cursor-state.json          │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  PATCHED BY: wordHighlight.ts (clear on typing)               │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ • Detects if text changed (ignoring invisible chars)     │ │
│  │ • Clears highlight state if user typed new content       │ │
│  │ • Stores parent value for invisible char toggling        │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  PATCHED BY: dynamicHighlight.ts (auto-submit trigger)        │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ • Counts words, compares to previous count               │ │
│  │ • If new word detected → 50ms debounce + stability check  │ │
│  │ • If word edited mid-sentence → 50ms + stability check   │ │
│  │ • If 300ms passes with no typing → final pause trigger   │ │
│  │ • Per-word clearing: changed words have alts cleared     │ │
│  │ • When timer fires → targeted index optimization:        │ │
│  │   - opencues-core O(1) tips lookup first                     │ │
│  │   - Only sends words lacking alts to LLM (re-indexed)    │ │
│  │   - Stores index map for unmapping on return              │ │
│  └──────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

### Phase 2: Special Key Detection

```
User presses: Ctrl+Alt+Left
                │
                ▼
┌───────────────────────────────────────────────────────────────┐
│                    KEY HANDLER (switch statement)              │
│                                                                │
│  PATCHED BY: wordHighlight.ts (navigation)                    │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ case (key.leftArrow && key.ctrl && key.alt):             │ │
│  │                                                          │ │
│  │ 1. Get words from globalThis._hlText                     │ │
│  │ 2. Filter to navigable words:                             │ │
│  │    • _isCueControl(w): step patterns + control overrides │ │
│  │    • PLUS: words with dynamic alts                       │ │
│  │    • PLUS: tip words, span members                       │ │
│  │ 3. Move to previous navigable word                       │ │
│  │ 4. Store wordIndex in globalThis._hlState                │ │
│  │ 5. Toggle invisible char to trigger re-render            │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  Similar cases for: Right, Up, Down arrows                    │
└───────────────────────────────────────────────────────────────┘
```

### Phase 3: Up/Down Action (Cycling/Incrementing)

```
User presses: Ctrl+Alt+Up (with "dogs" highlighted)
                │
                ▼
┌───────────────────────────────────────────────────────────────┐
│                    UP KEY HANDLER                              │
│                                                                │
│  PATCHED BY: dynamicHighlight.ts (FIRST - _cycleAlt)          │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ 1. Check if word is custom cue-blank (e.g., "volume")  │ │
│  │    → If yes: spawn script, RETURN                        │ │
│  │                                                          │ │
│  │ 2. Check if word matches step control pattern             │ │
│  │    → If yes: increment/decrement per config, RETURN      │ │
│  │                                                          │ │
│  │ 3. Check if word has dynamic alts in _dynDefs            │ │
│  │    → If yes: cycle to next alt, update linked words      │ │
│  │    → Update text, RETURN                                 │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  PATCHED BY: wordHighlight.ts (delegates to _cycleAlt)        │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ 4. Up/Down delegates to _cycleAlt (no duplicate logic)  │ │
│  │    → Handles step blanks, cue-blanks, alt cycling   │ │
│  │    → Returns result with text/offset for InputZone      │ │
│  └──────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

### Phase 4: Rendering

```
Text ready to display: "The boy has 3 dogs"
                │
                ▼
┌───────────────────────────────────────────────────────────────┐
│                    RENDERING ENGINE                            │
│                                                                │
│  Original renderedValue: "The boy has 3 dogs"                 │
│                                                                │
│  PATCHED BY: wordHighlight.ts (rendering wrapper)             │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ 1. Parse words and their positions                       │ │
│  │ 2. Build highlight ranges (white) for selected word      │ │
│  │    • If span selected: include span words                │ │
│  │ 3. Build dim ranges (gray) for:                          │ │
│  │    • Step-pattern matches (if numberDimming enabled)     │ │
│  │    • Cue-blanks                                        │ │
│  │    • Tip words (instant — checked via _localCueMap)      │ │
│  │    • Words with dynamic alts (after LLM response)        │ │
│  │ 4. Walk through renderedValue char-by-char:              │ │
│  │    • Track ANSI codes (preserve cursor styling)          │ │
│  │    • Apply highlight color to highlight ranges           │ │
│  │    • Apply dim color to dim ranges                       │ │
│  │    • Pass through everything else unchanged              │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  Final output: ANSI-colored string for terminal               │
└───────────────────────────────────────────────────────────────┘
```

---

## LLM Analysis Flow (Dynamic Highlight)

### Auto-Submit Trigger (Three-Tier)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    AUTO-SUBMIT TRIGGER (Three-Tier)                         │
│                                                                             │
│  Tier 1: Space-based (50ms)                                                │
│    User types "The boy " (space) → word count increases → 50ms debounce    │
│                                                                             │
│  Tier 2: Final pause (300ms)                                               │
│    User stops typing → 300ms passes → timer fires for last word            │
│                                                                             │
│  Tier 3: Edit detection (50ms)                                             │
│    User edits a word mid-sentence → 50ms debounce → re-analyze             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
         ▼ (50ms or 300ms)
┌─────────────────────────────────────────────────────────────────────────────┐
│                    TIPS LOOKUP + TARGETED INDEX                             │
│                                                                             │
│  1. opencues-core lookupMultiple() — O(1) tips lookup for all words            │
│     → Words with tips get instant alts (merged immediately)                │
│  2. Check which indices already have valid alts in _dynDefs                 │
│  3. Skip function words (the, a, to, is, etc.)                             │
│  4. Remaining indices become targetIndices                                  │
│                                                                             │
│  If all words have alts or tips → skip LLM entirely                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    CueResolver.resolve() (opencues-core)                        │
│                                                                             │
│  Filters sources by supports():                                            │
│    ConfigSource (scope:words) → non-blank words (from cues.md)            │
│    ClassifiedSourceGroup (scope:blanks) → blanks only (from blanks.md)    │
│                                                                             │
│  Each source:                                                               │
│    1. Builds prompt (ConfigSource: indexed words or BLANK replacement)     │
│    2. Calls NodeHttpAdapter.post() → Groq API (keep-alive, ~400ms)        │
│    3. Parses response → CueResult[]                                        │
│                                                                             │
│  Resolver merges results by priority → returns CueResult[]                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    RESULT PROCESSING (tweakcc patch)                        │
│                                                                             │
│  1. Convert CueResult[] to WordDef[] (filter alts.length > 1)             │
│  2. Merge into existing _dynDefs (preserve spans, currentAltIndex)         │
│  3. _forceInputRefresh() → triggers re-render with dim/highlight          │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## File-by-File Breakdown

### cursorStateExport.ts

```
PURPOSE: Export cursor position for external tools

PATCHES:
  └── Input handler (before return statement)

INJECTS:
  └── Async debounced write to /tmp/opencues-cursor-state.json

OUTPUT FILE:
  {
    "text": "hello world",
    "cursorPosition": 6,
    "currentWord": "world",
    "atEnd": false,
    "textLength": 11,
    "timestamp": 1705500000000
  }

DEPENDENCIES: None (standalone)
```

### wordHighlight.ts

```
PURPOSE: Navigation, rendering, delegates Up/Down to _cycleAlt

PATCHES:
  ├── Key handler (Ctrl+Alt+Left/Right/Up/Down)
  ├── Raw sequence handler (fallback for \x1B[1;7D/C/A/B)
  ├── Escape handler (clear highlight)
  ├── Input handler (clear on typing, store parent value)
  ├── Rendering wrapper (dim/highlight colors)
  └── Status line trigger export

INJECTS:
  ├── Navigation logic with _isCueControl filtering
  ├── Up/Down delegates to _cycleAlt (no duplicate logic)
  ├── globalThis._cueBlankOverrides assignment (serialized from config)
  ├── ANSI rendering with highlight/dim ranges
  └── Invisible char toggle for re-render triggering

STATE (globalThis):
  • _hlState: {active, index, wordIndex, originalNumbers}
  • _hlText: current input text
  • _parentValue: parent's value (for invisible char toggle)
  • _cueBlankOverrides: control word config (serialized from config at build time)
  • _triggerStatusLineRefresh: function to refresh status line
  • _forceInputRefresh: function to force re-render

CONFIG:
  • highlightMode: 'numbers' | 'words'
  • highlightColor: 'white' | 'cyan' | 'yellow' | ...
  • numberDimming: boolean
  • cueControlOverrides: {word: {control, upArgs, downArgs}}

EXTERNAL SCRIPTS:
  • ~/claude-code-cues/.opencues/actions/{control}.sh

DEPENDENCIES: None (foundation for dynamicHighlight)
```

### dynamicHighlight.ts

```
PURPOSE: LLM-based word analysis and cycling via opencues-core

PATCHES:
  ├── Startup IIFE (load opencues-core, create NodeHttpAdapter + CueResolver)
  ├── Input handler (auto-submit trigger, tips lookup, resolver call)
  ├── 4× key handlers (Up/Down × case/raw — delegates to shared _cycleAlt)
  ├── Rendering extension (dim words with alts)
  └── Clear on change (word-level invalidation)

INJECTS:
  ├── Startup IIFE:
  │   ├── opencues-core loading + tipsMap building (once per process)
  │   ├── NodeHttpAdapter (keep-alive, Groq provider config)
  │   ├── _reloadCuesConfig() — parses all .md config + rebuilds resolver
  │   │   (called at startup; re-called after 2s TTL on next analysis trigger)
  │   └── Shared _cycleAlt(dir) function (cue-blanks, alts, linked, spans)
  ├── Input handler:
  │   ├── Three-tier trigger (space 50ms, pause 300ms, edit 50ms)
  │   ├── Tips lookup (instant, merge immediately)
  │   ├── Targeted index computation (skip function words, skip existing alts)
  │   ├── CueResolver.resolve() call with targetIndices
  │   └── Result merge into _dynDefs + _forceInputRefresh
  ├── Key handlers: 3-line delegates to _cycleAlt(±1)
  ├── Per-word clearing (clears alts when word changes)
  └── Underscore (blank) handling with context tracking

STATE (globalThis):
  • _cuesCore: opencues-core module reference
  • _tipsMap: prebuilt hash map from tips file
  • _httpAdapter: NodeHttpAdapter instance (from opencues-core)
  • _cueResolver: CueResolver instance (rebuilt on config reload)
  • _reloadCuesConfig: config reload function (TTL-based hot-reload)
  • _configLoadedAt: timestamp of last config load (0 = never)
  • _configReloading: boolean (gates analysis during rebuild)
  • _resolverGeneration: counter incremented on each resolver rebuild
  • _isCueControl: unified check for cue-blanks (step patterns + custom overrides)
  • _stepPatterns: compiled step control regex patterns (rebuilt on config reload)
  • _cycleAlt: shared cycling function (cue-blanks first, then dynamic alts)
  • _dynDefs: parsed LLM response {words: [...]}
  • _dynPending: boolean (resolver in progress)
  • _dynPrevWords: previous word list
  • _dynDebounceTimer: timer reference (50ms)
  • _dynFinalPauseTimer: timer reference (300ms)
  • _dynSpans: span tracking for multi-word alts
  • _dynLastAnalyzed: text at last analysis (cleared on config reload)
  • _dynUnderscoreContext: context for blank re-evaluation

CONFIG:
  • enableDynamicHighlight: boolean
  • dynamicHighlightDebounceMs: number

EXTERNAL DEPENDENCIES:
  • opencues-core (npm module — prompts, sources, resolver, adapter)

READS (from wordHighlight.ts):
  • globalThis._hlState, _hlText, _parentValue
  • globalThis._cueBlankOverrides (for cue-blank checks in Up/Down handlers)
  • globalThis._triggerStatusLineRefresh, _forceInputRefresh

DEPENDENCIES:
  • REQUIRES wordHighlight.ts (extends its key handlers, reads its globalThis vars)
  • REQUIRES opencues-core (npm module)
  • REQUIRES GROQ_API_KEY environment variable
```

---

## State Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         globalThis STATE                                    │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   _hlText       │     │   _hlState      │     │   _dynDefs      │
│                 │     │                 │     │                 │
│ Current input   │     │ {               │     │ {               │
│ text (stripped  │     │   active: bool  │     │   words: [...]  │
│ of invisible    │     │   wordIndex: n  │     │ }               │
│ chars)          │     │   original...   │     │                 │
│                 │     │ }               │     │ LLM + tips      │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         │    ┌──────────────────┼───────────────────────┘
         │    │                  │
         │    │
         ▼    ▼                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                      RENDERING                                   │
│                                                                  │
│  Combines all state to produce final colored output:            │
│  • _hlText → word positions                                     │
│  • _hlState.wordIndex → which word is highlighted               │
│  • _dynDefs → which words have alternatives (gray)              │
│  • Mode config → which words are navigable                      │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  "The boy has [gray]3[/gray] dogs"                             │
│                    ^                                            │
│                    └── number (dimmed)                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## External File Interactions

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         FILE I/O MAP                                        │
└─────────────────────────────────────────────────────────────────────────────┘

WRITES (from cli.js):
  │
  ├── /tmp/opencues-cursor-state.json          ← cursorStateExport.ts
  │   (debounced, async)
  │
  ├── /tmp/opencues-highlight-state-{PID}.json ← wordHighlight.ts
  │   (sync, on navigation)
  │
  ├── /tmp/claude-llm-timing-{PID}.txt       ← dynamicHighlight.ts
  │   (after resolver returns)
  │
  └── /tmp/claude-auto-debug-{PID}.txt       ← dynamicHighlight.ts
      (trigger/resolver logs)

HTTPS (via opencues-core NodeHttpAdapter):
  │
  └── api.groq.com/openai/v1/chat/completions  ← CueResolver sources
      (keep-alive agent, warmed on startup)

READS (at startup + on 2s TTL reload):
  │
  ├── ~/claude-code-cues/.opencues/tips.json         ← opencues-core tips lookup
  │   (parsed once at startup, built into base hash map)
  │
  ├── {cwd}/cues.md (or hints.md / tips.md)   ← tips + prompt sources
  ├── {cwd}/blanks.md                          ← blank-fill modes
  ├── {cwd}/blanks.md                        ← cue-blank definitions
  └── {cwd}/cues/, blanks/, controls/          ← folder-based configs
      (all re-read on every TTL-triggered reload)

SPAWNS (from cli.js):
  │
  └── ~/claude-code-cues/.opencues/actions/{control}.sh           ← _cycleAlt (control words)
      Args: <up|down>
```

---

## Summary: What Each File Does

| File | One-Line Summary |
|------|------------------|
| `cursorStateExport.ts` | Writes cursor position to JSON on each keystroke |
| `wordHighlight.ts` | Navigation + rendering + numbers + controls |
| `dynamicHighlight.ts` | opencues-core wiring + trigger + cycling + spans |

**Dependency order:**
```
1. cursorStateExport.ts  (standalone)
2. wordHighlight.ts      (standalone, foundation)
3. dynamicHighlight.ts   (requires wordHighlight + opencues-core npm module)
```

---

## Development Notes

### `require()` in Patch Files

Claude Code's `cli.js` is a bundled file where the standard Node.js `require` function is renamed by the bundler (e.g., to `$e`, `__require`, or similar). The patch `.ts` files are TypeScript templates that get compiled by tweakcc and injected into `cli.js` at runtime.

**Never use bare `require()` in patch code.** It will silently fail — the bundler's shim either returns `undefined` or throws, which gets swallowed by any surrounding `try/catch`, making bugs extremely difficult to trace.

| Context | Correct | Wrong |
|---------|---------|-------|
| Template strings (injected code blocks) | `${requireFuncName}("fs")` | `require("fs")` |
| Inside `_cycleAlt` function | `_reqFn("moduleName")` | `require("moduleName")` |

The `requireFuncName` variable is resolved at patch-apply time by `getRequireFuncName(oldFile)`, which finds the actual require function name in the bundled `cli.js`. The `_reqFn` parameter is the require function passed into `_cycleAlt` from the key handler scope.

This applies to `dynamicHighlight.ts`, `wordHighlight.ts`, and any future patch `.ts` files that inject code into `cli.js`.
