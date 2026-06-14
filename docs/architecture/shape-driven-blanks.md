---
last_updated: 2026-06-14
---

# Shape-Driven Blanks — Three-Axis Model

This is the canonical reference for the **shape-driven blank** mechanic introduced June 2026. It replaces the coarse `blankProximity:` gate with declarative shape patterns, formalises the `<script> set <value>` contract, and converges every script-backed blank on a single emission shape (the selector-satellite span) with well-defined navigation and cycling semantics.

Read this before:
- Authoring a new script-backed blank (`defaults/blanks/<name>/BLANK.md` + script)
- Touching `matchKeyword` / `applySatelliteFill` in `packages/opencues-runtime/src/modules/blank-fill.ts`
- Touching `cycleSelectorSatellite` in `packages/opencues-runtime/src/modules/cycling.ts`
- Touching word-by-word navigation in `packages/opencues-runtime/src/modules/navigation.ts` (when the atomic-pair carve-out lands; see [Navigation semantics](#navigation-semantics))
- Migrating an existing script-backed blank from `blankProximity:` to `blankShapes:`

Companion docs:
- **[`blank-sources.md`](blank-sources.md)** — the family of `CueSource` classes (`BlankSource` / `FluidBlankSource` / etc.) and the substitute mechanisms. Shape-driven gating sits **above** that layer — it picks which slots `BlankSource` claims, not how the substitute is computed.
- **[`fluid-config.md`](fluid-config.md)** — the LLM-classifier flow for natural-language settings flips. Shape-driven blanks deliberately avoid LLM classification; this doc explains why.
- **[`blank-replace-modes.md`](blank-replace-modes.md)** — the legacy `blankReplace: keep | wipe | wipe-all | auto` mechanic. Shape-driven blanks have a fixed effective mode (line-scoped wipe) regardless of the field; this doc explains the divergence.
- **[`spans-and-cycling.md`](spans-and-cycling.md)** — DynDef + span machinery the selector-satellite stash sits on top of.

User-facing summary: `docs/features/blanks.md` (TODO — to be written as part of the shape-driven migration).

---

## What this mechanic is

Three independent axes that compose into one blank declaration:

| Axis | Frontmatter field | Controls |
|---|---|---|
| **Shapes** | `blankShapes:` (array of `{pattern, action, valueGroup?}`) | When the blank fires (precision gate) + which script verb runs (`get` / `set` / `step`) + what literal value gets captured |
| **Script contract** | `blankScript:` (or `impl:` for JS user-blanks) | How state gets applied. Script accepts `<verb> <value>` and echoes `<selector>\t<satellite>` on stdout |
| **Cycle vocab** | `blankStep:` (numeric) and/or `stepValues:` (categorical) | What Ctrl+Alt+↑/↓ does after the fill. Both optional, both compose with shapes + script |

Default emission: a **selector-satellite span** (`blankSatellite: true` + `blankClearOnEdit: true` + `blankConsumeContext: true`). The result reads `volume 70%` as one wipeable unit.

---

## Emission shapes — cycle vocab decides

A shape-driven blank picks one of two emission shapes based on **whether it declares cycle vocab** (`blankStep:` and/or `stepValues:`). The visual structure reflects whether there's an interaction to expose.

### Selector-satellite emission (cyclable blanks)

When a blank declares cycle vocab AND `blankSatellite: true` AND the script outputs `<selector>\t<satellite>` (tab-separated), the runtime splices the pair as a selector-satellite span:

```
INPUT:  volume 70 _
SCRIPT: volume\t70%
BUFFER: volume 70%
        └─selector──┘└─satellite─┘
        plain text   gray (cyclable)
```

The selector is a **static label** (plain text); the satellite is the **cyclable handle** (gray). The user navigates to the pair as one nav step and presses Ctrl+Alt+↑/↓ to cycle the value. Used by every shape-driven blank that has cycle vocab — today volume + brightness, future theme / lights / any blank with a tunable axis.

### One-span emission (read-only blanks)

When a blank has NO cycle vocab (no `blankStep`, no `stepValues`), there's no interaction to expose. We drop the selector-satellite split entirely. The script outputs a plain string (no tab), the runtime splices it via the regular `consumeContext` path, the whole substitution renders as one gray span:

```
INPUT:  weather london _
SCRIPT: weather London 14°C Partly cloudy
BUFFER: weather London 14°C Partly cloudy
        └────────── one gray span ──────────┘
        clearOnEdit + Backspace-wipe still apply
```

The user can Backspace the whole span away (one wipe) or edit anywhere inside it (triggers `blankClearOnEdit`). No selector to navigate to, no cycling key bindings — just "AI substituted text the user can remove."

### Which shape to use

The author decides at BLANK.md authorship time, gated by cycle vocab:

| Has `blankStep:` or `stepValues:` declared? | Emission shape | Script output |
|---|---|---|
| Yes (cyclable) | Selector-satellite | `<selector>\t<satellite>` (tab-separated) + `blankSatellite: true` in BLANK.md |
| No (read-only) | One uniform gray span | Plain string (no tab), no `blankSatellite:` in BLANK.md |

Both shapes use `blankClearOnEdit: true` + `blankConsumeContext: true`. Both shapes wipe-line on fill. The only differences are: (a) whether the substituted region splits into selector+satellite words, (b) whether cycling keys do anything, (c) whether the runtime registers a `selectorSatelliteState` stash or a `spanFillState` stash for the substituted region.

### Shipped examples

| Blank | Has cycle vocab? | Emission |
|---|---|---|
| `volume` (`blankStep: 6`) | Yes | `volume\t70%` (selector-satellite) |
| `brightness` (`blankStep: 10`) | Yes | `brightness\t70%` (selector-satellite) |
| `weather` (none) | No | `weather London 14°C Partly cloudy` (one gray span) |
| `stocks` (none) | No | `AAPL: $230.50` (one gray span) |
| `dictionary` (none) | No | one gray span (TBD per migration) |
| (future) `theme` (`stepValues: [dark, light, sepia]`) | Yes | `theme\tdark` (selector-satellite) |

**There is one separate case** — the FEATURES-registry blank (`opencues settings _`) — where the selector is **also** a cycle axis. See [Two distinct kinds of selector-satellite pairs](#two-distinct-kinds-of-selector-satellite-pairs) below.

---

## Navigation semantics

> **Status note:** the atomic-pair carve-out described in this section is the **agreed design** but **not yet implemented** in `navigation.ts` as of June 2026. The runtime currently treats every word as independently navigable. This section documents the intended semantics; the migration is queued in `plan.md` § Step 4.

For shape-driven blank pairs, the selector + satellite together act as **one navigation unit**:

```
Hello there volume 70% world
            ├──────────┤
            one Ctrl+Alt+→ step
```

Concretely:

- **Ctrl+Alt+→** stepping into a shape-driven pair lands on the **satellite directly**, skipping the selector. The pair is one step.
- **Ctrl+Alt+←** stepping out of a shape-driven pair lands on the **word before the selector**, also skipping the selector. Symmetric.
- The cursor still **passes through** selector character positions during normal text editing — the carve-out is specifically about Ctrl+Alt+→/← (word-skip navigation), not character-level cursor movement. Typing inside the span triggers `clearOnEdit` (same as today).

For FEATURES-registry pairs (where the selector axis is real), navigation is unchanged — both selector and satellite are independently navigable, because the user genuinely wants to land on the selector to cycle through settings.

### Rendering follows the navigation predicate

The dim layer (`dim-render.ts`) and the nav layer (`navigation.ts`) share the **same predicate** for shape-driven blanks: when the active pair's blank has `blankShapes:` declared, the selector is **suppressed from `dimRanges`**. The visual gray treatment means "there's a navigable cue here" — and since the selector isn't navigable for shape-driven blanks, dimming it would be a lie. The satellite stays dimmable; the selector renders as plain text.

For FEATURES-pairs, both sides stay dimmed — both ARE interactive.

The two carve-outs (navigation + dimming) must move together. If you ever change one's predicate, change the other's to match — otherwise you get the visual-promise vs. interaction-reality drift that confused users in the first place.

### Why atomic for shape-driven

The selector for shape-driven blanks carries no independent semantic. It's a label. Making it independently navigable suggests an axis that doesn't exist: pressing Ctrl+Alt+↑ on it would either do nothing (confusing — implies action but does none), or forward to the satellite (today's behaviour — masks that they're not actually the same axis), or cycle into something else (which is exactly the bug we hit when the selector wasn't in the FEATURES registry — see [the June 2026 incident](#the-june-2026-incident) below).

Atomic navigation gives the user one clear interaction model: **navigate to the pair, then cycle the value**. The label is read-only context. The two-step navigation model (selector and satellite as separate stops) was a vestige of the FEATURES-pair pattern that didn't transfer.

---

## Cycling semantics

After the splice, `Ctrl+Alt+↑` / `Ctrl+Alt+↓` step the satellite value through the blank's declared cycle vocab. Three dispatchers in `cycleSelectorSatellite`, walked in order:

| Dispatcher | Precondition | Behaviour |
|---|---|---|
| **Numeric-step** | `blankStep:` set + current value parses as integer | `current ± blankStep`, clamped to `[0, 100]` |
| **Categorical** | `stepValues:` is a non-empty array | Cycle through the list with wraparound |
| **FEATURES-registry** (legacy) | Current selector is in `opencuesState.definitions` | Selector cycles through settings, satellite cycles through values |

Each dispatcher short-circuits to the next if its precondition fails. A blank can declare both `blankStep` and `stepValues` (numeric-step wins for numeric values, categorical wins for string values — useful when a control has both numeric range AND symbolic shortcuts like "max" / "mute").

### Selector-press routing

For shape-driven blanks, **pressing ↑/↓ on the selector forwards to the satellite**. This is implemented as a flag-flip at the top of `cycleSelectorSatellite`:

```typescript
if (isSelector && !isSatellite) {
  const blank = configLoader.blanks.get(entry.blankName);
  const isShapeDriven = Array.isArray(blank?.blankShapes)
    && (blank.blankShapes.length ?? 0) > 0;
  if (isShapeDriven) {
    isSatellite = true;
    isSelector = false;
  }
}
```

The forward only fires when the blank has `blankShapes:` declared. For FEATURES-registry blanks (`opencues settings _`) — which have no shapes — the flag stays as `isSelector`, and the existing dual-axis cycle path runs.

With the atomic-pair navigation carve-out (above), selector presses become rare in practice — the user can only land on the selector via character-level cursor movement, not word-skip navigation. But the forward rule stays as defence-in-depth: even if a press lands on the selector, the right thing happens.

---

## Two distinct kinds of selector-satellite pairs

OpenCues now has two structurally similar but semantically different uses of the selector-satellite emission. Both ship `pair as one span, clearOnEdit, satellite cycling` — but they differ on the selector axis:

### Single-parameter pair (shape-driven blanks)

- One parameter per blank: volume, brightness, weather, stocks
- Selector is a **static label** echoing the keyword
- Satellite is the only cyclable handle
- Selector-press cycling forwards to satellite (no independent axis)
- Navigation: pair is one Ctrl+Alt+→ step (atomic)

### Multi-parameter pair (FEATURES-registry blanks)

- One blank, N parameters (every OPENCUES.md scalar)
- Selector is a **chooser** cycling through parameter names
- Satellite cycles the chosen parameter's value vocab
- Selector-press cycles parameters; satellite-press cycles values
- Navigation: selector and satellite are independently navigable (each axis is meaningful)

Today only `opencues-settings` (the FEATURES-registry blank) uses the multi-parameter shape. ConfigIntent's natural-language flip (`turn debug mode on _` → `debug-mode on`) lands as a FEATURES pair too — it's reusing the same emission with the same dual-axis semantics.

The two patterns coexist because they answer different questions. Single-parameter answers "what's the value of this thing?" Multi-parameter answers "which thing, and what's its value?" A future `blankParameters:` field would let user blanks opt into the multi-parameter shape (see [Multi-parameter blanks (deferred)](#multi-parameter-blanks-deferred) below).

---

## Reasoning

### Why selector is a label, not a chooser

When we introduced shape-driven blanks, every shipped script-backed blank turned out to be single-parameter. Volume has one value to tune. Brightness has one. Weather reads one current condition. Stocks reads one price. There is no second axis a selector could meaningfully cycle to.

We considered three options:

| Option | Selector behaviour | Verdict |
|---|---|---|
| Selector is non-interactive (read-only label, ↑/↓ no-op) | Honest but confusing — selectable but does nothing | Rejected |
| Selector and satellite both cycle the value (interchangeable handles) | Ergonomic but conflates model | Rejected — implies two axes when there's one |
| Selector forwards to satellite (label that helpfully redirects presses) | Honest model + ergonomic UX | **Picked** |

The third option keeps the mental model clean (selector = label, satellite = control) while giving the user a forgiving interaction (press on either word, the value cycles). The atomic-pair navigation makes the model even cleaner by removing the temptation to land on the selector independently.

### Why we didn't use LLM classification

ConfigIntent classifies natural-language phrases like "turn debug mode on" via an LLM call. That's appropriate because the codomain is bounded — it can only flip OPENCUES.md FEATURES-registry scalars, never a script-backed user blank.

Shape-driven blanks deliberately avoid LLM classification because:

1. **Codomain widens unacceptably**. A user blank declares an arbitrary script that can touch the world (system audio, brightness, HTTP fetches, file writes). Allowing an LLM to route arbitrary natural-language phrases to a user blank's `set <value>` widens the prompt-injection blast radius — a hostile page or document could craft text that the LLM classifies as a setter call.
2. **Latency cost**. ConfigIntent already pays ~280ms per `_` for its LLM call. Doing the same for every script-backed blank multiplies the cost. PR #135's keyword pre-filter mitigates ConfigIntent's cost specifically; extending it to all blanks would lose that win.
3. **Determinism**. Regex shapes are deterministic. Authors can reason precisely about what fires their blank. LLM classification is probabilistic — every model and every version drifts in subtle ways.

Shapes give us the precision (no misfires on prose like "the volume was great _") without the security or perf cost. The trade-off: shapes are less forgiving — a phrase that doesn't literally match a declared pattern won't fire, even if the LLM would have classified it correctly.

### Why proximity gate retires for shape-driven blanks

`blankProximity:` is a **positive-only** gate — it says "keyword is within N words of `_`" and claims the slot if true. It can't say "the user actually intends an invocation." Three structural misfires:

| User types | proximity 3 verdict | What user wanted |
|---|---|---|
| `the volume was great _` | Fires GET (claims slot) | Fluid-blank lookup |
| `please increase the volume _` | Fires GET | A setter (or fluid lookup) |
| `the volume button is broken _` | Fires GET | Fluid-blank lookup |

Shapes upgrade the gate to "input matches one of these patterns." Prose strings match no shape → fluid-blank takes the slot. The misfire surface drops from "any sentence with the keyword near `_`" to "only sentences that literally look like an invocation."

We didn't rip `blankProximity:` out of the codebase. Shape-less blanks (the legacy default) still use it. Shape-driven blanks bypass it. Both can coexist indefinitely.

### Why we wipe the whole matched input

Shape regex patterns are author-anchored: by convention `^...$` against the buffer up to and including `_`. When a shape matches, the **entire input** is the summon. Wiping just the keyword (today's `blankConsumeContext` semantic) would leave prefix/suffix words orphaned:

```
INPUT:  change theme to sepia _
LEGACY: change theme sepia      ← "change" and "to" orphaned
NEW:    theme sepia              ← whole shape wiped, satellite spliced
```

`applySatelliteFill` was extended with a shape-aware wipe range: when `slot.action !== undefined` (shape-driven match), wipe from the last newline boundary up to and including the `_`, then splice the pair. Surrounding paragraphs survive (line-scoped, not buffer-scoped).

---

## The June 2026 incident

The first cut of shape-driven blanks made the selector navigable AND let selector-position ↑/↓ fall through to the FEATURES-registry cycle dispatcher. The fallthrough used `definitions.get(entry.currentSetting)` to look up the selector word in the OPENCUES.md registry; for volume that returned `undefined` and the code bumped to index 0, which is the first registry setting (`debug-mode` or similar). The visible bug: pressing Ctrl+Alt+↑ on `volume` cycled into `debug-mode something`, replacing the volume blank's selector with an unrelated setting.

The structural lesson: **the FEATURES-registry selector dispatcher assumed every selector it ever saw was a registry entry.** That assumption was true before shape-driven blanks because the only selector-emitting blank was `opencues-settings`. Once a second emission path appeared (shape-driven blanks), the assumption silently failed open.

Two fixes applied:

1. **Bail in the FEATURES selector dispatcher** when `definitions.indexOf(entry.currentSetting) < 0`. Defence-in-depth — even if a selector press leaks past the forward rule, the registry path no longer cycles into something the user didn't want.
2. **Forward selector-press to satellite for shape-driven blanks** (the rule documented above). Eliminates the leak path entirely for the intended case.

This is documented in `cycling.ts` with the multi-paragraph comment that opens `cycleSelectorSatellite`.

---

## Multi-parameter blanks (deferred extension)

Today every shape-driven blank is single-parameter. A future extension would let one BLANK.md group multiple controls under a single blank, with the selector cycling between them — exactly the shape `opencues-settings` already has, but exposed to user blanks.

### Provisional schema

```yaml
---
name: system
type: blank
blankKeywords: system
blankShapes: [{"pattern":"^system\\s*_$","action":"get"}]
blankParameters:
  volume:     { step: 6,           type: numeric, clamp: [0, 100] }
  brightness: { step: 10,          type: numeric, clamp: [0, 100] }
  mute:       { values: [on, off], type: categorical }
  balance:    { step: 5,           type: numeric, clamp: [-100, 100] }
blankScript: ./system-blank.sh
---
```

### Provisional script contract (extended)

```
$1 = get | set
$2 = parameter name (volume / brightness / mute / balance)
$3 = (set only) the value
echo `<parameter>\t<final-value>` on stdout.
```

### Runtime changes when this lands

- Selector cycler dispatcher learns to read `blankParameters:`. When the blank has parameters declared:
  - Selector-position ↑/↓ cycles parameter names (`volume → brightness → mute → balance → volume`)
  - Satellite-position ↑/↓ cycles the chosen parameter's vocab (e.g. `balance` uses `step: 5, clamp: [-100, 100]`)
- The selector-forwards-to-satellite rule becomes **conditional on `!blankParameters`** — single-parameter blanks still forward, multi-parameter blanks expose the dual-axis.
- Navigation atomic-pair carve-out becomes conditional too — multi-parameter pairs keep both stops navigable (selector axis is real).
- `BlankSlot.parameter?: string` added to carry the chosen parameter through to the script call.
- Spec adds `blankParameters:` to the blank schema. Conformance fixtures cover the two-axis cycling.

### Why we're not doing this now

- No real use-case in the shipped defaults. Adding it speculatively widens the schema surface.
- Single-parameter covers ~100% of shipped script blanks.
- The `opencues-settings` blank already serves the multi-axis UX via the FEATURES registry. A user blank wanting the same shape can mirror that pattern when needed.

Comments in `cycling.ts` and this doc flag the exact extension points so future-us knows where to plug in.

---

## Where this lives in code

| Concern | File | Key symbols |
|---|---|---|
| `blankShapes:` schema + parser | `packages/opencues-core/src/cues-md.ts` | `BlankFrontmatter.blankShapes`, parser `case 'blankShapes':` |
| Shape-walk gate + slot fields | `packages/opencues-runtime/src/modules/blank-fill.ts` | `matchBlankShape`, `BlankSlot.action`, `BlankSlot.value`, hasShapes proximity bypass |
| SET path script invocation | Same file | `scriptAction`/`actionArgs` in `maybeRunScripts`, cacheKey includes action+value |
| stepValues + script composition | Same file | `maybeRunScripts` short-circuit predicate, `onUnderscoreKey` hasBackingImpl check |
| Shape-aware wipe range | Same file | `applySatelliteFill` `if (slot.action !== undefined)` branch |
| Numeric satellite cycle | `packages/opencues-runtime/src/modules/cycling.ts` | First dispatcher in `cycleSelectorSatellite` |
| Categorical satellite cycle | Same file | Second dispatcher |
| Selector-forwards-to-satellite | Same file | The `if (isSelector && !isSatellite)` flag-flip |
| FEATURES-registry dual-axis (preserved) | Same file | The `if (isSelector)` block further down |
| FEATURES selector defence-in-depth | Same file | The `if (curIdx < 0) return false;` bail |
| Atomic-pair navigation carve-out | `packages/opencues-runtime/src/modules/navigation.ts` | **Not yet implemented** — see `plan.md` |
| Volume migration reference | `defaults/blanks/volume/BLANK.md` + `volume-blank.sh` | Canonical shape-driven blank |
| Brightness migration reference | `defaults/blanks/brightness/BLANK.md` + `brightness-blank.sh` | Mirror of volume |

---

## Author checklist — migrating a script-backed blank to shape-driven

For each blank you migrate (weather, stocks, hackernews, dictionary, crypto, countries, …):

1. **`BLANK.md`** — add the new fields:
   ```yaml
   blankShapes: [{"pattern":"^<kw>\\s*_$","action":"get"}, {"pattern":"^<kw>\\s+(...)\\s*_$","action":"set","valueGroup":1}, ...]
   blankSatellite: true
   blankClearOnEdit: true
   blankConsumeContext: true
   blankStep: <N>          # if numeric
   stepValues: [...]       # if categorical
   ```
   Retire `blankProximity:` (or leave commented for posterity).
2. **Script** — `get` branch outputs `<keyword>\t<value>` (tab-separated, optional unit suffix). `set` branch applies the value, then echoes `<keyword>\t<final-value>` — the post-clamp / post-validate state. Accept both `set <value>` (shape-driven invocation) and `set <setting> <value>` (cycler invocation) via the value-picker shim used in volume + brightness.
3. **Test** — update `packages/opencues-runtime/testing/blank-scripts.test.ts` to expect the new tab-separated output. Add a SET-clamp / SET-validate test.
4. **Agentic scenario** — add a `tests/agentic/scenarios/<N>-<blank>-shapes.json` covering GET, direct SET, verbose SET, satellite cycle (if cyclable), and at least one prose-misfire-reject case.
5. **Verify** — `pnpm -C packages/opencues-runtime test` + `npx tsx tests/agentic/scenario-runner.ts --pid $PID --scenario tests/agentic/scenarios/<N>-<blank>-shapes.json -v`.

---

## Open standard implications

When this stabilises and at least 2-3 script blanks have migrated, the spec PR updates:

- **`spec/blank-spec.md`** — add `blankShapes:` field definition + the `<script> set <value>` echo contract. Mark `blankProximity:` as legacy.
- **`spec/core.md`** — document the selector-satellite emission contract (tab-separated `<selector>\t<satellite>` from script, atomic pair as one navigation unit for single-parameter blanks).
- **`spec/conformance/`** — add fixtures covering: numeric shape SET, categorical shape SET, misfire-reject (prose declines).
- **`SPEC_VERSION`** bump from `0.2-alpha` → `0.3-alpha` (breaking change at the gate-shape level — `blankProximity` semantics narrow).

User explicitly green-lit the breaking change because few external custom blanks exist. See `plan.md` for the full spec-bump checklist.

---

*Migration progress + open todos: `plan.md` at the repo root.*
