# @opencues/core

Pure-TypeScript core of [OpenCues](https://github.com/opencues/opencues) — the open standard for real-time guidance as you type. No I/O dependencies, no host coupling. Given text + config, answers "what should we suggest for this word / blank?"

> **Pre-1.0 — internal package.** Today this ships as a workspace dep
> for `@opencues/runtime` + per-host integrations. Subject to change
> until v1.0. If you're building an editor integration, start at
> [opencues/opencues](https://github.com/opencues/opencues) and read
> `CONTRIBUTING.md` + `docs/guides/adding-an-integration.md`.

## What it does

`@opencues/core` is the brain of the system:

- **Parsers** — read `CUES.md` / `BLANKS.md` / `AUDITORS.md` master files + folder-based `cues/<name>/CUE.md` / `blanks/<name>/BLANK.md` / `auditors/<name>/AUDITOR.md` entries.
- **Cue sources** — pluggable per-word and per-`_` LLM source classes (`ConfigSource`, `FluidBlankSource`, `TransformBlankSource`, `SentenceCueSource`, `ConfigIntentSource`, plus the local `LocalCueSource`).
- **Resolver** — orchestrates source dispatch via `RoutedWordSourceGroup`: each word is claimed by exactly one source by priority + match/keywords, then batched into LLM calls in parallel.
- **LLM provider router** — six providers built in (groq, cerebras, openai, anthropic, openrouter, gemini); per-feature / per-cue overrides; auto-fallback on transient failures (402, 429, 5xx).

What it does NOT do: render to a screen, intercept keystrokes, manage host state. Those live in [`@opencues/runtime`](../opencues-runtime).

## Public surface

Minimal example — resolve cues for a text buffer:

```ts
import {
  parseCuesMd,
  discoverFolderConfigs,
  buildSourcesFromConfig,
  createResolver,
} from '@opencues/core';
import * as fs from 'fs/promises';

const cuesCfg = parseCuesMd(await fs.readFile('CUES.md', 'utf8'));
const cuesFolders  = await discoverFolderConfigs('.cues/cues',  fsAdapter);
const blanksFolders = await discoverFolderConfigs('.cues/blanks', fsAdapter);

const sources = buildSourcesFromConfig(cuesCfg, cuesFolders, blanksFolders, {
  httpAdapter, endpoint, apiKey, defaultModel,
  enableFluidBlank: true, enableWordCues: true,
});
const resolver = createResolver(sources);
const result = await resolver.resolve({ text: 'the lawyer filed today', words: [...] });
```

Key exports (full list in `src/index.ts`):

| Symbol | Purpose |
|---|---|
| `parseCuesMd`, `parseSingleCueMd`, `parseBlanksMd`, `parseAuditorsMd` | `.md` config parsers |
| `discoverFolderConfigs` | folder discovery for cues/blanks/auditors |
| `KNOWN_SCOPES` | forward-compat allowlist (drop unknown scope values silently) |
| `buildSourcesFromConfig` | factory: `.md` configs → `CueSource[]` |
| `createResolver`, `CueResolver` | orchestrator |
| `ConfigSource`, `FluidBlankSource`, `TransformBlankSource`, `SentenceCueSource`, `ConfigIntentSource`, `RoutedWordSourceGroup` | source classes |
| `PROVIDERS`, `getProvider`, `pickAutoProvider`, `describeLLMCall` | LLM provider router |
| `FEATURES`, `MENU_TUNABLES`, `BUILTIN_BLANKS`, `getCyclableValues` | single-source-of-truth feature registry |
| `inferHostCompat`, `inferSiteCompat`, `HOSTS`, `NATIVE_HOSTS` | host-compat resolution |

## Architecture

```
packages/opencues-core/src/
├── types.ts                  CueSource / CueContext / CueResult contracts
├── cues-md.ts                .md frontmatter + section parser
├── discover.ts               folder-based config discovery
├── resolver.ts               CueResolver orchestration
├── llm-provider.ts           6-provider router + reasoning-floor + auto-fallback
├── feature-registry.ts       single-source-of-truth for features/scalars/blanks
├── node-http-adapter.js      Node HTTPS with keep-alive (re-exported for hosts)
└── sources/
    ├── config-source.ts            generic LLM cue source (CUE.md driven)
    ├── routed-word-source-group.ts per-word dispatch — gives prompt-injection isolation
    ├── blank-source.ts             keyword-bound blank dispatcher
    ├── fluid-blank-source.ts       free-form `_` lookup (FUSED single-call)
    ├── transform-blank-source.ts   imperative rewrite via `_` (3-pass or fused)
    ├── sentence-cue-source.ts      scope:sentence cue (passive — buffer untouched until cycle)
    ├── config-intent-source.ts     fluid-config — semantic `_` → settings change
    ├── local-cue-source.ts         static tip lookups (CUES.md tips JSON)
    └── parsers.ts                  response parsers (alternatives, raw, math, etc.)
```

Per-source / per-feature `maxTokens` + `temperature` overrides plumb through both per-cue CUE.md frontmatter AND OPENCUES.md root scalars (`fluid-blank-max-tokens:` etc.).

## Tests

```bash
pnpm --filter @opencues/core test       # 565+ unit tests
```

Live LLM benches (per pipeline) live under `tests/benchmarks/` in the umbrella repo, NOT here.

## License

See [LICENSE](./LICENSE) — currently proprietary pre-launch.
