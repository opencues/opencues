---
last_updated: 2026-04-13
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
| 15 | Weather control | `London weather _` fills with current weather |
| 16 | Stocks control | `AAPL _` fills with stock price (needs Finnhub key) |
| 17 | Hackernews control | `hackernews _` fills with headlines, cycle through |
| 18 | Prompt improver | `improve write a poem _` replaces with improved versions |
| 19 | Volume control | `volume _` shows tab audio level (needs audio/video on page) |
| 20 | Selector/satellite | `opencues settings _` shows setting + value pair |
| 21 | Hot-reload | Config changes in popup take effect without page reload |
| 22 | Input swapping | Works on textarea (swapped to contenteditable) and native contenteditable |
| 23 | CORS fallback | Stock API falls back to background service worker proxy |

## Bugs Fixed During Testing

| Bug | Fix |
|-----|-----|
| Tips not loading — `DEFAULT_TIPS_JSON` never wired into config | Added `__DEFAULT_TIPS_JSON__` build-time define from tips.json, used in `DEFAULT_CONFIG` |
| Stored empty `tipsJson` overriding non-empty default | `loadConfig()` skips empty stored values when default is non-empty |
| Tips not instant — buried in async `analyze()` behind debounce | Added synchronous `lookupTipsSync()` called directly on input event |
| Re-analysis of already-rendered words | Tier 2 idle timer skipped when tier 1/3 already fired; tips skip words with existing defs |
| Multi-word spans not rendering as one unit | Renderer now accepts `engine.spans`, highlights full active span, dims non-origin span words |
| Manifest paths mismatched flat copy | Desktop copy uses `dist/` subfolder matching manifest `dist/` paths |
