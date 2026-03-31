---
last_updated: 2026-03-31
---

# Cues System Architecture

A modular system for providing word alternatives, tips, and suggestions across different platforms (CLI, Chrome extension, VS Code).

## Overview

The cues system is designed with three layers:

1. **Core Layer** (`cues-core`) - Pure TypeScript with no I/O dependencies
2. **Adapter Layer** (`cues-node`, `cues-browser`) - Platform-specific implementations
3. **Integration Layer** - Platform-specific UI and triggers

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
│ TipsFileSource  │ │ GroqSource      │ │ CustomSource    │
│ (loads JSON)    │ │ GeminiSource    │ │ (user-defined)  │
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
cd ~/cues-system
npm install
npm run build
```

## Package Structure

```
~/cues-system/
├── packages/
│   ├── cues-core/              # Pure TypeScript, no I/O
│   │   ├── src/
│   │   │   ├── types.ts        # Interfaces
│   │   │   ├── resolver.ts     # CueResolver
│   │   │   └── sources/
│   │   │       ├── tips-file.ts   # TipsFileSource
│   │   │       └── llm-base.ts    # LLM source classes
│   │   └── dist/               # Compiled output
│   │
│   ├── cues-node/              # Node.js adapters
│   │   ├── src/
│   │   │   ├── storage.ts      # NodeStorageAdapter
│   │   │   ├── http.ts         # NodeHttpAdapter
│   │   │   └── config.ts       # NodeConfigAdapter
│   │   └── dist/
│   │
│   └── cues-browser/           # Browser adapters
│       ├── src/
│       │   ├── storage.ts      # LocalStorage, ChromeStorage
│       │   ├── http.ts         # BrowserHttpAdapter (fetch)
│       │   └── config.ts       # BrowserConfigAdapter
│       └── dist/
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
  altTips?: Record<string, string>;  // Per-alternative tips
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
import { CueResolver, TipsFileSource, parseTipsFile } from 'cues-core';
import { NodeStorageAdapter } from 'cues-node';

// Load tips from file
const storage = new NodeStorageAdapter('~/.claude');
const tipsContent = await storage.read('claude-code-tips.json');
const tipsData = parseTipsFile(tipsContent!);

// Create resolver with tips source
const resolver = new CueResolver([
  new TipsFileSource(tipsData, { priority: 100 })
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
//     source: 'tips',
//     priority: 100
//   }
// ]
```

### Multiple Sources

```typescript
import { CueResolver, TipsFileSource, GroqSource } from 'cues-core';
import { NodeStorageAdapter, NodeHttpAdapter } from 'cues-node';

// Tips source (high priority, instant)
const tipsSource = new TipsFileSource(tipsData, { priority: 100 });

// LLM source (lower priority, slower but comprehensive)
const llmSource = new GroqSource({
  apiKey: process.env.GROQ_API_KEY!,
  model: 'gpt-oss-120b',
  systemPrompt: grammarPrompt,
  httpAdapter: new NodeHttpAdapter(),
  priority: 50
});

const resolver = new CueResolver([tipsSource, llmSource]);

// Tips results come first (higher priority)
// LLM fills in gaps for words not in tips
const result = await resolver.resolve(context);
```

### Browser Usage (Chrome Extension)

```typescript
import { CueResolver, TipsFileSource, parseTipsFile } from 'cues-browser';
import { ChromeStorageAdapter, BrowserHttpAdapter } from 'cues-browser';

// Load tips from chrome.storage
const storage = new ChromeStorageAdapter('sync');
const tipsContent = await storage.read('tips');
const tipsData = parseTipsFile(tipsContent!);

const resolver = new CueResolver([
  new TipsFileSource(tipsData)
]);

// Use in content script
document.addEventListener('input', async (e) => {
  const text = (e.target as HTMLInputElement).value;
  const words = text.split(/\s+/);
  const result = await resolver.resolve({ text, words });
  showTooltips(result.results);
});
```

## Tips File Format

The tips file supports two structures:

### Words Structure (per-word tips)

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

Configure multiple tips files for different domains:

```typescript
const sources = [
  new TipsFileSource(claudeCodeTips, {
    id: 'claude-code-tips',
    domain: 'claude-code',
    priority: 100
  }),
  new TipsFileSource(medicalTips, {
    id: 'medical-tips',
    domain: 'medical',
    priority: 100
  }),
  // LLM fallback for all domains
  new GroqSource({ ... })
];

const resolver = new CueResolver(sources);

// Only claude-code tips will match
const result = await resolver.resolve({
  text: 'Use ultrathink',
  words: ['Use', 'ultrathink'],
  domain: 'claude-code'
});
```

## Caching

The `TipsFileSource` can be combined with file watching for hot reload:

```typescript
import { NodeStorageAdapter } from 'cues-node';

const storage = new NodeStorageAdapter('~/.claude');
const source = new TipsFileSource(initialData);

// Watch for changes
storage.watch('claude-code-tips.json', (content) => {
  const newData = parseTipsFile(content);
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
import { lookupWord, parseTipsFile, TipsData } from 'cues-core';

const data: TipsData = parseTipsFile(jsonContent);

// Pure function lookup - no async, no I/O
const result = lookupWord('ultrathink', data);
if (result) {
  console.log(result.tip);          // "Add ultrathink to prompt..."
  console.log(result.alternatives); // ["ultrathink", "Tab", "deep thinking"]
  console.log(result.altTips);      // { ultrathink: "...", Tab: "...", ... }
}
```

## Integration with dynamicHighlight.ts

cues-core is now used directly from the injected cli.js code (no shell scripts). The `writeCuesCoreInit` patch initializes a CueResolver with TipsFileSource and GroqSource, and the NodeHttpAdapter handles all HTTPS calls inline:

```typescript
// In dynamicHighlight.ts writeCuesCoreInit:
// 1. Load tips file into TipsFileSource
// 2. Create NodeHttpAdapter (replaces _httpsAgent / _grammarPrompt globals)
// 3. Create GroqSource with NodeHttpAdapter
// 4. Create CueResolver with [TipsFileSource, GroqSource]
// 5. Store as globalThis._cueResolver
```

> **HISTORICAL NOTE**: An earlier migration example showed wrapping cues-core inside `llm-analyze-auto.sh`. That script-based approach is no longer used; all calls are inline.

## Testing

Run the test suite:

```bash
cd ~/cues-system/packages/cues-core
npm run build
npm run test
```

## Future Extensions

1. **VS Code Extension**: Use `cues-core` with VS Code decoration API
2. **Web Application**: Use `cues-browser` with any web framework
3. **Database Source**: Implement `CueSource` for database-backed tips
4. **Real-time Sync**: Use file watchers or WebSocket for live updates
5. **Analytics**: Track which cues are most useful via metrics

## Migration from Existing System

The migration to cues-core is complete:

1. Existing tips JSON format is fully supported
2. All LLM calls go through CueResolver + NodeHttpAdapter (no more bash scripts)
3. Output format matches existing `_dynDefs` structure
4. Classification via cues-core's `looksLikeMath`/`looksLikeFactual` (no more wink-pos-tagger)
