# Unified model-driven dispatch

Status: **shipped — the sole `_` router (no flag; always on)**
Last updated: 2026-06-28

## Why

A `_` used to be routed by **five different opinionated mechanisms**, each a
place the code decided *for* the user instead of reading intent:

1. `blankKeywords` exact-match — a blank fired only on a literal keyword.
2. `blankProximity: N` — a magic number for how close the keyword must sit to `_`.
3. `blankReplace: auto` — a deterministic copula/equation regex that *guessed*
   how much surrounding text to wipe.
4. The structural **claim race** — the keyword path claimed input before the
   flexible LLM paths (fluid-blank / transform) got a look.
5. **BlankIntent** — an LLM invoke/cede gate bolted on top of 1–4.

The failure this produced (real, reported): typing a natural sentence
`what's the weather like in oslo _` was claimed by the weather keyword
(proximity 3), and `blankReplace: auto` then wiped the phrase, producing the
mangled `what's the Oslo: 21°C Mostly clear`.

**The fix:** replace those five opinions with **ONE model decision per `_`**,
consistently for every blank. The model reads the buffer and decides *which
blank, what action, what argument, and how to substitute*; the deterministic
code stops deciding and becomes a **safe executor**. This is the project's
"minimise opinions, rely on the model" philosophy applied to dispatch.

## The decision shape

One classifier call per `_` returns a `DispatchDecision`
(`packages/opencues-core/src/unified-dispatch.ts`):

```
{
  route: 'action' | 'lookup' | 'transform' | 'none',
  blank?: string,                 // for 'action' — the chosen blank
  action?: 'get' | 'set' | 'step',
  arg?: string,                   // city / ticker / set-value / step-direction
  replaceStart?: number,          // char span the result replaces (model-chosen)
  replaceEnd?: number,
}
```

The parser is **total and validate-and-degrade**: malformed output → `none`;
an out-of-bounds REPLACE span is clamped to the buffer (no OOB splice, ever).

## The gate is authoritative

The classify-first gate runs at the top of the resolver's `resolveAndApply`
(`packages/opencues-runtime/src/modules/resolver.ts`). It owns every `_`:

- **`action`** → executed immediately and short-circuits the source resolve.
  - Data/host-native blanks (weather/stocks/crypto) run via `adapter.blankInvoke`.
  - Script/settable blanks (volume/brightness) run via `BlankFill.runScriptAction`
    (reuses the tested exec/sandbox engine). The result is spliced at the
    **model-chosen span** (default = just the `_`, so the sentence survives).
- **`lookup`** → falls through; the resolve carries `dispatchRoute='lookup'`,
  so **only FluidBlank** claims the `_` (it returns `true` from `supports`,
  skipping the keyword-cede heuristics). Every other blank source cedes.
- **`transform`** → same, for **TransformBlank** only.
- **`none`** → fluid + transform both cede; a prose `_` is left alone.
  ConfigIntent (settings) + sentence/word cues still run — they are outside
  the blank classifier's codomain.

`dispatchRoute` is threaded on the `CueContext`; FluidBlankSource and
TransformBlankSource each gate `supports()` on it. This is what makes the
classifier authoritative **without** touching the fragile span/cycling
machinery — and it's what fixed the cede-collision (`the capital of france
is _`: "capital of" is the `countries` keyword, which used to make *both* the
keyword blank and fluid cede, dropping the lookup entirely).

Coordination with BlankFill: when the gate is wired (`gateActive`), BlankFill
**cedes every keyword script/data blank** in `matchKeyword`, so its
`scan()` returns no slots and its keyword path never double-fires against the
gate. BlankFill keeps only the things the gate doesn't do: stepValues
list-blank auto-populate (`onUnderscoreKey`) + span preservation / clearOnEdit.

## The floors (kept — these are safety, NOT opinions)

The model owns *judgment*; code keeps hard floors regardless:

- **No buffer destruction.** The model's replace span is validated/clamped; an
  ambiguous/failed decision degrades to `none` (leaves the buffer). The "no
  logical landmines" rule.
- **No exec with an unsanitized arg.** A `set`/`step` on a script blank is
  CLAMPED to `[0,100]` and the arg is passed as a **discrete argv element**,
  never a shell string — so an LLM-chosen value can't inject a command. The
  executor also verifies the blank exists and is settable.
- **`determineReplaceMode` survives as fluid-blank's data-loss floor.** The
  old `blankReplace: auto` heuristic is no longer a *router* (the model owns
  the span now), but the same function is fluid-blank's FILL/WIPE safety floor
  — so it stays. Likewise `blankProximity` survives only as the no-classifier
  fallback window. Both are **inert on the live dispatch path**; neither is a
  routing opinion any more. (This is the deliberate "open judgment → model,
  data-loss invariant → hardcoded floor" split — we removed the opinions, not
  the floors.)

## The trade-off (explicit)

The classifier makes **every `_` an LLM call**:
- ~200–1000ms latency per trigger (softened by cerebras prefix-cache + the
  per-buffer-text classify cache, never zero),
- **no offline / no-API-key operation** — without a key, `classify` degrades
  to `none` and `_` does nothing. This is the accepted cost of one uniform,
  flexible router.

## Wiring

Built once per host in `buildSharedRuntime` (`boot-common.ts:buildDispatchClassifier`),
reading API keys live and resolving its LLM lazily on the first `_`. Threaded
into the Resolver on every band (cc / oc / gemini / chrome / shell). Browser
hosts pass their fetch-based `dispatchHttpAdapter`; native hosts get
NodeHttpAdapter. Advanced per-feature overrides `dispatch-provider:` /
`dispatch-model:` remain (file-edit-only); otherwise it reads the **blanks**
LLM bucket.

## What this replaced / removed

- `dispatch-mode` scalar — **gone** (it's just how `_` works now).
- **BlankIntent** feature (classifier, `blank-intent-mode`, the 5-site
  keyword-window lockstep, its benches + scenarios) — **deleted**, subsumed
  by this gate.
- `blankProximity` / `blankReplace: auto` — demoted from routers to the
  fallback window / fluid's data-loss floor (see Floors above).
