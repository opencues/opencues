# Fluid Config — architecture reference

Canonical doc for the `fluid-config-mode` feature. User-facing summary:
[`docs/features/fluid-config.md`](../features/fluid-config.md).

This doc covers: what makes the feature safe (the trust boundary that
distinguishes it from "auto-routing to user blanks"), where the
classifier prompt comes from + how it's evolved, the priority placement
in the source chain, the substitution path that wipes summon words and
hands off to standard satellite cycling, and the integration with the
existing `applyOpenCuesScalar` write-race plumbing.

Read this before touching:

- `packages/opencues-core/src/sources/config-intent-source.ts`
- the config-intent substitution branch in
  `packages/opencues-runtime/src/modules/resolver.ts`
- the prompt / few-shots / `validateAgainstRegistry` helper
- the FEATURES registry's `fluid-config-mode` entry

---

## Threat model — why the scope is FEATURES-only

The classifier's job is to take a `_` that no keyword matched and decide
whether the surrounding prose semantically asks for a settings change.
On HIT it applies via `applyOpenCuesScalar`. Auto-apply on the back of
a single LLM call is a **deliberately narrow** capability:

| Target class | Auto-applyable on semantic intent? | Reason |
|---|---|---|
| FEATURES scalars (`debug-mode`, `tips-mode`, ...) | **Yes** | Closed set; bounded enum codomains; flipping any of them has no exec / fetch / shell side effect. Recoverable visually + by re-summoning the inverse. |
| MENU_TUNABLES (`agent-debounce-ms`, `blank-loading-animation`) | **No (v1)** | Numeric codomains widen the attack surface and the value space; need a per-pipeline threat-model review before opting in. Glyph-only tunables could land in v2. |
| Hidden values (`identity-context-mode: raw`) | **Never** | Footgun modes (PII inlined into LLM prompts) require deliberate file edits. The classifier prompt excludes them; the runtime validator rejects them even if a model regression emits one. |
| User blanks (volume, brightness, weather, stocks, dictionary, any `impl:` / `blankScript:` entry) | **Never** | These are user-shipped capabilities that exec, fetch, run scripts. Auto-applying them from semantic intent bypasses the keyword gate that today protects them. Stays out of scope for fluid-config indefinitely — even widening "for symmetry" would be a security regression. |

The structural property the design relies on: **every FEATURES scalar
has a closed enum codomain.** Flipping `tips-mode` to `off` or `voice-mode`
to `active` cannot become exec because there's no exec layer downstream
of a setting flip — it just writes a string into `~/.cues/OPENCUES.md`
and updates an in-memory enum field. The same write path that satellite
cycling already uses (audited since OpenCues v0.1).

If you ever consider widening fluid-config to non-FEATURES targets,
re-read this section first. The capability boundary is structural;
widening it converts a recoverable "wrong setting flipped" failure
into "exec / fetch / file-write on prompt injection" territory.

Memory pointer: feedback `Fluid-config classifier is settings-only`.

---

## Source placement — priority 94

```
95  BlankSource              keyword-bound, explicit match — wins over everything
94  ConfigIntent             this source — semantic settings change
93  TransformBlank           imperative rewrite ("change boy to girl _ ...")
92  FluidBlank               free-form lookup ("capital of france _")
```

Priority **94 specifically** sits ConfigIntent ABOVE TransformBlank so
that "change debug mode to on _" routes to a settings change rather
than being interpreted as a generic rewrite. If the classifier says
NONE, TransformBlank then gets its shot, then FluidBlank.

The cede logic in `supports()` mirrors what TransformBlank and FluidBlank
already do: if a registered blank's keyword sits within `blankProximity`
of the `_`, ConfigIntent declines so BlankSource takes the slot.

---

## Classifier prompt

Lives at `SYSTEM_PROMPT` in `config-intent-source.ts`. Built at module
load by enumerating `FEATURES` from the registry — adding a new feature
extends the choice space automatically. Hidden values (`exposeInMenu: false`)
are filtered out at the same step.

Output shape:

