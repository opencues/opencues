---
last_updated: 2026-03-31
---

# Dynamic Highlight System

*Comprehensive documentation for the LLM-based dynamic word highlighting feature.*

---

## Overview

The Dynamic Highlight system extends Claude Code's word highlight navigation to support **LLM-generated word alternatives**. Instead of hardcoded word relationships (numbers, gender words), the system automatically analyzes text and generates alternatives.

**Two trigger modes available:**

| Mode | Trigger | Best For |
|------|---------|----------|
| **Auto-submit** (recommended) | Immediate on space, 300ms final pause | Seamless UX, continuous analysis |
| **Submit trigger** | Type "submit" | Manual control |

The system generates a JSON schema defining:
- Which words have alternatives
- What those alternatives are
- Which words are semantically linked (should change together)

This creates a powerful **in-context word cycling interface** where the LLM understands the semantic relationships in your text.

---

## Per-Word Tips Lookup (Runs First)

Before any LLM analysis, each word is checked against `~/.claude/claude-code-tips.json`. This provides instant alternatives for Claude Code concepts (~1ms).

### Tips File Structure

The tips file supports two structures:

**1. `words` structure (per-word tips):**
```json
{
  "id": "context-management",
  "words": {
    "/compact": { "tip": "...", "alts": ["/clear", "/rewind"] },
    "/clear": { "tip": "...", "alts": ["/compact", "/rewind"] }
  }
}
```

**2. `groups` structure (synonym groups):**
```json
{
  "id": "parallel-execution",
  "groups": [
    {
      "synonyms": ["agents", "sub-agents", "subagents", "spawn"],
      "tip": "Spawn parallel workers via Task tool",
      "alts": ["swarm", "background"]
    },
    {
      "synonyms": ["swarm", "team"],
      "tip": "Multiple coordinated agents working on related tasks",
      "alts": ["agents", "background"]
    }
  ]
}
```

**Key difference:**
- `words`: Each word has its own alts (can include synonyms)
- `groups`: Synonyms share ONE entry; alts point to OTHER groups (different concepts)

### Processing Flow

```
Input: "The quick fox uses subagents"
         │
         ▼
   For EACH word:
         │
   ┌─────┴─────┐
   ▼           ▼
 In tips?    Not in tips
   │           │
   ▼           ▼
 INSTANT    Goes to LLM
 (~1ms)     (~200ms)
   │           │
   ▼           ▼
 source:    source:
 'tips'     'grammar'
```

**Result:** Mixed sentences work - "quick" and "fox" get grammar alts, "subagents" gets tips alts.

---

## Auto-Submit Mode (Recommended)

Auto-submit mode automatically analyzes text using a **two-tier triggering system**.

### Two-Tier Triggering

| Tier | Trigger | Debounce | Purpose |
|------|---------|----------|---------|
| 1 | Space typed (word count increases) | 50ms + stability check | Analyze just-completed word |
| 2 | No typing for 300ms | 300ms + stability check | Analyze final word (no trailing space) |
| 3 | Word edited (same word count) | 50ms + stability check | Re-analyze after mid-sentence edit |

**Stability checks** prevent partial/incomplete words from reaching the LLM:
1. **Pre-fire** (50ms): After trigger, compare captured words with current `_hlText` — abort if changed
2. **Pre-request**: Inside `_dynTriggerAnalysis`, re-read `_hlText` — abort if text changed since trigger

### How It Works

```
User types: "The"
    │
    └─→ Tier 2: 300ms inactivity timer starts

User types: "The boy " (space)
    │
    └─→ Tier 1: word count increased → immediate trigger
    └─→ Tier 2: timer resets

Tier 1 fires immediately
    │
    └─→ Inline HTTPS call to Groq → "boy" gets alternatives
        └─→ "boy" turns gray (navigable)

User types: "The boy said"  (no trailing space, stops typing)
    │
    └─→ Tier 1 doesn't fire (no space yet)

300ms passes...
    │
    └─→ Tier 2 fires for "said" (final word without trailing space)
    └─→ Only sends "said" (targeted), MERGES with existing "boy" alternatives
```

### Configuration

