# Chrome Extension vs Claude Code: Parity Notes

What the Claude Code patches handle that the Chrome extension doesn't need, handles differently, or has known divergence.

## Not Needed (browser eliminates the problem)

### Invisible Character Toggle (\u200B / \u200C)
**Claude Code:** Appends alternating zero-width characters to force React re-renders.
**Chrome Extension:** Not needed. DOM mutations are immediate. `MutationObserver` detects external changes.

### ZWS Double-Correction
**Claude Code:** Cursor fix must pass clean text to avoid the ZWS strip block subtracting again.
**Chrome Extension:** No ZWS in text. Cursor managed via `Selection`/`Range` API.

### `InputZone.fromText()` + `onOffsetChange()` Persistence
**Claude Code:** Must call `onOffsetChange()` to persist cursor in React state.
**Chrome Extension:** `Selection`/`Range` API is stateful — persists until next user action.

### Raw Terminal Escape Sequences
**Claude Code:** Fallback for `\x1B[1;7D` etc.
**Chrome Extension:** Browsers fire proper `KeyboardEvent` objects.

### ANSI Escape Code Rendering
**Claude Code:** ~200 lines of char-by-char ANSI position tracking.
**Chrome Extension:** CSS classes on `<span>` elements.

### `require()` Function Name Discovery
**Claude Code:** Bundled `cli.js` renames `require`.
**Chrome Extension:** Standard ES module imports.

### Render-Cycle Execution Order
**Claude Code:** Cursor fix must run before auto-populate in same render cycle.
**Chrome Extension:** No render cycle — DOM changes are immediate.

### External Highlight Preservation (shimmer)
**Claude Code:** Skips ANSI wrapping for words with shimmer highlights.
**Chrome Extension:** No shimmer component. Overlay has `pointer-events: none`.

### File-Based State Export
**Claude Code:** Writes JSON to `/tmp/` for shell status line.
**Chrome Extension:** In-memory state + DOM status bar.

### Process-Based TTS
**Claude Code:** Spawns `SpeakCtl.exe` or `speak.sh`.
**Chrome Extension:** Native Web Speech API.

## Handled Differently

### Config Loading
**Claude Code:** `fs.readFileSync()` with 2-second hot-reload TTL polling.
**Chrome Extension:** User pastes into popup. `chrome.storage.local` with `onChanged` listener (event-driven, no polling).

### Control Script Execution
**Claude Code:** `child_process.execSync("bash script.sh get/set")`.
**Chrome Extension:** Browser-native: Web Audio (volume), `fetch()` (stocks/weather/HN).

### Text Replacement
**Claude Code:** `onChange(newFullText)` replaces entire input.
**Chrome Extension:** `document.execCommand('insertText')` preserves undo history.

### Selector/Satellite Script Calls
**Claude Code:** `execFileSync("bash", [script, "set", setting, value])` writes back to opencues.md synchronously.
**Chrome Extension:** In-memory only — `openCues.current[setting] = newValue`. No file writeback. **Divergence:** changes don't persist across page reloads. User must update opencues.md in popup manually.

### Keyword Expansion
**Claude Code:** Replaces typed shorthand (`aapl` → `AAPL`) using `keywordExpansion` from resolver metadata.
**Chrome Extension:** Implemented via `ControlKeywordConfig.expansions` map in `controls/index.ts`. Expansion happens in the auto-populate flow before blank fill. **Full parity** for built-in controls (stocks). Custom expansions require adding entries to the config.

### Keyword Clearing (blankClearKeywords)
**Claude Code:** Removes context words before blank fill, shifts all downstream indices (descending order).
**Chrome Extension:** Implemented in auto-populate flow. Keywords removed in descending index order, blank index adjusted per removal. **Full parity.** Used by prompt improver control (`clearKeywords: true`).

### System Volume / Brightness
**Claude Code:** Controls actual system volume/brightness via OS APIs.
**Chrome Extension:** Volume is tab-scoped only (Web Audio GainNode). Brightness not controllable. **Divergence:** no system-level hardware control.

