---
last_updated: 2026-03-31
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
│  │ • Async writes to /tmp/claude-cursor-state.json          │ │
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
│  │   - cues-core O(1) tips lookup first                     │ │
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
│  │ 2. Filter to navigable words based on mode:              │ │
│  │    • 'numbers': /^-?\d+(\.\d+)?$/                        │ │
│  │    • 'gender': /^(boy|girl)$/i                           │ │
│  │    • 'both': numbers OR gender roots                     │ │
│  │    • 'words': all words                                  │ │
│  │    • PLUS: cue-action overrides                         │ │
│  │    • PLUS: words with dynamic alts                       │ │
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
User presses: Ctrl+Alt+Up (with "boy" highlighted)
                │
                ▼
┌───────────────────────────────────────────────────────────────┐
│                    UP KEY HANDLER                              │
│                                                                │
│  PATCHED BY: dynamicHighlight.ts (FIRST - action check)       │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ 1. Check if word is cue-action (e.g., "volume")         │ │
│  │    → If yes: spawn script, RETURN                        │ │
│  │                                                          │ │
│  │ 2. Check if word is gender root (boy/girl)               │ │
│  │    → If yes: SKIP (let wordHighlight handle)             │ │
│  │                                                          │ │
│  │ 3. Check if word has dynamic alts in _dynDefs            │ │
│  │    → If yes: cycle to next alt, update linked words      │ │
│  │    → Update text, RETURN                                 │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  PATCHED BY: wordHighlight.ts (SECOND - fallback)             │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ 4. Check if word is gender root (boy/girl)               │ │
│  │    → Flip ALL linked words:                              │ │
│  │      boy→girl, his→her, he→she, him→her, man→woman      │ │
│  │    → Update text, RETURN                                 │ │
│  │                                                          │ │
│  │ 5. Check if word is number                               │ │
│  │    → Increment by 1 (track original for floor)           │ │
│  │    → Update text, RETURN                                 │ │
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
│  │    • If gender selected: include linked words            │ │
│  │    • If span selected: include span words                │ │
│  │ 3. Build dim ranges (gray) for:                          │ │
│  │    • Numbers (if numberDimming enabled)                  │ │
│  │    • Gender root words (boy/girl)                        │ │
│  │    • Cue-actions                                        │ │
│  │    • Words with dynamic alts                             │ │
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
│  1. cues-core lookupMultiple() — O(1) tips lookup for all words            │
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
│                    CueResolver.resolve() (cues-core)                        │
│                                                                             │
│  Filters sources by supports():                                            │
│    GrammarSource → always (priority 50)                                    │
│    MathSource    → only if looksLikeMath() (priority 90)                   │
│    FactualSource → only if looksLikeFactual() (priority 90)               │
│                                                                             │
│  Each source:                                                               │
│    1. Builds prompt (GrammarSource: words-first + targetIndices filter)    │
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
  └── Async debounced write to /tmp/claude-cursor-state.json

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
PURPOSE: Navigation, rendering, number/gender/cue-action handling

