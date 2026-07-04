# 05 — Inline Prompting (the `_` Blank)

For blog post #4: "Inline Prompting (Blank / `_`)".

## The core idea

A **Blank** is a literal underscore character `_` placed in the user's text.
It's a cue *from the user to the system*: "fill this in." The direction is
reversed compared to regular cues.

> **Think of blanks as user-placed autocomplete.** Unlike traditional
> autocomplete that guesses what comes next, blanks let you decide *where*
> the completion appears. — `docs/glossary.md`

This is the most novel HCI primitive in OpenCues. Worth the post on its own.

## The framing

Traditional autocomplete: **the system decides where the completion appears.**
You're typing, it pops up suggestions, you accept or dismiss.

Blank-driven prompting: **the user decides where the completion appears.**
You place `_` exactly where you want a value substituted in, and the system
fills it.

```
volume _                      → "volume 50%"
capital of france _           → "the capital of france is Paris"
unicode for em dash _         → "U+2014"
4 * 12 = _                    → "48"
nvda _                        → "121.45"     (live stock price)
agentically fix typos _ ...   → arms a continuous LLM editing loop
fix grammar _ she don't like it when he go there → "she doesn't like it when he goes there"
```

Same character, doing wildly different jobs depending on context.

## The five flavours of blank

From `docs/features/cue-blanks.md`:

1. **Auto-populated cue-blanks** — `_` populates from a script or runtime
   class. Up/Down cycles the value and writes back. `volume _` → `50%`.
2. **List blanks** — fixed `stepValues: [...]`. Cycles through a list.
   `affirmation _` → "I am brave" / "I am strong" / etc.
3. **Dynamic list blanks** — script returns multiple lines, each becomes a
   cycling alternative. `HN posts _` → live headlines.
4. **Read-only blanks** — fetches data once, no cycling. `nvda _` → `121.45`.

Plus two **fluid** modes (no keyword needed):

5. **Fluid blank** — free-form lookup. `FluidBlankSource` segments the
   query span and answers it (always-FILL, FUSED single-call pipeline).
   Handles math, factual, translation, unit conversion, codes, etc. without
   per-mode classification.
6. **Transform blank** — imperative instruction. `TransformBlankSource`
   detects "rewrite this text per <instruction>" and substitutes the
   rewrite over the whole buffer. This is where free-form rewrites now live:
   the old "consume-all" prompt-improver blank was retired, and
   `improve prompt _` routes here as an imperative instruction. (See
   [`06-inline-agents.md`](06-inline-agents.md) for the deep dive.)

Resolution order on a `_`:
```
95  BlankSource          ← keyword-bound (volume, brightness, ...)
93  TransformBlankSource ← imperative instructions
92  FluidBlankSource     ← free-form lookups
80  SpellingSource       ← misspelled words on plain text
```

The highest-priority source that claims the slot wins.

## The "universal interaction handle" framing

From `docs/architecture/transform-blank.md`:

> `TransformBlankSource` makes `_` a *universal interaction handle* rather
> than just a slot to fill.

That phrasing is the headline insight. The `_` is one character, but it's a
single handle through which the user can:
- Look something up (fluid blank)
- Read external state (volume, weather, stocks)
- Change external state (volume cycling)
- Run an LLM rewrite (transform blank)
- Arm a continuous LLM editor (agent task — see file 06)

One character. Six (or more) jobs. Which job runs is decided by the
*context around the `_`*, not by the user picking a mode.

## Re-evaluation: blanks are never permanent

From `docs/glossary.md`:
> Blanks are automatically computed and **re-evaluated on every edit**. When
> the surrounding text changes, the blank's value updates. This means a
> blank is never permanently filled — it can always return to `_` and be
> re-evaluated in its new context.

This is the second novel HCI piece. Most "fill" UI is commit-once: you
accept a suggestion, it becomes part of your text, the suggestion machinery
forgets about it. Blanks stay live. Edit the surrounding context and the
blank value updates.

The implementation lock that keeps the LLM from clobbering a blank value
*you've already accepted* is `metadata.blankName` on the WordDef. Only the
user can clear it (by editing the word).

## Keyword matching: the binding rule

For keyword-bound blanks (volume, stocks, weather), `blankKeywords` desugar
to anchored shapes that route the sentence containing `_`. A blank claims a `_`
when its keyword (or shape) leads the sentence, with `_` at the trailing edge —
sentence-scoped, deterministic. The sentence is the segment after the last
sentence terminator (`.`/`!`/`?` + whitespace, or CJK `。！？．`) or newline
before `_`. First match wins.

```
With blankKeywords: volume, sound, audio
  volume _              → matches (volume leads, _ at end)
  let me check. volume _ → matches (volume leads the sentence after ".")
  volume 30 _           → matches (30 captured as the set value)
  set audio _           → no match (sentence leads with "set")
  the volume is loud _  → no match (prose; volume doesn't lead the sentence)
  the _ is loud         → no match (no keyword, _ not at the end)
```

