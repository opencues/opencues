---
last_updated: 2026-04-06
---

# Auto-Submit Trigger

Analysis fires automatically as the user types, without requiring an explicit submit action. A three-tier trigger system detects when words are ready for analysis and invokes the resolver after a debounce period and stability check.

---

## How It Works

1. **On every text change**, the auto-submit code (`writeAutoSubmitDebounced`) runs inside the render loop
2. **Hot-reload check** — if no LLM request is in flight and `Date.now() - _configLoadedAt > 2000`, `_reloadCuesConfig()` fires before any analysis logic
3. **Eager tips lookup** — before debouncing, all current words are checked against `_localCueMap` via `cuesCore.lookupMultiple()`. Matching words get their `WordDef` entries immediately (~0ms), dimming them in the input before the LLM round-trip
4. **If all words resolved from tips** (no missing indices and no blanks), the 50ms debounce timer still fires, but `_dynTriggerAnalysis` returns early because `_dynLastAnalyzed` is already up to date. No LLM call is made
5. **Otherwise**, a 50ms debounce timer fires, followed by a stability check, then `_dynTriggerAnalysis()` runs the full LLM pipeline

---

## Three-Tier Trigger

| Tier | Condition | Debounce | Purpose |
|------|-----------|----------|---------|
| 1 — Space typed | `_curWords.length > _prevWords.length` | 50ms + stability check | The previous word is complete; analyze it |
| 2 — Typing pause | Last word differs from last analyzed word | 300ms + stability check | Catches the final word when the user stops typing without a trailing space |
| 3 — Mid-sentence edit | `_curWords.length === _prevWords.length` but a word changed | 50ms + stability check | Re-analyze the changed word |

**Tier 1** fires on the main debounce path. The code detects `_curWords.length > _prevWords.length` and sets `_needsAnalysis = true`.

**Tier 2** uses a separate timer (`_dynFinalPauseTimer`). After any text change, if the last word differs from the last analyzed word, a 300ms `setTimeout` is set. When it fires, it re-checks that the last word still differs (stability check) and calls `_dynTriggerAnalysis()`.

**Tier 3** fires when word count is unchanged but the joined text differs from `_dynLastAnalyzed`. The same 50ms debounce path as Tier 1 handles it.

All three tiers clear `_dynFinalPauseTimer` on text change to prevent stale pause triggers from firing.

---

## Word Stability Check

After the debounce timer fires, the system verifies the text has not changed since the timer was set:

```
var _nowText = hlText.split(/\s+/).filter(w => w).join(" ");
var _thenText = _curWords.join(" ");
if (_nowText !== _thenText) return;  // skip — next keystroke re-triggers
```

This prevents false triggers from rapid typing. If the user types "hel" then quickly "lo", the 50ms timer from "hel" fires but sees "hello" and aborts. The timer from "hello" then fires cleanly.

**Additional guards:**
- `_dynPending` flag prevents overlapping LLM requests. If a request is in flight, the trigger is skipped. When the response returns, a post-check detects if the text changed during the call and re-triggers if needed
- `_resolverGeneration` counter — incremented on config reload. In-flight responses from an old generation are discarded
- `_dynUnderscoreQueued` — when a blank's context changes, a re-analysis is queued for the next available slot

---

## Portability

### Standard (cues-core)

- The resolver is stateless — it accepts text and word indices, returns results, and has no opinion on when it is called
- No built-in debounce, timer, or text-change detection
- Supports targeted indices so the caller can request analysis for specific words only
- Returns results keyed by word index, allowing incremental merging with previous results

### Integration responsibilities

- Implement a debounce strategy for each trigger tier (space-typed, typing pause, word-edited)
- Detect text changes and determine which words changed (new, edited, deleted)
- Track pending/in-flight request state to prevent duplicate LLM calls
- Perform the stability check (verify text hasn't changed between debounce fire and actual submission)
- Merge incremental results into the existing alternatives map
- Decide when to skip remote cues (all words already have alternatives)