PATCHES:
  ├── Key handler (Ctrl+Alt+Left/Right/Up/Down)
  ├── Raw sequence handler (fallback for \x1B[1;7D/C/A/B)
  ├── Escape handler (clear highlight)
  ├── Input handler (clear on typing, store parent value)
  ├── Rendering wrapper (dim/highlight colors)
  └── Status line trigger export

INJECTS:
  ├── Navigation logic with mode-based filtering
  ├── Number increment/decrement with floor tracking
  ├── Gender flip with linked word handling
  ├── globalThis._cueActionOverrides assignment (serialized from config)
  ├── ANSI rendering with highlight/dim ranges
  └── Invisible char toggle for re-render triggering

STATE (globalThis):
  • _hlState: {active, index, wordIndex, originalNumbers, originalGender}
  • _hlText: current input text
  • _parentValue: parent's value (for invisible char toggle)
  • _cueActionOverrides: action word config (serialized from config at build time)
  • _triggerStatusLineRefresh: function to refresh status line
  • _forceInputRefresh: function to force re-render

CONFIG:
  • highlightMode: 'numbers' | 'words' | 'gender' | 'both'
  • highlightColor: 'white' | 'cyan' | 'yellow' | ...
  • numberDimming: boolean
  • cueActionOverrides: {word: {action, upArgs, downArgs}}

EXTERNAL SCRIPTS:
  • ~/.claude/actions/{action}.sh

DEPENDENCIES: None (foundation for dynamicHighlight)
```

### dynamicHighlight.ts

```
PURPOSE: LLM-based word analysis and cycling via cues-core

PATCHES:
  ├── Startup IIFE (load cues-core, create NodeHttpAdapter + CueResolver)
  ├── Input handler (auto-submit trigger, tips lookup, resolver call)
  ├── 4× key handlers (Up/Down × case/raw — delegates to shared _cycleAlt)
  ├── Rendering extension (dim words with alts)
  └── Clear on change (word-level invalidation)

INJECTS:
  ├── Startup IIFE:
  │   ├── cues-core loading + tipsMap building
  │   ├── NodeHttpAdapter (keep-alive, Groq provider config)
  │   ├── CueResolver (GrammarSource + MathSource + FactualSource)
  │   └── Shared _cycleAlt(dir) function (cue-actions, alts, linked, spans)
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
  • _cuesCore: cues-core module reference
  • _tipsMap: prebuilt hash map from tips file
  • _httpAdapter: NodeHttpAdapter instance (from cues-core)
  • _cueResolver: CueResolver instance (from cues-core)
  • _cycleAlt: shared cycling function
  • _dynDefs: parsed LLM response {words: [...]}
  • _dynPending: boolean (resolver in progress)
  • _dynPrevWords: previous word list
  • _dynDebounceTimer: timer reference (50ms)
  • _dynFinalPauseTimer: timer reference (300ms)
  • _dynSpans: span tracking for multi-word alts
  • _dynLastAnalyzed: text at last analysis
  • _dynUnderscoreContext: context for blank re-evaluation

CONFIG:
  • enableDynamicHighlight: boolean
  • dynamicHighlightDebounceMs: number

EXTERNAL DEPENDENCIES:
  • cues-core (npm module — prompts, sources, resolver, adapter)

READS (from wordHighlight.ts):
  • globalThis._hlState, _hlText, _parentValue
  • globalThis._cueActionOverrides (for cue-action checks in Up/Down handlers)
  • globalThis._triggerStatusLineRefresh, _forceInputRefresh

DEPENDENCIES:
  • REQUIRES wordHighlight.ts (extends its key handlers, reads its globalThis vars)
  • REQUIRES cues-core (npm module)
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
│  "The [gray]boy[/gray] has [gray]3[/gray] dogs"                │
│        ^^^                  ^                                   │
│        │                    └── number (dimmed)                 │
│        └── gender root (dimmed, navigable)                      │
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
  ├── /tmp/claude-cursor-state.json          ← cursorStateExport.ts
  │   (debounced, async)
  │
  ├── /tmp/claude-highlight-state-{PID}.json ← wordHighlight.ts
  │   (sync, on navigation)
  │
  ├── /tmp/claude-llm-timing-{PID}.txt       ← dynamicHighlight.ts
  │   (after resolver returns)
  │
  └── /tmp/claude-auto-debug-{PID}.txt       ← dynamicHighlight.ts
      (trigger/resolver logs)

HTTPS (via cues-core NodeHttpAdapter):
  │
  └── api.groq.com/openai/v1/chat/completions  ← CueResolver sources
      (keep-alive agent, warmed on startup)

READS (at startup):
  │
  └── ~/.claude/claude-code-tips.json         ← cues-core tips lookup
      (parsed once, built into hash map)

SPAWNS (from cli.js):
  │
  └── ~/.claude/actions/{action}.sh           ← _cycleAlt (action words)
      Args: <up|down>
```

---

## Summary: What Each File Does

| File | One-Line Summary |
|------|------------------|
| `cursorStateExport.ts` | Writes cursor position to JSON on each keystroke |
| `wordHighlight.ts` | Navigation + rendering + numbers + gender + actions |
| `dynamicHighlight.ts` | cues-core wiring + trigger + cycling + spans |

**Dependency order:**
```
1. cursorStateExport.ts  (standalone)
2. wordHighlight.ts      (standalone, foundation)
3. dynamicHighlight.ts   (requires wordHighlight + cues-core npm module)
```
