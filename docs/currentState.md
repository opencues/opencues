# cues-core: Current State

**Last Updated:** 2026-03-24

## Overview

cues-core is a TypeScript library providing word cues (tips, alternatives, computed values) for text input systems. It's designed to be platform-agnostic and usable in CLI tools, browser extensions, and IDE plugins.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           cues-core                                      │
│                                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │ TipsFile    │  │ Grammar     │  │ Math        │  │ Factual     │    │
│  │ Source      │  │ Source      │  │ Source      │  │ Source      │    │
│  │ (instant)   │  │ (LLM)       │  │ (LLM+eval)  │  │ (LLM)       │    │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘    │
│         │                │                │                │            │
│         └────────────────┴────────────────┴────────────────┘            │
│                                   │                                      │
│                          ┌────────▼────────┐                            │
│                          │   CueResolver   │                            │
│                          │  (orchestrates) │                            │
│                          └─────────────────┘                            │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                         Prompts                                  │   │
│  │  CLASSIFIER_PROMPT | GRAMMAR_PROMPT | MATH_PROMPT | FACTUAL_... │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                        Utilities                                 │   │
│  │  ModeClassifier | looksLikeMath | looksLikeFactual | evaluateMath│   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

## Exports (26 total)

### Tips Lookup (Instant, No LLM)
```typescript
parseTipsFile(content: string): TipsData
buildLookupMap(data: TipsData): Map<string, TipsLookupResult>
lookupWord(word: string, data: TipsData): TipsLookupResult | null
lookupMultiple(words: string[], map: Map, options?): LookupMultipleResult
formatAsWordDefs(found: WordDef[], allWords: string[]): WordDef[]
mergeWordDefs(existing: WordDef[], newDefs: WordDef[]): WordDef[]
validateTipsData(data: unknown): string[]
TipsFileSource  // Class implementing CueSource
```

### LLM Sources
```typescript
GrammarSource   // Word alternatives (synonyms, opposites, creative)
MathSource      // Compute expressions, return numeric values
FactualSource   // Answer knowledge questions
GroqSource      // Generic Groq API wrapper
GeminiSource    // Generic Gemini API wrapper
LLMSourceBase   // Abstract base class
```

### Classifier
```typescript
ModeClassifier          // Determines MATH | FACTUAL | GRAMMAR for blanks
looksLikeMath(text)     // Quick heuristic (no LLM)
looksLikeFactual(text)  // Quick heuristic (no LLM)
```

### Prompts
```typescript
CLASSIFIER_PROMPT      // Mode classification
GRAMMAR_PROMPT         // Word alternatives (no blanks)
BLANK_GRAMMAR_PROMPT   // Fill-in-the-blank
MATH_PROMPT            // COMPUTE=expression
FACTUAL_PROMPT         // ANSWER=value
```

### Utilities
```typescript
evaluateMath(expr: string): number | null  // Safe math evaluation
CueResolver             // Orchestrates multiple sources
createResolver(config)  // Factory function
```

## Test Results

```
cues-core Integration Tests: 27 passed, 0 failed
cues-core Modes Tests:       23 passed, 0 failed
─────────────────────────────────────────────────
Total:                       50 passed, 0 failed
```

## Performance

| Operation | Latency |
|-----------|---------|
| Tips map build | 0.31ms |
| Tips lookup (10 words) | 0.0004ms |
| Speedup vs linear | 106-178x |

## Integration Status

### tweakcc (Claude Code CLI)

| Component | Uses cues-core? | Notes |
|-----------|-----------------|-------|
| Tips lookup | ✅ Yes | `buildLookupMap`, `lookupMultiple`, etc. |
| GRAMMAR mode | ❌ No | Still uses shell script |
| MATH mode | ❌ No | Still uses shell script |
| FACTUAL mode | ❌ No | Still uses shell script |
| Classifier | ❌ No | Still uses shell script |

**Why shell scripts still exist:**
- tweakcc injects synchronous code into Claude Code
- LLM calls are async (need Promises)
- Shell script acts as async-to-file bridge
- Patch polls for JSON file result

```
Current flow:
  tweakcc patch → spawn bash → llm-analyze-auto.sh → curl API → write JSON
                                                              ↓
  tweakcc patch ← poll file ← JSON result ←──────────────────┘

Ideal flow (future):
  tweakcc patch → cues-core.GrammarSource.getCues() → result
```

### Chrome Extension (Future)

Can use cues-core directly since browser handles async natively:

```typescript
import { buildLookupMap, GrammarSource, MathSource } from 'cues-core';

// Tips (instant)
const tipsMap = buildLookupMap(parseTipsFile(bundledJson));
const result = lookupMultiple(words, tipsMap);

// LLM (async, no shell script needed)
const grammar = new GrammarSource({ httpAdapter: fetch, ... });
const cues = await grammar.getCues({ text, words });
```

### VS Code Extension (Future)

Same as Chrome - can use cues-core directly with async/await.

## File Locations

```
cues-core source:
  /home/wilfred/cues-system/packages/cues-core/src/

cues-core installed:
  ~/.claude/node_modules/cues-core/

Shell scripts (still used by tweakcc):
  ~/.claude/llm-analyze-auto.sh (559 lines)
  ~/.claude/llm-analyze.sh

Prompts (original, now also in cues-core):
  /home/wilfred/tweakcc/system_prompts/*.txt

Tips data:
  ~/.claude/claude-code-tips.json (38 sections, 139 keys)
```

## Next Steps

1. **Test current system** - Verify tweakcc + cues-core works end-to-end
2. **Remove shell script dependency** - Make tweakcc call cues-core directly
3. **Add browser adapter** - `cues-browser` package with fetch-based HTTP
4. **Build Chrome extension** - Use cues-core for real-time tips

## How to Update

### Update cues-core
```bash
cd /home/wilfred/cues-system/packages/cues-core
# Edit src/*.ts
npm run build
cp -r dist/* ~/.claude/node_modules/cues-core/
```

### Update tweakcc
```bash
cd /home/wilfred/tweakcc-source
# Edit src/patches/*.ts
npm run build
node dist/index.mjs --apply
node --check ~/.claude/local/node_modules/@anthropic-ai/integrations/claude-code/cli.js
```

### Run tests
```bash
node /home/wilfred/tweakcc/tests/test-cues-core-integration.js
node /home/wilfred/tweakcc/tests/test-cues-modes.js
```
