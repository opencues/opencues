# Blank integration templates

The `integration:` field on a blank lets it **expose how its output reads**,
so the runtime can weave the value into the buffer with connective "fluff"
instead of dropping a bare value. It is **add-only by construction** — it
only ever shapes the *inserted value*, never the user's surrounding text.

> Status: the **static** form (below) is shipped. The **LLM-driven** form
> (§ Future direction) is designed but deliberately deferred.

---

## Shipped: static template

A blank declares a fixed frame with a `{value}` placeholder:

```yaml
# defaults/blanks/weather/BLANK.md
integration: it's currently {value}
```

At fill time the runtime renders the blank's output through it:

- `weather oslo _` → blank output `Oslo: 22°C Clear` → **`it's currently Oslo: 22°C Clear`**
- `volume 30 _`   (`integration: volume is now {value}`) → **`volume is now 30%`**

### Mechanics

`BlankFill.renderIntegration(blank, value)` is the whole implementation:

```ts
const tpl = blank.integration;            // "it's currently {value}"
if (!tpl || !value || !tpl.includes('{value}')) return value;
return tpl.replace(/\{value\}/g, value);  // value is the ONLY input
```

Applied **after** `blankSuffix`, and it **supersedes** the default
`<keyword> <value>` rendering. Its presence is also one of the signals (with
"typed set/step" and "shape captured an arg") that tells the fill path to
clear the whole command span — so `weather oslo` is consumed and only the
woven sentence lands. See `applyAsyncFill` in
`packages/opencues-runtime/src/modules/blank-fill.ts`.

### Properties

- **Static.** `renderIntegration` sees only the template + the value. It does
  **not** read the surrounding buffer; the phrase is identical every time
  modulo `{value}`.
- **Add-only.** It can only wrap `{value}` in connective words — it cannot
  delete anything. The command-span clearing (a separate step) is what
  removes the typed command.
- **Opt-in, 0-LLM, deterministic.** A blank with no `integration:` shows its
  raw value (`brightness _` → `brightness 50%`).
- **Grammar is the author's job.** A mismatched value reads awkwardly
  (`it's currently {value}` + value `It is 22°C` → `it's currently It is 22°C`).
  The author designs the template + the blank's output to compose.

### Why it *looks* context-aware (but isn't)

Typing `weather oslo _` → `it's currently Oslo: 22°C Clear` feels like a
contextual rewrite, but it's two independent steps: (1) shape-clearing
deletes the `weather oslo` command, (2) the static template pastes its fixed
phrase around the value. There is no reading of "what came before."

---

## Future direction: LLM-driven contextual weaving (deferred)

The static frame can't adapt to surrounding prose. The intended evolution:
**`integration:` becomes an *exemplar* — it indicates the shape/register of
`{value}` — and an LLM that can see the surrounding text writes the connective
fluff to integrate the value naturally.**

The deterministic shape fetches the **data**; the LLM does the
**presentation**, using the author's exemplar as a style guide. This keeps the
"static data, format afterwards, the blank owns its presentation" philosophy —
just with the formatting done per-context instead of by a fixed string.

### Sketch

1. Blank fires deterministically (shape) → real value `Oslo: 22°C Clear`.
2. Blank declares an exemplar, e.g. `integration: it's a clear evening, about
   18°C` — teaches register + shape, not a literal template.
3. One LLM call receives **the buffer context** (the prose around the command),
   **the value**, and **the exemplar**.
4. It returns the value woven into the flow:
   - `Planning a trip to Oslo.\nweather oslo _`
     → `Planning a trip to Oslo.\nRight now it's 22°C and clear there.`
   - `weather oslo _` alone → `It's currently 22°C and clear in Oslo.`
5. Merge-protected (reuses the transform / three-way-merge machinery) so a
   late LLM response never clobbers edits made during the call.

### Distinct from the other verbs

| Verb | Role |
|---|---|
| blank + static integration | fixed frame, `{value}` substituted, 0 LLM (shipped) |
| blank + LLM integration | value woven into surrounding prose via an exemplar (deferred) |
| transform | rewrites the whole buffer by intent |
| fluid | looks up a free-form answer |

### Open design decisions (resolve before building)

1. **It's an LLM call** — opt-in per blank; trades the 0-latency static path
   for context-aware weaving. Be deliberate about the cost.
2. **Context scope** — with anchored shapes the command leads its line, so the
   natural "around it" is the **prior buffer** (earlier lines/sentences), not
   same-line text.
3. **Exemplar format** — free example sentence (`it's a mild, clear evening`,
   max LLM freedom) vs a `{value}`-bearing template the LLM may adapt
   (`it's currently {value}`, more anchored). Leaning free-example.

### Why deferred

The static form covers the common case at zero cost and zero risk. The
LLM form is a genuine feature (call cost, prompt design, a bench for weaving
quality) and was parked to keep the current simplification pass focused on
*removing* machinery rather than adding it.

---

## Pointers

- Implementation: `renderIntegration` + the `clearsCommandSpan` logic in
  `packages/opencues-runtime/src/modules/blank-fill.ts`.
- Parser field: `integration?: string` in
  `packages/opencues-core/src/cues-md.ts`.
- Related: [`blank-sources.md`](blank-sources.md) (the source family),
  the `blankShapes` deterministic routing (keywords desugar to shapes),
  [`transform-blank.md`](transform-blank.md) (the LLM rewrite verb the future
  weaving would borrow its merge layer from).
