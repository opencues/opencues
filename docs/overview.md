---
last_updated: 2026-04-01
---

# OpenCues Architecture

A system for real-time guidance as you type — providing alternatives, blanks, cue-tips, and cue-controls across any text input. See the [glossary](glossary.md) for all terminology.

For the full list of features any integration should implement, see `features/README.md`.

## Overview

OpenCues has three types of interaction: **Cues** (system indicates alternatives to the user), **Blanks** (user cues the system to fill in), and **Cue-Controls** (user triggers external actions like volume). All three share the same navigable system.

The architecture has two layers:

1. **Config Standard** (`cues.md`, `blanks.md`, `controls.md`) — Markdown files that define all prompts, modes, and behaviour. The standard is the protocol — integrations read these files.
2. **Core Library** (`cues-core`) — Pure TypeScript reference implementation. Parses config files, runs LLM sources, resolves results. No I/O or platform dependencies.

Integrations (Claude Code, future editors) use cues-core to load the config standard and provide the UI layer.


```
┌─────────────────────────────────────────────────────────────────┐
│                     CUES CORE (pure TypeScript)                 │
│  - CueSource interface                                          │
│  - CueResult interface                                          │
│  - CueResolver class (orchestrates sources)                     │
│  - No I/O, no platform dependencies                             │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ CUE SOURCES     │ │ CUE SOURCES     │ │ CUE SOURCES     │
│ LocalCueSource  │ │ ConfigSource    │ │ Classified      │
│ (loads JSON)    │ │ (from .md file) │ │ SourceGroup     │
└─────────────────┘ └─────────────────┘ └─────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ CLI ADAPTER     │ │ CHROME ADAPTER  │ │ VSCODE ADAPTER  │
│ - ANSI colors   │ │ - Tooltips      │ │ - Decorations   │
│ - Key handlers  │ │ - Content script│ │ - Hover provider│
│ - File triggers │ │ - chrome.storage│ │ - Commands      │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

## Installation

```bash
cd ~/opencues
npm install
npm run build
```

## Package Structure

```
~/opencues/
├── packages/
│   ├── cues-core/              # Pure TypeScript, no I/O
│   │   ├── src/
│   │   │   ├── types.ts        # Interfaces
│   │   │   ├── resolver.ts     # CueResolver
│   │   │   └── sources/
│   │   │       ├── local-cue-source.ts   # LocalCueSource
│   │   │       ├── config-source.ts     # ConfigSource (generic, config-driven)
│   │   │       ├── classified-source-group.ts # ClassifiedSourceGroup
│   │   │       ├── build-sources.ts     # buildSourcesFromConfig factory
│   │   │       └── parsers.ts           # Response parsers
│       └── dist/               # Compiled output
│
└── package.json                # Workspace root
```

## Core Interfaces

### CueResult

Result from a cue source for a single word:

```typescript
interface CueResult {
  wordIndex: number;        // Position in text (0-indexed)
  word: string;             // The actual word
  alternatives: string[];   // Original word at [0], then alternatives
  tip?: string;             // Hint text for status line
  altCueTips?: Record<string, string>;  // Per-alternative tips
  linked?: number[];        // Indices of words that cycle together
  source: string;           // 'tips' | 'grammar' | 'math'
  priority: number;         // Higher wins on merge
}
```

### CueContext

Context provided to sources for analysis:

```typescript
interface CueContext {
  text: string;                    // Full input text
  words: string[];                 // Text split into words
  domain?: string;                 // 'claude-code', 'medical', etc.
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
  supports(context: CueContext): boolean;
  getCues(context: CueContext): Promise<CueSourceResult>;
}
```

## Usage Examples

### Basic Usage (Node.js)

```typescript
import { CueResolver, LocalCueSource, parseLocalCueFile } from 'cues-core';
import * as fs from 'fs';

// Load tips from file
const tipsContent = fs.readFileSync('~/.claude/claude-code-tips.json', 'utf8');
const tipsData = parseLocalCueFile(tipsContent);

