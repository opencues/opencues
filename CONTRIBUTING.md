# Contributing to OpenCues

Thank you for your interest in OpenCues. This guide covers what you need to know to contribute.

OpenCues has three areas of contribution, each with different expectations. Pick the one that fits — you don't need to understand the whole system to contribute a word source or blank mode.

## Good first issues

If you're new, look for issues labelled **`good first issue`** on GitHub. These are typically:

- Adding a new word source to `cues.md` (no code changes)
- Adding a new blank mode to `blanks.md` (config + prompt only)
- Adding a new cue-control in `controls/{name}/` (config + shell script)
- Fixing typos or improving docs
- Adding test cases to `tests/user-test.md`

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

That's it. When a user types a word matching the pattern, the LLM will suggest formal alternatives. Test it by saving the file — config changes hot-reload within ~2 seconds on the next keystroke (no restart needed).

For details on the config fields, see [SourceConfig fields](#sourceconfig-fields) below.

---

## 1. Contributing to the Standard

The `.md` config files are the heart of OpenCues. They define what cues are, how they're computed, and how they behave — independent of any specific editor or implementation.

| File/Folder | What it defines |
|------|-----------------|
| `cues.md` | Word tips (`## Tips`) and base LLM prompt (`## Prompt`). Domain sources can also be `### sections` here. |
| `cues/{name}/cue.md` | Folder-based word source — config in YAML frontmatter, prompt in body. Overrides same-name monolithic section. |
| `blanks.md` | Blank fill-in modes — math, factual, translation, etc., plus the `### classifier`. |
| `controls.md` | Cue-controls — words that trigger external scripts (can be empty if using folders). |
| `controls/{name}/cue.md` | Folder-based control with colocated script (e.g., `script: ./volume.sh`). |

### Adding a new word source

**Option A: Folder (recommended for domain sources)**

Create `cues/{name}/cue.md`:

```markdown
---
name: legal
scope: words
priority: 70
match: contract|agreement|clause|indemnify
classify: Legal terminology
---

Your prompt instructions here...
```

**Option B: Monolithic section in cues.md**

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

Both are picked up automatically by `buildSourcesFromConfig()`. Folder configs override same-name monolithic sections.

**Important:** All word-scoped `alternatives`-parser sources get combined into a single LLM call. Domain sources (with a `match` regex) get a conditional header ("When the input contains terms like ..."), so the LLM only applies them for matching words. But sources **without** a `match` regex are treated as base instructions — their prompts are concatenated unconditionally. If you add a second base source (e.g., `### creative` alongside `### grammar`), both prompts will apply to every word. Make sure their instructions are complementary, not contradictory — "prefer concise synonyms" and "suggest wild unexpected alternatives" in the same prompt will confuse the LLM. If your new source is domain-specific, always include a `match` regex.

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

Then you **must** also update `### classifier` in two places:

1. Add examples for your mode so the LLM knows when to select it
2. Add your mode name to the `Output ONLY: MODE=...` line

**If you skip this step**, inputs that miss your `match`/`keywords` fast-path will fall through to the LLM classifier, which won't know your mode exists and will route to grammar instead. Your mode will only work for inputs that hit the fast-match — anything ambiguous will silently misclassify.

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
| `parser` | string | `math` (safe arithmetic) / `answer` / `alternatives` / `raw` / `compute` (⚠️ unsafe — uses Function(), see below) (default: `alternatives`) |
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
# From the repo root (pnpm workspace)
pnpm install
pnpm build
```

### Running tests

```bash
pnpm --filter @opencues/core test        # cues-core unit tests
pnpm --filter @opencues/runtime test     # runtime tests (350)
pnpm test                                # all packages, via turbo
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
GROQ_API_KEY=xxx pnpm --filter @opencues/core test
```

### Live benchmark

The benchmark runs 390 real sentences through the full pipeline with live LLM calls and saves results for comparison:

```bash
GROQ_API_KEY=xxx npx tsx tests/benchmarks/cues-core-benchmark.ts
```

Results are saved to `tests/results/cuescore-{model}-{timestamp}.json`. Compare runs to detect regressions.

Current categories benchmarked (30 tests each): word-adj, word-verb, word-noun, word-finance, blank-math, blank-factual, blank-translate, blank-unit, blank-spell, blank-color, blank-http, blank-tz, blank-roman, blank-grammar.

**Benchmark stability note:** Structured blank domains (math, factual, translation, color, HTTP, etc.) are highly stable — deterministic answers, consistent pass rates across runs. Word alternatives are inherently non-deterministic (~41% of word tests are flaky across runs) because the LLM returns valid synonyms that may not be in the expected list. Use the benchmark for **trend detection** (did a change make word accuracy worse overall?) not as a strict pass/fail gate. The total pass rate should stay above ~90%; a significant drop indicates a regression.

### Key source files

| File | Purpose |
|------|---------|
| `src/sources/config-source.ts` | Generic config-driven LLM source |
| `src/sources/classified-source-group.ts` | Blank mode classification |
| `src/sources/build-sources.ts` | Factory: .md configs to CueSource[] |
| `src/sources/parsers.ts` | Response parsers (math, compute, answer, alternatives, raw) |
| `src/cues-md.ts` | .md config file parser |
| `src/resolver.ts` | CueResolver orchestration |
| `src/types.ts` | Core interfaces (CueSource, CueContext, CueResult) |

### Architecture: combining vs classifying

cues-core uses two strategies for multi-source inputs. Understanding this is critical when adding sources.

**Words (combining)**: All word-scoped `alternatives`-parser sources from `cues.md` are merged into a **single LLM call** at build time. Domain prompts (grammar, legal, medical, financial) become conditional sections in one combined prompt. This is because domains can overlap — "the contract covers the diagnosis" needs grammar, legal, AND medical alternatives in the same response.

**Blanks (classifying)**: Blank-fill modes are **mutually exclusive** — an input is math OR factual OR grammar, never both. `ClassifiedSourceGroup` picks one mode via fast heuristics (regex/keywords) or LLM classifier fallback, then routes to that single source.

**Why blanks can't be combined like words**: Word combining works because every domain uses the **same output format** (`INDEX:alt1,alt2,alt3`). Blank modes use **different parsers** — math outputs `COMPUTE=expression`, factual outputs `ANSWER=value`, grammar outputs `INDEX:word1,word2,word3`. Combining them into one prompt would force the LLM to pick the right format AND produce the answer — two decisions in one call. With 10 blank domains, that's 10 conflicting output formats in one prompt, which would overwhelm the LLM and degrade accuracy. Classifying first (one cheap decision) then routing to a focused prompt (one clear task) keeps each call simple and reliable.

**Why combining instead of parallel execution**: The resolver runs with `parallel: false`. An alternative fix for the 3x word-source slowdown would have been `parallel: true`, but that fires N concurrent API calls per keystroke — tripling the request rate to Groq and risking rate limits during fast typing. Combining into one call keeps the request rate at 1:1 and produces better results since the LLM sees all domain context together.

If you add a new `### section` to `cues.md`, it gets combined automatically — no extra LLM call. If you add a new `### section` to `blanks.md`, it becomes a new classification target. See `build-sources.ts` for the combining logic and `classified-source-group.ts` for the classification logic.

### Pitfalls discovered during testing

These issues were found during development and are worth knowing about:

**Reasoning models consume tokens differently.** Models like `openai/gpt-oss-120b` on Groq put their thinking in a `reasoning` field, not `content`. If `max_tokens` is too low, all tokens go to reasoning and `content` is empty. The classifier now checks both fields and uses `max_tokens: 200`. ConfigSource uses `max_tokens: 800` for alternatives. Both `ConfigSource` and `ClassifiedSourceGroup` now include `reasoning_effort: "low"` in their request bodies — this is a Groq-specific field that non-Groq providers ignore. This ensures cues-core works correctly out of the box without requiring the integration's HTTP adapter to inject provider overrides.

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

---

## Contributor expectations

- **Keep PRs focused** — one feature or fix per PR. If you find something else to fix along the way, open a separate PR.
- **Test manually** — run `setup.sh`, restart Claude Code, and verify your change works. Describe what you tested in the PR.
- **Run the test suite** for `@opencues/core` changes: `pnpm --filter @opencues/core test`
- **Don't break hot-reload** — config file changes (`.md`) must not require a restart. Patch file changes (`.ts`) must not require re-running `setup.sh` more than once.
- **Follow existing patterns** — look at how existing controls, sources, or features are built before starting something new.
- **Docs matter** — if you add a config field, document it in the relevant feature doc and the config table. If you add a feature, add test cases to `tests/user-test.md`.
