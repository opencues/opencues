# Answer Replaces Query

**Feature #51** · Host-supplied · No scalar (structural, per focused field)

Some fields ARE the question box: a transient one-line search field
where the query and its answer cannot coexist. In Spotlight the panel
shows ~37 characters, so the default fill behaviour —

```
capital of france _   →   capital of france Paris
```

— pushes the answer out of view. When the host declares the field's
content disposable, FluidBlank instead **replaces the whole query**:

```
capital of france _   →   Paris
```

First (and currently only) user: the **mac** host, and only while
**Spotlight** is focused. Every other app on the mac host — and every
other host — keeps the non-destructive fill.

This is the sibling of [Answer Char Budget](answer-char-budget.md)
(#50): that one asks the model for a *shorter* answer, this one frees
up the field to show it.

## How it flows

```
HostAdapter.getAnswerReplacesQuery?(): boolean   (dynamic, per current target)
  → resolver stamps CueContext.answerReplacesQuery      (no scalar gate)
    → FluidBlankSource: replaceQuerySpan(text) → spanStart/spanEnd
      → the resolver's existing WIPE splice replaces [start, end)
```

Nothing new happens in the runtime: the WIPE splice, its drift guard,
and the chain/undo bookkeeping have always been there for
`spanStart`/`spanEnd`-bearing fluid-blank results. The feature is only a
decision about *which* range a result covers.

- **The span is the runtime's, not the model's.** `replaceQuerySpan()`
  returns the whole buffer; the model's `SPAN:` / `MODE:` lines are still
  ignored. A slot-splice source must never take splice bounds from an
  LLM-claimed span — see `docs/architecture/blank-sources.md`.
- **Absent by default** — no flag, no span, prompts and behaviour
  byte-identical to the pre-feature shape on every other host.
- **No mode scalar** — like `answerCharBudget`, a host-computed value
  about the host's own element. Inference is structural, like
  `supportsCycling`.
- **Applies to the ANSWER path only.** Error substitutes
  (`[OpenCues: …]`) always fill, never wipe — losing a typed question to
  a transient provider failure would be unrecoverable.

## Shape guards (why a wipe can't run away)

Hosts in this profile are in the universal/no-cycling band
([universal-integration.md](../architecture/universal-integration.md)),
so there is **no Ctrl+Alt+Down to revert with**. `replaceQuerySpan()`
therefore refuses two shapes even when the host says yes:

| Buffer | Result | Why |
|---|---|---|
| `capital of france _` | wipe `[0, 19)` | one line, `_` trails → the answer stands alone |
| `shopping list\ncapital of france _` | fill only `_` | a newline means this is the user's own content, not a query |
| `water boils at _ degrees` | fill only `_` | mid-sentence: whether the model returns the value or the whole clause, splicing at the gap is right either way — wiping is right for only one |

Pinned by `answer-replaces-query.test.ts` (core, the span rule) and
`answer-replaces-query.scenarios.test.ts` (runtime, the user journey).

## mac host specifics

Bundle whitelist in `integrations/mac/src/ax-host.ts`
(`DEFAULT_REPLACE_QUERY_BUNDLES`: `com.apple.Spotlight`). Override via
env — a non-empty value **replaces** the default set:

```bash
OPENCUES_AX_REPLACE_QUERY="com.raycast.macos,com.apple.Spotlight"  # opt a launcher in
OPENCUES_AX_REPLACE_QUERY="com.raycast.macos"                      # …and Spotlight back out
OPENCUES_AX_REPLACE_QUERY="off"                                    # disable entirely
```

Pair a newly opted-in launcher with a char budget
(`OPENCUES_AX_CHAR_BUDGET`) — the two knobs describe the same narrow
field from different angles.

The Swift-side `PANEL_AGENT_BUNDLES` list is deliberately NOT reused
here: that set is about observer lifetime (non-activating panels never
fire app activations — `SPOTLIGHT-SPIKE.md`), not about whether a
field's content is disposable.

## Adding it to another host

Implement `getAnswerReplacesQuery()` on the band's adapter, returning
true only for fields whose typed content is genuinely throwaway
(a launcher query, a command palette). Return false — or omit the method
— for anything the user could mistake for a document. Chrome's natural
future candidates are the omnibox-style search inputs it already
recognises; not wired yet.