// Create resolver with tips source
const resolver = new CueResolver([
  new LocalCueSource(tipsData, { priority: 100 })
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
//     tip: 'Add ultrathink to prompt for max reasoning',
//     source: 'local',
//     priority: 100
//   }
// ]
```

### Multiple Sources

```typescript
import { createResolver, buildSourcesFromConfig, parseCuesMd, LocalCueSource } from 'cues-core';

// Tips source (high priority, instant)
const tipsSource = new LocalCueSource(tipsData, { priority: 100 });

// Config-driven sources from .md files
const cuesCfg = parseCuesMd(fs.readFileSync('cues.md', 'utf8'));
const blanksCfg = fs.existsSync('blanks.md') ? parseCuesMd(fs.readFileSync('blanks.md', 'utf8')) : undefined;
const configSources = buildSourcesFromConfig(cuesCfg, blanksCfg, {
  httpAdapter, endpoint, apiKey, defaultModel: 'openai/gpt-oss-120b',
});

const resolver = createResolver([tipsSource, ...configSources]);

// Tips results come first (higher priority)
// LLM fills in gaps for words not in tips
const result = await resolver.resolve(context);
```

### Browser Usage (Chrome Extension)

```typescript
// Browser integration example
import { createResolver, buildSourcesFromConfig, parseCuesMd, LocalCueSource } from 'cues-core';

// Load tips and config
const tipsData = parseLocalCueFile(tipsJson);
const cuesCfg = parseCuesMd(cuesMdContent);
const sources = buildSourcesFromConfig(cuesCfg, undefined, { httpAdapter, endpoint, apiKey, defaultModel });
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
  new LocalCueSource(medicalTips, {
    id: 'medical-tips',
    domain: 'medical',
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

const source = new LocalCueSource(initialData);

// Watch for changes
fs.watch('~/.claude/claude-code-tips.json', () => {
  const content = fs.readFileSync('~/.claude/claude-code-tips.json', 'utf8');
  const newData = parseLocalCueFile(content);
  source.updateData(newData);
  console.log('Tips reloaded');
});
```

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
import { lookupWord, parseLocalCueFile, LocalCueData } from 'cues-core';

const data: LocalCueData = parseLocalCueFile(jsonContent);

// Pure function lookup - no async, no I/O
const result = lookupWord('ultrathink', data);
if (result) {
  console.log(result.tip);          // "Add ultrathink to prompt..."
  console.log(result.alternatives); // ["ultrathink", "Tab", "deep thinking"]
  console.log(result.altCueTips);      // { ultrathink: "...", Tab: "...", ... }
}
```

## Integration with dynamicHighlight.ts

cues-core is used directly from the injected cli.js code (no shell scripts). The `writeCuesCoreInit` patch loads `.md` config files and builds all sources via `buildSourcesFromConfig()`:

```typescript
// In dynamicHighlight.ts writeCuesCoreInit:
// 1. Load tips file into LocalCueSource
// 2. Parse cues.md, blanks.md, controls.md
// 3. Create NodeHttpAdapter (keep-alive, Groq provider config)
// 4. buildSourcesFromConfig(cuesCfg, blanksCfg, options) → sources
//    - Word sources: combined into ONE ConfigSource (grammar + domain prompts merged)
//    - Blank sources: ClassifiedSourceGroup (classify → route to one mode)
// 5. createResolver([...sources]) → globalThis._cueResolver
```

> **HISTORICAL NOTE**: An earlier migration example showed wrapping cues-core inside `llm-analyze-auto.sh`. That script-based approach is no longer used; all calls are inline.

## Testing

Run the test suite:

```bash
cd ~/opencues/packages/cues-core
npm run build
npm run test
```

## Future Extensions

1. **VS Code Extension**: Use `cues-core` with VS Code decoration API
2. **Web Application**: Use `cues-core` directly with any web framework (the chrome extension under `integrations/chrome-extension/` is the reference)
3. **Database Source**: Implement `CueSource` for database-backed cues
4. **Real-time Sync**: Use file watchers or WebSocket for live updates
5. **Analytics**: Track which cues are most useful via metrics

## Migration from Existing System

The migration to cues-core is complete:

1. Existing cue source JSON format is fully supported
2. All LLM calls go through CueResolver + NodeHttpAdapter (no more bash scripts)
3. Output format matches existing `_dynDefs` structure
4. Classification via `ClassifiedSourceGroup` with fast heuristics + LLM fallback (no more wink-pos-tagger)
