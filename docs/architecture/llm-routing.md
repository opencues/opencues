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
