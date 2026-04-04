# Contributing to OpenCues

OpenCues has three areas of contribution, each with different expectations.

## Your first contribution

The easiest way to contribute is adding a new word source to `cues.md`. This requires no code changes — just add a `### section` and the system picks it up automatically.

**Example: adding a "formal" source that suggests formal alternatives**

Add this under `## Prompt` in your `cues.md`:

````markdown
### formal

```yaml
match: \b(hi|hey|yeah|cool|ok|gonna|wanna)\b
keywords: informal, casual, slang
priority: 60
```

Suggest formal alternatives for informal words. Return one line per word:
INDEX:formal1,formal2

Examples:
- "hi" → 0:hello,greetings
- "gonna" → 0:going to,will
````

That's it. When a user types a word matching the pattern, the LLM will suggest formal alternatives. Test it by running `setup.sh` and restarting Claude Code.

For details on the config fields, see [SourceConfig fields](#sourceconfig-fields) below.

---

## 1. Contributing to the Standard

The `.md` config files are the heart of OpenCues. They define what cues are, how they're computed, and how they behave — independent of any specific editor or implementation.

| File | What it defines |
|------|-----------------|
| `cues.md` | Word tips (`## Tips`) and LLM prompt sources (`## Prompt`) for word alternatives. Each `### section` under `## Prompt` is a source — grammar, legal, medical, etc. |
| `blanks.md` | Blank fill-in modes (`## Prompt`) — math, factual, translation, unit conversion, spelling, color codes, HTTP codes, timezone, roman numerals, grammar, plus the `### classifier` that picks which mode to use. Each mode has `match`/`keywords` for fast detection and a `parser` type (`compute`, `answer`, `alternatives`, `raw`). |
| `controls.md` | Cue-controls (`## Controls`) — words that trigger external scripts instead of text cycling. |

### Adding a new word source

Add a `### section` under `## Prompt` in `cues.md`:

```markdown
### legal

\`\`\`yaml
match: contract|agreement|clause|indemnify
classify: Legal terminology
priority: 70
\`\`\`

Your prompt instructions here...
```

The `match` pattern filters which words this source handles. The prompt text becomes the LLM instruction. No code changes needed — `buildSourcesFromConfig()` picks it up automatically.

### Adding a new blank mode

Add a `### section` under `## Prompt` in `blanks.md`:

```markdown
### code

\`\`\`yaml
priority: 80
parser: alternatives
match: function|class|import|export
keywords: implement, refactor, debug
\`\`\`

Your prompt instructions here...
```

Then add examples to `### classifier` so the LLM can route to your mode.

### How blank classification works

When a blank (`_`) is encountered, the system picks which mode to use via a three-stage pipeline:

1. **`match` (regex)** — fastest. If the surrounding text matches a mode's `match` pattern, that mode is selected immediately. No LLM call needed.
2. **`keywords`** — fast. If no `match` hits, the system checks if any mode's keywords appear in the surrounding text.
3. **`### classifier` (LLM fallback)** — if neither heuristic matches, the classifier prompt is sent to the LLM, which returns the mode name.

When adding a blank mode, provide good `match` and `keywords` values to avoid unnecessary LLM calls. The classifier is a safety net, not the primary routing mechanism.

### SourceConfig fields

Each `### section` supports these yaml fields:

| Field | Type | Description |
|-------|------|-------------|
| `priority` | number | Higher = checked first (default: 50 for words, 90 for blanks) |
| `parser` | string | `alternatives` / `compute` / `answer` / `raw` (default: `alternatives`) |
| `match` | regex | Fast pre-LLM regex pattern for classification |
| `keywords` | string | Comma-separated keywords for classification |
| `model` | string | LLM model override for this source |
| `scope` | string | `words` / `blanks` / `all` (default: inferred from config file) |
| `enabled` | boolean | Set `false` to disable (default: `true`) |

## 2. Building an Integration

Integrations bring OpenCues into specific editors or tools. See `docs/guides/adding-an-integration.md` for the full guide.

The minimal integration:

```typescript
import { createResolver, buildSourcesFromConfig, parseCuesMd } from 'cues-core';

const cuesCfg = parseCuesMd(fs.readFileSync('cues.md', 'utf8'));
const blanksCfg = fs.existsSync('blanks.md')
  ? parseCuesMd(fs.readFileSync('blanks.md', 'utf8')) : undefined;

const sources = buildSourcesFromConfig(cuesCfg, blanksCfg, {
  httpAdapter, endpoint, apiKey, defaultModel,
});
const resolver = createResolver(sources);

const result = await resolver.resolve({ text, words });
```

Place your integration in `integrations/<editor>/` with:
- Integration code (patches, plugins, extensions)
- `docs/` for editor-specific documentation
- `tests/` for integration tests

## 3. Contributing to cues-core

The core library is pure TypeScript with no I/O dependencies.

### Setup

```bash
cd packages/cues-core
npm install
npm run build
```

### Running tests

```bash
cd packages/cues-core
npm run build    # compile TypeScript
npm test         # run all unit tests (418 tests)
```

The test suite has four layers:

| File | Tests | What it covers |
|------|-------|----------------|
| `src/sources/parsers.test.ts` | 43 | Response parsers: COMPUTE, ANSWER, alternatives, raw |
| `src/sources/build-sources.test.ts` | 56 | Source combining, building, error handling, resolver integration |
| `src/sources/output.test.ts` | 67 | Exact output verification for words and blanks with mocked LLM |
| `src/sources/sentences.test.ts` | 41 | Full sentence integration tests with mocked LLM |
| `src/sources/classifier.test.ts` | 196 | Fast-match routing (96) + live LLM classifier (100) |
| `src/sources/local-cue-source.test.ts` | 15 | Tips lookup, parsing, validation |

**Live LLM classifier tests** require `GROQ_API_KEY` — they call the real Groq API to verify the classifier routes ambiguous inputs correctly. Without the key, these tests are skipped automatically.

```bash
# Run with live LLM classifier tests
GROQ_API_KEY=xxx npm test
```

### Live benchmark

The benchmark runs 390 real sentences through the full pipeline with live LLM calls and saves results for comparison:

```bash
GROQ_API_KEY=xxx npx tsx tests/benchmarks/cues-core-benchmark.ts
```

Results are saved to `tests/results/cuescore-{model}-{timestamp}.json`. Compare runs to detect regressions.

Current categories benchmarked (30 tests each): word-adj, word-verb, word-noun, word-finance, blank-math, blank-factual, blank-translate, blank-unit, blank-spell, blank-color, blank-http, blank-tz, blank-roman, blank-grammar.

### Key source files

| File | Purpose |
|------|---------|
| `src/sources/config-source.ts` | Generic config-driven LLM source |
| `src/sources/classified-source-group.ts` | Blank mode classification |
| `src/sources/build-sources.ts` | Factory: .md configs to CueSource[] |
| `src/sources/parsers.ts` | Response parsers (compute, answer, alternatives, raw) |
| `src/cues-md.ts` | .md config file parser |
| `src/resolver.ts` | CueResolver orchestration |
| `src/types.ts` | Core interfaces (CueSource, CueContext, CueResult) |

### Architecture: combining vs classifying

cues-core uses two strategies for multi-source inputs. Understanding this is critical when adding sources.

**Words (combining)**: All word-scoped `alternatives`-parser sources from `cues.md` are merged into a **single LLM call** at build time. Domain prompts (grammar, legal, medical, financial) become conditional sections in one combined prompt. This is because domains can overlap — "the contract covers the diagnosis" needs grammar, legal, AND medical alternatives in the same response.

**Blanks (classifying)**: Blank-fill modes are **mutually exclusive** — an input is math OR factual OR grammar, never both. `ClassifiedSourceGroup` picks one mode via fast heuristics (regex/keywords) or LLM classifier fallback, then routes to that single source.

If you add a new `### section` to `cues.md`, it gets combined automatically — no extra LLM call. If you add a new `### section` to `blanks.md`, it becomes a new classification target. See `build-sources.ts` for the combining logic and `classified-source-group.ts` for the classification logic.

### Pitfalls discovered during testing

These issues were found during development and are worth knowing about:

**Reasoning models consume tokens differently.** Models like `openai/gpt-oss-120b` on Groq put their thinking in a `reasoning` field, not `content`. If `max_tokens` is too low, all tokens go to reasoning and `content` is empty. The classifier now checks both fields and uses `max_tokens: 200`. ConfigSource uses `max_tokens: 800` for alternatives. Always pass `reasoning_effort: "low"` via provider overrides for Groq.

**The classifier reasoning field echoes the full prompt.** When checking the reasoning field for `MODE=GRAMMAR`, the reasoning text contains the classifier prompt which lists ALL mode names. Matching bare mode names (e.g., `raw.includes('MATH')`) would always hit the first entry. Only match the `MODE=X` pattern in reasoning.

**Keyword matching needs word boundaries.** `"in french"` as a keyword would match inside `"frozen in french toast"`. The fast classifier uses word-boundary checks (non-alphanumeric characters at both ends of the match). When adding keywords, test for false positives with embedded matches.

**Fast-match priority matters.** When multiple domains have keywords that could match the same input, the highest-priority source wins. For example, math (priority 90) would beat translation (priority 85) if both match. Keep domain-specific terms in the right source's keywords — `celsius`/`fahrenheit` belong in unit conversion, not math.

**The factual regex was too broad.** The original pattern `the .+ of .+ is` matched any sentence with that structure, including "The opposite of hot is _" (spelling, not factual). Tighten regexes to include domain-specific nouns: `the (capital|ceo|founder|author|...) of .+ is`.

**Combined word sources must use the same parser.** Only sources with `parser: alternatives` and `scope: words` get combined. A source with `parser: raw` or `scope: all` stays separate and adds an extra sequential LLM call.

### After making changes

```bash
# Build, deploy, and apply patches (handles everything)
integrations/claude-code/patches/setup.sh
# Then restart Claude Code
```
