# Cues System Integration with TweakCC

## Executive Summary

The cues-core system provides **fast local lookup** (~0.3ms) for words explicitly in the tips file, while the existing LLM-based system provides **semantic understanding** (~200-600ms) for all words. The two systems are complementary, not replacements.

## Benchmark Results

### Performance Comparison

| Metric | Current LLM System | Cues-Core | Improvement |
|--------|-------------------|-----------|-------------|
| **Latency (avg)** | 200-600ms | 0.292ms | ~1000x faster |
| **Latency (p99)** | ~800ms | 1.3ms | ~600x faster |
| **API Calls** | Yes (Groq/Gemini) | None | No network |
| **API Cost** | ~$0.0001/call | $0 | Free |
| **Coverage** | 94% accuracy | 50.9% | LLM wins |
| **Semantic Match** | Yes | No | LLM wins |

### Detailed Timing

```
Cues-Core Direct Lookup:
  Per lookup: 19.6µs
  Lookups/sec: 50,994
  1000 lookups: 470ms

CueResolver (with overhead):
  Per lookup: 292µs
  Lookups/sec: 3,425
```

### Coverage Analysis

**Words Found by Cues-Core (50.9%):**
- Exact matches: ultrathink, Tab, /compact, agents, swarm, background
- Synonyms: sub-agents, subagents (via groups)
- Multi-word: "deep thinking", "think harder"

**Words Only Found by LLM (43.1%):**
- Semantic: refactor → plan mode
- Semantic: stuck → rewind/debug
- Semantic: parallel → parallel agents
- Semantic: crashing → bug/error handling
- Contextual: "this is hard" → opus model

## Architecture Integration

