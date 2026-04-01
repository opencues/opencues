---
last_updated: 2026-04-01
---

# Dynamic Highlight (LLM-Based Word Analysis) — Quick Reference

## Auto-Submit Mode (Recommended)

Automatically analyzes text using a two-tier triggering system.

**Two-Tier Triggering:**

| Tier | Trigger | Debounce | Purpose |
|------|---------|----------|---------|
| 1 | Space typed (word count increases) | 50ms + stability check | Analyze just-completed word |
| 2 | No typing for 300ms | 300ms + stability check | Analyze final word (no trailing space) |
| 3 | Word edited (same word count) | 50ms + stability check | Re-analyze after mid-sentence edit |

**How it works**:
1. User types: "The docu" → nothing yet (still typing word)
2. User types: "The document " (space) → Tier 1: 50ms stability check → fires
3. Inline HTTPS call to Groq → words with alternatives turn gray
4. User types: "The document is great" (stops typing)
5. User edits "document" to "report" → Tier 3: detects word change → re-analyzes
5. After 300ms → Tier 2 triggers for "great" (final word)
6. Navigate with Ctrl+Alt+Left/Right, cycle with Up/Down

**Single execution path — CueResolver (cues-core):**
- GrammarSource (always runs) — words-first prompt, `targetIndices` filter, `INDEX:alt,alt` format
- MathSource (runs when `looksLikeMath()`) — `COMPUTE=expression` → eval
- FactualSource (runs when `looksLikeFactual()`) — `ANSWER=value`
- All via NodeHttpAdapter with HTTPS keep-alive + Groq provider config

**Targeted Index Requests:**
After the first full submission, subsequent triggers only send words that don't already have valid alts. GrammarSource reads `context.metadata.targetIndices` and builds "Generate exactly N entries for indices: X,Y. No other indices." into the prompt.

**No Duplicate Requests:**
The system prevents overlapping LLM requests via `_dynPending` flag:
- When request fires → `_dynPending = true`
- While pending, new triggers are **ignored**
- When response received → `_dynPending = false`
- Next trigger can fire

**Key features**:
- Space-based: analyzes words when completed (followed by space)
- Final pause: catches last word after 1s of inactivity
- No duplicate requests: `_dynPending` prevents overlapping calls
- Tracks `_dynLastAnalyzed`: compares against actual LLM submissions, not just keystrokes
- `_dynSentWords`: captures text at request time (not completion time) for accurate tracking
- Merges new results with existing (stacks alternatives, deduplicates)
- Word-level invalidation preserves alts when text changes

## Per-Word Tips Lookup (CLAUDE_CODE)

Words matching the tips file (`~/.claude/claude-code-tips.json`) are handled locally without LLM calls.

**Key insight**: Words in the same sentence can have DIFFERENT classifications:
- "The quick fox uses ultrathink" → "quick" gets GRAMMAR alts, "ultrathink" gets TIPS alts
- Tips lookup runs FIRST, then LLM for remaining words

**How it works**:
1. Each word is checked against `~/.claude/claude-code-tips.json`
2. Matching words get instant alternatives + tips (~1ms)
3. Non-matching words go to LLM for GRAMMAR alternatives (~200ms)
4. Results are merged - each word shows its `source` field: `tips` or `grammar`

**Per-word tips** - Each word gets its own tip that changes when cycling:
- Navigate to "ultrathink" → Tip: "Add 'ultrathink' to prompt..."
- Cycle to "Tab" → Tip: "Press Tab to toggle extended thinking..."
- Cycle to "deep thinking" → Tip: "Extended thinking - Claude reasons..."

## Fill-in-the-Blank with Underscore

Type `_` (underscore) as a placeholder and the LLM will fill it with contextually appropriate words.

**LLM Classifier (blanks only):**
The classifier (~280ms) only runs for inputs with blanks (`_`):

| Mode | Example | Alternatives |
|------|---------|--------------|
| GRAMMAR | "The _ dog barked" | big, small, brown |
| FACTUAL | "The CEO of Google is _" | Sundar Pichai |
| MATH | "2 + 2 = _" | 4 |

Note: CLAUDE_CODE detection is now handled by per-word tips lookup, not the classifier.

**Grammar Prompts (built into cues-core):**
- `GRAMMAR_PROMPT` - Word alternatives for existing words (no blanks)
- `BLANK_GRAMMAR_PROMPT` - Fill-in-the-blank with grammatically correct word types

**Blank Grammar Rules:**
The blank prompt determines word type by looking at BOTH sides of the blank:

| After Blank | Before Blank | Blank Needs |
|-------------|--------------|-------------|
| Noun (dog) | Determiner (The) | ADJECTIVE |
| Verb (ran) | Determiner (The) | NOUN (subject) |
| Noun/Adj | Start of sentence | DETERMINER |
| Adverb (quickly) | Subject | VERB |

**Multi-word alternatives:**
Factual answers can be multi-word (e.g., "Sundar Pichai"). Up to 3 words allowed.

**Span Groups (Implemented):**
Multi-word replacements are tracked as "spans" that cycle together:
- **Cycling**: When cycling to "Sundar Pichai", both words are replaced as a unit
- **Navigation**: Only span originals (e.g., "Sundar") are navigable, not continuation words ("Pichai")
- **Highlighting**: Both words in span highlighted white when selected
- **Dimming**: Both words in span dimmed gray when not selected
- **Protection**: Re-analysis skips non-original span positions to prevent individual alternatives

Span tracking is handled within dynamicHighlight.ts.
See `/docs/blank-system.md` for full algorithm and benchmark details.

**Context-aware re-evaluation with queue:**
Underscores track context independently and queue re-evaluation if context changes during pending requests:

```
"The _"           → request fires, stores context=""
(user types "dog" while pending)
"The dog _"       → context="dog" queued (underscore-queued)
(request completes)
                  → auto-triggers with "dog" context
```

**State variables:**
- `_dynUnderscoreContext`: Last context sent for underscore analysis
- `_dynUnderscoreQueued`: Whether re-analysis is queued

**Re-evaluation triggers:**
- New words typed (space-based trigger)
- Context words changed during pending (queued)
- **Up/Down cycling changes context** (immediate re-evaluation)

**Debug log messages:**
- `underscore-queued: context changed while pending` - context change during request
- `underscore-trigger: context changed` - immediate trigger (no pending)
- `underscore-queue-trigger: processing queued re-analysis` - queued request firing

## LLM Provider Configuration

**Default model: GPT-OSS-120b via Groq** (~200ms, 94% math accuracy)

```bash
# Use GPT-OSS-120b (default, ~200ms, fastest & most accurate)
export GROQ_API_KEY="your-key"
claude

# Use Gemini 3 Flash Preview (fallback, ~1400ms)
export LLM_MODEL=gemini
export GEMINI_API_KEY="your-key"
claude
```

**Required API Keys:**
- `GROQ_API_KEY` - required for default GPT-OSS mode
- `GEMINI_API_KEY` - required if using `LLM_MODEL=gemini`

**Model Comparison:**

| Model | Latency | Math Accuracy | Use Case |
|-------|---------|---------------|----------|
| **GPT-OSS-120b (default)** | **~200ms** | **94%** | All modes (fastest) |
| Gemini 3-flash-preview | ~1400ms | 79% | Fallback |
| Gemini 2.5-flash | ~2500ms | 50% | Not recommended |

**Full documentation**: See `/docs/llm-providers.md` for benchmarks and provider configuration.

## Claude Code Tips System

For CLAUDE_CODE mode, alternatives and tips come from a pluggable JSON file instead of LLM calls.

**Tips File Location:** `~/.claude/claude-code-tips.json`

**Two Structures Supported:**

**1. `words` structure (per-word tips):**
```json
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
```

**2. `groups` structure (synonym groups):**
```json
{
  "id": "parallel-execution",
  "groups": [
    {
      "synonyms": ["agents", "sub-agents", "subagents", "parallel agents", "spawn"],
      "tip": "Spawn parallel workers via Task tool - faster for multi-file ops",
      "alts": ["swarm", "background"]
    },
    {
      "synonyms": ["swarm", "team"],
      "tip": "Multiple coordinated agents working on related tasks",
      "alts": ["agents", "background"]
    },
    {
      "synonyms": ["background", "Ctrl+B"],
      "tip": "Press Ctrl+B to send running agent to background",
      "alts": ["agents", "swarm"]
    }
  ]
}
```

**Groups vs Words:**
| Structure | Synonyms | Tips | Alts |
|-----------|----------|------|------|
| `words` | Each word is separate | Per-word tip | Can include synonyms |
| `groups` | Share ONE entry | Shared tip | Point to OTHER groups |

**Lookup Priority:** Groups are checked first, then words (backward compatible).

**Synonym Group Behavior:**
When using groups, cycling skips synonyms and goes to different concepts:
- Type "subagents" → recognized (in agents group)
- Cycle → "swarm" (different concept, different tip)
- Cycle → "background" (different concept, different tip)
- NOT → "agents", "sub-agents", "spawn" (synonyms are skipped)

