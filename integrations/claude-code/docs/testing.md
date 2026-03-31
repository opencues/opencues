# cues-core Testing Documentation

**Last tested:** 2026-03-24
**All tests:** PASSED (27/27)

## Test Suite Location

```
/home/wilfred/tweakcc/tests/test-cues-core-integration.js
/home/wilfred/tweakcc/tests/benchmark-tips-lookup.js
```

## Test Results

### Unit Tests (27 tests)

```
--- parseTipsFile ---
✓ parseTipsFile returns array
✓ parseTipsFile has sections with id

--- buildLookupMap ---
✓ buildLookupMap returns Map
✓ buildLookupMap has keys
✓ buildLookupMap keys are lowercase
✓ buildLookupMap values have required fields
✓ buildLookupMap synonym groups share result

--- lookupMultiple ---
✓ lookupMultiple returns found and missingIndices
✓ lookupMultiple finds known words
✓ lookupMultiple tracks missing words
✓ lookupMultiple skipPattern works
✓ lookupMultiple found items have correct index

--- formatAsWordDefs ---
✓ formatAsWordDefs returns all words
✓ formatAsWordDefs found words have alts
✓ formatAsWordDefs unfound words have null alts
✓ formatAsWordDefs preserves order

--- mergeWordDefs ---
✓ mergeWordDefs adds new defs
✓ mergeWordDefs preserves existing alts
✓ mergeWordDefs fills missing alts
✓ mergeWordDefs does not mutate existing

--- Integration Scenarios ---
✓ Tips-only sentence: all words found, skip LLM
✓ Mixed sentence: some words found, call LLM
✓ Underscore sentence: blank skipped, call LLM
✓ Full flow: lookup -> format -> ready for UI

--- Performance ---
✓ buildLookupMap completes in < 5ms
✓ lookupMultiple 10 words completes in < 0.1ms
✓ formatAsWordDefs 10 words completes in < 0.1ms
```

### Performance Benchmark

| Test Case | O(n×m) Linear | O(1) Hash Map | Speedup |
|-----------|---------------|---------------|---------|
| 5 words | 0.0105ms | 0.0006ms | **18x** |
| 10 words | 0.0440ms | 0.0004ms | **106x** |
| 20 words | 0.0830ms | 0.0005ms | **178x** |
| 50 words | 0.2508ms | 0.0040ms | **62x** |
| 100 words | 0.5373ms | 0.0030ms | **178x** |

**Map build time:** 0.67ms (one-time at startup)

## Integration Verification

```bash
# Verify patched cli.js syntax
node --check ~/.claude/local/node_modules/@anthropic-ai/integrations/claude-code/cli.js
# ✓ Syntax valid

# Verify cues-core functions are called
grep -c 'buildLookupMap\|lookupMultiple\|formatAsWordDefs\|mergeWordDefs' cli.js
# 4 (all functions present)
```

## How to Run Tests

```bash
# Run unit tests
node /home/wilfred/tweakcc/tests/test-cues-core-integration.js

# Run performance benchmark
node /home/wilfred/tweakcc/tests/benchmark-tips-lookup.js

# Verify cli.js after patching
cd /home/wilfred/tweakcc-source
npm run build
node dist/index.mjs --apply
node --check ~/.claude/local/node_modules/@anthropic-ai/integrations/claude-code/cli.js
```

## Test Coverage

| Function | Unit Tests | Integration Tests | Performance Tests |
|----------|------------|-------------------|-------------------|
| `parseTipsFile` | 2 | - | - |
| `buildLookupMap` | 5 | 1 | 1 |
| `lookupMultiple` | 5 | 3 | 1 |
| `formatAsWordDefs` | 4 | 1 | 1 |
| `mergeWordDefs` | 4 | - | - |

## Known Limitations

1. Tests use the actual tips file (`~/.claude/claude-code-tips.json`)
2. Performance depends on tips file size (currently 133 entries)
3. Tests don't cover error cases (malformed JSON, missing file)