```
SETTING: <kebab-case scalar from the registry, OR the literal word NONE>
VALUE: <one of the listed values for that scalar; empty when NONE>
CONFIDENCE: <0.0-1.0>
```

Three structural rules in the prompt that map to bench failures we
fixed during validation:

- **Emit all three lines.** Empty `VALUE:` is fine, but truncating
  after `SETTING:` is not. Caught when Groq sometimes early-stopped
  after the SETTING line.
- **Never drop the `-mode` suffix.** The prompt explicitly lists every
  full scalar name. Caught when Groq emitted `voice` instead of
  `voice-mode`.
- **Confidence below 0.5 → emit NONE.** Uncertainty IS the signal to
  reject; better to fall through to FluidBlank than mis-route.

Bench provenance: `tests/benchmarks/fluid-config/` —
v2.1 prompt validated across 5 providers (Groq, Cerebras, Gemini Flash
Lite, Claude Haiku, OpenAI nano). See `EXPERIMENTS.md` in that folder
for the full evolution and per-provider sweep table.

**Don't edit `SYSTEM_PROMPT` without re-running the bench against both
suites** (in-prompt + holdout). The prompt is the only thing standing
between "100% precision" and a precision drop into FP territory.

---

## Apply at emit time

The setting flip happens INSIDE `getCues()`, before the CueResult is
returned to the runtime:

```ts
// in config-intent-source.ts
try {
  await Promise.resolve(this.applyScalar(verdict.setting!, verdict.value!));
} catch (e) {
  // file write failed → bail, no result, no half-applied UI
  return { results: [], ... };
}
```

`applyScalar` is injected by the runtime — wraps
`ConfigLoader.applyOpenCuesScalar` which:

1. Writes the new value into `~/.cues/OPENCUES.md`.
2. Updates the in-memory `opencuesState`.
3. Arms `_suppressReloadUntil = now + 2500ms` so the next
   `maybeReload` doesn't see the still-stale file and clobber the
   in-memory update (the write-race guard documented in CLAUDE.md
   `## Hoisted-blank writes vs ConfigLoader hot-reload`).

If the write fails, ConfigIntent bails — no CueResult is emitted, no
satellite UI appears. Showing a confirmation marker for a change
that didn't happen would lie to the user.

---

## Validation — defence in depth

`validateAgainstRegistry(verdict)` runs BEFORE `applyScalar`:

```ts
- if setting === null      → ok (NONE verdict, nothing to apply)
- if setting not in FEATURES → reject with "unknown setting"
- if value not in the setting's cyclable values → reject "not cyclable"
- (cyclable filter = exposeInMenu !== false, so hidden values reject)
```

The classifier prompt instructs the model to stay inside the registry,
but the validator is the load-bearing line. If a model regression ever
emits `SETTING: shell\nVALUE: rm -rf` or `SETTING: identity-context-mode\nVALUE: raw`,
the validator drops it before any write happens.

---

## Substitution path — selector-satellite shape

Once `applyScalar` succeeds, ConfigIntent emits a CueResult shaped to
mirror what `BlankSource` produces for keyword-bound `opencues settings _`:

```ts
{
  wordIndex: blankIdx,
  word: '_',
  alternatives: [setting],          // e.g. ['debug-mode']
  source: 'config-intent',
  priority: 94,
  spanStart: 0,
  spanEnd: context.text.length,     // wipe the whole prompt — see below
  metadata: {
    blankName: 'opencues',
    selectorBlank: true,
    satelliteValue: value,           // e.g. 'on'
    displaySeparator: ' ',
    configIntent: { setting, value, confidence },
  },
}
```

The runtime resolver's config-intent branch
(`resolver.ts`, condition `isConfigIntent && alts.length > 0 && isMultiWordSpan`)
then:

1. **Race-guards twice.**
   - Bails if `_` is no longer in the live text (user typed past it).
   - Bails if `liveText.slice(spanStart, spanEnd) !== text.slice(spanStart, spanEnd)`
     — the wipe range no longer matches what the classifier analysed.
     ConfigIntent's wipe is more aggressive than FluidBlank's localized
     splice, so the stricter guard is necessary; without it, an
     unrelated edit in the prefix would silently get destroyed.