**Semantic Detection:**
The classifier detects CLAUDE_CODE mode for semantic queries:
- "how do I undo my changes" → CLAUDE_CODE (finds "undo" → /rewind tips)
- "what command clears context" → CLAUDE_CODE (finds "context" → /compact tips)
- "how to search the codebase" → CLAUDE_CODE (finds "search" → sub-agents tips)

**Performance:**
- CLAUDE_CODE mode skips LLM entirely (~1ms vs ~200-600ms)
- Tips lookup is local JSON file read
- No API key required for CLAUDE_CODE mode

## JSON Schema

```json
{
  "words": [
    {"index": 0, "word": "The", "alts": null, "linked": null},
    {"index": 1, "word": "boy", "alts": ["boy", "girl", "child"], "linked": [3]},
    {"index": 2, "word": "said", "alts": ["said", "whispered", "shouted"], "linked": null},
    {"index": 3, "word": "he", "alts": ["he", "she", "they"], "linked": [1]},
    {"index": 4, "word": "was", "alts": null, "linked": null},
    {"index": 5, "word": "happy", "alts": ["happy", "sad", "excited"], "linked": null}
  ],
  "_model": "gpt-oss-120b",
  "_tokens": {"in": 112, "out": 95}
}
```

**Field meanings**:
- `alts`: Array of alternatives (original word at index 0), null if no alternatives
- `linked`: Array of word indices that should cycle together (e.g., "boy" and "he")
- `_model`: Which LLM generated this response
- `_tokens`: Token usage for debugging

**Hybrid Mode**:
- If JSON exists and has alternatives for highlighted word → use JSON cycling
- **Exception**: Gender root words (boy/girl) ALWAYS skip dynamic cycling → use hardcoded gender flip
  - This ensures linked words (his→her, he→she) change together
  - LLM script doesn't populate `linked` arrays, so hardcoded logic is needed
- If no JSON or word not defined → fall back to hardcoded behavior:
  - Numbers: increment/decrement
  - Gender: boy↔girl flip with linked words

## Architecture

**Auto-Submit Mode (primary path — no blanks):**
```
User types word → 50ms debounce → stability check → Patch detects new word
    → Checks which indices already have alts (targeted optimization)
    → Calls globalThis._cueResolver.resolve({text, words, metadata:{targetIndices}})
      → CueResolver runs GrammarSource in-process (no bash spawn, no polling)
      → Inline HTTPS to Groq API with keep-alive connection
      → Returns CueResult[] with .wordIndex, .word, .alternatives, .source
    → Merges into existing _dynDefs → _forceInputRefresh()
    → Words with alternatives turn gray
```

**Full-Context Targeted Flow (subsequent triggers):**
```
Existing: "the boy ran to the store" → boy, ran, store have alts
User adds: "quickly" → triggers analysis

1. Check each index: boy(1)✓ ran(2)✓ store(5)✓ quickly(6)✗
2. Send FULL sentence with metadata.targetIndices=[6]
3. LLM has full context → ~450ms (same speed, better quality)
4. Result: [{wordIndex:6, alternatives:["slowly","rapidly","swiftly"]}]
5. Merge into existing defs, preserve all others
```

**Blanks path:**
```
Input contains "_" → same CueResolver path
    → MathSource fires if looksLikeMath() (priority 90)
    → FactualSource fires if looksLikeFactual() (priority 90)
    → GrammarSource always fires (priority 50, uses BLANK_GRAMMAR_PROMPT)
    → All sources include '_' as first alt for uniform > 1 handling
```

**CueResolver initialization (IIFE at startup):**
```
var g6=Gt4(import.meta.url),...;    ← require function defined here
;(function(){                        ← cues-core IIFE injected here (after g6)
  globalThis._cuesCore = ...
  globalThis._tipsMap = ...
  globalThis._httpAdapter = new NodeHttpAdapter({providerOverrides: {...}})
  globalThis._cueResolver = cuesCore.createResolver([GrammarSource, MathSource, FactualSource])
})();
```

**IMPORTANT — Injection point (v2.1.84+ ESM):** The IIFE must be injected AFTER `var g6=Gt4(import.meta.url)`, not just after the `import{createRequire}` statement. See CLAUDE.md → Version Update Workflow for diagnostics.

**CueResolver Sources (all in cues-core):**

| Source | Prompt | Trigger | Output |
|--------|--------|---------|--------|
| GrammarSource | `GRAMMAR_PROMPT` (built-in) | Always (priority 50) | `INDEX:alt,alt` |
| MathSource | `MATH_PROMPT` (built-in) | `_` + `looksLikeMath()` (priority 90) | `COMPUTE=expr` |
| FactualSource | `FACTUAL_PROMPT` (built-in) | `_` + `looksLikeFactual()` (priority 90) | `ANSWER=val` |
| Tips (instant) | n/a | `_tipsMap` lookup | ~0ms, no LLM |