```json
{
  "misc": {
    "enableDynamicHighlight": true,
    "dynamicHighlightDebounceMs": 0
  }
}
```

### Key Features

1. **Only triggers on NEW words** - Editing existing words doesn't trigger re-analysis
2. **Unified CueResolver** - All modes go through cues-core (GrammarSource, MathSource, FactualSource)
3. **Smart classification** - `looksLikeMath()` / `looksLikeFactual()` route blanks to correct source
4. **Targeted index requests** - GrammarSource only sends words that lack alts (via `targetIndices`)
5. **Merges results** - New alternatives are stacked with existing ones (deduplicated)
6. **Word-level invalidation** - Editing one word clears its alts; others are preserved
7. **Single-char filter** - Rejects 1-character alternatives (except `_` placeholder)
8. **Uses GPT-OSS-120b** - ~400-500ms avg latency via Groq, 3 alternatives per word

### Targeted Index Optimization

After the first full submission, subsequent triggers only send words that don't already have valid alternatives. This cuts LLM latency roughly in half for incremental typing.

**How it works:**

1. Before calling the LLM, check each word index against `globalThis._dynDefs.words`
2. Skip indices that already have alts (where the current word is in the alts array)
3. Skip function words (the, a, to, is, etc.) which never get alts
4. Send the **full sentence** with original indices to the LLM
5. Prepend: `"ONLY give alternatives for indices: 6. Skip ALL other indices."`
6. LLM has full context for disambiguation but only generates alts for target words
7. Results come back with real indices — no unmapping needed

**Example:**

```
Sentence: "the boy ran to the store"
First trigger: sends full sentence, "ONLY indices 1,2,5" → ~600ms

User types: "the boy ran to the store quickly"
Second trigger: boy(1), ran(2), store(5) already have alts
  → Sends full sentence: "the boy ran to the store quickly"
  → With instruction: "ONLY give alternatives for indices: 6"
  → LLM sees full context, returns: 6:slowly,rapidly,swiftly
  → Direct merge (no unmapping) → ~450ms
```

**Why full context matters:**

Without context, "bank" always gets generic alts (shore, institution). With context:
- "the river bank" → shore, edge, embankment (water meaning)
- "the money bank" → institution, vault, treasury (finance meaning)

Benchmarks (102 tests): context produced different/better alts in 100% of cases, and was 19% faster (469ms vs 577ms avg) because the LLM resolves ambiguity faster.

**Benchmarks (March 2026):**

| Scenario | Avg Latency |
|----------|------------|
| Full 6 words | ~800ms |
| Full 10 words | ~920ms |
| Targeted 1 word | ~620ms |
| Targeted 2 words | ~610ms |

Savings: **~25-35%** per subsequent word. Combined with words-first prompt format and 50ms debounce, the total pipeline averages ~471ms.

### State Variables

```javascript
globalThis._dynPrevWords       // Previous word list for comparison
globalThis._dynDebounceTimer   // setTimeout reference (Tier 1/3: 50ms + stability)
globalThis._dynFinalPauseTimer // setTimeout reference (Tier 2: 300ms)
globalThis._dynLastAnalyzed    // Text of last LLM submission (for dedup)
globalThis._httpAdapter         // NodeHttpAdapter instance (from cues-core)
globalThis._cueResolver        // CueResolver instance (from cues-core)
globalThis._cycleAlt           // Shared cycling function (action words, alts, linked, spans)
globalThis._dynDefs._auto      // Flag indicating auto-submit result
```

### Debug File

Auto-submit writes debug info to `/tmp/claude-auto-debug-{PID}.txt`:

```
[1770932310674] text="The" cur=1 prev=0
  newWords=true pending=false
[1770932311360] text="The boy" cur=2 prev=1
  newWords=true pending=true
```

---

## CueResolver Sources and Response Parsing

All LLM analysis goes through cues-core's CueResolver. Each source has its own prompt, parser, and `supports()` condition.

### Source → Prompt → Parser Mapping

