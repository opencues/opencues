# Spans and Cycling — Implementation Reference

This is the canonical implementation reference for everything that
happens when a user presses Ctrl+Alt+Up/Down, Left/Right on a word in
the buffer. It complements the feature-level docs in
`docs/features/cycling.md` and `docs/features/multi-word-spans.md`,
which describe the user-visible behaviour.

If you're re-implementing the runtime in a new language, debugging an
edge case, or trying to understand why two pieces of state exist for
something that looks the same — start here.

---

## Where the code lives

**Everything is in `@opencues/runtime`.** Adapters (chrome, claude-code,
opencode, codex) wire it up via `buildSharedRuntime()` and never
re-implement the cycling/span/dim/nav logic. `@opencues/core` is a
separate concern: it does LLM resolution and produces alternatives.

```
packages/opencues-runtime/
├── src/
│   ├── state/
│   │   ├── dyn-defs.ts           ← static-alt span source of truth
│   │   ├── span-fill.ts          ← blank-fill span (single slot)
│   │   ├── highlight-state.ts    ← which word is selected
│   │   ├── dismissed-blanks.ts   ← user said "no" to filling this `_`
│   │   └── selector-satellite.ts ← `opencues settings _` pair
│   └── modules/
│       ├── cycling.ts            ← all Ctrl+Alt+Up/Down dispatch
│       ├── navigation.ts         ← all Ctrl+Alt+Left/Right dispatch
│       ├── dim-render.ts         ← computes dim + highlight ranges
│       ├── blank-fill.ts         ← detects `_`, runs scripts/LLM, registers
│       │                            spans, owns SpanFillState invalidation
│       └── resolver.ts           ← runs the LLM Resolver, populates DynDefs
└── adapters/{cc,oc,chrome,codex}/v*/boot.ts ← per-host wiring
```

---

## Two span systems, two roles

OpenCues has **two different span tracking systems**. They coexist
deliberately because they have different semantics.

### Blank-fill spans (`SpanFillState`)

For: `_` placeholders that get filled by blank scripts or LLM
classifiers. Examples:
- `weather _ paris` → `_` becomes `13.9°C, light cloud`
- `improve prompt write a poem _` → consume-all overwrites the whole
  buffer with the improved prompt
- `volume _` → blankScript writes the current value (`50%`)

**Single-slot** — at any moment, at most ONE blank-fill is being
cycled. This matches the user model: they're focused on one fill at a
time, then move on.

