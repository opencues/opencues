# Shape-driven blanks — plan + todo tracker

The three-axis blank model. Started June 2026 after the volume-blank user-experience review (`set volume 70% _` exposed two gaps: prose-misfire problem and natural-language SET problem). What we're building, what's shipped, what's left.

## The three-axis model

Every script-backed blank composes three independent pieces:

| Axis | Frontmatter | What it controls |
|---|---|---|
| **Shapes** | `blankShapes:` — array of `{pattern, action, valueGroup?}` | When the blank fires (precision gate, replaces `blankProximity`) + which script verb runs (`get` / `set` / `step`) + what value gets passed |
| **Script contract** | `blankScript: ./xyz.sh` (or `impl:` for JS user-blanks) | How state gets applied. Script accepts `<verb> <value>` (and `<verb> <setting> <value>` from cycler — see compat note) and echoes `<selector>\t<satellite>` on stdout |
| **Cycle vocab** | `blankStep:` (numeric) and/or `stepValues:` (categorical) | What Ctrl+Alt+↑/↓ does after the fill. Both optional, both compose with shapes + script |

Default emission: selector-satellite span (`blankSatellite: true` + `blankClearOnEdit: true` + `blankConsumeContext: true`). One Backspace wipes the pair. Cycler stash drives Ctrl+Alt+↑/↓ from the cycle vocab.

What we converged on:

- Shape-driven blanks bypass the `blankProximity` gate — shapes own precision.
- `applySatelliteFill` wipes the whole matched input (line-scoped) when the slot was matched via shapes.
- `stepValues` + `blankScript` compose (categorical cycle vocab + script ownership of get/set). Previously stepValues short-circuited the script path.
- Selector-satellite cycler gained two dispatchers (numeric, categorical) before the FEATURES-registry path.

---

## Status

### ✅ Shipped on branch `feat/blank-shapes`

| Area | Done |
|---|---|
| `blankShapes:` schema in `BlankFrontmatter` + `BlankConfig` | `packages/opencues-core/src/cues-md.ts` |
| `blankShapes:` parser case (inline-JSON, mirrors `stepValues:`) | Same file |
| Loader copy step | Same file |
| `BlankSlot.action` + `BlankSlot.value` fields | `packages/opencues-runtime/src/modules/blank-fill.ts` |
| `matchBlankShape` helper + shape-walk in `matchKeyword` | Same file |
| Proximity gate bypassed when `blankShapes:` present | Same file |
| `stepValues` + `blankScript` composition (`maybeRunScripts` + `onUnderscoreKey`) | Same file |
| SET path: scriptAction + actionArgs picker + cacheKey includes action+value | Same file |
| `applySatelliteFill` shape-aware wipe-line range | Same file |
| Numeric-step satellite cycler dispatcher | `packages/opencues-runtime/src/modules/cycling.ts` |
| Categorical-stepValues satellite cycler dispatcher | Same file |
| Volume migration (BLANK.md + script tab-emit + SET branch + dual-arg shape) | `defaults/blanks/volume/` |
| Brightness migration (mirrors volume) | `defaults/blanks/brightness/` |
| Test suite updates (volume + brightness selector-satellite contract) | `packages/opencues-runtime/testing/blank-scripts.test.ts` |
| Agentic scenarios (volume × 3 + brightness × 1) | `tests/agentic/scenarios/67-70` |

### ✅ Validation

| Surface | Result |
|---|---|
| `@opencues/core` tests | 870/879 pass, 9 skipped, 0 fail |
| `@opencues/runtime` tests | **1658/1658 pass** (added brightness SET clamp test) |
| Agentic — volume shapes gate | 16/16 (GET / SET / verbose SET) |
| Agentic — volume prose misfire reject | 16/16 (3 prose strings decline) |
| Agentic — volume cycling | 20/20 (+6/-6/wraparound) |
| Agentic — brightness shapes + cycling | 26/26 (GET / SET / +10/-10 / verbose SET) |
| Agentic — OPENCUES settings (FEATURES-registry path) | 18/18 (unaffected) |
| Agentic — fluid-config NL flip (ConfigIntent) | 8/8 (unaffected) |
| Agentic — fluid-blank pipeline | 8/8 (unaffected) |

