---
last_updated: 2026-04-10
---

# Creating a New Cue Type

This guide explains what parts of the system you need to touch when creating a new kind of cue, when you need dedicated cycling variables, and why. It uses the "consume-all" prompt improver as a worked example.

## The five systems a cue type can touch

Every cue type interacts with some subset of these systems. Understanding which ones you need — and which you can skip — determines the scope of your implementation.

### 1. Config parsing (`cues-md.ts`)

**What:** New frontmatter fields in `cue.md` files.

**When you need it:** Your cue type has configuration that other types don't (e.g., `blankConsumeAll`, `blankDismissible`, `stepSuffixes`).

**Touch points (4 locations per field):**
- `ControlConfig` interface — add the field type
- `SingleCueFrontmatter` interface — add to the frontmatter type
- `parseExtendedFrontmatter` switch — parse the YAML value
- `parseSingleCueMd` control branch — copy from frontmatter to control config

These four must stay in sync. Miss one and the field silently drops.

### 2. Source resolution (`control-blank-source.ts`)

**What:** How the blank `_` gets resolved to alternatives.

**When you need it:** Your cue type triggers from a blank and produces results differently from existing patterns (scalar, list, selector+satellite).

**Existing patterns you can reuse:**
- Script returns one line → scalar value (numeric cycling)
- Script returns multiple lines → dynamic list (cycling through options)
- Script returns tab-delimited → selector + satellite pair

If your cue type fits one of these, you only need config changes. If not, you may need a new resolution path.

### 3. Auto-populate (`wordHighlight.ts`)

**What:** How the resolved value replaces `_` in the text and what state gets set up.

**When you need it:** Your cue type needs special handling during the text replacement step — e.g., clearing all surrounding words, setting up dedicated storage, or creating span tracking for multi-word results.

**Key state set during auto-populate:**
- `globalThis._hlText` / `_dynLastAnalyzed` / `_dynPrevWords` — text tracking
- `globalThis._dynSpans` — multi-word span entries
- `globalThis._pendingCursorOffset` — where the cursor lands after replacement

### 4. Cycling (`dynamicHighlight.ts` → `_cycleAlt`)

**What:** What happens when the user presses Alt+Up/Down on the result.

**When you need it:** Always, if your cue type supports cycling. The question is whether you can use the existing dynamic alt cycling path or need a dedicated one.

### 5. Rendering (`wordHighlight.ts` → rendering code)

**What:** How the highlighted word appears visually — single word, full span, dimmed neighbours.

**When you need it:** If your cue type uses multi-word spans and needs the full span highlighted (not just the origin word).

---

## Decision: dedicated variable or `_dynDefs`?

The central architectural decision: does your cue type store its cycling state in `_dynDefs.words` (the shared WordDef array) or in a dedicated global?

### Use `_dynDefs` when:
- Your result is a **single word** (no span collisions)
- Your alternatives are **simple word swaps** at one index
- Grammar/tips analysis won't **overwrite** your WordDef (because `metadata.controlName` guards protect it at the same index)

Examples: scalar blanks (volume `50`), read-only blanks (stock prices).

### Use a dedicated global when:
- Your result is **multi-word** AND the user cycles through alternatives
- After `blankConsumeAll` clearing, **multiple WordDefs collide** at the shifted index (the grammar one and yours — `find()` returns the wrong one)
- The tips-only fast path or grammar analysis **replaces `_dynDefs`** and your WordDef is lost
- You need cycling state to **survive** arbitrary `_dynDefs` overwrites

Examples: consume-all controls (prompt improver).

### The existing dedicated globals

Each cycling mechanism has its own storage because `_dynDefs` can't reliably hold its state:

| Cue type | Storage | Why not `_dynDefs` |
|----------|---------|-------------------|
| Word controls (volume, brightness) | `_cueControlOverrides` | Script-based, no LLM alts |
| Selector+satellite (opencues settings) | `_openCuesSettings` | Setting names/values are separate from word alts |
| Step controls (numbers, units) | `_stepPatterns` | Regex-matched arithmetic, not word alternatives |
| **Consume-all (prompt improver)** | **`_consumeAllAlts`** | Multi-word span, index collisions after clearing |

---

## When you add a new dedicated global

If you decide your cue type needs its own variable, you must handle these concerns. Each one was discovered during the prompt improver implementation — skipping any of them causes a specific failure.

### A. Data pipeline: resolver → auto-populate → global

**Problem:** The resolver creates results with your alternatives. But the auto-populate code in `wordHighlight.ts` needs to store them in your global. If auto-populate looks up the WordDef in `_dynDefs` to get the alts, it may find the wrong WordDef (index collisions after clearing).

**Solution:** Pass the alternatives through `_pendingAutoPopulate` directly. Add your data to the `_pendingAutoPopulate` object in the resolver callback (`dynamicHighlight.ts`), then read it in `wordHighlight.ts` without any `_dynDefs` lookup.

