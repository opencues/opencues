# Hardcoded Features

Features and values that are hardcoded in patch code or cues-core rather than driven by `.md` config files. Each should eventually be configurable.

---

## User-Facing Behaviour

### Stop-words list
- **What:** Common words skipped during LLM analysis (`the`, `a`, `an`, `to`, `is`, `was`, `of`, `and`, `in`, `on`, `at`, `for`, `it`, `its`, `be`, `am`, `are`, `were`, `been`, `has`, `had`, `have`, `do`, `did`, `does`, `not`, `but`, `or`, `if`, `so`, `no`, `my`, `we`, `he`, `she`, `me`, `us`, `them`, `this`, `that`, `with`, `from`, `by`, `as`)
- **Where:** `dynamicHighlight.ts` line ~698
- **Proposed:** `cues.md` frontmatter or `## Ignore` section (partially exists for user-defined ignores)

### Blank marker character
- **What:** `_` is the blank placeholder
- **Where:** Hardcoded throughout cues-core and patches (~20 locations)
- **Proposed:** `blanks.md` frontmatter `blankMarker: _`

### Number-to-word conversion
- **What:** Numbers 0-20 converted to English words before sending to LLM for word-scoped analysis
- **Where:** `config-source.ts` lines 41-43 (hardcoded array of 21 English words)
- **Proposed:** Remove entirely or make configurable via `cues.md` frontmatter

### Answer length limit
- **What:** `ANSWER=` responses longer than 100 characters are rejected
- **Where:** `parsers.ts` line 115
- **Proposed:** `blanks.md` per-mode config `maxLength: 100`

### Math precision
- **What:** Math results rounded to 4 decimal places
- **Where:** `parsers.ts` line 82
- **Proposed:** `blanks.md` math mode config `precision: 4`

---

## LLM Parameters

### Tokens per parser type
- **What:** `math`/`compute`/`answer` use 200 tokens, `alternatives` uses 800
- **Where:** `config-source.ts` line 106
- **Proposed:** Per-source config in `.md` files: `maxTokens: 200`

### Temperature per parser type
- **What:** `math`/`compute`/`answer` use 0.1, `alternatives` uses 0.3
- **Where:** `config-source.ts` line 107
- **Proposed:** Per-source config: `temperature: 0.1`

### Reasoning effort
- **What:** Hardcoded to `"low"` for all sources
- **Where:** `config-source.ts` line 117
- **Proposed:** Per-source config: `reasoningEffort: low`

---

## Timing

### Debounce timings
- **What:** Space typed = 50ms, final pause = 300ms, word edited = 50ms
- **Where:** `dynamicHighlight.ts` lines 263, 607
- **Proposed:** `cues.md` frontmatter: `debounceMs: 50`, `pauseMs: 300`

### Config hot-reload TTL
- **What:** 2000ms between config file re-reads
- **Where:** `dynamicHighlight.ts` line 511
- **Proposed:** `cues.md` frontmatter: `configTtlMs: 2000`

### TTS tip delay
- **What:** 100ms delay before speaking tips
- **Where:** `dynamicHighlight.ts` lines 406, 819
- **Proposed:** `cues.md` frontmatter or per-control: `ttsDelay: 100`

---

## Integration-Specific (not `.md` — belongs in integration config)

### ANSI colour codes
- **What:** 5 highlight styles hardcoded (cyan, yellow, inverse, underline, white)
- **Where:** `wordHighlight.ts` lines 835-848
- **Note:** Selected via `highlightColor` config, but the codes themselves are hardcoded

### Keyboard shortcuts
- **What:** Ctrl+Alt+Left/Right/Up/Down, Escape
- **Where:** `wordHighlight.ts` (Ink handlers + raw escape sequences)
- **Note:** Integration-specific — different editors have different key systems

### File paths
- **What:** TTS script (`~/.claude/actions/speak.sh`), highlight export (`/tmp/claude-highlight-state-{pid}.json`)
- **Where:** `dynamicHighlight.ts`, `wordHighlight.ts`
- **Note:** Could be in `~/.tweakcc/config.json`

### HTTP configuration
- **What:** Timeout (30s), socket pool (2), warmup timeout (1s)
- **Where:** `dynamicHighlight.ts` lines 210-216
- **Note:** Could be in `cues.md` frontmatter or integration config