**112 agentic steps across 7 scenarios, 0 fails.** All legacy paths unaffected.

### 🚧 User-side manual testing (next step)

Wilfred to drive volume + brightness in a real opencode session and confirm the UX feels right end-to-end:

- [ ] `volume _` → `volume 50%` (one-span pair, one Backspace wipes it)
- [ ] `volume 70 _` → `volume 70%` + system actually at 70
- [ ] `set volume to 50 _` → `volume 50%` ("set"/"to" wiped)
- [ ] `volume 200 _` → `volume 100%` (clamp visible)
- [ ] `the volume was great _` / `please increase the volume _` → no claim
- [ ] Ctrl+Alt+→ then Ctrl+Alt+↑ → +6% steps
- [ ] Same flow for brightness (`brightness _`, `brightness 30 _`, `set brightness to 80 _`, +10/-10 steps)
- [ ] Existing settings cycle (OPENCUES.md scalars) still cycles
- [ ] Existing fluid-config still flips on natural-language settings phrasing

---

## What's not yet shipped (todo)

### Step 1a — Implement atomic-pair navigation for shape-driven blanks

Documented in `docs/architecture/shape-driven-blanks.md` § Navigation semantics but NOT yet wired in `navigation.ts`. Runtime currently treats every word as independently navigable.

