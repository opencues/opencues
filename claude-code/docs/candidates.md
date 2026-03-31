---
last_updated: 2026-03-31
---

# Output Token Optimization Candidates

> **HISTORICAL NOTE**: The script references (`llm-analyze.sh`, `llm-analyze-compact.sh`) and curl-based examples in this document are from the pre-cues-core era. LLM calls now go through cues-core's CueResolver and NodeHttpAdapter. The output format analysis and cost findings remain valid.

Strategies to reduce LLM output tokens for word analysis.

## Problem Statement

**Current cost breakdown:**
- Input: ~300 tokens × $0.125/1M = $0.0000375
- Output: ~200 tokens × $0.50/1M = $0.0001000
- **Output is 73% of cost despite being fewer tokens**

**Goal:** Reduce output tokens by 50-90% while maintaining parseability.

---

## Candidate A: Current JSON (Baseline)

### Prompt
```
Return JSON with word analysis...
```

### Output (~200 tokens)
```json
{
  "priority": 1,
  "sentence": "The boy said he was happy",
  "words": [
    {"index": 0, "word": "The", "alts": null, "linked": null},
    {"index": 1, "word": "boy", "alts": ["boy", "girl", "child"], "linked": [3], "currentAltIndex": 0},
    {"index": 2, "word": "said", "alts": null, "linked": null},
    {"index": 3, "word": "he", "alts": ["he", "she"], "linked": [1], "currentAltIndex": 0},
    {"index": 4, "word": "was", "alts": null, "linked": null},
    {"index": 5, "word": "happy", "alts": ["happy", "sad", "content"], "linked": null, "currentAltIndex": 0}
  ]
}
```

### Pros
- Easy to parse
- Self-documenting
- LLMs naturally produce JSON

### Cons
- Verbose
- Repeats sentence
- Includes null values
- Includes original word in alts

### Cost
- Output: ~200 tokens = $0.0001000
- **Baseline**

---

## Candidate B: Compact JSON

### Prompt
```
Return compact JSON. Only include words with alternatives.
Format: {"w":[[index,"alt1","alt2"],[index,"alt1",">linkedIdx"]]}
Skip words without alternatives.
```

### Output (~50 tokens)
```json
{"w":[[1,"girl","child",">3"],[3,"she",">1"],[5,"sad","content"]]}
```

### Parsing Logic
```javascript
function parse(compact, words) {
  const result = words.map((w, i) => ({index: i, word: w, alts: null, linked: null}));
  compact.w.forEach(entry => {
    const [idx, ...rest] = entry;
    const alts = [words[idx]]; // Original word
    const linked = [];
    rest.forEach(v => {
      if (typeof v === 'string' && v.startsWith('>')) {
        linked.push(parseInt(v.slice(1)));
      } else {
        alts.push(v);
      }
    });
    result[idx].alts = alts;
    result[idx].linked = linked.length ? linked : null;
    result[idx].currentAltIndex = 0;
  });
  return result;
}
```

### Pros
- Still JSON (easy to parse)
- ~75% smaller
- Only includes meaningful data

### Cons
- Requires post-processing
- LLM might struggle with format

### Cost
- Output: ~50 tokens = $0.000025
- **75% savings**

---

## Candidate C: Pipe-Delimited

### Prompt
```
Return ONLY alternatives in this format:
INDEX:alt1,alt2>LINKED|INDEX:alt1,alt2

Example: 1:girl,child>3|3:she>1|5:sad,content

Rules:
- INDEX = word position (0-based)
- Only list alternatives (not original word)
- >N means linked to word N
- | separates entries
- Skip words without alternatives
```

### Output (~30 tokens)
```
1:girl,child>3|3:she>1|5:sad,content
```

### Parsing Logic
```javascript
function parse(encoded, words) {
  const result = words.map((w, i) => ({index: i, word: w, alts: null, linked: null}));
  if (!encoded.trim()) return result;

  encoded.split('|').forEach(entry => {
    const [idxPart, rest] = entry.split(':');
    const idx = parseInt(idxPart);
    const alts = [words[idx]]; // Original word first
    const linked = [];

    rest.split(',').forEach(v => {
      if (v.includes('>')) {
        const [alt, link] = v.split('>');
        if (alt) alts.push(alt);
        linked.push(parseInt(link));
      } else {
        alts.push(v);
      }
    });

    result[idx].alts = alts;
    result[idx].linked = linked.length ? linked : null;
    result[idx].currentAltIndex = 0;
  });
  return result;
}
```

### Pros
- Very compact
- Human readable
- Easy to validate

### Cons
- Non-standard format
- LLM needs clear instructions
- Edge cases (commas in words?)

### Cost
- Output: ~30 tokens = $0.000015
- **85% savings**

---

## Candidate D: Ultra-Compact (First Letter Codes)

### Prompt
```
Return alternatives as first-letter codes.
Format: INDEX:CODE1,CODE2>LINKED

Example input: "The boy said he was happy"
Example output: 1:G,C>3|3:S>1|5:S,C

G=girl, C=child, S=she/sad, C=content
Only return the encoded string, nothing else.
```

### Output (~20 tokens)
```
1:G,C>3|3:S>1|5:S,C
```

### Parsing Logic
Requires predefined mappings or context-aware expansion:
```javascript
const COMMON_ALTS = {
  'boy': {G: 'girl', C: 'child', M: 'man'},
  'girl': {B: 'boy', C: 'child', W: 'woman'},
  'he': {S: 'she', T: 'they'},
  'she': {H: 'he', T: 'they'},
  'happy': {S: 'sad', C: 'content', J: 'joyful'},
  // ... etc
};
```

