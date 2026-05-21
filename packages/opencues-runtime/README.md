# @opencues/runtime

Host-agnostic runtime for [OpenCues](https://github.com/opencues/opencues) — the reference implementation of three open file-format standards (Cues, Blanks, Auditors) for real-time guidance as you type. Takes the cue/blank decisions from [`@opencues/core`](../opencues-core) and turns them into keystroke-aware editor behaviour: navigation, cycling, dim rendering, blank fill, statusline, TTS, hot-reload.

> **Pre-1.0 — internal package.** Today this ships as a workspace dep
> for per-host integrations (Claude Code, OpenCode, Chrome, Gemini
> CLI). Subject to change until v1.0. If you're building an editor
> integration, start at
> [opencues/opencues](https://github.com/opencues/opencues) and read
> `CONTRIBUTING.md` + `docs/guides/adding-an-integration.md`.

## What it does

`@opencues/runtime` is the nervous system of the framework:

- **`HostAdapter` contract** — the universal interface every editor integration implements (text get/set, cursor get/set, key dispatch, force-render, render-override directives, blank invocation, statusline export, capabilities advertisement).
- **`boot(adapter)`** — single entry point. Wires up every runtime module against the host adapter; returns a `BootResult` with the dispatch hooks the integration calls on key/text events.
- **Per-host adapter bands** under `adapters/cc/`, `adapters/oc/`, `adapters/chrome/`, `adapters/gemini/` — each declares its host-specific quirks (CC's stale-closure mitigation, OC's keypress filter wrap, gemini's React render-kick, chrome's normal-input pruning).
- **Modules** under `src/modules/` — Navigation, Cycling, Resolver (orchestrates `@opencues/core` LLM calls), BlankFill, AgentRewrite, ConfigLoader, Statusline, TTS, DimRender, MarkdownSubstitute, BlankLoading, etc. Each module is host-agnostic — quirks live in the adapter band, not here.
- **State classes** under `src/state/` — DynDefs (per-word cycling state), SelectorSatelliteState (opencues-settings pair), SpanFillState (multi-word substitutes), HighlightState, DismissedBlanks.
- **Render directives** — `render-override`, `dim-ranges`, `highlight-range`, `render-rgb-color`, `coloredRanges` — host-capability-gated rendering primitives.

What it does NOT do: parse `.md` configs, call LLMs, decide which source claims a word. Those live in [`@opencues/core`](../opencues-core).

## Public surface

Minimal example — a host integration boots the runtime:

```ts
import { Runtime } from '@opencues/runtime';
import type { HostAdapter } from '@opencues/runtime';

const adapter: HostAdapter = createMyHostAdapter(/* ... */);
const runtime = new Runtime({ adapter, /* config */ });
await runtime.boot();
// adapter.onKey / .onTextChange now route through runtime modules
```

Key exports:

| Symbol | Purpose |
|---|---|
| `HostAdapter`, `BootResult`, `ProcessSpec` | Universal contracts |
| `Runtime` | Boot orchestrator |
| `boot()` | Function-style boot entry (used by every per-host adapter) |

## Architecture

```
packages/opencues-runtime/
├── src/
│   ├── adapter.ts                  HostAdapter contract (types only)
│   ├── runtime.ts                  Runtime class
│   ├── boot-common.ts              Shared boot wiring
│   ├── event-bridge.ts             Optional bridge for the agentic test harness
│   ├── modules/                    Host-agnostic modules
│   │   ├── navigation.ts           Ctrl+Alt+arrow → highlight movement
│   │   ├── cycling.ts              Ctrl+Alt+Up/Down → alt rotation; satellite cycling
│   │   ├── resolver.ts             Bridges core's CueResolver to runtime state
│   │   ├── blank-fill.ts           Keyword + `_` → blank substitution
│   │   ├── agent-rewrite.ts        `agentically X _` task arming + debounced rewrite
│   │   ├── config-loader.ts        Reads ~/.cues/, hot-reloads on file change
│   │   ├── statusline.ts           Tip/alt/cursor export to /tmp/opencues-status-*.json
│   │   ├── tts.ts                  Speak tips on highlight when voice-mode: active
│   │   ├── dim-render.ts           Dim ranges for cued words
│   │   ├── markdown-substitute.ts  Range splice that preserves rich-text styling
│   │   └── blank-loading.ts        Braille / RGB / ANSI loading animator
│   ├── state/                      Per-buffer state classes
│   ├── blanks/                     Built-in blank impls (volume, weather, dictionary, …)
│   ├── user-blanks/                Capability-constrained loader for user-shipped JS blanks
│   └── security/                   Spawn sandbox (bubblewrap on Linux/WSL)
└── adapters/
    ├── cc/v2.1/                    Claude Code 2.1.x band
    ├── oc/v1.4/  + v1.14/          OpenCode 1.4.x + 1.14.x bands
    ├── chrome/v1/                  Chrome MV3 extension band
    └── gemini/v0.41/               Gemini CLI 0.41.x band (React/Ink)
```

## Tests

```bash
pnpm --filter @opencues/runtime test    # 1252+ unit + scenario tests
```

End-to-end scenarios live under `tests/agentic/` in the umbrella
repo (gitignored — extracted to a private harness).

## License

See [LICENSE](./LICENSE) — currently proprietary pre-launch.