```
Resolver callback (dynamicHighlight.ts)
  → _pendingAutoPopulate.myAlts = [...]

Auto-populate (wordHighlight.ts)
  → globalThis._myGlobal = { alts: _ap.myAlts, ... }
```

### B. Cycling path: position in `_cycleAlt`

**Problem:** The `_cycleAlt` function checks cue types in order. Your cycling code must run **before** dynamic alt cycling (the fallback), otherwise the grammar WordDef at the same index handles the keypress instead.

**Solution:** Insert your cycling block between step controls and dynamic alt cycling in `_cycleAlt`. The order is:

1. Cue-control overrides (word-level scripts)
2. Control-bound blank cycling (numeric blanks)
3. Selector word cycling
4. Satellite word cycling
5. Step control cycling
6. **Your new cycling path** ← here
7. Dynamic alt cycling (grammar/tips fallback)

### C. State updates in cycling

**Problem:** After cycling changes text, various systems detect the change and react. If you don't update the right globals, they'll interfere.

**Required state updates after text replacement:**

| Global | What happens if you skip it |
|--------|---------------------------|
| `_hlText` | Cached text out of sync — highlight deactivates on next onChange |
| `_hlState.text` | Same as above — `_oldText` comparison fails |
| `_hlState.wordIndex` | Highlight drifts to wrong word after cycling |
| `_dynLastAnalyzed` | Analysis debounce detects "changed text" → fires re-analysis → grammar alternatives overwrite spans |
| `_dynPrevWords` | Same — must be updated alongside `_dynLastAnalyzed` |
| `_dynSpans` | Old span entries linger → navigation/rendering breaks for new word count |
| Your global's `spanLength` | Next cycle uses wrong span boundaries for text replacement |

Compare with **dynamic alt cycling** (Path 7): it only updates `_hlText`, `_hlState.text`, and `_dynSpans`. It does NOT update `_dynLastAnalyzed`/`_dynPrevWords`. It can skip these because its WordDef in `_dynDefs` is protected by `metadata.controlName` guards during the merge path. Your dedicated global doesn't have that protection — the analysis will overwrite `_dynDefs` and break your spans if you don't prevent it.

### D. Per-word clearing skip

**Problem:** The `writeDynamicClearOnChange` code runs on every onChange. When words change between renders, it finds the WordDef at that index and checks if the new word is in its alts. If not, it clears the WordDef and **deletes the `_dynSpans` entry**.

After your cycling changes the text, every word in the span "changed" from the clearing code's perspective. It deletes the span entries one by one. Next cycle: span resolution fails, your cycling code doesn't fire, grammar alternatives take over.

**Solution:** Skip positions covered by your global:

```javascript
if (globalThis._myGlobal) {
  var _s = globalThis._myGlobal;
  if (_wi >= _s.index && _wi < _s.index + (_s.spanLength || 1)) continue;
}
```

### E. Cleanup on user edit

**Problem:** After your global is set and spans are active, the user might start typing new text. If your global persists, the old span locks those positions — the user's new text is still treated as part of the span.

**Solution:** Clear your global, its span entries, AND the control-blank WordDefs at those positions from `_dynDefs`. This check must run **unconditionally** — outside the `_hlState.active` guard — because the highlight may already be inactive when the user types over the span. Cycling doesn't trigger this because it pre-sets `globalThis._hlText` before onChange fires, so `_hlText === _oldText` during cycling.

```javascript
// OUTSIDE the _hlState.active guard — must fire even when highlight is already inactive
if (_hlText !== _oldText && globalThis._myGlobal) {
  var _c = globalThis._myGlobal;
  for (var _i = 0; _i < (_c.spanLength || 1); _i++) {
    if (globalThis._dynSpans) delete globalThis._dynSpans[_c.index + _i];
  }
  // Remove stale control-blank WordDefs at span positions
  if (globalThis._dynDefs && globalThis._dynDefs.words) {
    globalThis._dynDefs.words = globalThis._dynDefs.words.filter(function(d) {
      return d.index < _c.index || d.index >= _c.index + (_c.spanLength || 1);
    });
  }
  globalThis._myGlobal = null;
}
```

This must run before (or independently of) the `_hlState.active` block. `_dismissedBlanks` and `_hlState` are cleared inside that block because they're only relevant when the highlight is active. Your global must clear unconditionally — if the user navigates away (deactivating the highlight) and then edits, `_hlState.active` is already false and the inner block never runs.

**Pitfall: stale `cueTip` after clearing.** When the blank originally resolved, a WordDef was created in `_dynDefs` with `metadata.controlName` and your `cueTip`. After clearing your global, this WordDef persists. The LLM merge path in `dynamicHighlight.ts` guards: `if(_oldW2.metadata.controlName && !_nw2.metadata.controlName) continue` — it skips grammar results for control-blank positions. So the fresh analysis of the user's new text updates the `alts` but the old `cueTip` is never overwritten. The user sees correct alternatives but the wrong tip label. Removing the WordDefs from `_dynDefs` during cleanup unblocks the guard so the next analysis populates cleanly.