### Pros
- Minimal tokens
- Deterministic expansion

### Cons
- Requires predefined dictionary
- Ambiguity (S = she or sad?)
- Less flexible

### Cost
- Output: ~20 tokens = $0.000010
- **90% savings**

---

## Candidate E: Index-Only (Words in Input)

### Prompt
```
You will analyze: "The boy said he was happy"
Words: [0:The, 1:boy, 2:said, 3:he, 4:was, 5:happy]

For each word with alternatives, return:
INDEX:ALT_WORDS>LINKED

Where ALT_WORDS are the alternative words (not codes).
Return ONLY the encoded string.
```

### Output (~25 tokens)
```
1:girl,child>3|3:she>1|5:sad,content
```

### Key Insight
We already send the words in input, so:
- Input includes word list (we pay input token cost anyway)
- Output only needs indices + alternatives
- No need to repeat sentence or original words

### Pros
- Leverages input tokens (cheaper)
- Clear format
- No dictionary needed

### Cons
- Slightly longer input prompt
- Still need to parse

### Cost
- Input: +20 tokens = $0.0000025
- Output: ~25 tokens = $0.0000125
- **Net 85% savings on output**

---

## Candidate F: Hybrid (Numbered Alternatives)

### Prompt
```
Common alternatives:
1=girl 2=boy 3=child 4=man 5=woman
6=he 7=she 8=they
9=happy 10=sad 11=content 12=angry

Analyze: "The boy said he was happy"
Return: INDEX:ALT_NUMS>LINKED

Example: 1:1,3>3|3:7>1|5:10,11
```

### Output (~15 tokens)
```
1:1,3>3|3:7>1|5:10,11
```

### Parsing Logic
```javascript
const ALT_MAP = {1:'girl',2:'boy',3:'child',...};
// Parse and expand numbers to words
```

### Pros
- Extremely compact
- Consistent encoding

### Cons
- Requires shared dictionary
- Limited to predefined alternatives
- Complex prompt setup

### Cost
- Input: +50 tokens for dictionary
- Output: ~15 tokens = $0.0000075
- **92% savings on output (but more input)**

---

## Candidate G: Binary Flags + Separate Query

### Approach
Two-phase:
1. First query: "Which words have alternatives?" → `010010` (binary)
2. Second query: For each flagged word, get alternatives

### Phase 1 Output
```
010010
```

### Pros
- Minimal first query
- Can skip second query if no alternatives

### Cons
- Two API calls
- More complex logic
- Latency doubled

### Cost
- Depends on alternative density
- Best case (no alts): ~5 tokens
- Worst case: More expensive than single call

---

## Comparison Matrix

| Candidate | Output Tokens | Output Cost | Savings | Parse Complexity | LLM Reliability |
|-----------|---------------|-------------|---------|------------------|-----------------|
| A: Full JSON | 200 | $0.000100 | 0% | Easy | High |
| B: Compact JSON | 50 | $0.000025 | 75% | Easy | Medium |
| C: Pipe-delimited | 30 | $0.000015 | 85% | Medium | Medium |
| D: First-letter | 20 | $0.000010 | 90% | Hard | Low |
| E: Index-only | 25 | $0.000013 | 87% | Medium | High |
| F: Numbered alts | 15 | $0.000008 | 92% | Medium | Medium |
| G: Binary flags | 5-50 | Variable | Variable | Hard | Medium |

---

## Recommended Test Order

1. **Candidate C (Pipe-delimited)** - Best balance of savings vs reliability
2. **Candidate E (Index-only)** - Similar but clearer format
3. **Candidate B (Compact JSON)** - Fallback if custom formats fail

---

## Test Sentences

```
1. "The boy ran quickly"
2. "She said hello to her friend"
3. "The happy man walked slowly to the big store"
4. "He told him that his brother was waiting"
5. "The girl whispered softly"
```

---

## Benchmark Metrics

For each candidate, measure:
1. **Token count** (input + output)
2. **Parse success rate** (3 runs per sentence)
3. **Latency** (seconds)
4. **Quality** (correct alternatives identified)
5. **Cost per request**

---

## Benchmark Results (Feb 2026)

Tested with Gemini 2.0 Flash on 5 sentences:

| Candidate | Avg Input | Avg Output | Latency | Success | Cost |
|-----------|-----------|------------|---------|---------|------|
| A: Full JSON | 134 | 131 | 1.59s | 100% | $0.000082 |
| B: Compact JSON | 81 | 19 | 0.93s | 100% | $0.000020 |
| C: Pipe-delimited | 100 | 6 | 0.83s | 100% | $0.000016 |
| D: First-letter | 86 | 5 | 0.75s | 100% | $0.000013 |
| E: Index-only | 87 | 14 | 0.87s | 100% | $0.000018 |
| F: Numbered alts | 105 | 5 | 0.57s | 100% | $0.000016 |
| G: Binary flags | 54 | 1 | 0.52s | 100% | $0.000007 |

## Winner: Candidate C (Pipe-Delimited)

**81% cost savings** with full alternative words returned.

Script: `~/.claude/llm-analyze-compact.sh`

## Implementation Status

- [x] Benchmark all candidates
- [x] Create compact script
- [x] Update pricing documentation
- [ ] Integrate with dynamicHighlight.ts
- [ ] Add fallback for parse failures