## Known Divergence

### Selector/Satellite Persistence
**Claude Code:** Satellite cycling writes back to opencues.md via script, persisting across sessions.
**Chrome Extension:** In-memory only. Setting changes are lost on page reload. To persist, the user must update opencues.md content in the popup.

### Keyword Expansion/Clearing
**Claude Code:** Auto-populate expands shorthand keywords and clears context words before filling.
**Chrome Extension:** Implemented. Expansion via `ControlKeywordConfig.expansions`, clearing via descending-order removal with blank index adjustment. **Full parity.**

### blankClearOnEdit — Text Removal
**Claude Code:** When user edits over a control-blank pair with `blankClearOnEdit: true`, the pair is removed from text entirely (selector + separator + satellite deleted).
**Chrome Extension:** Implemented — pair indices are queued in `pendingClearOnEdit` and removed on next input event. **Same behavior**, but uses `execCommand('insertText')` instead of `onChange()` for the text replacement.

### Consume-All — Two-Step LLM Pipeline
**Claude Code:** The `blankConsumeAll` flow has a two-step LLM pipeline (extract → transform) via `prompt-blank.sh`. Cycling state in dedicated `_consumeAllAlts`.
**Chrome Extension:** Fully implemented. `PromptImproverControl` (`controls/prompt-improver.ts`) runs the same two-step pipeline (Extract → Transform) using `fetch()` to the LLM API. Returns newline-separated alternatives. Auto-populate in `content.ts` detects "improve prompt" keywords, calls the control, populates `engine.consumeAllAlts`, and replaces the full text with the first alternative. Cycling and unconditional cleanup are handled by the engine. **Full parity** (same prompts, same parsing, same fallbacks).

### opencues.md Parser — Regex Avoidance
**Claude Code:** Learned the hard way that regex for frontmatter parsing fails silently due to escape-sequence interactions across TypeScript template → patched string → runtime regex.
**Chrome Extension:** Uses the same line-by-line walker approach (no regex for frontmatter). **Full parity.**

### Cycling Priority Order
**Claude Code:** Strict order: cue-controls → control-blanks → selector → satellite → consume-all → step → dynamic alts → tips.
**Chrome Extension:** Same order enforced in `cycle()` method. Control-bound blanks are handled separately via `controlAction()` in word-navigator before the main `cycle()` call. **Full parity.**

### Voice-Mode Gate
**Claude Code:** Checks `_openCuesCurrent["voice-mode"]` synchronously before every TTS spawn. Satellite cycling updates this in-memory immediately.
**Chrome Extension:** Same — `isVoiceMuted()` checks `openCues.current["voice-mode"]`. Satellite cycling updates in-memory immediately. **Full parity.**

### Stale Result Rejection
**Claude Code:** `_resolverGeneration` counter incremented on config rebuild. Results from old generation are discarded.
**Chrome Extension:** Same — `resolverGeneration` counter in CueEngine. **Full parity.**

### Linked Word Atomicity
**Claude Code:** All linked word replacements in single pass via `_updW` map.
**Chrome Extension:** Same — `updatedWords` map, sequential forward walk. **Full parity.**

### controlName Merge Guard
**Claude Code:** `if(_oldW2.metadata.controlName && !_nw2.metadata.controlName) continue` — prevents LLM overwriting control-blank positions.
**Chrome Extension:** Same guard in analysis merge loop. **Full parity.**

### Unconditional Consume-All Cleanup
**Claude Code:** `_consumeAllAlts` cleanup runs OUTSIDE `_hlState.active` guard on text change.
**Chrome Extension:** Same — cleanup runs in `analyze()` which fires on every input event, regardless of highlight state. **Full parity.**

### blankClearOnEdit Cleanup Outside Highlight Guard
**Claude Code:** `_pendingClearOnEdit` words are removed unconditionally on text change.
**Chrome Extension:** Same — `executeClearOnEdit()` is called at the top of the input handler, before any highlight checks. **Full parity.**