| Source | Prompt (built into cues-core) | Output Format | Parser | Trigger |
|--------|------|---------------|--------|---------|
| GrammarSource | `GRAMMAR_PROMPT` | `INDEX:alt,alt\|INDEX:alt,alt` | Split on `\|:,` | Always (priority 50) |
| MathSource | `MATH_PROMPT` | `COMPUTE=expression` | Eval expression | `looksLikeMath()` (priority 90) |
| FactualSource | `FACTUAL_PROMPT` | `ANSWER=value` | Extract value | `looksLikeFactual()` (priority 90) |
| FACTUAL | `system_prompts/blank_factual.txt` | `ANSWER=value` | Extract value |

### LINKED Mode Parser (Critical)

The LINKED prompt returns `LINKS: 1-3 [GENDER], 1-3 [POSSESSION]`. The parser:
1. Extracts all `index-index` pairs from the LINKS line
2. Populates `result.words[a].linked` and `result.words[b].linked` **bidirectionally**
3. Also parses any `INDEX:alt,alt` grammar format if present in the same response

**IMPORTANT:** The LINKED parser must be a separate `else if (mode === 'LINKED')` branch in the Node.js response handler — NOT falling through to the GRAMMAR parser. The grammar parser cannot parse `LINKS:` format and will silently produce empty results.

### Benchmark Results (March 2026, groq-120b)

| Category | Accuracy |
|----------|----------|
| Math | 92.6% |
| Factual | 94.1% |
| Grammar | 88.4% |
| Linked (gender) | 100% |
| Linked (number/verb/possession/tense) | 78-89% |
| Linked (concept) | 23% |
| **Overall** | **78.8%** |

### Prompt Selection Logic

In cues-core, each source uses its own built-in prompt:
- GrammarSource: `GRAMMAR_PROMPT` (regular words) or `BLANK_GRAMMAR_PROMPT` (blanks)
- MathSource: `MATH_PROMPT` (replaces `_` with `BLANK` in text)
- FactualSource: `FACTUAL_PROMPT` (replaces `_` with `BLANK` in text)

---

> **HISTORICAL NOTE**: The sections below describe the **old bash script architecture** (pre-March 2026). All LLM analysis now goes through cues-core's CueResolver. These sections are preserved for reference only.

### [HISTORICAL] Old Prompt File Selection (llm-analyze-auto.sh)

```bash
if [[ -n "$BLANKS" ]]; then
    GRAMMAR_PROMPT_FILE="blank_grammar.txt"
elif [[ "$MODE" == "LINKED" ]]; then
    GRAMMAR_PROMPT_FILE="linked.txt"        # ← Must use linked.txt, NOT grammar.txt
else
    GRAMMAR_PROMPT_FILE="grammar.txt"
fi
```

## [HISTORICAL] Architecture (Submit Trigger — removed)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Claude Code Input Box                         │
├─────────────────────────────────────────────────────────────────────┤
│  User types: "The boy said he was happy submit"                     │
│                                              ^^^^^^                  │
│                                              trigger                 │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Trigger Detection Patch                           │
│  1. Detect /\bsubmit\b/i in text                                    │
│  2. Remove "submit" from text                                        │
│  3. Write cleaned text to /tmp/claude-llm-input-{PID}.txt           │
│  4. Spawn external script (detached, background)                     │
│  5. Start polling for result (100ms interval, 30s timeout)          │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    External Script                                   │
│  ~/.claude/llm-analyze.sh                                            │
│                                                                      │
│  1. Read input text                                                  │
│  2. Construct prompt with schema + examples                          │
│  3. Call: claude -p "$PROMPT" --model haiku                          │
│  4. Validate JSON response                                           │
│  5. Write to /tmp/claude-llm-result-{PID}.json                       │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Polling & Loading                                 │
│  1. Check if result file exists (every 100ms)                        │
│  2. Read and parse JSON                                              │
│  3. Store in globalThis._dynDefs                                     │
│  4. Delete result file                                               │
│  5. Clear polling interval                                           │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Visual Feedback                                   │
│  Words with alternatives turn GRAY (dimmed)                          │
│  This indicates they are now navigable                               │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    User Interaction                                  │
│  • Ctrl+Alt+Left/Right: Navigate to any gray word                   │
│  • Ctrl+Alt+Up: Cycle forward through alternatives                  │
│  • Ctrl+Alt+Down: Cycle backward through alternatives               │
│  • Linked words change together                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## JSON Schema

