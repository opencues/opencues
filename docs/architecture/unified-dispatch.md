# Unified model-driven dispatch (`dispatch-mode`)

Status: **Stage 1 — engine + flag (default `heuristic`, opt-in `model`)**
Last updated: 2026-06-28

## Why

Today a `_` trigger is routed by **five different opinionated mechanisms**,
each a place the code decides *for* the user instead of reading intent:

1. `blankKeywords` exact-match — a blank fires only on a literal keyword.
2. `blankProximity: N` — a magic number for how close the keyword must sit to `_`.
3. `blankReplace: auto` — a deterministic copula/equation regex that *guesses*
   how much surrounding text to wipe.
4. The structural **claim race** — the keyword path claims input before the
   flexible LLM paths (fluid-blank / transform / typed-sentinel) get a look.
5. BlankIntent — already an LLM invoke/cede gate, but bolted on top of 1–4.

The failure this produces (real, reported): typing a natural sentence
`what's the weather like in oslo _` is claimed by the weather keyword
(proximity 3), and `blankReplace: auto` then wipes the phrase, producing the
mangled `what's the Oslo: 21°C Mostly clear`.

**Goal:** replace those opinions with ONE model decision per `_`, consistently
for every blank. The model reads the buffer and decides *which blank, what
action, what argument, and how to substitute*; the deterministic code stops
deciding and becomes a **safe executor**. Slower (an LLM call per trigger) but
flexible and uniform — the project's "minimise opinions, rely on the model"
philosophy applied to dispatch.

## The floors (kept — these are safety, NOT opinions)

The model owns *judgment*; code keeps these hard floors regardless:

- **No buffer destruction.** The model's chosen replace span is validated; an
  ambiguous/failed decision degrades (leaves the buffer), never wipes content.
  (The "no logical landmines" rule.)
- **No exec with an unsanitized LLM arg.** A `set`/`step`/script action's
  argument is validated/bounded before the executor runs it — the same
  capability model as typed-sentinel `param-safe` (security-audit.md #23).
  The model can't make the runtime run an arbitrary shell command.
- **Executor sanity-checks the command** (volume 0–100, known blank names, …).

So actions still work: the model *decides* "set volume to 50"; the deterministic
executor *runs* it after validation. Consistency is in the decision layer.

## The trade-off (explicit)

`dispatch-mode: model` makes **every `_` an LLM call**:
- ~200–1000ms latency per trigger (softened by cerebras prefix-cache + debounce, never zero),
- **no offline / no-API-key operation** (today actions + cached lookups work without an LLM),
- token cost per keystroke-`_`.

This is why it's **opt-in** (`dispatch-mode: heuristic` default). It is a
deliberate "slower but flexible" choice.

## The decision shape

One classifier call per `_` returns a `DispatchDecision`:

```
{
  route: 'action' | 'lookup' | 'transform' | 'none',
  blank?: string,                 // for 'action' — the chosen blank
  action?: 'get' | 'set' | 'step',
  arg?: string,                   // city / ticker / set-value / step-direction
  replaceStart: number,           // char span the result replaces (model-chosen)
  replaceEnd: number,
}
```

- `action` → the executor runs the blank's get/set/step (deterministic, validated)
  and substitutes the result into `[replaceStart, replaceEnd)`.
- `lookup` / `transform` → hand to the existing fluid-blank / transform paths,
  which ALREADY do model-driven substitution well (so we reuse, not rebuild).
- `none` → no blank fires.

The model owning `replaceStart/replaceEnd` is what kills `blankReplace: auto`:
for `what's the weather like in oslo _` it can replace just the `_`, or the
whole question, preserving the sentence — its call, not a regex's.

## Stages

- **Stage 1 (this):** the pure classifier engine (`unified-dispatch.ts` —
  schema + prompt + parser) + the `dispatch-mode` flag (default `heuristic`).
  Fully unit-tested. NOT yet wired into the live resolve loop.
- **Stage 2:** wire it behind the flag — when `dispatch-mode: model`, the
  resolver routes each `_` through the classifier and applies the decision,
  bypassing the keyword/proximity/blankReplace heuristics. Prove it preserves
  the weather sentence end-to-end; keep the heuristic path as default.
- **Stage 3:** once proven, make `model` the default; the keyword path becomes
  an optional offline fast-path the model can confirm. Retire `blankProximity`
  / `blankReplace: auto` for data blanks.

Each stage is its own checkpoint so the latency can be *felt* before widening.
