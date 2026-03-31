---
last_updated: 2026-03-31
---

# Cues System Architecture

A modular system for providing word alternatives, tips, and suggestions across different platforms (CLI, Chrome extension, VS Code).

## Feature Concepts

These are the core features any integration should implement. The concepts are platform-agnostic — each integration provides its own UI for them.

### Word Navigation

Move between words in the input. The user selects which word to focus on.

- **Navigation modes**: numbers only, all words, gender roots, or combined
- **Direction**: typically left/right through the text
- The integration decides the UI (keyboard shortcuts, click, hover, etc.)

### Word Cycling

Replace the focused word with an alternative. Sources provide alternatives via cues-core.

- **Up/Down** or equivalent to cycle through the `alts` array
- `currentAltIndex` tracks position in the cycle
- Original word is always `alts[0]`

**Number increment/decrement:**
- Numbers cycle differently — Up increments by 1, Down decrements by 1
- Each number has a **floor** (the original value before first edit)
- Down never goes below the floor; each number tracks its floor independently

**Gender cycling:**
- Gender root words (boy/girl) use hardcoded linked groups instead of LLM alts
- **Case preservation**: character-by-character (He→She, HIM→HER, Boy→Girl)
- Down restores ALL words to original gender (not just the selected word)

### Visual States

Words need three visual states:

| State | Meaning | Claude Code example |
|-------|---------|-------------------|
| **Normal** | No alternatives | Default text |
| **Dimmed** | Has alternatives available | Dark gray |
| **Highlighted** | Currently selected for cycling | Bold white |

### Cursor Position Preservation

When words change length (cycling, gender flip, number increment), the cursor position must adjust:

- Replacement before cursor → offset adjusts by length difference
- Replacement after cursor → offset unchanged
- Cursor at end of text → stays at end

### Linked Words

Some words must change together. When "boy" cycles to "girl", linked words like "he"→"she" and "his"→"her" must also change.

- `linked` array on each word definition contains indices of linked words
- All linked words cycle to the same `currentAltIndex`
- Gender groups are a common case: boy/girl/he/she/him/her/his/her/man/woman

### Tips

Per-word hint text from a local JSON file (`claude-code-tips.json`). Instant (~0ms), no LLM call.

- Each word can have a `tip` string and `altTips` (per-alternative tips)
- Tips are shown in a secondary display (status line, tooltip, hover, etc.)
- Words are organised into concepts with groups (synonyms) and alts (related concepts)

### LLM Alternatives

For words not in the tips file, an LLM generates alternatives:

- **GrammarSource** — synonym, opposite, creative (priority 50)
- **MathSource** — evaluates expressions like `4*12=_` → `48` (priority 90)
- **FactualSource** — answers questions like `capital of France is _` → `Paris` (priority 90)
- Higher priority sources win when both provide alts for the same word

### Fill-in-the-Blank

Typing `_` (underscore) creates a blank that the LLM fills contextually.

- Context around the blank determines word type (see `docs/blank-position-detection.md`)
- Classification routes to correct source: math, factual, or grammar
- Alts always include `_` as first entry so user can cycle back to blank
- **Context invalidation**: changing words around the blank clears stale alts and re-analyses

### Multi-Word Spans

An alternative can be multiple words (e.g., "toy" → "stuffed animal").

- Span tracking maps each word of the replacement back to the original index
- All span words cycle as a unit
- Navigation skips non-original span positions

### Per-Word Clearing

When the user edits text, alternatives are preserved intelligently:

- Word changes to something IN alts → update index (valid cycle)
- Word changes to something NOT in alts → clear that word's alts only
- Word count changes → clear affected positions, re-analyse
- Typing recovery: "dog"→"do"→"dog" restores alts (never deleted during same-count edits)

### Action Words

Special words that trigger external actions instead of cycling.

- Checked first before any other cycling logic
- The word is NOT modified — it triggers a side effect (script, command, API call)
- Example: "volume" triggers system volume change

### Auto-Submit Trigger

Analysis fires automatically as the user types, not on explicit submit.

- **Tier 1**: Space typed (50ms debounce) — completed word
- **Tier 2**: 300ms pause — final word with no trailing space
- **Tier 3**: Word edited mid-sentence (50ms) — re-analyse changed word
- **Targeted optimisation**: only send words lacking alts to the LLM (subsequent triggers skip words that already have valid alternatives)
- **Duplicate prevention**: a pending flag prevents overlapping LLM requests

### Cursor State Export

Export the current cursor position and context for external tools.

- Current text, cursor offset, current word, whether at end
- Debounced writes (~100ms) to avoid I/O overhead
- Enables external tools to react to cursor position

### Status Display

Secondary display showing info about the highlighted word:

- Current word + position in cycle (e.g., "agents 1/3")
- Tip text if available
- Per-alt tip when cycling
- The integration decides where this appears (status bar, tooltip, panel, etc.)

---

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