### Complete Schema

```json
{
  "priority": 1,
  "sentence": "The boy said he was happy",
  "words": [
    {
      "index": 0,
      "word": "The",
      "alts": null,
      "linked": null
    },
    {
      "index": 1,
      "word": "boy",
      "alts": ["boy", "girl", "child", "kid"],
      "linked": [3],
      "currentAltIndex": 0
    },
    {
      "index": 2,
      "word": "said",
      "alts": ["said", "whispered", "shouted", "mentioned"],
      "linked": null,
      "currentAltIndex": 0
    },
    {
      "index": 3,
      "word": "he",
      "alts": ["he", "she", "they"],
      "linked": [1],
      "currentAltIndex": 0
    },
    {
      "index": 4,
      "word": "was",
      "alts": null,
      "linked": null
    },
    {
      "index": 5,
      "word": "happy",
      "alts": ["happy", "sad", "excited", "content", "joyful"],
      "linked": null,
      "currentAltIndex": 0
    }
  ]
}
```

### Field Definitions

| Field | Type | Description |
|-------|------|-------------|
| `priority` | number | Conflict resolution priority (higher wins). Reserved for future multi-schema support. |
| `sentence` | string | Original sentence for validation/debugging. |
| `words` | array | Array of word definitions, one per word in the sentence. |
| `words[].index` | number | 0-based position of word in sentence (by whitespace split). |
| `words[].word` | string | The current word text (updated when cycling). |
| `words[].alts` | array\|null | Array of alternative words. Original word MUST be at index 0. `null` if no alternatives. |
| `words[].linked` | array\|null | Array of word indices that should cycle together. `null` if no linkages. |
| `words[].currentAltIndex` | number | Current position in `alts` array. Starts at 0 (original word). Only present if `alts` is not null. |
| `words[].source` | string\|null | Source of alternatives: `'tips'`, `'grammar'`, `'math'`, or `'factual'`. |
| `words[].claudelogTip` | string\|null | Tip text to display (only for tips-sourced words). |
| `words[].altTips` | object\|null | Map of alt word → tip for cycling (tips words only). |

### Key Constraints

1. **All words must be included** - Every word in the sentence needs an entry, even if it has no alternatives.

2. **Original word at index 0** - The `alts` array must include the original word as the first element.

3. **Bidirectional linking** - If word A links to word B, word B should link back to word A.

4. **Index consistency** - The `index` field must match the word's actual position in the whitespace-split sentence.

---

## LLM Prompt Design

### Prompt Structure

The prompt sent to Claude Haiku follows this structure:

```
[Role/Context]
You are a text analyzer for a word-cycling interface...

[Output Format]
Return ONLY valid JSON in this exact format (no markdown, no explanation, no code blocks):
{schema example}

[Rules]
- Include ALL words in the sentence, indexed from 0
- Only include "alts" array for words where alternatives make semantic sense
- "alts" must include the original word at position 0
- "linked" references indices of words that should change together
- Common linkages: pronouns to their referent nouns, verb forms that agree
- Include "currentAltIndex": 0 only for words that have alts
- Words without meaningful alternatives should have "alts": null and "linked": null

[Few-Shot Examples]
Input: "The happy boy ran quickly"
Output: {example1}

Input: "She said hello to her friend"
Output: {example2}

[Actual Task]
Now analyze this text:
{user_text}
```

### Why This Prompt Works

1. **Explicit JSON-only instruction** - "Return ONLY valid JSON" prevents markdown wrapping.

2. **Compact examples** - Single-line JSON in examples encourages compact output.

3. **Clear rules** - Explicit rules for edge cases (null vs array, original word position).

4. **Semantic guidance** - "pronouns to their referent" guides linkage decisions.

5. **Two diverse examples** - One with adjectives, one with pronouns/linkages.

### Prompt Gotchas Discovered

