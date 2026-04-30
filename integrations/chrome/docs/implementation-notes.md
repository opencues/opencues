# Chrome Extension — Implementation Notes

Technical notes on how the extension works, what was ported from Claude Code, and known limitations.

## Architecture

```
Content Script (per tab)              Background Service Worker
├── content.ts                        └── background.ts
│   ├── init()                            └── CORS proxy for API calls
│   │   ├── loadConfig() from storage
│   │   ├── findAndAttach() target div
│   │   └── bodyObserver for SPA nav
│   │
│   ├── bootstrap(target, config)
│   │   ├── CueEngine (core/cue-engine.ts)
│   │   ├── HighlightRenderer (ui/highlight-renderer.ts)
│   │   ├── WordNavigator (ui/word-navigator.ts)
│   │   └── StatusBar (ui/status-bar.ts)
│   │
│   ├── Three-tier analysis trigger     Popup (popup/popup.ts)
│   │   ├── Tier 1: Space (50ms)        ├── Config paste UI
│   │   ├── Tier 2: Idle (300ms)        ├── Save → chrome.storage
│   │   └── Tier 3: Edit (50ms)         └── Fields: apiKey, cuesMd,
│   │                                       blanksMd, opencuesMd, tipsJson,
│   └── Blank auto-populate (500ms)         model, targetSelector, etc.
│       ├── Keyword matching
│       ├── Keyword expansion
│       ├── Keyword clearing
│       └── Consume-all (prompt improver)
```

## Data Flow

### Typing → Analysis → Rendering

1. User types in target element
2. `input` event fires → 3-tier debounce cascade:
   - Space typed (word count increased) → 50ms debounce
   - Word edited mid-text → 50ms debounce
   - Idle pause → 300ms debounce
3. `engine.analyze(text)` runs:
   - Phase 1: Instant tips lookup via `lookupMultiple()` (O(1) per word)
   - Phase 2: Async LLM resolution via `resolver.resolve()`
4. `convertCueResultsToWordDefs()` cleans alternatives (strip punctuation, dedupe)
5. `mergeWordDefs()` merges with existing state:
   - Tips entries protected (`protectSource: 'tips'`)
   - Control-blank entries protected (`protectControlName: true`)
   - Alts merged (new first, then unique old, stale prefixes filtered)
   - `currentAltIndex` preserved from cycling state
6. `engine.onUpdate()` fires → `renderer.render()` applies CSS classes
7. `statusBar.update()` shows cueTip if word is highlighted

### Navigation → Cycling → Text Replacement

1. User presses Ctrl+Alt+Right/Left → `navigate()` in WordNavigator
2. Builds navigable index list (words with alts, step patterns, consume-all)
3. Updates `HighlightState` → `notify()` → re-render with `.oc-word--active`
4. User presses Ctrl+Alt+Up/Down → `cycle()` in WordNavigator
5. Delegates to `engine.cycle()` which checks priority order:
   - Blanks (via `controlAction()`)
   - Selector word cycling (opencues.md settings)
   - Satellite word cycling (opencues.md values)
   - Consume-all cycling (dedicated state)
   - Step number cycling (arithmetic with step/min/max/suffix)
   - Dynamic alt cycling (LLM/tips alternatives + linked words)
6. Returns `CycleResult` with new text, position info, word def
7. `setText()` applies via `execCommand('insertText')` (preserves undo)
8. `setCursorPosition()` places cursor after changed word
9. If word count changed: downstream WordDef indices shifted, navigation recomputed

### Blank Auto-Populate

1. User types `_` with a control keyword nearby (e.g., "stocks aapl _")
2. 500ms debounce fires → `checkBlanks()`
3. `matchControlKeyword()` scans within proximity for keyword matches
4. If keyword found and has expansion (e.g., "aapl" → "Apple"), applies it
5. If `clearKeywords: true` (prompt improver), removes keyword words from text
6. Calls `engine.controlGet(controlName, keyword, context)` → browser control
7. For consume-all blanks: replaces entire text, populates `engine.consumeAllAlts`
8. For regular controls: replaces `_` with fetched value

## Cycling Priority Order

Matches Claude Code exactly (dynamicHighlight.ts `_cycleAlt`):

1. **Blanks** — browser controls (volume up/down)
2. **Selector word** — cycles opencues.md setting names, updates satellite
3. **Satellite word** — cycles values for current setting
4. **Consume-all** — dedicated `consumeAllAlts` state, separate from `words[]`
5. **Step numbers** — arithmetic cycling with step/min/max/format/suffix
6. **Dynamic alts** — LLM/tips alternatives with linked word synchronization

## State Management

### CueEngine State

| Field | Type | Purpose |
|-------|------|---------|
| `words` | `WordDef[]` | Current word definitions (alts, tips, linked indices) |
| `spans` | `Record<number, SpanInfo>` | Multi-word span tracking |
| `consumeAllAlts` | `ConsumeAllState \| null` | Consume-all cycling state (isolated from `words`) |
| `dismissedBlanks` | `Set<number>` | Positions where user cycled back to `_` |
| `pendingClearOnEdit` | `number[] \| null` | Queued word removals for blankClearOnEdit |
| `openCues` | `OpenCuesState` | Settings, current values, tips from opencues.md |
| `stepPatterns` | `Array<{re, ctrl}>` | Compiled step patterns from controls config |