The carve-out:
- When `Ctrl+Alt+→` would land on the selector of a shape-driven pair (the `selectorSatelliteState.current` entry's `blankName` is in `configLoader.blanks` AND that blank has `blankShapes:` declared), advance to the satellite instead. The pair is one step.
- Symmetric: `Ctrl+Alt+←` past the satellite lands on the word before the selector.
- Multi-parameter blanks (when `blankParameters:` lands) keep both stops navigable. The carve-out's predicate becomes `hasShapes && !hasParameters`.
- FEATURES-registry pairs (`opencues settings _`) keep independently navigable selector + satellite (the selector axis IS real there).

Code pointers: `packages/opencues-runtime/src/modules/navigation.ts` for the nav stepper; `selectorSatelliteState` in the BlankFill module for the active-pair lookup.

Tests needed:
- Agentic scenario: `volume _` → `Ctrl+Alt+→` from the word before the pair → cursor lands on `50%` (not `volume`). Symmetric backward.
- Agentic scenario: `opencues settings _` → `Ctrl+Alt+→` still lands on each word independently (selector + satellite as two stops).
- Unit test pinning the carve-out predicate (`hasShapes && !hasParameters`).

### Step 1b — Migrate remaining script-backed blanks

Once Wilfred confirms the UX, each is a small per-blank PR (or batched). All follow the volume/brightness pattern: add shapes, emit tab-separated, accept dual-arg SET, set `blankSatellite: true` + `blankClearOnEdit: true` + `blankConsumeContext: true`.

- [ ] **weather** (`defaults/blanks/weather/`) — shapes: `weather _`, `weather <city> _`. No SET (read-only). Suffix `%` retires; selector becomes `weather`.
- [ ] **stocks** (`defaults/blanks/stocks/`) — shapes: `stocks _`, `stocks <SYMBOL> _`. Read-only.
- [ ] **hackernews** (`defaults/blanks/hackernews/`) — shapes: `hn _` / `hackernews _`. Read-only. Already emits multi-line so converge carefully.
- [ ] **dictionary** (`defaults/blanks/dictionary/`) — shapes: `what is X _` / `define X _`. Read-only.
- [ ] **crypto** (`defaults/blanks/crypto/`) — shapes: `crypto _`, `crypto <SYMBOL> _`. Read-only.
- [ ] **countries** (`defaults/blanks/countries/`) — shapes: `countries _`, `country <name> _`. Read-only.
- [ ] **affirmations** (`defaults/blanks/affirmations.md`) — list-blank. Stays on `stepValues` only (no script).
- [ ] **answer** (`defaults/blanks/answer.md`) — special LLM-backed. Decide separately.
- [ ] **prompt** (`defaults/blanks/prompt.md`) — LLM-backed. Decide separately.
- [ ] **claude-status** — script-backed. Migrate or leave.
- [ ] **opencues / sentinel** — special selector blanks. Probably stay on FEATURES-registry path.

### Step 2 — Documentation sweep

The three-axis model is going to land in user-facing prose, architecture docs, and the spec. Plan:

- [x] **`docs/architecture/shape-driven-blanks.md`** ✅ **Written June 2026.** Canonical reference for the new mechanic. Covers the three-axis model, selector-satellite emission, navigation semantics (including the atomic-pair carve-out), cycling semantics (numeric/categorical/FEATURES dispatchers + selector-forwards-to-satellite), reasoning (why label-not-chooser, why no LLM classification, why proximity retires), the June 2026 incident post-mortem, the multi-parameter deferred extension, code pointers, and the per-blank migration checklist. Cross-references blank-sources.md, fluid-config.md, blank-replace-modes.md, spans-and-cycling.md.
- [ ] `concept.md` — Update "Two directions of intent" diagram. Mention shapes briefly under Blanks.
- [ ] `CLAUDE.md` (root) — Add a section pointing at `docs/architecture/shape-driven-blanks.md` as canonical. Replace old volume/brightness mentions.
- [ ] `docs/features/blanks.md` (if exists) or new file — User-facing reference. How to author a shape-driven blank.
- [ ] `docs/guides/adding-a-cue-blank.md` ⚠️ — Referenced from CLAUDE.md as a must-read. Update with the three-axis model. Old `blankProximity:` advice marked as legacy. Cross-reference shape-driven-blanks.md.
- [ ] `docs/architecture/blank-sources.md` ⚠️ — Add a "shape-driven gate" pointer linking to shape-driven-blanks.md. The CueSource family layer is unchanged; the shape gate sits above it.
- [ ] `docs/architecture/spans-and-cycling.md` ⚠️ — Add note on the satellite cycler's three dispatchers + selector-forwards-to-satellite rule. Cross-reference shape-driven-blanks.md.
- [ ] `docs/architecture/blank-replace-modes.md` — Note that shape-driven blanks have a fixed effective mode (line-scoped wipe) regardless of `blankReplace:`. The legacy field still applies to shape-less blanks.
- [ ] `docs/glossary.md` — Add entries for: shape, shape-driven blank, selector, satellite, cycle vocab, atomic-pair navigation.
- [ ] `docs/features/transform-blank.md` / `docs/features/agent-task.md` — Already cleaned up (the `<INSTR> _ <BODY>` rule). No changes needed here.

### Step 3 — Spec update (separate repo)

After we have at least volume + brightness landed and used, open a PR against the spec repo. This is a breaking-change at the spec level (`blankProximity` becomes legacy, `blankShapes` becomes the canonical gate). User said "feel free to make a breaking change" because few external custom blanks exist.

- [ ] Bump `SPEC_VERSION` in `packages/opencues-core/src/spec-version.ts` (currently `0.2-alpha` → `0.3-alpha`).
- [ ] Update `SPEC.md` (root) current-version line.
- [ ] Update `spec/blank-spec.md`:
  - Add `blankShapes:` field definition.
  - Add the script `set` contract (echo `<selector>\t<satellite>` on stdout).
  - Mark `blankProximity:` as legacy / deprecated for new blanks.
  - Document the `cycle vocab` axis (blankStep numeric + stepValues categorical).
  - Document selector-satellite emission as the default for shape-driven blanks.
- [ ] Update `spec/core.md`:
  - Document spec-version policy unchanged (omit-default stays at 0.1-alpha).
- [ ] Add conformance fixtures at `spec/conformance/valid/blank-shapes/`:
  - Numeric SET fixture (mirroring volume).
  - Categorical fixture (mirroring an imaginary theme blank).
  - Misfire-reject fixture (prose input that should decline).
- [ ] Update `spec/CHANGELOG.md` with the 0.2-alpha → 0.3-alpha cut entry.
- [ ] Bump `spec/README.md` Status banner + Status & versioning section.
- [ ] Bump `spec/*.md` Status banners.
- [ ] Update JSON schemas at `spec/schemas/` to add `blankShapes:` to the blank schema.
- [ ] Update `packages/opencues-core/src/conformance.test.ts` "spec-too-new" regex.
- [ ] CHANGELOG.md (root) entry under `[Unreleased]` describing the breaking change.

### Step 4 — Cleanup + back-compat decisions

- [ ] Decide whether to keep `blankProximity:` reading for the legacy blanks not yet migrated, or hard-rip it after all migrations land.
- [ ] Decide whether to keep `blankSuffix:` reading at all (shape-driven blanks emit the suffix in the script, so this field is dead weight on migrated blanks). Probably leave for now — back-compat costs nothing.
- [ ] Decide whether `blankReplace:` stays as a per-blank knob or retires for shape-driven blanks (which always wipe-line).
- [ ] Consider whether `blankConsumeContext: true` should be implicit for shape-driven blanks (currently has to be set explicitly in each BLANK.md). One less knob.

### Step 5 — Drift / structural protections

- [ ] Add an `opencues review` check: warn when a script-backed blank has `blankProximity:` set but no `blankShapes:` — the proximity gate is fragile and shapes is the recommended pattern.
- [ ] Add a test that pins: a blank with `blankShapes:` declared + no shape matching `<input> _` SHOULD decline the slot (BlankFill returns null, fluid-blank takes over). This is the misfire-reject invariant.
- [ ] Add a test that pins: shape-driven blank's emission ALWAYS goes through `applySatelliteFill` (never through the slot-splice path).

---

## What this enables downstream

Once volume + brightness + a few read-only blanks (weather, stocks, dictionary) have migrated:

- **Natural-language setters** for every action blank. Today: `volume 70 _`, `brightness 80 _`, `set volume to 50 _`. Tomorrow: any blank an author wants.
- **Per-blank cycle vocab** without polluting OPENCUES.md. A pack author ships a blank with `stepValues: ["red", "green", "blue"]` and the user cycles through them with Ctrl+Alt+↑/↓.
- **Misfire elimination** at the structural level. Prose mentions of "volume" / "brightness" / "weather" no longer hijack the slot.
- **One-Backspace wipe** consistent across every script-backed blank.
- **Third-party pack expressiveness** — pack authors declare what shapes fire their blank + a script that handles get/set. No LLM in the routing loop; security model unchanged.

---

## Risk surfaces

- Cycler complexity. Three dispatchers in `cycleSelectorSatellite` (numeric, categorical-stepValues, FEATURES-registry). Each short-circuits to the next when preconditions fail. Manageable; new tests would help pin the ordering.
- Inline-JSON in `blankShapes:` is ugly for users authoring by hand. A real YAML parser pass for the `blankShapes` field is a follow-up. Not blocking — the same shape applies to existing `stepValues:`.
- Author surface widens. Three-axis model means more frontmatter to think about. Documentation has to make the model obvious or we lose the simplicity gain.

---

## User-pack JS blanks fail to load on Bun hosts — known platform gap

`isolated-vm` (the sandbox we use to run user-pack JS like `gh-issues/blank.js`) is a Node V8 native binding. Bun's JavaScriptCore can't load it — the binding's symbol layout doesn't match what Bun expects. The error surfaces as:

```
isolated-vm unavailable on this runtime: undefined symbol: _ZN2v815ValueSerializer8Delegate19HasCustomHostObjectEPNS_7IsolateE
```

Affected hosts: **opencode** + **shell** (both Bun-based).
Unaffected hosts: Claude Code, Gemini CLI, Chrome (Node + native-messaging-host bridge).

Built-in TS blanks (volume / brightness / weather / stocks / crypto / dictionary / countries / hackernews / claude-status / answer / prompt / sentinel) and shell-script blanks keep working on Bun hosts — only `impl: ./blank.js` user-pack JS is blocked.

**Options for a real fix** (separate PR):

1. **Vendored isolated-vm-bun** — port the C++ binding to use Bun's bun:ffi or N-API-compat layer. Real C++ work, multi-week effort.
2. **Replace isolated-vm with `vm.Context` (Node built-in)** — give up the strong process-level isolation in exchange for cross-runtime support. Security regression vs current model.
3. **Use Worker threads** — run user-pack JS in a Worker with restricted globals. Works on Bun (Bun has Worker), but the sandbox boundary is weaker than isolated-vm's V8 isolate.
4. **Use a separate Node subprocess for user-pack JS dispatch** — opencode/shell spawn a small Node helper that owns the isolated-vm sandboxes. Cleanest separation but adds a process + IPC hop per invocation.
5. **Document the gap and defer** — user-pack JS is a feature for power users; the built-in blanks cover 95% of use cases. Mark `impl:` as Node-only in the spec and document in adding-a-cue-blank.md.

Recommendation: **(5) for the immediate doc sweep**, then **(4) as a small follow-up PR**. Subprocess isolation gives us cross-runtime support without compromising the security boundary. The IPC hop is ~5-10ms which is negligible compared to the network calls user-pack JS typically does (gh-issues hits api.github.com, others fetch from various APIs).

Tracked here so the next contributor knows the gap is structural, not a bug.

## Countries data source — known fragile

`CountriesBlank` previously hit `https://restcountries.com/v3.1/name/<country>`. That API was **deprecated** in 2026 — it now returns 301 → `legacy.json` with an error body, and the v5 replacement requires an auth key.

Quick fix shipped in PR #146: switched to `https://countries-api-836d.onrender.com/countries/name/<country>` — a community-run v2-clone with the same field shape as pre-deprecation REST Countries. Schema adapted (v2 has flatter shape: `name` is a string, `capital` is a string, `currencies`/`languages` are arrays of objects instead of keyed records).

**Known limitations of the workaround**:

- Hosted on Render's free tier — sleeps after ~15 min of inactivity, so the first request after a quiet period can take 30-60s (cold start). Cached for 24h per country once fetched.
- Third-party operator. Could go down or change shape without notice.
- No SLA, no contact for issues.

**Long-term path** (separate PR): bundle a static country dataset (mledoze/countries — public-domain JSON, ~250 countries, 80+ fields each). Eliminates the network call, the upstream dependency, and the cold-start. ~1.4MB bundled (or ~80KB with trimming to just the fields the blank uses). Yearly manual refresh for stale population numbers. Trade-off: slightly bigger npm package vs zero runtime upstream risk for read-only data that doesn't change daily.

Tracked here so the next contributor knows the current setup is provisional.

## Decisions made (record so we don't relitigate)

1. **Shape gate is regex-based**, not LLM-based. Authors declare shapes; runtime extracts the matching value. No LLM in the routing loop = no prompt-injection blast radius widening.
2. **Codomain stays bounded** by per-blank shape declarations. ConfigIntent retains exclusive access to OPENCUES.md FEATURES-registry scalars via its LLM classifier (different security boundary).
3. **Shape-driven blanks emit selector-satellite spans by default**. The convergence with ConfigIntent's UX (one-Backspace wipe) is the structural payoff.
4. **`blankProximity:` stays for back-compat** but becomes legacy. Hard-rip is queued for after all migrations land (or never — costs nothing to leave).
5. **`stepValues:` + `blankScript:` compose**. The old "stepValues = list-only blank" assumption retires.
6. **Wipe-line scope** (not buffer-scope) for the shape-driven splice. Prior paragraphs survive.
7. **Breaking-change at spec level is acceptable** because few external custom blanks exist. User explicitly green-lit this.
8. **Brightness migrated second** as the proving ground that the pattern works outside volume's specific case.
9. **Spec update deferred** until volume + brightness have been used in real sessions and the UX feels right.
10. **Selector = static label, satellite = control** for shape-driven blanks. The selector word displays the keyword as a visual context cue; cycling only happens on the satellite. Pressing ↑/↓ on the selector forwards the press to the satellite (the user doesn't have to know which side is the "active" handle, but the model stays clean — selector isn't a second axis, it's a label whose presses get helpfully redirected). The two-axis chooser model is reserved for the future multi-parameter pattern (see deferred section below).

## Deferred — multi-parameter blanks (`blankParameters:` axis)

Today every shape-driven blank is **single-parameter**: one keyword, one control, one value to tune. Volume is volume, brightness is brightness, weather is weather. The selector word is a label for the parameter; the satellite is the value handle.

A future extension would let one BLANK.md declare multiple parameters under a single blank — the user selects the parameter via the SELECTOR axis and the value via the SATELLITE axis. Same shape as today's `opencues settings _` flow but exposed to script-backed user blanks.

### Provisional schema

```yaml
---
name: system
type: blank
blankKeywords: system
blankShapes: [{"pattern":"^system\\s*_$","action":"get"}, ...]
blankParameters:
  volume:     { step: 6,           type: numeric, clamp: [0, 100] }
  brightness: { step: 10,          type: numeric, clamp: [0, 100] }
  mute:       { values: [on, off], type: categorical }
  balance:    { step: 5,           type: numeric, clamp: [-100, 100] }
blankScript: ./system-blank.sh
---
```

### Provisional script contract (extended)

```bash
# system-blank.sh
$1 = get | set
$2 = parameter name (volume / brightness / mute / balance)
$3 = (for set) the value
# Echo `<parameter>\t<final-value>` on stdout.
```

### Runtime changes when this lands

- Selector cycler dispatcher learns to read `blankParameters:`. When the blank has parameters declared, selector-position ↑/↓ cycles parameter names; satellite-position ↑/↓ cycles the chosen parameter's vocab.
- The "selector forwards to satellite" rule in `cycleSelectorSatellite` becomes **conditional on `!blankParameters`** — single-parameter blanks still forward, multi-parameter blanks expose the dual-axis.
- `BlankSlot.parameter?: string` added to carry the chosen parameter through to the script call.
- Spec adds `blankParameters:` to the blank schema. Conformance fixtures cover the two-axis cycling.

### Why we're not doing this now

- No real use-case in the shipped defaults today. Adding it speculatively widens the schema surface.
- The single-parameter pattern (volume, brightness, weather, stocks, etc.) is the dominant model — covers ~100% of shipped blanks.
- The opencues-settings blank already serves the "lots of settings, one menu" UX via the FEATURES registry. A user blank wanting the same structure can mirror that pattern when needed.

When someone has a real `system` / `audio` / `display` blank that needs to group multiple controls, ship `blankParameters:` then. Until then, single-parameter is the default and the cycler's selector-forwards-to-satellite rule stays unconditional. Comments in `cycling.ts` flag this exact deferral so future-us knows where to plug in.

---

## Open questions for Wilfred

1. After manual testing — is `blankConsumeContext: true` actually wanted on every shape-driven blank, or should it be implicit when shapes are present? Question matters because some read-only blanks (weather) might want to preserve surrounding prose differently.
2. Should `stepValues` cycling on volume support `up` / `down` text shapes too? Today: numeric values only. If we add `up`/`down`, the script needs to translate "step direction" → current+step.
3. Spec version bump — go to `0.3-alpha` for the breaking change, or wait until we have N migrated blanks?

---

*Last updated: 2026-06-14. Sitting on branch `feat/blank-shapes`. Awaiting Wilfred manual UX review.*