| Issue | Solution |
|-------|----------|
| Haiku wraps JSON in markdown code blocks | Python post-processor strips ``` markers |
| Haiku sometimes adds explanatory text | "no explanation" in prompt + JSON validation |
| Word indices get confused | Explicit "indexed from 0" rule |
| Missing currentAltIndex field | Included in examples and rules |
| Empty alts arrays | Rule: use `null` not `[]` |

---

## Human-Computer Interaction (HCI)

### Visual Feedback Loop

```
State: No dynamic defs loaded
┌────────────────────────────────┐
│ The boy said he was happy      │  ← "boy" gray (hardcoded gender)
│     ^^^                        │    All other words normal
└────────────────────────────────┘

User types: "submit"
┌────────────────────────────────┐
│ The boy said he was happy      │  ← "submit" removed
│ [Waiting for LLM...]           │    (visual: no change yet)
└────────────────────────────────┘

After ~10-30 seconds (LLM response):
┌────────────────────────────────┐
│ The boy said he was happy      │  ← "boy", "said", "he", "happy" now GRAY
│     ^^^ ^^^^ ^^     ^^^^^      │    These words are navigable
└────────────────────────────────┘

User presses Ctrl+Alt+Left:
┌────────────────────────────────┐
│ The boy said he was happy      │  ← "happy" highlighted WHITE
│                     █████      │    (bold bright white)
└────────────────────────────────┘

User presses Ctrl+Alt+Up:
┌────────────────────────────────┐
│ The boy said he was sad        │  ← "happy" → "sad"
│                     ███        │    Word replaced in text
└────────────────────────────────┘

User navigates to "boy", presses Ctrl+Alt+Up:
┌────────────────────────────────┐
│ The girl said she was sad      │  ← "boy" → "girl"
│     ^^^^     ^^^               │    "he" → "she" (linked!)
└────────────────────────────────┘
```

### Key Bindings

| Key Combination | Action |
|-----------------|--------|
| `Ctrl+Alt+Left` | Navigate to previous navigable word |
| `Ctrl+Alt+Right` | Navigate to next navigable word |
| `Ctrl+Alt+Up` | Cycle forward through alternatives (+ linked words) |
| `Ctrl+Alt+Down` | Cycle backward through alternatives |
| `Escape` | Clear highlight selection |
| Any typing | Clear dynamic definitions (stale detection) |

### Navigable Word Detection

A word is navigable (shown in gray, can be selected) if ANY of:
1. It matches the hardcoded number pattern (`/^-?\d+(\.\d+)?$/`)
2. It matches the hardcoded gender root pattern (`/^(boy|girl)$/i`)
3. It has `alts` with `length > 1` in `globalThis._dynDefs`

### Gender Root Word Handling

**Important**: Gender root words (`boy`/`girl`) are handled specially to ensure proper linked word flipping.

When Up/Down is pressed on a gender root word:
1. Dynamic highlight checks if the word matches `/^(boy|girl)$/i`
2. If it matches, dynamic highlight **skips** (doesn't cycle via LLM alts)
3. Control falls through to wordHighlight's hardcoded gender flip logic
4. wordHighlight flips ALL linked words together (boy→girl, his→her, he→she, etc.)

**Why this design?**

The LLM script doesn't currently populate `linked` arrays in its response (it sets `linked: null` for all words). If dynamic highlight cycled "boy" via LLM alternatives, linked pronouns like "his" wouldn't change together.

The wordHighlight gender logic has hardcoded linked groups:
- Male: `['boy','he','him','his','man',"he's"]`
- Female: `['girl','she','her','woman',"she's"]`

By skipping dynamic highlight for gender roots, we ensure the hardcoded linked flip runs, which properly transforms "The boy loved his dog" → "The girl loved her dog".

**Example flow**:
```
User highlights "boy" → presses Ctrl+Alt+Up
    │
    ├─→ dynamicHighlight: "boy" is gender root? YES → skip
    │
    └─→ wordHighlight gender flip:
        ├─→ "boy" → "girl"
        ├─→ "his" → "her" (linked)
        └─→ "he" → "she" (linked)
```

### Timing Considerations

- **CueResolver latency**: ~400-500ms avg (GPT-OSS-120b via Groq)
- **Timeout**: 30s per source (CueResolver config)
- **Visual feedback**: Gray coloring appears after resolver returns (~400ms)
- **Tips lookup**: ~0ms (instant from hash map, shown before LLM returns)

---

## Implementation Details

### State Storage

```javascript
// Dynamic definitions from LLM
globalThis._dynDefs = {
  priority: 1,
  sentence: "...",
  words: [...]
};