2. **Splices** `<setting><sep><value>` into `[spanStart, spanEnd)`. With
   the default `spanStart=0` and `spanEnd=text.length` from the source,
   the entire user prompt is replaced with just `debug-mode on`.
3. **Registers a `SelectorSatelliteEntry`** on the shared
   `SelectorSatelliteState`, with the same shape `BlankFill.applySatelliteFill`
   uses for the keyword-bound path. Standard satellite cycling
   (`Cycling.cycleSelectorSatellite`) is then live on the pair —
   cycling Up/Down on either word fires `applyOpenCuesScalar` via
   the existing path.

`SelectorSatelliteState` is injected into Resolver as the **8th
positional constructor argument** (boot.ts in each integration). Without
it, ConfigIntent falls back silently — the splice still paints but
cycling won't act on it. Every shipping host wires it today.

### `clearOnEdit: true`

The satellite entry is registered with `clearOnEdit: true`, so backspacing
into either word triggers `BlankFill.applyClearOnEdit` and wipes the
whole pair in one keystroke (`pairCharStart` .. `pairCharEnd`).

The reasoning: the user typed a natural-language summon
("enable debug logging _"); the satellite pair is just the visual
confirmation of the resulting state. It should behave as ONE span on
cleanup — not as two independent words requiring per-char backspace.

The file write is NOT reverted by the wipe — that would be a UX
surprise. Backspace clears the buffer; the user can re-summon if
they want to undo.

---

## What's NOT in scope

- **Statusline notification.** Deferred indefinitely. The inline
  satellite pair IS the visual confirmation. Adding a temporary
  highlight on the statusline ("debug-mode flipped to on for 2s")
  was scoped out — the inline pair already conveys the result.
- **Multi-setting summons.** "enable debug AND turn off tips _" is not
  supported. The classifier outputs one (setting, value) pair per
  call; if you summon two settings at once, only one gets applied
  (whichever the model picks). Multi-apply would need a different
  output shape and more bench rigour around partial-application
  semantics.
- **Statelessness across summons.** Each summon is independent —
  ConfigIntent doesn't remember what you flipped last. "undo that _"
  is NOT a settings change verdict; it falls through to FluidBlank.
- **Per-pipeline provider override at runtime.** The classifier
  inherits from `fluid-config-provider` / `fluid-config-model` /
  `fluid-config-endpoint` (read in resolver.ts), but the auto-route
  default uses the same provider chain everything else does
  (cerebras → groq → ...). If you want to pin a specific provider
  for the classifier alone, set the per-feature scalar.

---

## Known precision boundary — FluidBlank eagerness on imperatives

ConfigIntent's own precision is solid (100% in bench, verified via the
agentic harness on 2026-05-19). But the full _-claim chain after
ConfigIntent cedes is `TransformBlank (93) → FluidBlank (92)`, and
**FluidBlank is too eager on imperative phrases that ConfigIntent
correctly rejected**:

| Summon | ConfigIntent | TransformBlank | FluidBlank claims (incorrectly) |
|---|---|---|---|
| `make it louder _` | NONE ✓ | NONE ✓ | `increase volume` |
| `change the theme to dark _` | NONE ✓ | NONE ✓ | `mode` (one-word garbage) |

These look like fluid-config "false positives" from the user's seat
("I asked to change theme — it answered 'mode'?") but the classifier
is innocent: it correctly ceded. The actual defect is FluidBlank's
fallback claim. Two reasonable follow-ups, neither blocking today:

1. **FluidBlank cede gate on imperative phrasing.** If the prompt
   has verb-first shape (`make`, `change`, `set`, `turn`, ...) AND
   no question/lookup marker, cede. Same boundary ConfigIntent uses
   structurally — verb-first imperatives without a registry hit are
   the user-blank territory ConfigIntent is forbidden from touching.
   Code: `fluid-blank-source.ts` `supports()` or the fused prompt's
   "WHEN TO EMIT NONE" rules.