### F. Rendering span length

**Problem:** The highlight rendering computes `_hlSpanLen` from `_dynDefs.words[].spanLength`. Your global's spanLength isn't in `_dynDefs`, so only the first word gets the bright highlight.

**Solution:** Add a parallel check in the rendering code (both paths — number-dimming enabled and disabled):

```javascript
if (globalThis._myGlobal
    && globalThis._myGlobal.index === _hlWordIdx
    && globalThis._myGlobal.spanLength > _hlSpanLen) {
  _hlSpanLen = globalThis._myGlobal.spanLength;
}
```

---

## Worked example: prompt improver

The prompt improver is a consume-all control that clears the entire input and replaces it with an LLM-improved version of the user's prompt.

### Config (`controls/prompt/cue.md`)
```yaml
---
name: prompt
type: control
control: prompt
blankKeywords: improve prompt, enhance prompt, refine prompt
blankAutoPopulate: true
blankFormat: string
blankScript: ./prompt-blank.sh
blankClearKeywords: true
blankConsumeAll: true
blankTip: Prompt improver
---
```

### New config field: `blankConsumeAll`

Expands `matchedKeywordIndices` to include ALL non-blank positions. Added in `control-blank-source.ts` after keyword index computation:

```typescript
if (matched.blankConsumeAll) {
  for (let i = 0; i < context.words.length; i++) {
    if (i !== blankIndex && !matchedKeywordIndices.includes(i)) {
      matchedKeywordIndices.push(i);
    }
  }
  matchedKeywordIndices = [...new Set(matchedKeywordIndices)].sort((a, b) => b - a);
}
```

### New dedicated global: `_consumeAllAlts`

```javascript
globalThis._consumeAllAlts = {
  index: 0,              // Span origin (shifted after clearing)
  alts: [...],           // The N alternatives from the script
  currentAltIndex: 0,    // Which alt is currently displayed
  spanLength: 12,        // Word count of current alt
  cueTip: "Prompt improver",
  controlName: "prompt"
};
```

### Files changed

| File | Changes |
|------|---------|
| `cues-md.ts` | Parse `blankConsumeAll` (4 locations: interface, frontmatter type, parser switch, control assignment) |
| `control-blank-source.ts` | Expand `matchedKeywordIndices` when `blankConsumeAll` (after existing keyword index computation) |
| `dynamicHighlight.ts` | Consume-all cycling path in `_cycleAlt` (before dynamic alt cycling), `consumeAllAlts`/`consumeAllTip` fields in `_pendingAutoPopulate` (in resolver callback), per-word clearing skip (in `writeDynamicClearOnChange`) |
| `wordHighlight.ts` | `_consumeAllAlts` storage from `_pendingAutoPopulate` (in simple value auto-populate path), span highlight from `_consumeAllAlts` (in both render paths), WordDef index shift after keyword clearing |

### Script (`controls/prompt/prompt-blank.sh`)

Two-step LLM calls (model + prompts read from `cue.md`, defaults to Groq with `openai/gpt-oss-120b`):
1. **Extract:** Separate prompt from activation keywords and conditions
2. **Improve:** Generate 3 improved versions (newline-separated → dynamic list pattern)
3. **Original prompt:** Appended as the last line so the user can cycle back to their original text (without activation keywords)

Must complete within 6 seconds (`execFileSync` timeout). Post-processes output to guarantee exactly 3 clean improved lines + 1 original. The script reads all config from `cue.md` — no hardcoded prompts, model, or API endpoint.

---

## Checklist for new cue types

- [ ] **Config fields** — added to `ControlConfig`, `SingleCueFrontmatter`, `parseExtendedFrontmatter`, `parseSingleCueMd`?
- [ ] **Source resolution** — fits existing pattern (scalar/list/satellite) or needs new path?
- [ ] **Dedicated global needed?** — multi-word + cycling + analysis interference?
- [ ] **Data pipeline** — alts flow through `_pendingAutoPopulate`, not `_dynDefs` lookup?
- [ ] **Cycling path** — inserted before dynamic alt cycling in `_cycleAlt`?
- [ ] **State updates** — all 7 globals updated after cycling? (see table in section C)
- [ ] **Per-word clearing** — span positions skipped in `writeDynamicClearOnChange`?
- [ ] **Cleanup on user edit** — global, spans, and `_dynDefs` control-blank WordDefs at span positions all cleared unconditionally on text change (outside `_hlState.active` guard)?
- [ ] **Rendering** — span length checked from your global in both render paths?
- [ ] **Dismiss tracking** — if `blankDismissible`, `_dismissedBlanks` updated when cycling to `_`? Alternatively, include the original input as a cycling option instead of `_`.
- [ ] **Script** — completes within 6s, returns expected format?