// Pending flag (analysis in progress)
globalThis._dynPending = true/false;

// Result file path being polled
globalThis._dynResultPath = "/tmp/claude-llm-result-12345.json";

// Polling start time (for timeout)
globalThis._dynPollStart = Date.now();

// Polling interval reference (for cleanup)
globalThis._dynPollInterval = setInterval(...);
```

### File Paths

| File | Purpose | Cleanup |
|------|---------|---------|
| `/tmp/claude-llm-input-{PID}.txt` | Input text for LLM | Persists (debugging) |
| `/tmp/claude-llm-result-{PID}.json` | LLM response JSON | Deleted after reading |

### Patch Application Order

The dynamic highlight patches MUST be applied AFTER the word highlight patches:

```typescript
// In index.ts:
if ((result = writeWordHighlight(content, highlightConfig))) content = result;
// ... then ...
if ((result = writeDynamicHighlight(content, dynamicConfig))) content = result;
```

This is because dynamic highlight patches modify code that wordHighlight created.

---

## Development Lessons Learned

### What Worked Well

1. **External script approach** - Separating the LLM call into a shell script made debugging easy. You can test the script standalone:
   ```bash
   echo "The boy said he" > /tmp/test.txt
   ~/.claude/llm-analyze.sh /tmp/test.txt /tmp/out.json
   cat /tmp/out.json
   ```

2. **Using `claude -p` instead of curl** - The Claude CLI handles authentication, so no need to manage API keys in the script.

3. **Polling with setInterval** - Simple and reliable. The 100ms interval is fast enough to feel responsive but not wasteful.

4. **PID-based file paths** - Prevents conflicts when multiple Claude Code instances run simultaneously.

5. **Gray color for navigable words** - Provides clear visual feedback that analysis is complete.

6. **Hybrid fallback mode** - If JSON doesn't define a word, hardcoded behavior still works.

### Problems Encountered & Solutions

| Problem | Root Cause | Solution |
|---------|------------|----------|
| Script not running | `spawn` without `env: process.env` | Added `env: process.env` to spawn options |
| Navigation skipping dynamic words | Pattern matching wrong forEach syntax | Used flexible regex with capture group for existing condition |
| Rendering not working | Looking for `_numRanges` (doesn't exist in "both" mode) | Match `_dimRanges` pattern directly |
| Pattern with newlines not matching | JavaScript regex `\s*` needed | Added `\s*` to match optional whitespace/newlines |
| Haiku returning markdown | LLM wrapping JSON in code blocks | Python post-processor strips ``` markers |
| Words not turning gray | `_dynDefs` cleared on text change | Invisible char toggle doesn't trigger clear (stripped before compare) |

### Debugging Techniques

1. **Add debug logging to script**:
   ```bash
   echo "$(date): Starting..." >> /tmp/llm-analyze-debug.log
   ```

2. **Check if files are being created**:
   ```bash
   ls -la /tmp/claude-llm-*
   ```

3. **Run script manually with debug output**:
   ```bash
   bash -x ~/.claude/llm-analyze.sh /tmp/test.txt /tmp/out.json
   ```

4. **Check patch application**:
   ```bash
   grep -c '_dynDefs' /path/to/cli.js  # Should be 10+
   grep -c '_hasDynAlt' /path/to/cli.js  # Should be 6
   ```

5. **Verify syntax after patching**:
   ```bash
   node --check /path/to/cli.js
   ```

---

## Configuration

### Settings in `defaultSettings.ts`

```typescript
misc: {
  enableDynamicHighlight: true,
  dynamicHighlightDebounceMs: 0,   // 0 = 50ms internal debounce
}
```

### Types in `types.ts`

```typescript
interface MiscSettings {
  enableDynamicHighlight?: boolean;
  dynamicHighlightDebounceMs?: number;
}
```

---

## Examples

### Example 1: Simple Adjective Cycling

**Input**: `The happy dog ran`

