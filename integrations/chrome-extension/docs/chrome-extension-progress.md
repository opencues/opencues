---
last_updated: 2026-04-15
---

# Chrome Extension — Testing Progress

Tracking what has been manually verified in the Chrome extension integration.

## Verified Working

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | Build | ✅ | `npm run build` produces dist/ with content.js, background.js, popup |
| 2 | Load extension | ✅ | Load unpacked from dist/ folder, no errors |
| 3 | Popup config | ✅ | API key saves and persists across popup close/reopen |
| 4 | Target element | ✅ | Finds contenteditable elements |
| 5 | Visual cues (dimming) | ✅ | Words with alts dim gray after analysis |
| 6 | Navigation | ✅ | Ctrl+Alt+Left/Right moves highlight between navigable words |
| 7 | Cycling | ✅ | Ctrl+Alt+Up/Down cycles alternatives, multi-word spans grouped |
| 8 | Escape | ✅ | Clears highlight |
| 9 | Clear on typing | ✅ | Highlight clears when user types |
| 10 | Status bar | ✅ | Shows tip and alt index in bottom-right corner |
| 11 | TTS | ✅ | Speaks tip on navigation when enabled in popup |
| 12 | Instant tips | ✅ | Tips words dim immediately on input (synchronous lookup, no LLM wait) |
| 13 | Multi-word spans | ✅ | "deep thinking", "think harder" highlight as single unit during cycling |

## Not Yet Tested

| # | Feature | Notes |
|---|---------|-------|
| 14 | Blanks | ✅ | `2 + 2 = _` fills with `4` |
| 15 | Weather control | ✅ | `london weather _` fills with temp + condition, keyword cleared, rAF render fix |
| 16 | Stocks control | ✅ | `reddit stock _` fills with price, multi-word ticker map, closest-match proximity |
| 17 | Hackernews control | ✅ | `hackernews _` fills first headline, cycle through 20, expansion (`hn`→`HackerNews`), span cleanup on cycle |
| 18 | Prompt improver | ✅ | `improve prompt write a poem _` → 3 improved versions, consume-all cycling, span-safe |
| 19 | Volume control | ✅ | Standalone "volume" word navigable + cyclable, blank "volume _" fills with %, tab audio via Web Audio GainNode |
| 20 | Selector/satellite | ✅ | `opencues settings _` fills paired selector+satellite, multi-word spans, blankClearOnEdit collapses both on edit |
| 21 | Hot-reload | ✅ | Popup save → chrome.storage.onChanged → re-bootstrap. TTS checkbox syncs with voice-mode. Cycling persists back to storage. |
| 22 | Input swapping | Works on textarea (swapped to contenteditable) and native contenteditable |
| 23 | CORS fallback | ✅ | Finnhub, Open-Meteo via host_permissions; HN uses Firebase API (CORS-friendly) |

## Bugs Fixed During Testing

| Bug | Fix |
|-----|-----|
| Tips not loading — `DEFAULT_TIPS_JSON` never wired into config | Added `__DEFAULT_TIPS_JSON__` build-time define from tips.json, used in `DEFAULT_CONFIG` |
| Stored empty `tipsJson` overriding non-empty default | `loadConfig()` skips empty stored values when default is non-empty |
| Tips not instant — buried in async `analyze()` behind debounce | Added synchronous `lookupTipsSync()` called directly on input event |
| Re-analysis of already-rendered words | Tier 2 idle timer skipped when tier 1/3 already fired; tips skip words with existing defs |
| Multi-word spans not rendering as one unit | Renderer now accepts `engine.spans`, highlights full active span, dims non-origin span words |
| Manifest paths mismatched flat copy | Desktop copy uses `dist/` subfolder matching manifest `dist/` paths |
| Weather: "london" colored white after fill | `execCommand` DOM changes need rAF before CSS Highlight ranges stick; deferred render to `requestAnimationFrame` |
| Weather: location extraction returned wrong city | Scan from end of context (matching bash script), not start |
| Stocks: "Unknown: reddit" | Added multi-word entries (`"reddit stock"→RDDT`) to ticker map matching `tickers.json` |
| Stocks: same price for different tickers | Closest-match keyword proximity — pick nearest keyword to blank, not first in list |
| HN: CORS fetch error | Switched from hnrss.org RSS to official HN Firebase API (CORS-friendly) |
| HN: 20 headlines dumped into editor | Multi-line values treated as list alts — display first, cycle rest |
| HN: span breaks on space | `lookupTipsSync` now skips non-origin span positions |
| HN: stale span entries on cycle | Clean up old span entries beyond new span length when cycling to shorter headline |
| Prompt: span breaks on typing | Consume-all cleanup now word-level (only clears when span words change, not trailing spaces/appended words) — matches Claude Code |
| Prompt: not cycling | Consume-all WordDef had `controlName` → navigator routed to `controlAction()` (no-op). Added `consumeAll: true` metadata flag to bypass |
| Prompt: LLM/tips overwriting span words | Re-added `controlName` to consume-all WordDef for LLM protection; `consumeAll` flag routes cycling correctly |
| Consume-all: stale def clearing deleted span entry | Skip stale def clearing for consume-all fills (entire text replaced, no context word to clear) |
| Volume: not navigable | Control-bound blanks with `controlName` and `!blankReadOnly` now navigable |
| Volume: number not updating in text | Navigator controlAction path now replaces word in DOM with returned value |
| Volume: LLM giving word alts for "volume" | Standalone control words skipped in tips + LLM analysis; minimal WordDef created for renderer dimming |
| Selector/satellite: not auto-populating | Implemented satellite branch in checkBlanks, paired WordDefs, span setup |
| Selector/satellite: not cycling | selectorWord/satelliteWord skip controlAction path, fall through to cycleSelector/cycleSatellite |
| Selector/satellite: spans not updating on cycle | cycleSelector now clears old spans, shifts span keys, rebuilds for new word counts |
| Selector/satellite: blankClearOnEdit not firing | Added `invalidateWordsSync()` for immediate per-word invalidation (not 50ms timer) |
| Selector/satellite: executeClearOnEdit returning "" treated as falsy | Changed `if (cleaned)` to `if (cleaned !== null)` |
| Hot-reload: TTS checkbox disconnected from voice-mode | Popup syncs with voice-mode in opencues.md; cycling persists back to chrome.storage |