```
┌─────────────────────────────────────────────────────────────────┐
│                    TweakCC Dynamic Highlight                     │
│                                                                  │
│  ┌──────────────────┐    ┌──────────────────────────────────┐  │
│  │  llm-analyze-    │    │         Claude Code CLI          │  │
│  │  auto.sh         │    │                                  │  │
│  │                  │    │  ┌────────────────────────────┐  │  │
│  │  1. Read input   │    │  │   dynamicHighlight.ts      │  │  │
│  │  2. Check cache  │───▶│  │   - Spawns script          │  │  │
│  │  3. Call LLM     │    │  │   - Polls for JSON         │  │  │
│  │  4. Write JSON   │    │  │   - Updates _dynDefs       │  │  │
│  │                  │    │  │   - Triggers UI refresh    │  │  │
│  └──────────────────┘    │  └────────────────────────────┘  │  │
│           │              │               │                   │  │
│           │              │               ▼                   │  │
│           │              │  ┌────────────────────────────┐  │  │
│           │              │  │   wordHighlight.ts         │  │  │
│           │              │  │   - Renders dim/highlight  │  │  │
│           │              │  │   - Handles Ctrl+Alt keys  │  │  │
│           │              │  │   - Cycles alternatives    │  │  │
│           │              │  └────────────────────────────┘  │  │
│           │              └──────────────────────────────────┘  │
│           │                                                     │
│           │  ┌──────────────────────────────────────────────┐  │
│           │  │              cues-core                        │  │
│           │  │                                               │  │
│           │  │  ┌─────────────────────────────────────────┐ │  │
│           └──│──│ TipsFileSource                          │ │  │
│              │  │   - lookupWord() (~20µs)                │ │  │
│              │  │   - Exact + synonym matching            │ │  │
│              │  │   - Per-word tips                       │ │  │
│              │  └─────────────────────────────────────────┘ │  │
│              │                      │                        │  │
│              │                      ▼                        │  │
│              │  ┌─────────────────────────────────────────┐ │  │
│              │  │ CueResolver                             │ │  │
│              │  │   - Priority-based merging              │ │  │
│              │  │   - Multiple source support             │ │  │
│              │  └─────────────────────────────────────────┘ │  │
│              └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Integration Points

### Current Integration (llm-analyze-auto.sh)

The shell script currently:
1. Reads input text
2. Checks tips file for known words (inline JS)
3. Calls LLM for remaining words
4. Merges results
5. Writes JSON output

**Location:** `~/.claude/llm-analyze-auto.sh` lines 70-100

### Proposed Integration

Replace inline JS with cues-core:

```bash
# Before (inline JS in shell script)
TIPS_RESULT=$(node -e "
  const data = require('$TIPS_FILE');
  // ... 30 lines of lookup logic
")

# After (cues-core module)
TIPS_RESULT=$(node -e "
  const { lookupWords, parseTipsFile } = require('cues-core');
  const data = parseTipsFile(fs.readFileSync('$TIPS_FILE', 'utf8'));
  console.log(JSON.stringify(lookupWords(words, data)));
")
```

### Benefits of Integration

| Benefit | Description |
|---------|-------------|
| **Maintainability** | Logic in TypeScript, not embedded JS in bash |
| **Testability** | Unit tests for lookupWord() function |
| **Reusability** | Same code for CLI, Chrome extension, VS Code |
| **Type Safety** | TypeScript interfaces catch errors |
| **Performance** | Pure function, no I/O in hot path |

## Migration Path

### Phase 1: Parallel Operation (Current)

```
Input → llm-analyze-auto.sh → [Tips lookup (inline)] + [LLM call] → JSON
         ↓
Input → cues-core → [TipsFileSource] → CueResult[]  (standalone test)
```

### Phase 2: Integrated Operation (Next)

```
Input → llm-analyze-auto.sh → [cues-core TipsFileSource] + [LLM call] → JSON
```

Changes required:
1. Add cues-core to `~/.claude/node_modules/`
2. Update llm-analyze-auto.sh to import cues-core
3. Keep LLM fallback for semantic matching

### Phase 3: Full CueResolver (Future)

```
Input → CueResolver → [TipsFileSource(100)] → [GroqSource(50)] → merged results
```

Benefits:
- Single entry point
- Priority-based merging built-in
- Timeout and error handling
- Metrics collection

## Configuration

### Current TweakCC Config

```typescript
// ~/.tweakcc/config.json → settings.misc
{
  enableDynamicHighlight: true,
  dynamicHighlightAutoSubmit: true,
  dynamicHighlightDebounceMs: 500,
  tipsSources: [
    { path: '~/.claude/claude-code-tips.json', domain: 'claude-code', enabled: true }
  ]
}
```

### Multi-Domain Support

```typescript
tipsSources: [
  { path: '~/.claude/claude-code-tips.json', domain: 'claude-code', enabled: true },
  { path: '~/.claude/medical-tips.json', domain: 'medical', enabled: true },
  { path: '~/.claude/legal-tips.json', domain: 'legal', enabled: false }
]
```

## Key Differences

### Semantic vs Exact Matching

| Input | Cues-Core | LLM | Why Different |
|-------|-----------|-----|---------------|
| "ultrathink" | ✓ Found | ✓ Found | Exact match in tips |
| "refactor" | ✗ Not found | ✓ plan mode | Semantic: refactor = risky change |
| "stuck" | ✗ Not found | ✓ rewind | Semantic: stuck = need undo |
| "crashing" | ✗ Not found | ✓ debug | Semantic: crashing = bug |
| "parallel" | ✗ Not found | ✓ agents | Semantic: parallel = spawn agents |

### When to Use Each

| Use Case | Recommendation |
|----------|----------------|
| Known tip words | cues-core (~0.3ms) |
| Natural language | LLM (~200ms) |
| Offline operation | cues-core only |
| High accuracy needed | LLM + cues-core |
| Browser extension | cues-core only (no API key) |

## Conclusion

The cues-core system is a **complementary layer**, not a replacement for the LLM-based hints. The optimal architecture uses both:

1. **Fast path (cues-core):** Instant results for known tip words
2. **Slow path (LLM):** Semantic matching for natural language

This hybrid approach provides:
- 50% of lookups resolved in <1ms (no LLM call needed)
- Remaining 50% resolved via LLM with semantic understanding
- Average latency reduced from ~400ms to ~200ms
- API costs reduced by ~50%

## Files Modified

| File | Change |
|------|--------|
| `~/.tweakcc/config.json` | Add `tipsSources` config |
| `/home/wilfred/tweakcc-source/src/types.ts` | Add `tipsSources` type |
| `/home/wilfred/tweakcc-source/src/defaultSettings.ts` | Add default tips sources |
| `~/.claude/llm-analyze-auto.sh` | Import cues-core (future) |