**JSON Response**:
```json
{
  "priority": 1,
  "sentence": "The happy dog ran",
  "words": [
    {"index": 0, "word": "The", "alts": null, "linked": null},
    {"index": 1, "word": "happy", "alts": ["happy", "sad", "excited"], "linked": null, "currentAltIndex": 0},
    {"index": 2, "word": "dog", "alts": ["dog", "cat", "bird"], "linked": null, "currentAltIndex": 0},
    {"index": 3, "word": "ran", "alts": ["ran", "walked", "jumped"], "linked": null, "currentAltIndex": 0}
  ]
}
```

**Result**: "happy", "dog", "ran" become navigable. No linkages.

### Example 2: Pronoun Linkage

**Input**: `The boy said he was tired`

**JSON Response**:
```json
{
  "priority": 1,
  "sentence": "The boy said he was tired",
  "words": [
    {"index": 0, "word": "The", "alts": null, "linked": null},
    {"index": 1, "word": "boy", "alts": ["boy", "girl", "child"], "linked": [3], "currentAltIndex": 0},
    {"index": 2, "word": "said", "alts": ["said", "whispered", "shouted"], "linked": null, "currentAltIndex": 0},
    {"index": 3, "word": "he", "alts": ["he", "she", "they"], "linked": [1], "currentAltIndex": 0},
    {"index": 4, "word": "was", "alts": null, "linked": null},
    {"index": 5, "word": "tired", "alts": ["tired", "happy", "angry"], "linked": null, "currentAltIndex": 0}
  ]
}
```

**Result**: When user cycles "boy" → "girl", "he" automatically becomes "she".

### Example 3: Complex Sentence

**Input**: `She gave her friend a gift`

**JSON Response**:
```json
{
  "priority": 1,
  "sentence": "She gave her friend a gift",
  "words": [
    {"index": 0, "word": "She", "alts": ["She", "He", "They"], "linked": [2], "currentAltIndex": 0},
    {"index": 1, "word": "gave", "alts": ["gave", "sent", "handed"], "linked": null, "currentAltIndex": 0},
    {"index": 2, "word": "her", "alts": ["her", "his", "their"], "linked": [0], "currentAltIndex": 0},
    {"index": 3, "word": "friend", "alts": ["friend", "enemy", "neighbor"], "linked": null, "currentAltIndex": 0},
    {"index": 4, "word": "a", "alts": null, "linked": null},
    {"index": 5, "word": "gift", "alts": ["gift", "present", "card"], "linked": null, "currentAltIndex": 0}
  ]
}
```

**Result**: "She" and "her" are linked. Cycling one changes both.

---

## [HISTORICAL] Troubleshooting (bash script era)

> Most of this troubleshooting applies to the old bash script path. For the current CueResolver path, check `/tmp/claude-auto-debug-{PID}.txt` for "resolver:" or "no-resolver:" messages.

### Words Not Turning Gray

1. **Check if script completed**: `ls -la /tmp/claude-llm-result-*.json`
2. **Check debug log**: Add logging to script, check `/tmp/llm-analyze-debug.log`
3. **Verify JSON structure**: Run script manually and inspect output
4. **Check for text changes**: Any typing after "submit" clears definitions

### Script Not Running

1. **Check PATH**: Spawned process needs `claude` in PATH
2. **Check permissions**: `chmod +x ~/.claude/llm-analyze.sh`
3. **Check env**: Spawn needs `env: process.env`

### Navigation Skipping Words

1. **Verify patch applied**: `grep -c '_hasDynAlt' /path/to/cli.js`
2. **Check JSON indices**: Indices must match whitespace-split word positions
3. **Check alts length**: Must have `length > 1` to be navigable

### Cycling Not Working

1. **Verify highlight active**: Word must be selected (white) first
2. **Check alts array**: Must have alternatives defined
3. **Check linked indices**: Linked indices must be valid

---

## File Reference

| File | Purpose |
|------|---------|
| `/home/wilfred/tweakcc-source/src/patches/dynamicHighlight.ts` | Patch implementation (1087 lines) |
| `/home/wilfred/tweakcc-source/src/types.ts` | Config types |
| `~/.claude/node_modules/cues-core/` | Prompts, sources, resolver, adapter |
| `~/.claude/claude-code-tips.json` | Per-word tips data (loaded at startup) |

---

*Last updated: March 2026*
