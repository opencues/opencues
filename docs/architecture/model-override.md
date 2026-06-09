# Model Override — architecture reference

Canonical doc for the per-call `with <model>` override. User-facing
summary: [`docs/features/model-override.md`](../features/model-override.md).

This doc covers: the trust boundary that distinguishes per-call override
from the settings flip (fluid-config), the 5-tier resolution table in
`resolveAlias()`, the ConfigIntent synchronous cede gate that prevents
override syntax from being misclassified, the apiKeys plumbing through
build-sources, how each source threads the override into its dispatch
(FluidBlank explicit-arg vs TransformBlank `_currentOverride` field),
WIPE-mode span handling, and the event shape the agentic harness
asserts against.

Read this before touching:

- `packages/opencues-core/src/model-aliases.ts`
- the override-detect branch in
  `packages/opencues-core/src/sources/fluid-blank-source.ts`
  and `transform-blank-source.ts`
- the synchronous cede branch in
  `packages/opencues-core/src/sources/config-intent-source.ts`
- the `apiKeys` plumbing in
  `packages/opencues-core/src/sources/build-sources.ts`

---

## Trust boundary — what makes per-call override safe

The settings flip (`change to opus _` → `cues-llm-provider:
anthropic:claude-opus-4-7` written to disk) is a *persistent change with
side effects*: every future LLM call on that bucket flows through the
new provider until the user flips it back. The classifier owns a real
config mutation; that's why fluid-config has the FEATURES-only scope
guard and the `validateAgainstRegistry` defence in depth.

The per-call override is a *transient dispatch redirect with no
side effects*:

