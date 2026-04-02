---
last_updated: 2026-04-02
---

# Alternatives — Claude Code

Implements features [6](../../../docs/features/tips.md), [7](../../../docs/features/llm-alternatives.md), [8](../../../docs/features/fill-in-the-blank.md), [12](../../../docs/features/auto-submit.md). See those docs for the concepts.

**Patch file:** `patches/dynamicHighlight.ts`

## CC-Specific: Auto-Submit Flow

The three-tier trigger (see feature 12) is implemented in the input handler:

1. Trigger fires → `globalThis._localCueMap` lookup runs first (instant)
2. Words with tips get alts merged into `_dynDefs` immediately
3. Remaining words become `targetIndices`
4. If empty → skip LLM entirely
5. Otherwise → `globalThis._cueResolver.resolve()` with targeted indices (~400ms)
6. Results merge into `_dynDefs` → `_forceInputRefresh()` triggers re-render

**State variables:**
- `_dynPending` — prevents overlapping LLM requests
- `_dynLastAnalyzed` — tracks what was sent to avoid duplicates
- `_dynDebounceTimer` / `_dynFinalPauseTimer` — tier 1/2 timers

## CC-Specific: Tips File

Location: `~/.claude/claude-code-tips.json`

Hash map built at startup in `globalThis._localCueMap`. See feature 6 for the two formats (groups and words).

## CC-Specific: CueResolver Initialisation

IIFE injected at startup in cli.js:
- Loads cues-core module → `globalThis._cuesCore`
- Parses tips file → `globalThis._localCueMap`
- Creates NodeHttpAdapter (HTTPS keep-alive, Groq provider config) → `globalThis._httpAdapter`
- Creates CueResolver with GrammarSource + MathSource + FactualSource → `globalThis._cueResolver`
- Creates shared `_cycleAlt(dir)` function

**Injection point (v2.1.84+ ESM):** Must be after `var g6=Gt4(import.meta.url)`, not just after the `import{createRequire}` statement.

## CC-Specific: Provider

Default: GPT-OSS-120b via Groq. See `/docs/guides/llm-providers.md` for alternatives and benchmarks.

**Environment variables:**
- `GROQ_API_KEY` — required for default mode
- `GEMINI_API_KEY` — required if using `LLM_MODEL=gemini`
- `LLM_MODEL` — override all modes
- `LLM_MODEL_MATH` / `LLM_MODEL_FACTUAL` / `LLM_MODEL_LINKED` — per-mode overrides

## CC-Specific: Blank Handling

Classification uses cues-core's `looksLikeMath()` / `looksLikeFactual()` heuristics (no LLM classifier call for obvious cases).

**Underscore queuing:** State variables `_dynUnderscoreContext` and `_dynUnderscoreQueued` handle context changes during pending requests.

## CC-Specific: Performance

| Metric | Value |
|--------|-------|
| CueResolver avg | 471ms |
| CueResolver p50 | 405ms |
| CueResolver p90 | 708ms |
| Tips lookup | ~0-1ms |

## CC-Specific: Debugging

```bash
tail -f /tmp/claude-llm-timing-*.txt /tmp/claude-auto-debug-*.txt
```

## Config

| Option | Default | Purpose |
|--------|---------|---------|
| `enableDynamicHighlight` | `true` | Enable LLM/tips analysis |
| `dynamicHighlightDebounceMs` | `0` | Debounce delay (0 = 50ms internal) |

Requires `enableWordHighlight: true` (master switch).

## Related

- `navigation.md` — keybindings and rendering
- `cycling.md` — how Up/Down modifies words
- `status-line.md` — tip display in status bar
- `/docs/guides/llm-providers.md` — provider config and benchmarks
