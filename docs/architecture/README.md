---
last_updated: 2026-07-03
---

# Architecture docs — index

The 28 canonical references that describe how OpenCues is built.
One-line hooks below; each doc is the authoritative reference for
its area + the "read before editing" guard.

> **Reading order if you're new:** [`repo-structure.md`](repo-structure.md)
> first (where things live), then any feature-specific doc as
> needed. The cross-cutting docs (`spans-and-cycling.md`,
> `feature-registry.md`, `security-audit.md`) are the load-bearing
> backbones — read them when you need to.

---

## Backbone (read these first)

| Doc | What it covers |
|---|---|
| [`repo-structure.md`](repo-structure.md) | Folder layout + stage tracker for the May 2026 monorepo restructure. |
| [`feature-registry.md`](feature-registry.md) | Single-source-of-truth for FEATURES + MENU_TUNABLES + BUILTIN_BLANKS. Adding a feature is one entry; every install-boundary site reads from this registry. |
| [`security-audit.md`](security-audit.md) | Canonical threat model + attack-class table + residual-risk register. Read before touching trust-gate / sandbox / capability / secret-binding code. |
| [`universal-integration.md`](universal-integration.md) | The no-cycling host-attach profile (chrome's normal-input mode). Pruning rule: hosts that can't intercept Ctrl+Alt+arrow advertise `supportsCycling: false`; every cycleable cue/blank is filtered at registration. |

---

## Cycling + render pipeline

| Doc | What it covers |
|---|---|
| [`spans-and-cycling.md`](spans-and-cycling.md) | The cycling/span/dim/nav system. Two span systems (blank-fill vs static-alt), the cycling priority order (selector/satellite → spanFill → list blank → blankStep DynDef → static alts), shift+prune flow, every bug we've fixed. Read before touching `cycling.ts`, `dyn-defs.ts`, `span-fill.ts`, `dim-render.ts`, or `navigation.ts`. |
| [`blank-sources.md`](blank-sources.md) | Family of source classes (BlankSource / FluidBlankSource / TransformBlankSource / SentenceCueSource / ConfigIntentSource / ConfigSource / LocalCueSource) + the two substitute mechanisms (deterministic slot splice vs three-way-merge). Decision table for adding a new source. Read before touching the resolver substitute dispatch. |
| [`blank-integration.md`](blank-integration.md) | Blank routing (`blankShapes` + keyword desugaring, sentence-scoped) + output placement (always-FILL, shape-derived clearing) + the additive `integration:` output template. Replaces the deleted replace/consume-mode docs. |

---

## LLM-driven sources

| Doc | What it covers |
|---|---|
| [`transform-blank.md`](transform-blank.md) | Imperative-blank pipeline — a single fused LLM call (classify + rewrite in one pass) plus whole-buffer three-way merge. Design rationale, prompt design, composition for "X and Y", parser quirks. Companion: `tests/benchmarks/transform-blank/EXPERIMENTS.md`. |
| [`fluid-config.md`](fluid-config.md) | Optional `fluid-config-mode` feature — semantic `_` → settings change classifier at priority 94. Routes ONLY to FEATURES-registry scalars. Three structural defences + the known precision boundary (FluidBlank eagerness on imperatives). |
| [`sentence-cues.md`](sentence-cues.md) | `scope: sentence` cues + the `sentence-cues-mode` scalar. Passive DynDef contract — buffer is never modified without a keystroke. Managed-span overlap guard. Forward-compat KNOWN_SCOPES allowlist. |
| [`ambient-context.md`](ambient-context.md) | Optional `ambient-context-mode` — fluid-blank receives sanitized field metadata (label/placeholder/page-title) for disambiguating lookups. Chrome-only gatherer; host-agnostic at the HostAdapter contract. |
| [`identity-context.md`](identity-context.md) | Optional `identity-context-mode` — fluid-blank receives sentinel tokens from `~/.cues/IDENTITY.md`. Safe-mode (post-process substitution) vs raw-mode (inline values). PII never reaches provider logs in safe mode. |
| [`typed-sentinel-language.md`](typed-sentinel-language.md) | The typed-sentinel token language (`sentinel-language: typed`) that identity-context / ambient-context / blank-as-context share — scalar and on-demand `ai-callable` function tiers, capability gating, deployment status per phase. |
| [`blank-as-context.md`](blank-as-context.md) | Production wiring for surfacing a blank's live value as ambient catalog context to fluid-blank/transform-blank (`as-context:` frontmatter). Companion to `docs/features/blank-as-context.md`; bench evidence in `tests/benchmarks/blank-sentinels-matrix/FINDINGS.md`. |
| [`agent-task.md`](agent-task.md) | AgentRewrite module — `agentically X _` / `add task X _`. One debounce-driven LLM call per tick, three-way merge against live buffer drops hunks overlapping user edits. |
| [`agent-rewrite-cache.md`](agent-rewrite-cache.md) | AgentRewrite two-tier cache (skip-on-stable + LRU). Cache-key composition, determinism assumption (temp=0 + seed pinning), extension points. |
| [`llm-routing.md`](llm-routing.md) | Three-bucket LLM routing (cues / auditors / blanks) — one provider/model scalar pair per bucket in `OPENCUES.md`, precedence ladder over per-aspect file-edit-only overrides. |
| [`max-thinking.md`](max-thinking.md) | The `max-thinking` OPENCUES.md scalar — per-model reasoning-effort ceiling resolution. Single chokepoint (`resolveReasoningEffort`) every reasoning-capable wire call funnels through. |
| [`cerebras.md`](cerebras.md) | Cerebras-specific behaviour OpenCues relies on as the default provider — prompt prefix caching, gzip request-body optimisation, system/user message split rules. |
| [`claude-cli-provider.md`](claude-cli-provider.md) | The `claude-cli` subscription-backed transport (vs the direct `anthropic` HTTP provider) — subprocess dispatch, quota accounting, when each transport is picked. |

---

## Security + capability

| Doc | What it covers |
|---|---|
| [`sandbox.md`](sandbox.md) | OS-level sandbox for blank scripts. Bubblewrap on Linux/WSL; readonly FS, no network, isolated PID/IPC. Per-blank opt-in via `sandbox: strict`. |
| [`user-blanks.md`](user-blanks.md) | Capability model for user-shipped JS blanks (`impl: ./xxx.js`). Sandboxed VM/Worker context with `network` / `llm` / `storage` / `secrets` capabilities, per-secret host-allow-list, quota caps. |
| [`user-blanks-subprocess.md`](user-blanks-subprocess.md) | Bun-host fallback for user-pack JS blanks — `isolated-vm` can't load on Bun (opencode, shell), so those hosts run the sandboxed loader in a subprocess instead. |
| [`chrome-security.md`](chrome-security.md) | Chrome MV3 boundaries — what the content-script can/can't do, the storage tier, native-messaging host trust. |
| [`chrome-runtime-compat.md`](chrome-runtime-compat.md) | Canonical reference for the Node-vs-browser split in `@opencues/runtime`. Read before adding any runtime feature that does HTTP, reads `process.env`, requires a `node:*` module, or builds a host-specific adapter. |
| [`chrome-llm-keys.md`](chrome-llm-keys.md) | Chrome's multi-provider key forwarding + real-time updates. Three-tier merge, boot-time probes, live-mutation contract on `Resolver.options.apiKeys`. |

---

## Config, reload & versioning

| Doc | What it covers |
|---|---|
| [`config-loader-reload-race.md`](config-loader-reload-race.md) | The hoisted-blank-write vs ConfigLoader hot-reload race and its fix (`applyOpenCuesScalar`'s 2.5s reload-suppression window). |
| [`versioning.md`](versioning.md) | Semver-per-package policy, changelog discipline, and when to bump `SPEC_VERSION`. |

---

## Add a new doc?

If you're adding architecture content, this index also gets a row.
Keep the one-line hook tight — "what it covers", not "what it
contains". The full prose lives in the doc itself.

Two things every load-bearing arch doc should have:
1. A "read before editing X" guard at the top.
2. A "tests pinning this behaviour" section at the bottom listing
   the unit + scenario + bench tests that catch regressions.