### Cleanup Rules

- **Consume-all**: Cleaned unconditionally on ANY text change (not gated by highlight state)
- **Dismissed blanks**: Cleared on any text change
- **blankClearOnEdit**: Executed on next input event, unconditionally
- **All state**: Cleared on `engine.clear()` (called by `teardown()`)

## opencues-core Integration

### Functions used from opencues-core

| Function | Used for |
|----------|----------|
| `parseCuesMd()` | Parse cues.md, blanks.md config |
| `buildSourcesFromConfig()` | Create LLM sources (with controls passed through) |
| `createResolver()` | Build async LLM resolver |
| `lookupMultiple()` | O(1) tips lookup (with `skipFn` for ignore filtering) |
| `mergeWordDefs()` | Merge word definitions (with `mergeAlts`, `protectSource`, `protectControlName`) |
| `convertCueResultsToWordDefs()` | Clean CueResult[] → WordDef[] (punctuation strip, dedupe) |
| `cleanAlternatives()` | Used internally by `convertCueResultsToWordDefs` |
| `buildLookupMap()` | Build tips hash map from parsed JSON |
| `parseLocalCueFile()` | Parse tips JSON |
| `validateLocalCueData()` | Validate tips JSON structure |

### Extension-specific logic (not in opencues-core)

- Cycling state machine (priority order, linked words, spans, index shifting)
- opencues.md parser (line-by-line walker — opencues-core doesn't parse this format)
- Keyword matching for blank auto-populate (opencues-core's `BlankSource` uses bash)
- DOM rendering (CSS classes on spans)
- Cursor management (Selection/Range API)

## Browser-Native Controls

| Control | API | Behavior |
|---------|-----|----------|
| Volume | Web Audio GainNode | Tab audio 0-100%, 6% steps |
| Stocks | fetch → Finnhub | Read-only, keyword → ticker → price, 1min cache |
| Weather | fetch → Open-Meteo | Read-only, geocode + forecast, 5min cache |
| Hacker News | fetch → hnrss.org | Read-only, RSS → DOMParser, 5min cache |
| Prompt Improver | fetch → LLM API | Two-step Extract→Transform pipeline, 3 alternatives |

## Event Listener Lifecycle

All inline event listeners use `AbortController` signal. On `teardown()`:
1. `abortController.abort()` — removes all `addEventListener` calls with `{ signal }`
2. `nav.destroy()` — removes keydown + input listeners
3. `renderer.destroy()` — removes ResizeObserver, overlay element
4. `statusBar.destroy()` — removes status bar element
5. `domObserver.disconnect()` — stops MutationObserver
6. `bodyObserver.disconnect()` — stops target search
7. All timers cleared

## Rendering

Uses the **CSS Custom Highlight API** (`CSS.highlights` + `::highlight()`) on `contenteditable` elements only. See `docs/rendering.md` for the full story — we tried 5 approaches (overlay, inline spans, backdrop mirror, element swap, Highlight API) before settling on this one.

Three highlights create a brightness hierarchy:
- `oc-dim` (`#555`) — selectable words with alternatives (darkest)
- `oc-base` (`#999`) — normal words without alternatives (mid)
- `oc-active` (`#fff`) — currently highlighted word (brightest)

**During typing:** Highlights render immediately after LLM analysis completes (~500ms). Zero DOM modification — cursor, selection, undo history never disrupted.

**During cycling:** Text is changed via `textNode.data` (preserves the text node), then highlights are rebuilt in `requestAnimationFrame` (after text mutation settles, before paint). This prevents the "white flash" that occurs when highlight ranges are invalidated by text changes.

## Supported Elements

- **`contenteditable` divs** — full per-word coloring via CSS Highlight API. This covers most modern web apps (Google Docs, Notion, Slack, ChatGPT, VS Code web).
- **`<textarea>` / `<input>`** — not supported. The Highlight API cannot style text inside native form controls (their content isn't in the DOM tree). We tried replacing them with contenteditable divs but it broke page CSS. This is a known browser platform limitation.

## Known Limitations

- **Contenteditable only**: No textarea/input support (see above)
- **System volume/brightness**: Tab-scoped only (browser sandbox)
- **Selector/satellite persistence**: In-memory only, no file writeback
- **Silent LLM errors**: Catch blocks don't surface errors to user
- **Duplicate word ambiguity**: `indexOf()` for word position can match wrong instance
- **Stocks without API key**: Returns "no API key" text instead of empty
- **Firefox**: CSS Custom Highlight API not supported — no visual highlighting
- **LLM variance**: Same model can return inconsistent alt quality between calls
- **`::highlight()` styling**: Only color, background-color, text-decoration, text-shadow (no borders, padding, font changes)
- **Cycling white flash**: Minimal but can occur on very slow machines — `requestAnimationFrame` timing between text change and highlight rebuild