| Property | Settings flip | Per-call override |
|---|---|---|
| Writes to OPENCUES.md? | Yes (`applyOpenCuesScalar`) | **No** |
| Survives the call? | Yes (persistent) | **No** (single dispatch only) |
| Visible in `opencues doctor`? | Yes | No |
| Re-fires on next `_`? | Yes (it's the new default) | **No** (back to bucket) |
| Bypasses `trainsOnInput` guard? | Bucket-class gate still applies | **No** (same bucket-class gate) |
| User-blank reachable? | No (FEATURES-only) | **N/A** (overrides dispatch only, not source selection) |

The structural property the design relies on: **the override changes
which (provider, model, apiKey) the dispatch call uses, NOTHING else.**
Bucket selection — including the `trainsOnInput` guard that refuses
`opencode-zen` for cues sources — runs against the configured target,
not the override. You can't bypass the consent gate by typing `with
opencode-zen _`; the override only fires inside FluidBlank /
TransformBlank, both of which are already user-opt-in via the `_`
keystroke.

If you're considering widening the override path to other sources
(word-cues, auditors, agent-rewrite, sentence-cues), re-read this
section first. Each new surface widens the prompt-injection blast
radius slightly because `with <model>` is now reachable from prose
that's not user-typed (e.g., a CUES.md prompt template includes "rewrite
with opus" as an instruction). The trust gate stays valid as long as
the override only affects DISPATCH, never prompt-design or source
selection.

---

## Resolution order — `resolveAlias()`

Walks five layers in order, returns on first hit. Lives in
`model-aliases.ts`:

```
COMMON_ALIASES         opus → anthropic/claude-opus-4-7
                       haiku → anthropic/claude-haiku-…
                       cerebras → cerebras/(default model)
                       gpt-oss → cerebras/gpt-oss-120b
                       …

→ provider id          anthropic / cerebras / groq / openai / …
                       → uses provider.defaultModel

→ exact model name     any model in any provider's knownModels
                       claude-opus-4-7 → anthropic/claude-opus-4-7

→ prefix match         token is a prefix of a knownModel
                       gpt-5 → gpt-5.4 (shortest matching wins —
                       closest to what the user typed)

→ substring match      token appears anywhere in a knownModel
                       4-7 → claude-opus-4-7
                       same shortest-wins tie-break
```

Returns null if no rule fires. `detectModelOverride(text)` walks
*every* `with <token>` match and returns the LAST resolved one (closest
to `_`) — earlier `with X` tokens are revision history; the one nearest
the trigger is what the user is actively editing.

The regex `\bwith\s+([a-zA-Z][\w.-]*)\b` is case-insensitive on `with`,
word-boundary-anchored to prevent `without` from matching, and the
token must start with a letter (so `with 5` isn't a match) but may
contain alphanumerics, dots, dashes, underscores (covers `gpt-5`,
`claude-haiku-4-5-20251001`, `gpt_oss`).

Unknown tokens — `with the cat`, `with fire`, `with fish` — return
null. The override doesn't fire. The call dispatches through the
configured target as if no `with` was present.

---

## ConfigIntent synchronous cede

ConfigIntent sits at priority 94, above TransformBlank (93) and
FluidBlank (92). Without the cede gate, ConfigIntent's classifier on
cerebras was reliably misclassifying `make formal with opus _` as a
PROVIDER-routing intent → `cues-llm-provider: anthropic:claude-opus-4-7`
written to disk. A settings flip the user didn't ask for, plus a
selector-satellite painted in the buffer.

The fix in `config-intent-source.ts:getCues()`:

```ts
if (detectModelOverride(context.text) !== null) {
  this.log(`ConfigIntent: ceding — buffer carries 'with <model>' override token`);
  return { results: [], ... };  // no LLM call, no scalar write
}
```

Runs synchronously BEFORE the classifier dispatch. Cost is one regex
pass over the buffer. Effects:

- No classifier LLM round-trip (saves ~300ms on cerebras, more on
  slower providers).
- No settings-flip side effect (OPENCUES.md untouched).
- TransformBlank / FluidBlank get the slot uncontested.

The settings-flip syntax (`change to opus _`, `switch to cerebras _`,
`use anthropic for cues _`) doesn't contain `with` — `detectModelOverride`
returns null — the cede doesn't fire — the classifier runs normally
and writes the scalar. So both syntaxes coexist:

```
change to opus _     →  ConfigIntent fires → writes blanks-llm-provider
make X with opus _   →  ConfigIntent cedes → TransformBlank dispatches via Opus
```

---

## apiKeys plumbing — full multi-provider map

Pre-override, each source stored a single `apiKey` (the configured
provider's key) — sufficient for the configured target. The override
needs a DIFFERENT provider's key, so build-sources now passes the full
apiKeys map into FluidBlankSource + TransformBlankSource constructors:

```
runtime resolver options.apiKeys
  → build-sources options.apiKeys
  → new FluidBlankSource({ ..., apiKeys })
  → new TransformBlankSource({ ..., apiKeys })
```

The map is keyed by `envKeyName` (`ANTHROPIC_API_KEY`,
`CEREBRAS_API_KEY`, …) — matches what `resolveLLM` reads at
`llm-provider.ts:1817` and what every host adapter populates. The
source's `resolveOverride()` looks up the override target's
`adapter.envKeyName`:

```ts
private resolveOverride(override: ModelOverride): OverrideTarget | null {
  const adapter = getProvider(override.provider);
  if (adapter === null) return null;
  const apiKey = this.apiKeys[adapter.envKeyName];
  if (!apiKey) return null;                          // silent fall-through
  return { provider: adapter, model: override.model, apiKey };
}
```

Returns null when the override's provider doesn't have a key in the
map. The call falls through to the configured target — no error, no
buffer mess, one debug-level log line:

```
FluidBlank: model-override skip — no apiKey for provider 'anthropic' (token="opus")
```

---

## Dispatch — two patterns

### FluidBlank: explicit-arg threading

FluidBlank has one `callLLM` site (FUSED mode is the only pipeline).
The override is threaded as explicit args:

```ts
const fusedOut = await this.callLLM(
  FUSED_SYSTEM_PROMPT, fusedUser, this.maxTokensOverride ?? 512,
  responseFormat, context.signal,
  effectiveProvider, effectiveModel, effectiveApiKey,  // override args
);
```

`callLLM` uses the override args when present, falls back to `this.*`
otherwise. Clean, async-safe, no shared state.

### TransformBlank: `_currentOverride` field pattern

TransformBlank has 6 callLLM sites (3-pass EXTRACT/APPLY/VERIFY/REPAIR
+ FUSED + the no-target generative branch). Threading the override
through all 6 sites is noisy and easy to miss. Instead, `getCues`
stores the resolved override on a private field at the top, clears it
in a `finally` block, and `callLLM` reads it:

```ts
async getCues(context) {
  const override = detectModelOverride(context.text);
  const overrideTarget = override ? this.resolveOverride(override) : null;
  this._currentOverride = overrideTarget;
  try {
    // ... 6 callLLM sites, all read _currentOverride as the default ...
  } finally {
    this._currentOverride = null;
  }
}

private async callLLM(..., overrideTarget?: OverrideTarget) {
  const eff = overrideTarget ?? this._currentOverride ?? null;
  // dispatch through eff.provider / eff.model / eff.apiKey when present
}
```

**Safety**: the resolver awaits `getCues` as one promise per resolve
generation. If a new generation supersedes the old, the old's signal
aborts (sibling-abort, June 2026) and the in-flight call rejects.
Under that contract there's no overlap on the same source instance, so
the field doesn't race. The `finally` clears the field on throw, so
even error paths leave the next `getCues` call with `_currentOverride
= null`.

If you ever invoke TransformBlank's `getCues` concurrently on the same
instance (a future test harness, a non-resolver caller, etc.), the
field pattern breaks down. Switch to explicit-arg threading at that
point.

---

## Prompt-body stripping

`stripModelOverride(text, override)` removes the `with <token>` match
and collapses the resulting double-space + trims. The LLM's user
message uses the stripped text:

| Buffer | LLM receives |
|---|---|
| `make formal: the cat sat on the mat with opus _` | `make formal: the cat sat on the mat _` |
| `atomic number of oxygen with cerebras _` | `atomic number of oxygen _` |
| `write with sonnet then refine with opus _` | `write then refine _` |
| `with opus _` (bare) | `_` |

The model never sees the token, so `with opus` can't leak into the
rewrite as styling instructions ("opus-flavoured", "with the voice of
opus", etc.) or noise.

The strip applies to the VISIBLE-buffer prompt path only. TransformBlank's
rich-text and as-typed projection paths skip the strip — those are runtime
overlays the user doesn't type the override into. The visible-buffer
strip is sufficient because that's where the override comes from.

---

## Span handling — WIPE mode forces full-buffer

The substitute span has to wipe `with <token>` along with the rest of
the lookup phrase. Otherwise the user types `atomic number of oxygen
with opus _` and gets back `atomic number of oxygen with opus 8` —
literal `with opus` lingers next to the answer.

For TransformBlank that's free — every rewrite already uses
`spanStart=0, spanEnd=context.text.length` (whole-buffer wipe by
design). The override token is wiped along with the rest.

For FluidBlank WIPE mode the existing path uses
`findSpanCharRange(span, context.text)` — searches for the LLM-returned
span text in the original buffer. But the LLM saw STRIPPED text, so
its claimed span doesn't appear verbatim in the original (the original
has `with opus` in the middle). `findSpanCharRange` returns null →
spanStart/spanEnd stay unset → only `_` gets substituted → `with opus`
lingers.

The fix: when override is active AND we're in WIPE mode, force
`spanStart=0, spanEnd=context.text.length`:

```ts
if (mode === 'WIPE') {
  if (override && overrideAdapter) {
    result.spanStart = 0;
    result.spanEnd = context.text.length;
  } else {
    const range = findSpanCharRange(span, context.text);
    if (range) { result.spanStart = range[0]; result.spanEnd = range[1]; }
  }
}
```

For FILL mode (`the capital of france is _` shape — copula / equation /
question marker before `_`), span stays at the `_` slot only and `with
<token>` lingers in the buffer. v1 trade-off — partial remapping from
stripped-offsets to original-offsets is doable but complex (the strip
collapses double-space + trims). Documented as a v2 follow-up; FILL
mode is the rarer path for override-bearing inputs.

---

## Event shape — `modelOverride` field on `started`

`fluid-blank.started` and `transform-blank.started` events both grew an
optional `modelOverride` field:

```ts
| { type: 'started';
    textLen: number;
    blankIdx: number;
    llm: string;          // describeLLMCall of the EFFECTIVE target (post-override)
    modelOverride?: { provider: string; model: string; token: string };
    // transform-blank also has: mode: '3-pass' | 'fused';
  }
```

Only set when the override resolved successfully. Absent on:
- No `with <token>` in the buffer.
- `with <token>` matched but provider's apiKey unavailable.
- Source's configured target is used.

The agentic harness asserts on this field. Scenarios 65-71 in
`tests/agentic/scenarios/` cover the happy path, the unknown-token
cede, the `without` regex word-boundary, and the multi-`with` last-match
tie-break. See the table in `tests/agentic/scenarios/README.md`.

---

## Interaction with sibling-abort

The resolver's parallel branch (PR #95, June 2026) issues per-source
`AbortController`s and aborts strictly-lower-priority siblings when a
higher-priority source emits a whole-buffer claim.

When the override fires, ConfigIntent has already ceded synchronously
(zero LLM calls). TransformBlank (93) and FluidBlank (92) both start
their dispatches via the override. Whichever finishes first with a
whole-buffer-claim CueResult triggers the abort: the loser's in-flight
LLM call gets cancelled mid-fetch via its `signal`.

So even with the bucket on Opus and override also on Opus, you don't
pay for two concurrent Opus calls. The winner emits, the abort
cascades, the loser's HTTP layer rejects with `AbortError`, the
source's catch logs `failed (… ms) — aborted` and returns empty. No
buffer churn, no double substitute.

---

## Adding a new alias / new provider

The matcher is data-driven. Two extension points:

### New common alias

Edit `COMMON_ALIASES` in `model-aliases.ts`:

```ts
const COMMON_ALIASES: Record<string, { provider: string; model?: string }> = {
  // existing entries...
  'your-alias': { provider: 'cerebras', model: 'gpt-oss-120b' },
  // model? optional — falls back to provider.defaultModel
};
```

Add tests in `model-aliases.test.ts` covering:
- The new token resolves to the expected (provider, model).
- Case-insensitive variants resolve too (the regex lowercases the token).
- `stripModelOverride` correctly removes the new alias from a sample buffer.

### New provider in `listProviders()`

No edit to `model-aliases.ts` required. The matcher walks
`listProviders()` for tier 2 (provider id) and walks each provider's
`knownModels` for tiers 3-5. Adding `provider: 'foo', knownModels:
['foo-mega']` to the registry automatically makes `with foo _` and
`with foo-mega _` resolvable. The provider's `envKeyName`
(`FOO_API_KEY`) needs to be set in the user's env for the override to
actually fire — without it, `resolveOverride` returns null and the
override silently falls through.

---

## Tests pinning this behaviour

| File | Pins |
|---|---|
| `packages/opencues-core/src/model-aliases.test.ts` | Common alias resolution (opus / haiku / cerebras / nano / gpt-oss), case insensitivity on `with` and the token, last-match-wins on multiple `with`, regex word-boundary (`without` doesn't match), `with` + number rejection, `with` + unknown token rejection, prefix + exact model match, `stripModelOverride` start/middle/end removal + double-space collapse |
| `tests/agentic/scenarios/65-model-override-fluid-blank.json` | End-to-end: `with opus` → FluidBlank dispatches through anthropic, WIPE wipes the token, `started` event carries `modelOverride.{provider,model,token}` |
| `tests/agentic/scenarios/66-model-override-transform-blank.json` | End-to-end: `with haiku` → TransformBlank dispatches through anthropic, strips token from rewrite, buffer end-state contains no `with haiku` |
| `tests/agentic/scenarios/67-model-override-config-intent-cedes.json` | ConfigIntent skips its classifier LLM call when `with <model>` present; no settings selector painted |
| `tests/agentic/scenarios/68-model-override-unknown-token.json` | `with fire` doesn't match — no `modelOverride` field in `fluid-blank.started` |
| `tests/agentic/scenarios/69-model-override-last-match-wins.json` | `with sonnet then refine with opus _` → routes through opus |
| `tests/agentic/scenarios/70-model-override-without-isnt-match.json` | `without opus` — regex word-boundary holds |
| `tests/agentic/scenarios/71-model-override-fluid-config-still-fires.json` | Regression: `change to cerebras _` (no `with`) still fires ConfigIntent → writes bucket scalar |

---

## See also

- [`docs/features/model-override.md`](../features/model-override.md) — user-facing summary.
- [`docs/architecture/llm-routing.md`](llm-routing.md) — bucket-bucket precedence that the override slots above.
- [`docs/architecture/fluid-config.md`](fluid-config.md) — the persistent-flip alternative + ConfigIntent's classifier.
- [`docs/architecture/blank-sources.md`](blank-sources.md) — substitute mechanics + the `CueSource` family the override threads through.
- [`packages/opencues-core/src/model-aliases.ts`](../../packages/opencues-core/src/model-aliases.ts) — the matcher.