2. **User-blank routing for verb-imperatives.** `make it louder` is
   semantically "volume + (delta: up)". Today no source maps verb-
   intent to user-blank cycling. A future `verb-route` source could
   bridge the gap — but it would need the same trust-boundary
   discipline ConfigIntent has (whitelist of safe blanks, no
   exec/fetch routing without a keyword gate).

Surfaced via the agentic harness re-walk of `MORNING.md`'s test
phrases on 2026-05-19. The two scenarios are not committed as
agentic tests because they'd assert on broken behaviour; they live
here as a documented follow-up.

---

## Adding a new feature → automatic classifier extension

This is the most important property: adding a new feature to FEATURES
automatically extends fluid-config's choice space. No edit to the
prompt, no edit to the validator, no edit to the runtime.

1. Add a `FeatureSpec` to `FEATURES` in `feature-registry.ts`.
2. Decide whether the new field needs a typed `OpenCuesState` slot
   (see `feature-registry-alignment.test.ts`) or stays settings-map-only
   (like `fluidBlankMode` itself).
3. That's it. The next time the classifier loads, it'll see your
   new scalar + values in the registry block of the system prompt.

What's optional but recommended:

- **Add a few-shot to the bench cases.** `cases.ts` / `cases-holdout.ts`
  in `tests/benchmarks/fluid-config/` — one hit case per polarity, a
  fuzzy variant, and any obvious reject case. Re-run the bench. If
  recall drops on the new scalar, add a few-shot to `SYSTEM_PROMPT`
  in `config-intent-source.ts` to pin the polarity (see how
  `blank-trigger-mode=immediate` and `identity-context-mode=off` were
  added).

If your new feature has values you DON'T want auto-flippable from
semantic intent (footgun modes like `identity-context-mode: raw`), mark
them `exposeInMenu: false`. The classifier prompt will exclude them
AND the validator will reject any attempt to apply them.

---

## Tests pinning this behaviour

| File | Pins |
|---|---|
| `packages/opencues-core/src/sources/config-intent-source.test.ts` | Parser tolerance, `validateAgainstRegistry` defence layer, `supports()` cede behaviour, `getCues` apply-on-hit / cede-on-NONE / cede-on-invalid / cede-on-throw, emit shape (alternatives, metadata.selectorBlank, satelliteValue, displaySeparator, spanStart/spanEnd) |
| `packages/opencues-runtime/src/modules/resolver.test.ts` (`Resolver config-intent substitution` describe) | Summon words wiped to `<setting> <value>`, SelectorSatelliteEntry registered with all fields including `clearOnEdit: true`, race guard fires when live text changed, defence-in-depth bail when satelliteValue missing, no cross-contamination with fluid-blank inline-paint path |
| `tests/benchmarks/fluid-config/` (bench, not unit) | Classifier precision ≥ 98% AND recall ≥ 80% on both in-prompt and holdout suites, across 5 providers |
| `packages/opencues-runtime/src/modules/feature-registry-alignment.test.ts` | `fluidConfigMode` is registered AND categorized as settings-map-only (consumed by resolver.ts:enableConfigIntent, no OpenCuesState typed slot) |

---

## Related architecture docs

- [`feature-registry.md`](feature-registry.md) — the FEATURES + MENU_TUNABLES + BUILTIN_BLANKS registry that fluid-config dispatches against.
- [`spans-and-cycling.md`](spans-and-cycling.md) — selector-satellite cycling, span priorities, the `clearOnEdit` cleanup path.
- [`security-audit.md`](security-audit.md) — fluid-config's bounded-codomain rationale slots into row #21 (no side-effect channel for LLM-derived buffer text).
- [`blank-replace-modes.md`](blank-replace-modes.md) — sister doc for FluidBlank's KEEP/WIPE/AUTO modes; ConfigIntent's wipe is structurally different (always whole-prompt) so it doesn't share the heuristic.

---

*Last updated: 2026-05-18.*
