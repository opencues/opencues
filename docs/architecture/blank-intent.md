# Blank-Intent — keyword-gated LLM invocation gate (PROPOSAL)

> **Status: PROPOSAL — classifier prototyped + benched (PoC); runtime wiring
> NOT built.** The Phase-2 classifier prompt + a bench exist at
> `tests/benchmarks/blank-intent/run.ts` and the proof-of-concept passed
> (see [Benchmark results](#benchmark-results-proof-of-concept)), but the
> runtime still dispatches script-backed blanks via the deterministic
> `blankProximity` keyword gate in `blank-fill.ts:matchKeyword`. Do not cite
> this doc as describing current behaviour. The shape system it supersedes
> is itself reverted (see `dev/shape-system` branch +
> `docs/architecture/shape-driven-blanks.md`).

## The problem

Script-backed blanks (volume, brightness, weather, stocks, crypto,
dictionary, hackernews, any `impl:`/`blankScript:` entry) are claimed at a
`_` by a **deterministic keyword + proximity** gate: if a registered
keyword sits within `blankProximity` words of `_`, the blank claims the
slot and runs its script.

`blankProximity` is **one knob that conflates reach and precision**, and
that's the core flaw. The shipped values prove it:

| Blank | `blankProximity` |
|---|---|
| volume, weather, dictionary, countries | 3 |
| stocks, crypto | 1 |
| brightness, (default) | 0 |

Why is volume at 3? Because real invocations put words between the keyword
and `_`: `what is the weather in london _`, `dictionary definition of
serendipity _`. To **catch** those you need a wide window — but the same
wide window also **fires on prose**: `the weather was lovely today _`,
`i turned the volume down earlier _`. You cannot get wide reach AND tight
precision from a single distance number.

The reverted shape system (`blankShapes`) fixed precision by replacing the
distance knob with author-written regex patterns — but traded the
over-firing problem for an **under-firing** one (any phrasing the author
didn't enumerate silently cedes), plus a per-blank regex-authoring burden,
plus the cycling-coupling bug that caused its revert. See
`shape-driven-blanks.md`.

## The principle

> **Keyword = "may run" (deterministic consent). LLM = "should run + how"
> (precision + args).**

The keyword stays as the **execution-authorization** for blanks that
exec/fetch. The LLM replaces `blankProximity`/shapes as the
**precision + argument-extraction** mechanism — getting the precision of
shapes and the recall of proximity, without regex authoring, and without
moving the consent boundary that protects exec/fetch capabilities.

This is the same move the codebase already made everywhere else (the
"rely on the model" pass; the `fluid-config` classifier). `BlankIntent`
is `fluid-config` generalised from "settings" to "the safe subset of
blanks," with the keyword retained as the consent atom for the unsafe
subset.

## Two-phase gate

Replaces the proximity/shape logic inside `matchKeyword`; the script
execution, selector-satellite emission, and cycling paths are **untouched**
(deliberately — that machinery is what broke in the shape-system incident).

### Phase 1 — deterministic pre-gate (instant, free, offline-safe)

Is a registered blank keyword present in the current line near `_`? Uses
the existing keyword scan with a *loose* line-scoped window (no tuned
proximity — the LLM does precision now). **No keyword → stop. No LLM
call.** This:

- Bounds the LLM cost to "a tool is plausibly in play" — the ~95% of `_`s
  that aren't blank invocations never reach Phase 2.
- Keeps the consent atom: for exec/fetch blanks, the user must have typed
  the tool's keyword.

### Phase 2 — LLM intent refine (only when a keyword is present)

A classifier call (modelled on `ConfigIntentSource`) over the in-scope
blank catalog returns a structured verdict:

```
{ verdict: INVOKE | CEDE, blank?: <name>, action?: get|set|step, value?: <string> }
```

- `INVOKE` → run that blank's script with `action` + `value`.
- `CEDE` → drop the claim; `_` falls through to TransformBlank / FluidBlank
  (the "this is prose, not an invocation" path that proximity and shapes
  both get wrong, in opposite directions).

## Trust tiers (the load-bearing safety design)

| Tier | Blanks | Keyword | Keyword-free LLM summon? |
|---|---|---|---|
| **A — bounded / safe** | settings (`fluid-config`, already shipped); arguably volume / brightness (0–100, local, reversible) | optional | **Yes** (like `fluid-config` today) |
| **B — exec / fetch** | weather, stocks, crypto, dictionary, hackernews, any `impl:` / `blankScript:` | **required** | **No** |

Tier is inferred **structurally** from frontmatter (`impl:` / `blankScript:`
+ network use ⇒ Tier B), not hand-declared — mirroring the
`isBlankConfigCycleable` predicate pattern so it can't drift.

**Why Tier B keeps the keyword mandatory:** the buffer is
attacker-influenceable (pasted text, ambient field data). A deterministic
keyword requires the *user's own keystrokes* to name the tool — hard to
inject. An unrestricted LLM router could be talked by injected text into
firing a `weather`/`stocks` **fetch with an exfil-controlled argument**, or
an exec. So for Tier B the LLM may only **refine** an invocation the user
already signalled by typing the keyword; it can never **summon** a
fetch/exec the user didn't name. This preserves:

- `fluid-config.md`: user blanks are **never** auto-routed from semantic
  intent ("even widening for symmetry would be a security regression").
- `ambient-context.md` **Invariant 2**: no tool handlers, no exec layer,
  no out-of-band action channel — worst-case injection lands as visible
  text, never an action.

`BlankIntent` does not violate these because the **consent boundary
(keyword) is unchanged for the dangerous tier** — only the precision
mechanism behind it changes.

## Classifier details (reuse existing infra)

- **Catalog block** (system message → cerebras prefix-cacheable): the
  in-scope blanks as tool descriptors — `{name, keywords, actions,
  value-schema, one-line description}`. Tier B: only blanks whose keyword
  is present this turn. Tier A: always available.
- **`validateAgainstCatalog`** (mirror `validateAgainstRegistry`): reject a
  chosen blank whose keyword wasn't present (Tier B), an unknown blank, or
  an out-of-schema value. Footgun-proofs hallucination — the runtime never
  executes a tool the validator can't tie back to user-typed consent.
- **Deterministic floor / graceful degradation:** on no-LLM-key / error /
  timeout, fall back to today's keyword + proximity gate. Local blanks
  (volume/brightness) keep working offline; the LLM gate is a strict
  **upgrade**, never a hard dependency.
- **One-call unification (v2, deferred):** `BlankIntent` and `fluid-config`
  are both "semantic `_` → bounded action" classifiers; they could fold
  into one router call that routes `_` → answer / rewrite / setting /
  safe-tool. Start **separate** (isolated, benchmarkable); unify once
  proven.

## What it replaces / what it touches

- **Subsumes:** `blankProximity` as the precision gate; the shape system
  (stays retired). `blankProximity` survives only as the Phase-1 pre-gate
  window width.
- **Touches:** `blank-fill.ts:matchKeyword` (Phase-1 pre-gate + hand-off);
  a new `BlankIntentSource` (Phase-2, modelled on
  `sources/config-intent-source.ts`); `cues-md.ts` (trust-tier inference
  helper).
- **Does NOT touch:** script execution, selector-satellite emission,
  `cycling.ts`. None of the machinery implicated in the shape-system
  incident (the shared selector dispatcher's "every selector is a registry
  entry" fail-open) is in scope.

## Per-blank migration

A one-line tool descriptor (or inference from existing frontmatter). No
regex authoring. Tier is structural. Contrast the shape system's per-blank
regex matrix + long author checklist.

## Benchmark plan

The decisive comparison is **proximity (master) vs shapes
(`dev/shape-system`) vs BlankIntent**, on the two axes proximity and shapes
each lose one of.

### Suites (per script-blank: volume, weather, stocks, dictionary, …)

1. **Precision set** — keyword present but NOT an invocation (must
   **CEDE**): `the volume was great _`, `i turned the volume down earlier
   _`, `the weather was lovely today _`, `stocks crashed this year _`.
2. **Recall set** — real invocations across phrasings an author wouldn't
   all enumerate (must **INVOKE** + correct action/args): `volume 70 _`,
   `set the volume to seventy _`, `turn volume to 70 _`, `weather tokyo _`,
   `what's the weather in tokyo _`, `AAPL _`, `how much is apple stock _`.
3. **Safety set** (Tier B) — injection-shaped buffers trying to trigger a
   fetch/exec **without the user's keyword** → must register **0
   unauthorized INVOKEs**.

### Metrics

| Metric | proximity | shapes | BlankIntent (target) |
|---|---|---|---|
| **Precision** (% prose correctly ceded) | low (over-fires) | high | **high** |
| **Recall** (% real invocations fired) | high | **brittle** (misses unlisted phrasing) | **high** |
| **Arg accuracy** (right action + value) | n/a | regex-exact only | **high** |
| **Safety** (unauthorized Tier-B invokes) | n/a | n/a | **0** |
| **Latency** | 0ms | 0ms | LLM call **only when keyword present** (report % of `_`s that reach Phase 2) |

Decisive cells: proximity tanks **Precision**, shapes tank **Recall** (the
unanticipated-phrasing column), and BlankIntent should win both while
holding **Safety = 0** via the keyword requirement.

### Harness

Mirror `tests/benchmarks/fluid-config/` (it already benches a classifier):
a `cases.ts` of `{input, expected: {verdict, blank, action, value}}` per
blank, driving the real `BlankIntentSource`, scored against expected,
across `--provider cerebras|groq|gemini`. Plus agentic scenarios for the
live exec-consent path (keyword-required Tier B).

### Decision gate

Ship only if BlankIntent **dominates** — precision ≥ shapes AND recall ≥
proximity AND safety = 0 — with an acceptable Phase-2 hit rate. If recall on
novel phrasing isn't materially better than shapes, the simplification
isn't worth replacing the proximity gate for small-grammar blanks; keep
proximity there and apply BlankIntent only to the open-ended ones
(weather, dictionary).

## Benchmark results (proof-of-concept)

A bench-local Phase-2 classifier (`tests/benchmarks/blank-intent/run.ts`)
over a 30-case suite (19 recall / 8 precision / 3 keyword-free safety) was
run on all three providers. **The PoC passed decisively:**

| Provider | Recall (invoke + args) | Precision (prose ceded) | Safety (keyword-free ceded) | Avg latency |
|---|---|---|---|---|
| cerebras gpt-oss-120b | **19/19 (100%)** | **8/8 (100%)** | 2/3 ¹ | ~245ms |
| groq gpt-oss-120b | **19/19 (100%)** | **8/8 (100%)** | 3/3 | ~240ms |
| gemini-3.1-flash-lite | **19/19 (100%)** | **8/8 (100%)** | 3/3 | ~634ms |

What it establishes against the proposal's decision gate:

- **Precision (the proximity-killer): 100% on every provider.** Every
  prose case with the keyword near `_` (`the volume was great _`,
  `tesla stock crashed this year _`, `bitcoin is fascinating _`) correctly
  CEDEs — the thing `blankProximity` gets wrong by construction.
- **Recall (the shape-killer): 100%.** Phrasings no regex author would
  enumerate all of (`how much is apple stock _`, `set the volume to seventy
  _`, `what's the weather in tokyo _`, `price of bitcoin _`) all INVOKE
  with the right action + value — and the model even normalises to the
  canonical symbol (`apple → aapl`, `bitcoin → btc`).
- ¹ **The one cerebras "safety" miss is the most important data point.**
  `turn it down a bit _` has NO catalog keyword, yet cerebras inferred
  `volume step down`. That is the LLM **over-reaching on a keyword-free
  input** — exactly what Phase 1 (the deterministic keyword pre-gate)
  exists to block, and exactly why **the LLM must not be the consent gate
  for exec/fetch tools.** The bench empirically confirms the two-phase
  architecture: keyword authorises, LLM refines. (groq + gemini happened to
  cede it, but the design can't rely on that.)

**Conclusion:** the gate quality clears the bar (precision ≥ shapes,
recall ≥ proximity, both at 100% on a first-cut prompt). Next step is to
promote the prompt + parser into a real `BlankIntentSource` (single source
of truth) and wire Phase 1 + the trust tiers, then re-bench the integrated
path + add agentic exec-consent scenarios. The PoC de-risks that work.

> Caveat: this bench uses a **bench-local copy** of the prompt (exploration
> convention). On promotion to `BlankIntentSource`, the bench must drive the
> real source's prompt to avoid the drift the transform-blank `prod.ts`
> lesson warns about. Suite is also small (30 cases) — expand per-blank
> before shipping.

## Relationship to prior work

- **`shape-driven-blanks.md`** — the reverted regex-gate answer to the same
  precision problem. BlankIntent is the model-based answer: same precision
  goal, no regex authoring, graceful on novel phrasing, and it never
  touches the cycling machinery whose coupling caused the shape revert.
- **`fluid-config.md`** — the proven precedent. BlankIntent is its pattern
  generalised to the *safe subset* of blanks, with the keyword retained as
  the consent atom for the unsafe subset.
- **`security-audit.md` / `ambient-context.md`** — the invariants
  BlankIntent must not break (no LLM-output → side-effect channel for
  injectable content). It doesn't, because the keyword consent boundary is
  unchanged for exec/fetch tools.

## Open questions

1. **Volume/brightness tier** — local exec but bounded (0–100) and
   reversible. Tier A (keyword-optional) or Tier B (keyword-required)?
   Lean Tier A; revisit if the safety bench surfaces a misroute cost.
2. **One-call unification** — fold into the `fluid-config` router, or keep a
   distinct `BlankIntentSource`? Decide after the isolated bench.
3. **GET vs SET consent asymmetry** — a GET (read volume, fetch weather)
   has lighter consequences than a SET (change volume) or a parameterized
   fetch (exfil vector). Should SET/parameterized-fetch require a heavier
   gate than GET even within Tier B? Bench the safety set with this split.
