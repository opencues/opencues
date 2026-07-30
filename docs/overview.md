---
last_updated: 2026-07-04
---

# OpenCues Architecture

A system for real-time guidance as you type — providing alternatives, blanks, cue-tips, and cue-blanks across any text input. See the [glossary](glossary.md) for all terminology and [`concept.md`](../concept.md) for the two-direction core concept.

For the full list of features any integration should implement, see `features/README.md`.

## Overview

OpenCues has two directions of intent: **Cues** (LLM → user — alternatives offered on plain text) and **Blanks** (user → system — substitutions summoned via `_`). Cue-Blanks are blanks bound to a keyword, pulling external state (volume, stocks). Everything that touches the world is `_`-gated. **Auditors** extend the Cues direction to the whole buffer — a continuous, revertable rewrite for one declared concern (grammar, clarity, tone, ...) instead of a per-word cycle; see `spec/auditor-spec.md` and [`docs/guides/adding-an-auditor.md`](guides/adding-an-auditor.md).

The architecture has three layers:

1. **Config Standard** (`CUES.md` + `cues/<name>/CUE.md` + `blanks/<name>/BLANK.md`) — Markdown files that define all prompts, modes, and behaviour. The standard is the protocol — integrations read these files.
2. **Core Library** (`@opencues/core`) — Pure TypeScript reference implementation. Parses config files, builds `CueSource` instances, runs LLM sources, resolves results. No I/O or platform dependencies. This is "what alternatives exist."
3. **Runtime Library** (`@opencues/runtime`) — Host-agnostic orchestration: the `HostAdapter` contract, `ConfigLoader` (hot-reload, search-path merge), `Resolver` (wraps `@opencues/core`'s `buildSourcesFromConfig`/`createResolver` and re-resolves on every debounced text change), Navigation/Cycling/BlankFill/DimRender modules, and per-host adapter bands. Knows nothing about LLMs. This is "how the user interacts with those alternatives."

Integrations (Claude Code, OpenCode, Chrome, Gemini CLI, Shell) are thin per-host adapters on top of `@opencues/runtime`, which in turn depends on `@opencues/core`.

```
┌─────────────────────────────────────────────────────────────────┐
│                @opencues/core (pure TypeScript)                 │
│  - CueSource interface (+ isCycleable)                           │
│  - CueResult interface                                           │
│  - CueResolver class (orchestrates sources)                      │
│  - buildSourcesFromConfig() — CuesMdConfig -> CueSource[]         │
│  - No I/O, no platform dependencies                              │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────────────────┐
              ▼               ▼                           ▼
┌─────────────────┐ ┌─────────────────┐        ┌─────────────────────┐
│ LocalCueSource  │ │ ConfigSource /  │  ...    │ BlankSource /       │
│ (static tips)   │ │ RoutedWordGroup │        │ FluidBlankSource /   │
│                 │ │ (LLM word-cues) │        │ TransformBlankSource │
└─────────────────┘ └─────────────────┘        └─────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              @opencues/runtime (host-agnostic)                  │
│  - HostAdapter contract, ConfigLoader, Resolver                  │
│  - Navigation / Cycling / BlankFill / DimRender modules          │
│  - Per-host adapter bands: cc, oc, gemini, chrome, shell          │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┬───────────────┐
              ▼               ▼               ▼               ▼
┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│ Claude Code │ │  OpenCode   │ │   Chrome    │ │ Gemini CLI  │  ...+Shell
│ tweakcc     │ │ patched fork│ │ MV3 ext.    │ │ patched fork│
│ patch       │ │             │ │             │ │             │
└─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘
```

## Installation

```bash
cd ~/opencues
pnpm install
pnpm build
```

For end-user installation (host integrations):

```bash
pnpm exec opencues install claude-code     # or: opencode | chrome | gemini-cli | shell | --all
```

See the top-level [README.md](../README.md) for the full quickstart.

## Package Structure

```
~/opencues/
├── packages/
│   ├── opencues-core/              # Pure TypeScript, no I/O
│   │   ├── src/
│   │   │   ├── types.ts               # Interfaces (CueSource, CueResult, CueContext, ...)
│   │   │   ├── resolver.ts            # CueResolver, createResolver
│   │   │   ├── cues-md.ts             # CUES.md/BLANK.md parser
│   │   │   ├── discover.ts            # discoverFolderConfigs — folder-based config discovery
│   │   │   └── sources/                # 20+ source classes: LocalCueSource, ConfigSource,
│   │   │                               # RoutedWordSourceGroup, BlankSource, FluidBlankSource,
│   │   │                               # TransformBlankSource, ConfigIntentSource,
│   │   │                               # SentenceCueSource, build-sources.ts, parsers.ts, ...
│   │   └── dist/                       # Compiled output
│   ├── opencues-runtime/            # Host-agnostic runtime — see docs/architecture/
│   │   ├── src/                       # Navigation, Cycling, BlankFill, ConfigLoader, Resolver, ...
│   │   ├── adapters/                   # Per-host adapter bands (cc, oc, gemini, chrome, shell)
│   │   └── dist/
│   ├── opencues-cli/                # The `opencues` command
│   └── opencues-park/               # npm-name placeholder (published; superseded on real-CLI launch)
│
└── package.json                    # Workspace root
```

## Core Interfaces

### CueResult

Result from a cue source for a single word:

```typescript
interface CueResult {
  wordIndex: number;        // Position in text (0-indexed)
  word: string;             // The actual word
  alternatives: string[];   // Original word at [0], then alternatives
  cueTip?: string;          // Hint text for status line
  altCueTips?: Record<string, string>;  // Per-alternative tips
  source: string;           // 'tips' | <cue/blank source name> | 'fluid-blank' | ...
  priority: number;         // Higher wins on merge
}
```

### CueContext

Context provided to sources for analysis:

```typescript
interface CueContext {
  text: string;                    // Full input text
  words: string[];                 // Text split into words
  domain?: string;                 // 'claude-code', 'gemini-cli', etc.
  previousResults?: CueResult[];   // For incremental updates
  blankIndices?: number[];         // Indices with underscore blanks
}
```

### CueSource

Interface for cue providers:

```typescript
interface CueSource {
  id: string;                      // Unique identifier
  priority: number;                // Resolution order (higher first)
  isCycleable: boolean;             // True for sources the user cycles through with the keyboard
                                     // (word-cues, selector/satellite blanks, list blanks). False
                                     // for single-answer sources (fluid-blank, transform-blank).
                                     // Hosts with no cycling surface (chrome's plain <input>/
                                     // <textarea> attach mode) drop cycleable sources at
                                     // registration — see docs/architecture/universal-integration.md.
  supports(context: CueContext): boolean;
  getCues(context: CueContext): Promise<CueSourceResult>;
}
```

## Usage Examples

### Basic Usage (Node.js)

```typescript
import { CueResolver, LocalCueSource, discoverFolderConfigs } from '@opencues/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Discover folder-based cue configs (cues/<name>/CUE.md — static tips + LLM sources)
const cuesRoot = path.join(os.homedir(), '.cues');
const discovered = discoverFolderConfigs({
  basePath: cuesRoot,
  readFile: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
  readDir: (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).map(e => ({ name: e.name, isDirectory: e.isDirectory() })); } catch { return null; } },
});

// The static-mode words/groups map, if any cues/<name>/CUE.md shipped a JSON tips block
const localCueData = discovered.cuesConfig?.tips ?? [];

// Create resolver with the tips source
const resolver = new CueResolver([
  new LocalCueSource(localCueData, { priority: 100 })
]);

// Resolve cues for input text
const result = await resolver.resolve({
  text: 'Use ultrathink for better results',
  words: ['Use', 'ultrathink', 'for', 'better', 'results']
});

console.log(result.results);
// [
//   {
//     wordIndex: 1,
//     word: 'ultrathink',
//     alternatives: ['ultrathink', 'Tab', 'deep thinking'],
//     cueTip: 'Add ultrathink to prompt for max reasoning',
//     source: 'tips',
//     priority: 100
//   }
// ]
```

### Multiple Sources

```typescript
import { createResolver, buildSourcesFromConfig, discoverFolderConfigs, LocalCueSource } from '@opencues/core';

// Tips source (high priority, instant)
const tipsSource = new LocalCueSource(tipsData, { priority: 100 });

// Discover folder-based cue + blank configs under .cues/
const discovered = discoverFolderConfigs({ basePath: '.cues', readFile, readDir });

// buildSourcesFromConfig builds every LLM-backed CueSource (word-cues wrapped in one
// RoutedWordSourceGroup, plus BlankSource/FluidBlankSource/TransformBlankSource/...) from the
// discovered CuesMdConfig. `httpAdapter` is required; apiKeys/globalProvider/enable* flags are
// optional — see BuildSourcesOptions in sources/build-sources.ts for the full (much larger)
// options surface a production host actually threads through (per-bucket + per-feature LLM
// routing, disable lists, event callbacks, ...).
const configSources = buildSourcesFromConfig(discovered.cuesConfig, discovered.blanksConfig, {
  httpAdapter,
  apiKeys: { GROQ_API_KEY: process.env.GROQ_API_KEY },
  globalProvider: 'groq',
  enableWordCues: true,
  enableFluidBlank: true,
});

const resolver = createResolver([tipsSource, ...configSources]);

// Tips results come first (higher priority)
// LLM fills in gaps for words not in tips
const result = await resolver.resolve(context);
```

### Browser Usage (Chrome Extension)

In practice, chrome's actual integration goes through `@opencues/runtime`'s host-agnostic modules (see `integrations/chrome/`) rather than calling `@opencues/core` directly — but the underlying core API is the same one used everywhere:

```typescript
// Simplified — the real chrome bootstrap (opencues-bootstrap.ts) builds this via @opencues/runtime
import { createResolver, buildSourcesFromConfig, parseLocalCueFile, LocalCueSource } from '@opencues/core';

// Load tips and config (chrome reads from the synced bundle in chrome.storage.local,
// not the filesystem — see docs/features/chrome-sync.md)
const tipsData = parseLocalCueFile(tipsJson);
const discovered = discoverFolderConfigs({ basePath: '.cues', readFile, readDir });
const sources = buildSourcesFromConfig(discovered.cuesConfig, discovered.blanksConfig, {
  httpAdapter, apiKeys, globalProvider,
});
const resolver = createResolver([new LocalCueSource(tipsData), ...sources]);

// Use in content script
document.addEventListener('input', async (e) => {
  const text = (e.target as HTMLInputElement).value;
  const words = text.split(/\s+/);
  const result = await resolver.resolve({ text, words });
  showTooltips(result.results);
});
```

## Cue Source File Format

The cue source file supports two structures:

### Words Structure (per-word cue-tips)

```json
[
  {
    "id": "context-management",
    "words": {
      "/compact": {
        "tip": "Summarize history when 'context limit' warning appears",
        "alts": ["/clear", "/rewind"]
      },
      "/clear": {
        "tip": "Fresh start - clears context but keeps CLAUDE.md",
        "alts": ["/compact", "/rewind"]
      }
    }
  }
]
```

### Groups Structure (synonym groups)

```json
[
  {
    "id": "parallel-execution",
    "groups": [
      {
        "synonyms": ["agents", "sub-agents", "subagents", "parallel agents"],
        "tip": "Spawn parallel workers via Task tool",
        "alts": ["swarm", "background"]
      },
      {
        "synonyms": ["swarm", "team"],
        "tip": "Multiple coordinated agents working together",
        "alts": ["agents", "background"]
      }
    ]
  }
]
```

**Key Differences:**
- `words`: Each word has its own entry and tip
- `groups`: Synonyms share one entry; `alts` point to OTHER groups (different concepts)

## Multi-Domain Support

Configure multiple cue source files for different domains:

```typescript
const sources = [
  new LocalCueSource(claudeCodeTips, {
    id: 'claude-code-tips',
    domain: 'claude-code',
    priority: 100
  }),
  new LocalCueSource(opencodeTips, {
    id: 'opencode-tips',
    domain: 'opencode',
    priority: 100
  }),
  // Config-driven sources from .md files
  ...buildSourcesFromConfig(cuesCfg, blanksCfg, options)
];

const resolver = createResolver(sources);

// Only claude-code tips will match
const result = await resolver.resolve({
  text: 'Use ultrathink',
  words: ['Use', 'ultrathink'],
  domain: 'claude-code'
});
```

## Caching

The `LocalCueSource` can be combined with file watching for hot reload:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { discoverFolderConfigs, LocalCueSource } from '@opencues/core';

const cuesRoot = path.join(os.homedir(), '.cues');
const opts = { basePath: cuesRoot, readFile, readDir };
const source = new LocalCueSource(discoverFolderConfigs(opts).cuesConfig?.tips ?? []);

// Watch for changes
fs.watch(cuesRoot, { recursive: true }, () => {
  source.updateData(discoverFolderConfigs(opts).cuesConfig?.tips ?? []);
  console.log('Tips reloaded');
});
```

> The runtime's `ConfigLoader` already does this — host integrations should subscribe to its hot-reload notifications instead of writing their own watcher.

## Error Handling

The resolver continues on source errors by default:

```typescript
const resolver = new CueResolver(sources, {
  continueOnError: true,  // default
  timeout: 30000          // per-source timeout
});

const result = await resolver.resolve(context);

// Check for errors
for (const error of result.errors) {
  console.warn(`Source ${error.sourceId} failed: ${error.error}`);
}

// Metrics include timing and error info
for (const metric of result.metrics) {
  console.log(`${metric.sourceId}: ${metric.latencyMs}ms, ${metric.resultCount} results`);
}
```

## Adding Custom Sources

Implement the `CueSource` interface:

```typescript
class MyCustomSource implements CueSource {
  id = 'my-source';
  priority = 75;
  isCycleable = true;  // false if this source produces a single answer with no cycling

  supports(context: CueContext): boolean {
    return context.domain === 'my-domain';
  }

  async getCues(context: CueContext): Promise<CueSourceResult> {
    const startTime = Date.now();
    const results: CueResult[] = [];

    // Your custom logic here
    for (let i = 0; i < context.words.length; i++) {
      const word = context.words[i];
      const alts = await this.lookupAlternatives(word);
      if (alts.length > 0) {
        results.push({
          wordIndex: i,
          word,
          alternatives: [word, ...alts],
          source: this.id,
          priority: this.priority
        });
      }
    }

    return {
      results,
      timing: Date.now() - startTime
    };
  }

  private async lookupAlternatives(word: string): Promise<string[]> {
    // Your lookup logic
    return [];
  }
}
```

## Pure Function: lookupWord

For simple use cases, use the pure function directly:

```typescript
import { lookupWord, parseLocalCueFile, LocalCueData } from '@opencues/core';

const data: LocalCueData = parseLocalCueFile(jsonContent);

// Pure function lookup - no async, no I/O
const result = lookupWord('ultrathink', data);
if (result) {
  console.log(result.cueTip);       // "Add ultrathink to prompt..."
  console.log(result.alternatives); // ["ultrathink", "Tab", "deep thinking"]
  console.log(result.altCueTips);      // { ultrathink: "...", Tab: "...", ... }
}
```

## Integration with `@opencues/runtime`

`@opencues/core` is consumed by `@opencues/runtime`'s `Resolver` module. On host launch, the runtime's `ConfigLoader` parses `.md` configs and `Resolver.rebuildResolver` calls `buildSourcesFromConfig()` from core to construct sources:

- Word sources: each `cues/<name>/CUE.md` becomes its own `ConfigSource`; all wrapped in one `RoutedWordSourceGroup` that dispatches per-word.
- Blank sources: `BlankSource` (keyword-bound, 95) + `TransformBlankSource` (imperative pipeline, 93) + `FluidBlankSource` (free-form lookup, 92).
- The constructed resolver is held by `Resolver` and called on every text-change event (debounced ~500ms).

## Testing

Run the test suite:

```bash
cd ~/opencues
pnpm test                                # all packages via turbo
pnpm --filter @opencues/core test        # opencues-core only
pnpm --filter @opencues/runtime test     # runtime only
```

## Future Extensions

1. **VS Code Extension**: Use `@opencues/core` + `@opencues/runtime` with VS Code's decoration API for a new `HostAdapter`
2. **Web Application**: Build a new `HostAdapter` on `@opencues/runtime` for any web framework (the chrome extension under `integrations/chrome/`, which itself depends on both `@opencues/core` and `@opencues/runtime`, is the reference)
3. **Database Source**: Implement `CueSource` for database-backed cues
4. **Real-time Sync**: Use file watchers or WebSocket for live updates
5. **Analytics**: Track which cues are most useful via metrics