**API calls per input type:**
- Regular words: 1 call (GrammarSource only)
- Grammar blanks: 1 call (GrammarSource only)
- Math blanks: 2 calls (MathSource + GrammarSource)
- Factual blanks: 2 calls (FactualSource + GrammarSource)

## Performance Benchmarks (March 2026)

Measured from `/tmp/claude-llm-timing-{PID}.txt` across live sessions.

**CueResolver with words-first prompt (current):**

| Metric | Value |
|--------|-------|
| n | 36 calls |
| avg | 471ms |
| p50 | 405ms |
| p90 | 708ms |
| min | 287ms |
| max | 1133ms |

**Old CueResolver without prompt rewrite:**

| Metric | Value |
|--------|-------|
| n | 516 calls |
| avg | 825ms |
| p50 | 806ms |
| p90 | 1224ms |

The words-first prompt with targetIndices is ~43% faster than the old CueResolver (no rewrite) and ~43% faster than the old bash path. The improvement comes from: (1) words at start of prompt, target filter adjacent to data, (2) LLM generates fewer output tokens, (3) HTTPS keep-alive with connection warmup.

**Tips lookup:** ~0–1ms (hash map, no network). Shown as `tips-partial` in timing log when at least one word matched tips before LLM returns.

## Config

In `~/.tweakcc/config.json`:
```json
{
  "misc": {
    "enableDynamicHighlight": true,
    "dynamicHighlightDebounceMs": 0
  }
}
```

## Debugging

Monitor timing and triggers:
```bash
tail -f /tmp/claude-llm-timing-*.txt /tmp/claude-auto-debug-*.txt
```

## Clearing (Word-Level Invalidation)

When user edits text, alternatives are preserved intelligently per-word:

```javascript
// In dynamicHighlight.ts → writeDynamicClearOnChange()
// Word-level invalidation - preserves alts when possible

if(_hlText!==_oldText&&globalThis._dynDefs&&globalThis._dynDefs.words){
  var _oldW=_oldText.split(/\s+/).filter(w=>w);
  var _newW=_hlText.split(/\s+/).filter(w=>w);
  var _minLen=Math.min(_oldW.length,_newW.length);

  // Check each position up to min length
  for(var _wi=0;_wi<_minLen;_wi++){
    if(_oldW[_wi]!==_newW[_wi]){
      var _def=globalThis._dynDefs.words.find(d=>d.index===_wi);
      if(_def){
        if(_def.alts&&_def.alts.indexOf(_newW[_wi])>=0){
          // Word is in alts - valid cycle, update index
          _def.word=_newW[_wi];
          _def.currentAltIndex=_def.alts.indexOf(_newW[_wi]);
        }else{
          // Word NOT in alts - clear alts
          // Handles mid-sentence insertion/deletion where indices shift
          _def.word=_newW[_wi];
          _def.alts=null;
          _def.currentAltIndex=0;
          if(globalThis._dynSpans)delete globalThis._dynSpans[_wi];
        }
      }
    }
  }

  // Handle removed words (invalidate defs beyond new length)
  if(_newW.length<_oldW.length){
    for(var _ri=_newW.length;_ri<_oldW.length;_ri++){
      var _rdef=globalThis._dynDefs.words.find(d=>d.index===_ri);
      if(_rdef){_rdef.alts=null;}
    }
  }
}
```

**Navigation/rendering also check word is in alts:**
```javascript
// Word must be IN alts array to be navigable/dimmed
var _hasDynAlt=globalThis._dynDefs&&globalThis._dynDefs.words&&
  globalThis._dynDefs.words.find(d=>d.index===i&&d.alts&&d.alts.length>1&&d.alts.indexOf(w)>=0);
```

**Clearing behavior**:
- Word changed to something IN `alts` array → update currentAltIndex (valid cycle)
- Word changed to something NOT in `alts` → **clear alts** (prevents stale alts after index shifts)
  - Auto-submit will re-fetch alts for the changed word on next trigger
- Word count increased → existing alts preserved, new words get alts on next auto-submit
- Word count decreased → removed word positions have alts cleared
- Auto-submit mode: re-analyzes automatically on new words, merges results

**Why this approach**:
- Preserves analysis during partial typing (backspace then retype)
- Words are only navigable when they match an entry in their alts array
- Existing unchanged words keep alts when new words are added

## Related

- `word-highlight.md` — navigation and rendering
- `status-line.md` — status line tips display
- `config.md` — all configuration options
- `/docs/llm-providers.md` — provider config and benchmarks