When the user types after the fill, the span clears (their next edit
is unrelated; they're done with that blank).

### Static-alt spans (DynDefs implicit)

For: a normal word whose LLM-resolved or static-tip alternative
happens to be multiple words. Examples:
- `attorney → legal eagle` (LLM-suggested multi-word synonym)
- `ceo → Jeff Bezos` (proper-noun replacement)
- `spantest → one word, two words, ...` (test fixture)

**N-slot** — many can coexist in one buffer. A sentence might have
both `legal eagle` AND `Jeff Bezos` active; cycling either doesn't
disturb the other.

When the user types, downstream defs SHIFT to follow their words; if
the span text is destroyed (mid-word edit), only that one def is
pruned. Other spans persist.

---

## Data structures

### `WordDef` (in `state/dyn-defs.ts`)

The unit of static-alt span tracking. One per cycled word position.

```ts
interface WordDef {
  readonly originalWord: string;     // word as it appeared at populate time
  readonly alternatives: readonly string[];  // index 0 = original; 1+ = alts
  currentIndex: number;              // which alt is currently displayed
  spanStart: number;                 // char offset (cache; not source of truth)
  spanEnd: number;                   // char offset (cache; not source of truth)
  readonly blankName?: string;       // attribution for blank-fill DynDefs
}
```

A WordDef "is" a multi-word span when
`alternatives[currentIndex].split(/\s+/).length > 1`. The span occupies
`[index, index + altWordCount)` in the current text.

### `SpanFillEntry` (in `state/span-fill.ts`)

The unit of blank-fill span tracking. ONE entry exists in
`SpanFillState` at any moment.

```ts
interface SpanFillEntry {
  readonly index: number;
  readonly alternatives: readonly string[];
  currentAltIndex: number;
  spanLength: number;
  readonly kind?: 'blank-fill' | 'static-alt';  // strict-equality vs preserve
  readonly blankTip?: string;
}
```

Historical note: `kind: 'static-alt'` exists because an earlier version
registered static-alt spans here too. After the April 2026 refactor
(`refactor(runtime): static-alt spans now live in DynDefs`), only
blank-fills set entries here. The field is kept for backwards-compat
inside the type but is not written by any current code path.

---

## Cycling dispatch — the seven paths

When Ctrl+Alt+Up/Down fires, `Cycling.onKey` runs through paths in
order. First one to return `true` wins.

| Path | Condition | What it does |
|---|---|---|
| -1 | `selectorSatelliteState.current` | Selector/satellite cycling (e.g. `opencues settings _`) |
| 0  | `spanFillState.current` AND wordIndex inside the span | Blank-fill span cycling (`cycleSpanFill`) |
| 1  | Word maps to a blank with `script:` | Spawn the script (no text change, side-effect only) |
| 2  | Word maps to a blank with `stepValues:` | Rotate values in-place (`cycleListBlank`) |
| 3a | DynDef at this index has `blankName` | Cycle via that blank's blankStep/Suffix/Script |
| 3  | Word matches a `step:` pattern (`5f`, `50%`) | Numeric arithmetic (`cycleStepPattern`) |
| 4  | Default | Static-alt cycling (`cycleStaticAlts`) |

Path 4 is where multi-word static-alt spans are created and rotated.
Path 0 is for blank-fills only (since the April 2026 refactor).

---

## Path 4 — `cycleStaticAlts` walkthrough

This is the most-trafficked path, and where multi-word span behaviour
emerges.

### 1. Inner-span redirect

If the highlighted index is inside an existing multi-word DynDef span
(but not the origin), recurse with the origin's index. This makes
pressing Ctrl+Alt+Up on `eagle` cycle `legal eagle` as a unit, not
nothing.

```ts
const span = this.dynDefs.findSpanContaining(wordIndex);
if (span && span.originIdx !== wordIndex) {
  // recurse on the origin
}
```

### 2. Get-or-build the DynDef

```ts
let def = this.dynDefs.get(wordIndex);
if (!def) {
  def = this.buildDefFrom(target);  // looks up alts via configLoader
  if (!def) return false;            // word has no cue, nothing to cycle
  this.dynDefs.set(wordIndex, def);
}
```

### 3. `applyAltCycle` — the splice

```ts
// 1. Compute the splice range from LIVE word positions every time
//    (never trust def.spanStart/spanEnd — they drift across cycles).
const words = splitWords(event.text);
const startWord = words[wordIndex];
const currentAlt = def.alternatives[def.currentIndex];   // BEFORE the cycle
const currentAltWordCount = max(1, currentAlt.split(/\s+/).length);
const endWord = words[wordIndex + currentAltWordCount - 1];
const rangeStart = startWord.start;
const rangeEnd = endWord.end;

// 2. Advance the cycle, splice the new alt in.
def.currentIndex = (def.currentIndex + direction + len) % len;
const nextWord = def.alternatives[def.currentIndex];
const newText = event.text.slice(0, rangeStart) + nextWord + event.text.slice(rangeEnd);

// 3. Cache the new char range (best-effort; recomputed next time).
def.spanStart = rangeStart;
def.spanEnd = rangeStart + nextWord.length;

// 4. Push the new text + cursor.
adapter.setText(newText);
adapter.setCursorOffset(...);

// 5. If word count changed, SHIFT downstream DynDefs by delta, then
//    PRUNE anything still mismatched. This keeps resolved-but-
//    unrelated words' DynDefs continuous across the cycle (no dim
//    flicker) while dropping anything genuinely stale.
const delta = nextAltWordCount - currentAltWordCount;
if (delta !== 0) {
  this.dynDefs.shiftAfter(wordIndex, delta);
  this.dynDefs.pruneStale(splitWords(newText));
}

adapter.forceRender();
```

### Why the order matters

- **Live word positions before def.spanStart cache** — caches drift over
  multi-word cycles. Multi-word → multi-word → user edits → cycle
  again would splice at a stale offset and corrupt the buffer.
- **Shift before prune** — if "filed" is at idx 2 and we cycle the def
  at idx 1 from single to 2-word, "filed" shifts to idx 3. Without
  shift-first, prune sees "the word at idx 2 is no longer 'filed'" and
  drops the def → dim flickers off until Resolver re-runs.

---

## DynDefs methods and invariants

### `findSpanContaining(index)` — query

Returns `{ originIdx, spanLength, def } | null`. `null` if `index`
isn't inside any multi-word DynDef span. Linear in number of defs.

Used by:
- Navigation.computeTargets — skip inner span positions
- DimRender.compute — group dim across spans, expand highlight
- Cycling.cycleStaticAlts — inner-span redirect

### `shiftAfter(originIndex, delta)` — mutation

Shifts every DynDef at index > originIndex by `delta` positions.
Snapshot-then-reinsert; collision-safe with origin and below.

Called from `applyAltCycle` after a word-count-changing cycle.

### `pruneStale(words)` — mutation

Three-phase reconciliation: keeps defs that still match at their
current index, RELOCATES defs whose currentAlt's words appear at
exactly one new position, drops everything else.

Phases:
1. **Classify** every def (keep / drop / move-to-N) without mutating.
2. **Resolve collisions** — drop any `move` that conflicts with
   another `move` to the same target, or with a `keep` at that target.
3. **Apply** — delete first, then re-insert moved entries at their
   targets.

Called from:
- Navigation.onTextChange — user edits (keystrokes, paste, deletion)
- Cycling.applyAltCycle — after a word-count-changing cycle

The relocate path is conservative: ambiguous matches always drop, no
silent wrong relocations. See "Trade-offs" → "Deterministic relocate".

### `get(wordIndex)` — query

Plain access. Note: with pruning in place, callers can trust the result
is fresh-or-undefined; no need to validate on read.

---

## Navigation — span-aware computeTargets

`computeTargets` produces the ordered list of word indices the
highlight can land on. Multi-word span inner positions are excluded:

```ts
for (const w of words) {
  // SpanFillState (blank-fills) — handled by another branch above.
  // DynDefs (static-alt) — skip inner positions.
  const span = this.dynDefs.findSpanContaining(w.index);
  if (span && span.originIdx !== w.index) continue;
  // ... usual navigable filter (cueMap / DynDef)
}
```

`Navigation.onTextChange` (user edits only) calls `dynDefs.pruneStale`
to drop entries whose words have changed.

---

## DimRender — group dim and highlight expansion

Three loops produce render directives:

1. **Per-word dim** — for each word that's navigable AND not active AND
   not in an active highlight block:
   - If inside a multi-word DynDef span:
     - Origin emits ONE group dim range covering all N words
     - Inner positions are skipped
     - The span containing the active highlight is also skipped (the
       highlight covers it)
   - Otherwise: emit a per-word dim range
2. **SpanFillState span dim** — if a blank-fill span is active and the
   highlight isn't inside it, dim the whole span as one block.
3. **Selector/satellite dim** — same shape, separate state.

For the highlight:
- If active is inside a SpanFillState span → expand to span range
- Else if active is inside a multi-word DynDef span → expand to span range
- Else if active is inside a selector/satellite multi-word side → expand
- Else → just the active word

---

## BlankFill — blank-fill span lifecycle

`BlankFill.onTextChange` is where SpanFillState gets invalidated and
re-anchored.

```ts
if (this.spanFillState && this.spanFillState.current && cleaned !== lastFilledText) {
  if (!this.maybePreserveSpanFill(cleaned)) {
    this.spanFillState.clear();
    this.dismissedBlanks?.clear();
  }
}
```

`maybePreserveSpanFill` only fires for `kind: 'static-alt'` entries
(legacy code path, no longer used by current code) — it tries to find
the alt's words elsewhere in the new text and re-anchor `entry.index`.
For `kind: 'blank-fill'`, any text mismatch clears the entry (the
"user moved on" semantic).

---

## The Resolver loop

The Resolver re-runs on user text changes (debounced 500ms). It
populates DynDefs with LLM-suggested alts.

**Critical:** the Resolver fires ONLY on user-source events, never on
runtime-source ones (cycling, blanks writing back, etc.). That's why
cycling alone never triggered drift — drift required cycling FOLLOWED
by a user keystroke that scheduled the resolver.

Four filters in `cleanWords` prevent waste AND prevent the resolver
from second-guessing words that cycling owns. A position becomes `''`
in the context (which RoutedWordSourceGroup + every other CueSource
silently skip) when ANY of these match:

1. **Inside an active blank-fill** — `i` falls in
   `spanFillState.current` range.
2. **Inside any multi-word static-alt span** — `dynDefs.findSpanContaining(i)`
   returns a span (covers origin AND inner positions).
3. **Word is a DynDef's originalWord** — `existing.originalWord === word`.
   The def is fresh and untouched; alts already cached.
4. **Word is the def's current alt's first word** — covers
   single-word cycle (`attorney → lawyer` — word at idx 1 is "lawyer",
   currentAlt is "lawyer", first word is "lawyer", match) AND the
   origin position of multi-word cycle (`attorney → legal eagle` —
   word is "legal", currentAlt is "legal eagle", first word is
   "legal", match).

**Blanks (`_`) are NEVER skipped** — their answer depends on context
that may have changed.

### Why filter #4 matters: alt-track drift

Without filter #4, this sequence drifted onto a different alt track:

```
1. text "the attorney filed"
2. user cycles attorney → lawyer (DynDef.currentIndex = 1)
   text becomes "the lawyer filed"
   — runtime-source change, Resolver doesn't fire
3. user types a single character anywhere → user-source
   Resolver scheduled, debounced 500ms
4. After 500ms, Resolver runs on "the lawyer filed"
   - Filter #3 fails: existing.originalWord ("attorney") !== word ("lawyer")
   - LLM gets sent "lawyer" as a fresh word
   - LLM returns lawyer's alts: [counsel, advocate, client]
   - Write-side check at resolver.ts (existing.originalWord === target.word)
     ALSO fails — overwrites the attorney def with lawyer's alts
5. user cycles again → now on lawyer's alt track (client, etc.)
6. Repeat: client → customer → ...
```

The bug was intermittent because it required all of:
- Cycling to a non-original alt
- A user keystroke after cycling
- Waiting past the 500ms debounce
- LLM returning sufficiently different alts

Fast cycling, navigation-only sequences, or back-to-original cycles
all dodged it. Filter #4 closes the door regardless of timing — any
cycled-to alt is recognized as "owned by cycling" on every resolver
pass.

---

## Pruning + shifting flow chart

```
                      ┌──────────────────────────┐
                      │ Text change (any source) │
                      └────────────┬─────────────┘
                                   │
        ┌──────────────────────────┴──────────────────────────┐
        │                                                     │
   user source                                          runtime source
   (keystroke)                                          (cycling, fill)
        │                                                     │
        ▼                                                     ▼
  Navigation.onTextChange                                 Cycling
        │                                                     │
        ├─ hlState.deactivate()                               ├─ apply splice
        ├─ dynDefs.pruneStale(words)                          │
        │                                                     ├─ if word-count
  BlankFill.onTextChange                                      │  changed:
        │                                                     │   ├─ shiftAfter
        ├─ if spanFillState mismatch:                         │   └─ pruneStale
        │   ├─ try maybePreserveSpanFill                      │
        │   └─ else: clear()                                  └─ forceRender
        │                                                       (no Nav/BlankFill
   forceRender (later)                                          subscribers fire)
```

---

## What lives in adapters vs runtime

Adapters do TWO things related to cycling/spans:

1. **Provide the `HostAdapter`** — `setText`, `setCursorOffset`,
   `forceRender`, `onKey`, `onTextChange`, `readFile`, `readDir`, etc.
2. **Render the directives** — chrome paints CSS Custom Highlight API
   ranges, claude-code emits ANSI sequences, opencode draws via its TUI.

Adapters do NOT:
- Track spans
- Compute dim ranges
- Decide what's navigable
- Cycle alternatives

If you're writing a new adapter, you implement steps 1+2 above and
inherit everything else from `buildSharedRuntime`. The cycling/spans
logic in this doc applies to your host automatically.

---

## Test fixtures and patterns

### `MockAdapter` (testing/mock-adapter.ts)

The test stand-in for any host. Records every `setText`, `forceRender`,
key dispatch, etc. Simulate user keystrokes via `fireKey`, simulate
typing via `pushText`, assert on `setTextCalls.at(-1)` for the visible
output.

### `wrapTipsAsCuesMd(data)` (in mock-adapter.ts)

Wraps a tips JSON object as a minimal folder-based `cues/<name>/cue.md`
so ConfigLoader's existing parser flow picks it up. Use for any test
that needs cued words.

### Static-alt span fixture (`spantest`)

Live in `defaults/cues/span-test/cue.md` (and copied to
`~/.cues/words/span-test/cue.md` after seeding) for manual testing
in chrome / opencode:

```json
{
  "id": "span-test",
  "words": {
    "spantest": {
      "alts": ["one word", "two words", "three short words", "back to one"]
    }
  }
}
```

Cycle sequence covers: single → multi (2) → multi (2) → multi (3) →
multi (3) → wrap to single. Hits every transition.

### Pinning a regression with vitest

Pattern from `cycling.test.ts`:

```ts
const { adapter, hlState, dynDefs } = await setupMw('the attorney filed today');
hlState.activate(1, 'the attorney filed today');
adapter.fireKey('up', { ctrl: true, alt: true }); // → lawyer
expect(adapter.setTextCalls.at(-1)).toBe('the lawyer filed today');
adapter.fireKey('up', { ctrl: true, alt: true }); // → legal eagle
expect(adapter.setTextCalls.at(-1)).toBe('the legal eagle filed today');
expect(dynDefs.findSpanContaining(1)?.spanLength).toBe(2);
```

End-to-end: real Cycling + Navigation + DynDefs, fake host, drive with
keystrokes, assert on observable text + state.

---

## Bugs we've fixed (and the test that pins each)

| Bug | Fix | Test |
|---|---|---|
| `def.spanStart/spanEnd` drifted across multi-word cycles → corrupt splice | `applyAltCycle` reads live `splitWords` every time | "swapping between multi-word alts splices at the correct char range" |
| Two multi-word spans → second clobbered first via `SpanFillState.set` | Static-alt spans live in DynDefs; SpanFillState is blank-fill only | "TWO concurrent multi-word spans coexist via DynDefs" |
| Cycling shifted downstream words → DynDefs got pruned, dim flickered | `shiftAfter` before `pruneStale` in `applyAltCycle` | "cycling single → multi-word SHIFTS downstream DynDefs (no dim flicker)" |
| `Navigation.onTextChange` called `dynDefs.clear()` → 500ms dim flash on every keystroke | Replaced with `pruneStale` (keeps fresh defs, drops stale ones) | "keeps DynDefs whose originalWord matches the current word" |
| Inner span position → cycle did nothing (no def at inner index) | Inner-span redirect at top of `cycleStaticAlts` | "Ctrl+Alt+Up from inner span word redirects to origin and cycles whole span" |
| Resolver re-ran on every keystroke including for already-resolved words → token spend + alt jitter | Filter `cleanWords` against DynDefs + SpanFillState before passing to Resolver | "does NOT send already-resolved words to the LLM" |
| Multi-word static-alt prompts produced prose, not `INDEX:alt` | `ConfigSource` auto-appends format spec when prompt missing it | `config-source.test.ts` — "appends the format spec when the prompt lacks one" |
| Stale DynDef.originalWord after user edit → wrong cycling direction | `pruneStale` drops mismatched defs on user text change | "drops DynDefs whose word has been deleted from that position" |
| Cycled alt re-evaluated by Resolver → alt-track drift (`attorney → lawyer → client → customer`) | Resolver filter also matches def's currentAlt first word + checks `findSpanContaining` | "skips a word that has been CYCLED to one of the def's alternatives" + "skips both inner positions of a multi-word static-alt span" |
| Prepending text dropped the cycled DynDef → user lost cycle progress on prefix edits | `pruneStale` adds deterministic relocate: stale def whose currentAlt's words appear at exactly ONE new position is moved instead of dropped | "cycle, then PREPEND text — DynDef RELOCATES to new position" + 4 sibling tests covering single/multi/ambiguity/collision |

---

## Scenarios — concrete walkthroughs of the complexity

The system's behaviour emerges from interactions between several
modules over multi-step user actions. Reading each module in
isolation hides this. The scenarios below trace exact state through
realistic sequences — what the user does, what each module sees, why
the result is correct.

For each: text + state at every step, which modules/methods fire, and
the invariant that holds at the end.

### Scenario 1 — Single-word cycle, then user types

```
Start:  text "the attorney filed today"
        DynDefs: {} (nothing resolved yet)
        SpanFillState: null

[t=0]   User highlights "attorney" (idx 1) and presses Ctrl+Alt+Up.
        ── Cycling.onKey → Path 4 cycleStaticAlts
        ── No def at idx 1 → buildDefFrom("attorney") via configLoader.lookup
        ── Returns {originalWord:"attorney", alts:[attorney,lawyer,legal eagle,...], currentIndex:0}
        ── applyAltCycle: increments currentIndex=1, nextWord="lawyer"
        ── Single-word alt (no shift), splice [4..12) with "lawyer"
        ── adapter.setText("the lawyer filed today")  [source: 'runtime']
        ── DynDefs: {1: attorney def, currentIndex=1}

[t=200ms] User types " ok" at the end → "the lawyer filed today ok"
          [source: 'user']
          ── Navigation.onTextChange:
             ── hlState.deactivate()
             ── pruneStale(words):
                - DynDef at idx 1: originalWord="attorney", current text "lawyer".
                  altWords[currentIndex=1] = ["lawyer"], single-word, matches "lawyer". KEEP.
          ── BlankFill.onTextChange: SpanFillState null, no-op
          ── Resolver.onTextChange: source==='user', schedules debounced resolve

[t=700ms] Resolver fires (500ms debounce elapsed):
          ── cleanWords: ["the", "?", "filed", "today", "ok"]
             - idx 1: existing def, currentAlt="lawyer", firstWord="lawyer"
                       === text word "lawyer" → SKIP, set ''
          ── Sends only ["", "filed", "today", "ok"] (and "the" if not function-filtered)
          ── LLM returns alts for filed/today/ok only
          ── DynDefs: {1: attorney def (untouched), 2: filed def, 3: today def, 4: ok def}

End:   "the lawyer filed today ok"
       attorney's def is INTACT — next cycle on idx 1 continues attorney's
       track (legal eagle next), NOT lawyer's track. No drift.
```

### Scenario 2 — Multi-word cycle shifts downstream defs

```
Start: text "the attorney filed today"
       DynDefs already populated by Resolver:
         {1: attorney def @0, 2: filed def @0, 3: today def @0}

[t=0]  User cycles attorney twice → "the legal eagle filed today"
       ── First cycle: attorney → lawyer (single, no shift)
          DynDefs: {1: attorney @1, 2: filed, 3: today}
       ── Second cycle: lawyer → legal eagle (multi, prevCount=1 → newCount=2, delta=+1)
          ── applyAltCycle: live splitWords, range from words[1]=lawyer
          ── newText = "the legal eagle filed today"
          ── shiftAfter(1, +1):
             snapshot {2:filed, 3:today}, delete both, re-insert at {3:filed, 4:today}
          ── pruneStale(splitWords(newText)):
             words = [the, legal, eagle, filed, today]
             - idx 1 (legal): attorney def, currentAlt="legal eagle",
                              altWords ["legal","eagle"] match contiguously → KEEP
             - idx 3 (filed): filed def, originalWord="filed" === word → KEEP
             - idx 4 (today): today def, matches → KEEP
             No stale entries pruned.
          ── adapter.setText(newText), forceRender

       DynDefs: {1: attorney@2, 3: filed, 4: today}
       findSpanContaining(2) returns {originIdx:1, spanLength:2}
       findSpanContaining(3) returns null

[t=200ms] DimRender.compute called by host:
          ── activeStaticAltSpan = findSpanContaining(activeIndex=1) = the span
          ── For each word:
             - idx 0 "the": function word, no dim
             - idx 1 "legal": span origin AND active → highlight expanded to whole span
             - idx 2 "eagle": inner span position → SKIP (covered by origin)
             - idx 3 "filed": no span here, has DynDef → dim
             - idx 4 "today": no span, has DynDef → dim
          ── Result: highlight covers "legal eagle"; dim covers "filed" and "today"
             (no flicker — defs survived via shift)

End:   filed and today STAY DIM through the cycle. No 500ms wait for
       Resolver to re-populate. The shift kept their defs alive.
```

### Scenario 3 — Two concurrent spans, cycle one without disturbing the other

```
Start: text "the attorney said the ceo agrees"
       DynDefs: {} initially

[t=0]  Cycle attorney → legal eagle (2 cycles up)
       After: text = "the legal eagle said the ceo agrees"
              DynDefs: {1: attorney @currentIndex=2 (legal eagle)}
              "ceo" shifted from idx 4 to idx 5

[t=2s] Cycle ceo → Jeff Bezos
       ── Cycling.onKey at wordIndex=5
       ── Path 0 (cycleSpanFill) — spanFillState.current is null, skip
       ── Path 4 (cycleStaticAlts):
          ── findSpanContaining(5) → null (5 isn't inside attorney's span at [1,2])
          ── No def at idx 5 → buildDefFrom("ceo")
          ── Cycle to "Jeff Bezos" (multi, +1 shift)
          ── applyAltCycle:
             newText = "the legal eagle said the Jeff Bezos agrees"
             shiftAfter(5, +1) — only "agrees" was at idx 6, now at idx 7
             pruneStale: all KEEP (no stale entries)
       After: DynDefs: {1: attorney@2 (legal eagle), 5: ceo@1 (Jeff Bezos), 7: agrees def?}
              Two ACTIVE multi-word spans coexist.

[t=5s] Cycle attorney AGAIN to defendant counsel:
       ── cycleStaticAlts at wordIndex=1
       ── No span containing 1 redirect needed (origin === wordIndex)
       ── Get def at 1: currentAlt="legal eagle", currentAltWordCount=2
       ── Range: [words[1].start, words[2].end] from LIVE positions
       ── newText: "the defendant counsel said the Jeff Bezos agrees"
       ── delta=0 (multi 2 → multi 2), no shift, no prune needed
       
       ceo's def at idx 5: UNTOUCHED. Its currentIndex still points at "Jeff Bezos".
       Span B remains intact across span A's cycle.
```

### Scenario 4 — Inner-span navigation + cycle redirect

```
Start: text "the legal eagle filed" — span at idx 1, spanLength 2
       DynDefs: {1: attorney @currentIndex=2 (legal eagle)}

[t=0]  User presses Ctrl+Alt+Right repeatedly to navigate left-to-right.
       ── Navigation.computeTargets for "the legal eagle filed":
          - idx 0 "the": not navigable (function word)
          - idx 1 "legal": findSpanContaining(1) returns span, origin===idx → INCLUDE
          - idx 2 "eagle": findSpanContaining(2) returns span, origin!==idx → SKIP
          - idx 3 "filed": no span, has def → INCLUDE
          Targets: [1, 3]
       
       Right from idx 0 lands on idx 1 (legal). Right again lands on idx 3 (filed).
       Inner position idx 2 (eagle) is INVISIBLE to navigation — exactly right.

[t=2s] Suppose user has cursor on "eagle" via mouse click and presses Ctrl+Alt+Up.
       ── cycleStaticAlts at wordIndex=2
       ── findSpanContaining(2) returns span, originIdx=1, spanLength=2
       ── Inner position! Redirect: recurse with wordIndex=1
       ── Now cycles attorney from currentIndex=2 → 3 (defendant counsel)
       
       The whole span rotates as one unit — cycling from inside felt the same
       as cycling from the origin.
```

### Scenario 5 — Blank fill coexists with static-alt span

```
Start: text "improve prompt write a poem _"
       — "_" is a blank, "improve prompt" is a consume-all keyword.
       — Some other word later might become a multi-word span.

[t=0]  User types this. BlankFill.onTextChange detects the blank slot.
       ── consume-all script runs (or LLM if no script)
       ── Returns ["A vivid poem about loss", "A whimsical haiku", ...]
       ── BlankFill.applyConsumeAllFill:
          ── spanFillState.set({
                kind: 'blank-fill',
                index: 0, spanLength: 4 (words in first alt),
                alternatives: [...4 items],
                currentAltIndex: 0,
                blankTip: '...'
             }, "A vivid poem about loss")
          ── adapter.setText("A vivid poem about loss")  [runtime]
       
       SpanFillState now has the consume-all entry.
       DynDefs: empty (no static-alt spans yet).

[t=2s] User cycles the blank fill: Ctrl+Alt+Up
       ── Path 0 (cycleSpanFill): spanFillState.current is set, wordIndex inside range
       ── Cycles to next alt "A whimsical haiku"
       ── Updates entry: currentAltIndex=1, spanLength=3 (new word count)
       ── adapter.setText("A whimsical haiku")
       
       This flow uses ONLY SpanFillState, never DynDefs.

[t=10s] User types after: "A whimsical haiku today"
        ── BlankFill.onTextChange: cleaned !== lastFilledText
           - kind: 'blank-fill' → maybePreserveSpanFill returns false (only 'static-alt' preserves)
           - spanFillState.clear()
        ── Navigation.onTextChange: hlState.deactivate(), pruneStale (no defs to prune)
        
        Blank fill ends naturally on the user's "I'm done" signal (any edit).

       Now if the user cycles "haiku" they could enter a static-alt span.
       The two systems can run sequentially in the same buffer; they just
       don't actively coexist the way two static-alt spans do.
```

### Scenario 6 — User destructively edits a span's content

```
Start: text "the legal eagle filed" — span at idx 1, spanLength 2

[t=0]  User selects "eagle" and types over it: "the legal owl filed"
       ── Navigation.onTextChange (user source):
          ── pruneStale(words):
             words = [the, legal, owl, filed]
             - DynDef at idx 1: originalWord="attorney", currentAlt="legal eagle",
               altWords ["legal","eagle"]:
                 words[1]="legal" matches, words[2]="owl" ≠ "eagle"
                 → NOT contiguous match → DROP
          ── DynDefs: {} (only the attorney def existed)
       
       ── BlankFill.onTextChange: spanFillState null, no-op

       findSpanContaining(1) now returns null. The span is gone. User starts fresh.

[t=500ms] Resolver fires:
          ── cleanWords: every word eligible (no spans, no defs)
          ── LLM resolves "legal", "owl", "filed" individually
          ── Builds fresh DynDefs for each
       
       Cycling on any of these now offers their own tracks.
```

### Scenario 7 — Adjacent multi-word spans

```
Start: text "the attorney filed indemnify clause"
       — both "attorney" (1) and "indemnify" (3) have multi-word alts in their cues.

[t=0]  Cycle attorney → legal eagle (multi, +1 shift)
       After: "the legal eagle filed indemnify clause"
              DynDefs: {1: attorney@2 (legal eagle)}
              indemnify shifted from idx 3 to idx 4

[t=2s] Cycle indemnify → "hold harmless" (multi, +1 shift)
       After: "the legal eagle filed hold harmless clause"
              DynDefs: {1: attorney@2, 4: indemnify@1 (hold harmless)}
              clause shifted from idx 5 to idx 6
       
       Both spans are tight — span A occupies [1,2], span B occupies [4,5].
       Nothing between them except "filed" at idx 3.

[t=5s] Cycle attorney back to "lawyer" (single, -1 shift)
       After: "the lawyer filed hold harmless clause"
              DynDefs: {1: attorney@1 (lawyer), 3: indemnify@1, 5: clause def}
              indemnify shifted from idx 4 to idx 3
              clause shifted from idx 6 to idx 5
              hold harmless's span is now at idx [3,4]
       
       Span B's def moved with the shift. span B still works correctly because:
       - findSpanContaining now scans defs and finds idx 3 has currentAlt="hold harmless"
       - Spans naturally relocate; nav and dim continue to treat [3,4] as one block.
```

### Scenario 8 — Cycle, type, cycle again on the SAME word

```
Start: text "fast slow"

[t=0]  Cycle "fast" → "quick"
       DynDefs: {0: fast @currentIndex=1 (quick)}
       text: "quick slow"

[t=2s] User types " today" at the end → "quick slow today"
       ── Navigation.onTextChange:
          ── pruneStale: word at idx 0 = "quick".
             def.originalWord="fast" ≠ "quick", but altWords[currentIndex=1]=["quick"]
             matches "quick". KEEP.
          DynDefs: {0: fast @1}  unchanged

[t=3s] Cycle again on idx 0:
       ── cycleStaticAlts: get def, found.
       ── applyAltCycle: currentIndex=2, nextWord="rapid"
       ── splice from words[0]=quick to "rapid"
       ── text: "rapid slow today"

       Continues attorney's track correctly. The intermediate user typing
       didn't disturb the cycle state.
```

### Common state-transition patterns

| Action | Modules fired | DynDefs effect | SpanFillState effect |
|---|---|---|---|
| Single-word cycle (no shift) | Cycling | def.currentIndex++; cache spanStart/End | unchanged |
| Single → multi-word cycle (+N shift) | Cycling | def.currentIndex++; shiftAfter; pruneStale | unchanged |
| Multi → single-word cycle (-N shift) | Cycling | def.currentIndex++; shiftAfter; pruneStale | unchanged |
| User types | Navigation, BlankFill, Resolver | pruneStale on stale defs; resolve fires after debounce | maybePreserveSpanFill or clear |
| User deletes a span word | Navigation, BlankFill | def at span origin pruned (multi-word match fails) | unchanged (no static-alt entries) |
| Blank-fill via script | BlankFill | unchanged | set with new entry |
| Cycle blank-fill | Cycling Path 0 (cycleSpanFill) | unchanged | currentAltIndex++ |
| Resolver runs | Resolver | new defs at unfilled positions; cycled defs untouched | unchanged |

### Gotchas

- **Cycling is runtime-source.** Resolver, Navigation, BlankFill all
  branch on `event.source === 'user'` or similar. Don't assume cycling
  triggers the same handlers as user typing.
- **Pruning is invariant per-event but called explicitly from two
  paths.** Navigation does it on user text change, Cycling does it
  inside applyAltCycle when word count changes. They're not a pipeline
  — each is independent. Adding a new path that mutates word count
  needs to call pruneStale itself.
- **`findSpanContaining` is queried on demand, not cached.** Linear
  scan each call. Fine at typical sizes; aware of it if profiling shows
  pressure.
- **The DynDefs char range cache (def.spanStart/spanEnd) is best-effort
  only.** applyAltCycle recomputes from live word positions every
  cycle. Other readers (DimRender) can use the cache, but treat it as
  hint not source-of-truth — between cycles, if the user edited
  surrounding text, the cache is stale until the next cycle refreshes it.

## Trade-offs accepted

### Deterministic relocate on prefix/middle edits — RESOLVED

(Originally listed here as "no auto-reanchor", later resolved.)

The original option B trade-off dropped DynDefs that no longer
matched at their current index — including the case where the user
just typed a prefix and the def's content is alive and well at a new
position. That meant prepending text reset cycle progress.

April 2026 added **deterministic relocate** to `pruneStale`: a stale
def whose currentAlt's words appear at EXACTLY ONE new position is
moved there instead of dropped. Ambiguous matches (zero or multiple
contiguous occurrences) still drop — that's the deterministic part.

Algorithm in three phases:

1. **Classify.** For each def, decide `keep` / `drop` / `move-to-N`
   without mutating. `keep` = matches at current index; `move-to-N` =
   doesn't match at current but matches at exactly one new position;
   `drop` = matches nowhere or matches multiple places.
2. **Resolve collisions.** If two `move` decisions target the same
   index, OR a `move` targets a position currently held by a `keep`,
   downgrade the conflicting `move`s to `drop`. We never overwrite
   a fresh def with a relocated one; ambiguous moves are bailed out
   of conservatively.
3. **Apply.** Delete all non-`keep` slots, then re-insert moved
   entries at their targets. Snapshot-then-mutate avoids iteration
   ordering hazards (a moved def can't be re-evaluated under its new
   index).

Net effect: prepending text now preserves cycle progress in the
common case, drops cleanly when ambiguity exists, and never silently
lands a def on the wrong word.

Tests pin all three outcomes — see `cycling.scenarios.test.ts`:
- "cycle, then PREPEND text — DynDef RELOCATES to new position"
  (single relocate)
- "relocate works for SINGLE-word cycled alts too"
- "relocate handles MULTIPLE defs all shifting by the same prefix"
- "relocate fails (drops) when the cycled alt appears MULTIPLE times
  AND original position no longer matches" (ambiguity bail)
- "relocate refuses to overwrite an existing keep-def at its target"
  (collision avoidance)

### Per-cycle splitWords pass

`applyAltCycle` calls `splitWords(event.text)` every cycle to compute
fresh char ranges. Past 1000-word buffers this could matter; under
that, it's noise. The correctness win (no stale char-cache splices)
is worth it.

### Pruning is O(defs)

`pruneStale` walks every entry in DynDefs every text change. For
typical buffers (tens of words, under 50 active defs) this is
negligible. If we ever see thousands of active defs, we could add a
"dirty range" hint, but no current host gets near that.

---

## Re-implementation checklist

If you're porting the runtime to a new language or auditing the
TypeScript implementation:

1. **WordDef + DynDefs** — keyed by word index, with `findSpanContaining`,
   `shiftAfter`, `pruneStale`, plain `get/set/delete/entries/size`.
2. **SpanFillState** — single slot, `set(entry, lastFilledText)`,
   `clear()`, `current`, `lastFilledText` getters.
3. **Cycling.onKey** dispatch in priority order: selector/satellite,
   spanFill, list blank, blankStep DynDef, static alts.
4. **applyAltCycle** must compute char range from live words, mutate
   def.currentIndex, push new text, and (if word count changed) shift
   downstream DynDefs then prune.
5. **Navigation.computeTargets** filters out inner span positions for
   both SpanFillState and DynDef-tracked multi-word spans.
6. **DimRender** emits one group dim range per multi-word span origin
   (skips inner positions), expands the active highlight to cover the
   whole span when active is inside one.
7. **BlankFill.onTextChange** invalidates SpanFillState on text
   mismatch (with the static-alt-preserve fallback for the legacy
   `kind` field).
8. **Resolver** filters context.words to skip already-resolved
   non-blank words and words inside active spans before sending to
   the LLM.

The vitest suite under `packages/opencues-runtime/src/` is the
contract. 371 tests across 25 files — every behaviour described above
is pinned by at least one test.
