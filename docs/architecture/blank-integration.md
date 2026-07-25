# Blank integration templates

The `integration:` field on a blank lets it **expose how its output reads**,
so the runtime can weave the value into the buffer with connective "fluff"
instead of dropping a bare value. It is **add-only by construction** — it
only ever shapes the *inserted value*, never the user's surrounding text.

> Status: BOTH forms are shipped. The **static** form (below) is the default
> and runs zero-LLM. The **LLM-woven** form (§ LLM contextual weaving) is
> opt-in behind `integration-weave-mode: on` + per-blank `integration-weave: true`.

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

## LLM contextual weaving (opt-in)

The static frame can't adapt to surrounding prose. The opt-in evolution:
**an LLM weaves the `integration:` exemplar into the surrounding text — but it
never sees the real value.** The deterministic shape fetches the **data**; the
LLM does the **presentation**; the runtime splices the data into the
presentation deterministically afterward.

### The privacy/integrity invariant

The load-bearing property: **the value never reaches the provider.** The LLM
weaves connective text around a sentinel **token**, and the runtime swaps the
real value in for the token *after* the response — locally, in `BlankFill`.
This buys two things the static template and a naive "send the value" design
can't:

1. **Privacy** — the value (a stock price, the weather, anything personal)
   stays on the machine; it's never in the provider's logs.
2. **Integrity** — the LLM can't hallucinate, reformat, translate, or drop the
   value. It only writes fluff around a token; the runtime fills the token.

### Flow

```
integration: it's currently {value}
integration-weave: true
```

1. Blank fires deterministically (shape) → real value `22°C Clear`. **Stays local.**
2. The exemplar's `{value}` → a sentinel token: `it's currently ⟦VALUE⟧`.
3. The fill is held back and the **loading animation keeps running** while ONE
   blanks-bucket LLM call (bounded by a ~6 s timeout) receives the **prior
   buffer** (context) + the **placeholder phrase** (with the token) and weaves
   it: `Planning a trip to Oslo.\nweather oslo _` → `Right now it's ⟦VALUE⟧ there.`
4. The runtime swaps `⟦VALUE⟧` → `22°C Clear` deterministically and commits the
   woven phrase **once**: `…Right now it's 22°C Clear there.` The buffer changes
   a single time (loader → woven), never value-then-reflow.
5. On ANY failure (gate off, no key, LLM error, mangled token, timeout) the
   commit lands the **static template** instead (`…it's currently 22°C Clear`) —
   still one change, never blocked, never corrupted.
6. If the user edits during the wait, the fill is dropped (their edit wins) —
   the same staleness contract every async blank fill already honours. The
   staleness check compares every word **except the slot word**: the slot
   char is transient during the wait (it flips between `_` and a
   loading-frame char as the animation paints, and a co-owner — the
   resolver, in `blank-trigger-mode: spaced` where both BlankFill and the
   resolver fire on the confirming space — can keep it a frame char after
   BlankFill's own `stop`). Comparing the whole string once treated that
   transient slot char as a user edit and silently dropped the fill —
   `blank.substituted` fired but nothing committed (the spaced +
   integration-weave bug, fixed 2026-07-25). The earlier `ourSlot` guard
   in `applyAsyncFill` already proved the slot was ours at dispatch, so the
   only thing the weave check must still catch is an edit **elsewhere**.

### Authoring + gating

- Per-blank: `integration-weave: true` (the `integration:` exemplar must keep
  its `{value}` slot — that's the swap point).
- Global: `integration-weave-mode: off | on` (off by default). Both must be set.
- Provider: the **blanks** bucket (`blanks-llm-provider`). The `_` keystroke is
  the consent gate, same as every other blank LLM call.

### Distinct from the other verbs

| Verb | Role |
|---|---|
| blank + static integration | fixed frame, `{value}` substituted, 0 LLM (default) |
| blank + woven integration | value spliced into LLM-written fluff via a token; value never sent (opt-in) |
| transform | rewrites the whole buffer by intent |
| fluid | looks up a free-form answer |

### Implementation

- `packages/opencues-runtime/src/modules/blank-weave.ts` — the weaver +
  `FUSED_WEAVE_SYSTEM` prompt + `WEAVE_VALUE_TOKEN`. The weaver returns the
  woven phrase *still containing the token*; the value swap happens in the
  caller, so the value never enters this module.
- `BlankFill.applyAsyncFill` (`blank-fill.ts`) — when a fill will weave, it
  holds the static commit, keeps the loader running, awaits the weaver (bounded
  by `WEAVE_TIMEOUT_MS`), then commits ONCE: the value spliced into the woven
  phrase on success, or the static template (`commitStatic`) on failure/timeout.
  A staleness check drops the fill if the buffer changed during the wait.
- Wired into every band via `buildBlankWeaver`: CC inline
  (`adapters/cc/v2.1/boot.ts`), OC/gemini/shell via `boot-common.ts` (native
  NodeHttpAdapter fallback), and chrome via `adapters/chrome/v1/boot.ts`
  passing its fetch-based `host.httpAdapter` (NodeHttpAdapter is stubbed in the
  browser bundle).
- Emits a `blank.woven` event (`blankName` + `output`) when the weave commits.

### Tests + bench

- Runtime contract (deterministic, mock weaver): token-swap +
  static-fallback in `blank-weave.test.ts`; the clearOnEdit-wipe regression +
  privacy guarantee in `blank-weave-fill.scenarios.test.ts`.
- LLM quality: `tests/benchmarks/integration-weave/prod.ts` measures
  token-survival across providers — cerebras + groq both 100% at the June 2026
  baseline.

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