Multi-word keywords work too — a keyword like `spanish weather` desugars to
a shape whose words are joined with `\s+`, so it must lead the sentence as a unit:
```
With blankKeywords: spanish weather
  spanish weather _          → matches (the phrase leads, _ at end)
  spanish weather oslo _     → matches (oslo captured as the arg)
  the spanish weather is _   → no match (sentence leads with "the")
```
(Under the older proximity model a keyword could match mid-sentence near `_`;
sentence-scoped routing replaced that — the command must lead its sentence.)

## Ownership: the most important contract

From `cue-blanks.md`:

> **The invariant:** Only the user can clear `metadata.blankName`. The LLM
> cannot. This ensures blank positions are stable until the user explicitly
> edits them away.
>
> **What goes wrong if you get this wrong:**
> - If LLM can overwrite blank-bound words: The auto-populated volume value
>   ("64") gets replaced by grammar alternatives ("sixty-four", "numerous").
>   The position loses its blank behaviour. Cycling no longer changes the
>   actual volume.
> - If user edits can't clear blank-bound words: The position is permanently
>   stuck. Even after deleting "64" and typing "hello", the position stays
>   dimmed and cycling tries to run the volume script.

This ownership model is what makes blanks safe to use in mixed text. You
type a paragraph with `volume 50%` embedded; the surrounding paragraph
rewrites freely as the LLM offers alternatives, but the `50%` doesn't move
or get re-themed. It's locked until you explicitly edit it.

## Blank flavours table (one-liner per blank)

From `damon.md`:

| Blank | Shape | Usage |
|---|---|---|
| Volume | Keyword-bound + step | `volume _` → `50%`, steps by 6, writes back to OS |
| Brightness | Keyword-bound + step | `brightness _` → `60%`, steps by 10 |
| Affirmations | List (dismissible) | `affirmation _` → cycles positive affirmations |
| Stocks | Read-only (live) | `nvda _`, `Reddit stock _` → live share price |
| Weather | Read-only (live) | `London weather _` → current forecast |
| Hacker News | Dynamic list (dismissible) | `HN posts _` → live headlines |
| Crypto | Read-only (live) | `btc _`, `eth _` → live price |
| Countries | Read-only (live) | `population of france _` → fact |
| Dictionary | Read-only (live) | `define ephemeral _` → definition |
| OpenCues Settings | Selector + Satellite | `opencues settings _` → cycles settings, writes to file |
| Answer | Fluid lookup | Free-form Q&A — routes through `FluidBlankSource` |
| Prompt Improver | Transform blank | `improve prompt _` — rewrites the surrounding prompt via `TransformBlankSource` |
| Fluid Blank | Free-form lookup | Any unbound `_` |

## The HCI angle (for blog #4)

1. **The user is the one placing the cursor of completion.** This inverts a
   decade of autocomplete UX. You don't accept-or-dismiss a popup; you
   *say where the value goes*.

2. **Single character, infinite uses.** The `_` is dispatched contextually.
   The user doesn't pick a mode. The keyword + position + content decide.

3. **Re-evaluation on edit means blanks compose.** You can edit the prefix
   of a sentence, and `4 * 12 = _` stays right while the surrounding text
   reshapes. Blanks are *anchored to context*, not to keystrokes.

4. **The visible failure mode.** If the system can't fill the blank, the
   `_` stays. There's no silent failure. (Compare to autocomplete that
   silently doesn't appear.)

5. **`_` is keyboard-friendly.** Shift-hyphen on every standard layout. No
   special command, no menu, no modifier-key combo. The interaction primitive
   is *typeable*.

## Pitfalls and trade-offs

- **The keyword vocabulary has to be discovered.** Users don't know `volume`
  is a registered keyword until they try it. Mitigation: cue-tips on the
  populated value, plus the upcoming `opencues list` CLI surface.
- **Latency budget is sub-second.** Slow LLMs hurt visibly here (compare to
  cues where invisible failure means no harm).
- **Re-evaluation can surprise.** Edit the prefix of a math blank and the
  number changes. This is correct but can feel "alive" in unsettling ways
  the first time. (The fix is the ownership lock — see above.)
- **Whole-buffer rewrites need dedicated span storage.** Transform-blank
  rewrites overwrite a multi-word region rather than a single word, so the
  runtime keeps a separate state class (`SpanFillState`) to avoid clobbering
  the standard WordDef array. See
  [`../architecture/blank-integration.md`](../architecture/blank-integration.md).

## Where this material lives

- `concept.md` — the user-→-system direction definition
- `docs/glossary.md` — Blank, Blanks (two flavours), Cue-Blank entries
- `docs/features/fill-in-the-blank.md` — core `_` mechanics
- `docs/features/cue-blanks.md` — the comprehensive reference
- `docs/architecture/blank-integration.md` — blank routing + the
  transform-blank prompt-improver pattern
- `docs/architecture/transform-blank.md` — the "universal interaction handle"
  framing
- `damon.md` § "Cue Types" sections 2-5 — diagrammed flows for each blank
  type

## Quotable lines

- "Think of blanks as user-placed autocomplete."
- "Never draw a blank."
- "`_` is a universal interaction handle, not just a slot to fill."
- "Re-evaluated on every edit."
- "Only the user can clear `metadata.blankName`."
- "Same character, infinite uses."
