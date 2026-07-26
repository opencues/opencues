# Answer Char Budget

**Feature #50** · Host-supplied · No scalar (structural, per focused field)

When the focused field has a small **visible capacity**, the host can
declare a soft character budget for LLM-generated answers. FluidBlank
and TransformBlank then append a `FIELD LIMIT` instruction to their
fused call's USER message asking for the shortest correct form
(abbreviate, round, drop filler) that fits — exceeding only when a
correct answer can't fit. It is an **aim, never a truncation**: the
runtime never cuts the model's output.

First (and currently only) user: the **mac** host sends **37** while
Spotlight's search field is focused — the panel shows ~37 characters,
so `distance to the moon in km _` answers as `384,400 km`, not a
sentence that scrolls out of view.

Sibling feature: [Answer Replaces Query](answer-replaces-query.md) (#51)
— in a field this narrow the mac host also declares the typed question
disposable, so the answer replaces it instead of trailing after it.

## How it flows

```
HostAdapter.getAnswerCharBudget?(): number | null   (dynamic, per current target)
  → resolver stamps CueContext.answerCharBudget      (no scalar gate)
    → renderCharBudgetBlock() appends FIELD LIMIT to the USER message
      (fluid-blank + transform-blank fused calls)
```

- **USER message, never SYSTEM** — per-call context must not salt the
  cerebras prefix cache (`docs/architecture/cerebras.md`). Pinned by
  `answer-char-budget.test.ts`.
- **Absent by default** — no budget = prompts byte-identical to the
  pre-feature shape, so the fluid-blank / transform-blank bench
  evidence stays valid without re-runs (benches never set a budget).
- **No mode scalar** — unlike ambient context, nothing user- or
  page-controlled rides this channel: it's a host-computed number.
  Inference is structural, like `supportsCycling`.

## mac host specifics

Per-bundle map in `integrations/mac/src/ax-host.ts`
(`DEFAULT_CHAR_BUDGETS`: `com.apple.Spotlight` → 37). Override, extend,
or disable via env:

```bash
OPENCUES_AX_CHAR_BUDGET="com.apple.Spotlight=50,com.raycast.macos=40"  # override + extend
OPENCUES_AX_CHAR_BUDGET="com.apple.Spotlight=0"                        # disable (value < 1 removes)
```

## Tuning firmness

Compliance is prompt-level ("usually short"), not guaranteed. If a
provider drifts long, edit `renderCharBudgetBlock()` (the one shared
copy) and escalate one rung at a time, re-driving the same failing
lookups between rungs:

1. **Current** (shipped): "Prefer the shortest correct answer that
   fits … Exceed N characters only when a correct answer cannot fit."
2. **Firm**: lead with the constraint — "Your answer MUST fit in N
   characters unless correctness is impossible within it."
3. **Hard cap + fallback shape**: "NEVER exceed N characters. When the
   full answer cannot fit, output its most information-dense N-character
   form (number + unit, abbreviation, leading clause)."

Whatever the rung: the block stays in the USER message (cerebras
prefix-cache rule), `renderCharBudgetBlock(undefined)` stays `''`
(bench byte-identity), and the wording regexes in
`answer-char-budget.test.ts` move in the same commit. Process
checklist: CLAUDE.md § "Answer char budget — tuning the FIELD LIMIT
firmness".

## Adding it to another host

Implement `getAnswerCharBudget()` on the band's adapter (re-evaluated
per current target) and return `null` when unconstrained. Chrome's
natural future source is the focused input's `maxlength` attribute /
measured visible width — not wired yet.
