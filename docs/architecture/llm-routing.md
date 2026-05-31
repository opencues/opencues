# LLM routing — three buckets

OpenCues runs many LLM-driven surfaces (word-cues, sentence-cues,
fluid-blank, transform-blank, fluid-config, keyword blanks, auditors,
agent-rewrite). The provider/model picker collapses them into **three
buckets**, each with one user-visible scalar pair in
`~/.cues/OPENCUES.md`. Per-aspect overrides remain available but are
deliberately file-edit-only.

## The buckets

| Bucket | Surfaces | Scalars |
|---|---|---|
| **cues** | word-cues, sentence-cues | `cues-llm-provider`, `cues-llm-model`, `cues-llm-endpoint` |
| **auditors** | auditors, agent-rewrite | `auditors-llm-provider`, `auditors-llm-model`, `auditors-llm-endpoint` |
| **blanks** | fluid-blank, transform-blank, fluid-config, keyword blanks | `blanks-llm-provider`, `blanks-llm-model`, `blanks-llm-endpoint` |

Both cues + auditors are **prose-bearing** — the resolver's
`trainsOnInput` guard refuses to wire them through a provider whose ToS
allows training on submitted inputs (today: `opencode-zen`). Only the
blanks bucket exposes `opencode-zen` in its menu, because typing `_` is
the user's explicit consent gate.

The agent-rewrite surface goes into the **auditors** bucket because
auditors and agent-rewrite share the same trust class — background
prose rewriters that ship the whole buffer to the model. Putting them
on the same knob lets the user pick one provider for "things that
rewrite my prose without me typing `_`".

## Precedence ladder

Most-specific wins:

```
per-source frontmatter (`provider:` / `model:` in a CUE.md / BLANK.md)
  ▶ per-feature scalar (`word-cues-provider:`, `fluid-blank-provider:`, …)
    ▶ bucket scalar (`cues-llm-provider:`, `auditors-llm-provider:`, `blanks-llm-provider:`)
      ▶ global scalar (`llm-provider:`)
        ▶ auto-fallback (first env key in `PROVIDER_AUTO_ORDER`)
```

Setting `cues-llm-provider: cerebras` pins every cue source to Cerebras
**unless** a particular word-cue source declares its own
`provider:` (per-source) or the user set a `word-cues-provider:`
(per-feature). Setting `cues-llm-provider: inherit` (the default)
collapses the bucket and lets `llm-provider:` take over.

## Per-aspect overrides — advanced, file-edit only

The per-aspect scalars are intentionally **not** in the menu, the
cycling list, or the fluid-config classifier. They exist for power
users who want fine-grained tuning. The full list:

- `word-cues-provider:` / `word-cues-model:` / `word-cues-endpoint:`
- `sentence-cues-provider:` / `sentence-cues-model:` / `sentence-cues-endpoint:`
- `fluid-blank-provider:` / `fluid-blank-model:` / `fluid-blank-endpoint:`
- `transform-blank-provider:` / `transform-blank-model:` / `transform-blank-endpoint:`
- `fluid-config-provider:` / `fluid-config-model:` / `fluid-config-endpoint:`
- `agent-provider:` / `agent-model:` / `agent-endpoint:` (auditors bucket)

If you want them, edit `~/.cues/OPENCUES.md` directly. The bucket scalars
cover the 90% case.

## How surfaces route at build time

**cues + blanks**: handled in
`packages/opencues-core/src/sources/build-sources.ts` via
`BuildSourcesOptions.{cuesBucket*, blanksBucket*}`. The resolver
collapses `inherit` to undefined before passing values down; build-sources
applies the ladder in `resolveFor()`.

**auditors**: handled in
`packages/opencues-runtime/src/boot-common.ts` via
`buildAgentLLMResolver`. Reads `auditorsLlmProvider` from
`OpenCuesState`, walks the same ladder, and returns the resolved tuple
for `agent-rewrite.ts`'s per-tick LLM call.

## Migration from the legacy `blank-llm-*` scalars

Pre-three-bucket installs used `blank-llm-provider:` /
`blank-llm-model:` / `blank-llm-endpoint:` (singular). The new names are
plural (`blanks-llm-*`).

- **Runtime**: reads both names; new wins if present, legacy is the
  fallback. See `config-loader.ts:bucketProvider`.
- **`opencues install`**: runs `seed-configs` which rewrites legacy →
  new in place. Idempotent, single-line replacement, preserves
  surrounding frontmatter.

After everyone has run `opencues install` once post-three-bucket, the
back-compat fallback will be removed in the next release.

## Natural-language switching via fluid-config

When `fluid-config-mode: on`, the classifier at priority 94 catches
`_`-trailed sentences and routes them to one of three intents: a
**setting** change, a **provider** change, or **NONE**. The
provider-change intent is the bucket-aware natural-language path:

```
use anthropic for cues _              → cues-llm-provider: anthropic
switch the blanks brain to cerebras _ → blanks-llm-provider: cerebras
use claude opus for auditors _        → auditors-llm-provider: anthropic
                                        auditors-llm-model: claude-opus-4-7
route everything to gemini _          → cues-llm-provider: gemini   (cues = default brain)
```

### What the classifier may emit

The model is bounded by two registries:

- **Bucket scope** ∈ `{cues, auditors, blanks}` — hard-coded list.
- **Provider id** ∈ entries of `PROVIDERS` in
  `packages/opencues-core/src/llm-provider.ts` (the `ProviderId` union).
- **Model id** ∈ each provider's optional `knownModels: readonly string[]`
  list. Models outside that list are rejected at runtime even if the
  classifier emits them — power users can still pin them by editing
  OPENCUES.md directly.

The trust-class guard from the resolver mirrors here: the classifier
verdict for the cues or auditors bucket cannot route to a provider
whose `trainsOnInput: true` (today: `opencode-zen`). Only the blanks
bucket may pick that provider.

### Adding a new model to the classifier's choice space

Append the model id to the provider adapter's `knownModels` array in
`packages/opencues-core/src/llm-provider.ts`. The classifier prompt
renders the lists at module-load, so no prompt edit is required. Aim
for 3–5 entries per provider — bench-validated picks that cover the
common cheap-fast / balanced / deep-reasoning tiers.

### Cycling after a switch

The fluid-config result is a selector-satellite pair: the selector is
the bucket scalar (e.g. `cues-llm-provider`) — itself a FEATURES
registry entry — and the satellite is the provider id. After a switch
the user can cycle the satellite through the menu values for that
bucket scalar (the registry's `values` list, e.g. `inherit, cerebras,
groq, gemini, anthropic, openai`). Picking a different provider via
cycling overwrites the provider scalar only — the model scalar (if
previously set) stays put.

## Diagnostics

`opencues doctor` shows the **LLM routing** section with the effective
provider per bucket after precedence walks (bucket scalar > global
> auto-fallback). The arrow notation `← llm-provider` indicates which
tier provided the value when the bucket itself was `inherit`.

## Related files

- Single source of truth: `packages/opencues-core/src/feature-registry.ts`
  (`FEATURES` entries for the three bucket scalars).
- Provider catalog: `packages/opencues-core/src/llm-provider.ts`
  (`ProviderId` union, `PROVIDER_AUTO_ORDER`, `PROVIDERS` adapters).
- Resolver wiring: `packages/opencues-runtime/src/modules/resolver.ts`
  (`buildOpts` block).
- Auditors wiring: `packages/opencues-runtime/src/boot-common.ts`
  (`buildAgentLLMResolver`).
- Trust guard: `packages/opencues-core/src/sources/build-sources.ts`
  (`resolveFor` → `trainsOnInput` rejection).
