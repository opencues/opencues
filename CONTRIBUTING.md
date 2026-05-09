# Contributing to OpenCues

Thank you for your interest in OpenCues. This guide covers what you need to know to contribute.

OpenCues has three areas of contribution, each with different expectations. Pick the one that fits — you don't need to understand the whole system to contribute a word source or blank mode.

## Good first issues

If you're new, look for issues labelled **`good first issue`** on GitHub. These are typically:

- Adding a new domain word source under `cues/{name}/cue.md` (no code changes)
- Adding a new keyword-bound blank under `blanks/{name}/cue.md` (config + script or runtime class)
- Fixing typos or improving docs
- Adding test cases to `tests/user-test.md`

## Your first contribution

The easiest way to contribute is adding a new domain word source. This requires no code changes — just create a folder under `cues/` and the system picks it up automatically via per-word routing.

**Example: adding a "formal" source that claims informal words and suggests formal alternatives**

Create `cues/formal/cue.md`:

````markdown
---
name: formal
scope: words
priority: 60
match: \b(hi|hey|yeah|cool|ok|gonna|wanna)\b
classify: Informal-to-formal substitutions
---

Suggest formal alternatives for informal words. Return one line per word:
INDEX:formal1,formal2

Examples:
- "hi" → 0:hello,greetings
- "gonna" → 0:going to,will
````

When a user types one of those words, `RoutedWordSourceGroup` dispatches it to your source (the `match:` regex claims the word). Words not claimed by any source stay uncoloured. Test by saving the file — configs hot-reload within ~2.5s on the next keystroke (no restart needed).

For details on the config fields, see [SourceConfig fields](#sourceconfig-fields) below.

---

## 1. Contributing to the Standard

The `.md` config files are the heart of OpenCues. They define what cues are, how they're computed, and how they behave — independent of any specific editor or implementation.

| File/Folder | What it defines |
|------|-----------------|
| `cues.md` | Top-level system settings (frontmatter only): `voice-mode`, `tips-mode`, `debug-mode`, etc., the nested `settings:` block, and the `ignore:` array. No cue/blank data. |
| `cues/{name}/cue.md` | Folder-based cue source — config in YAML frontmatter. Static cues put a JSON words map in the body; LLM cues declare `match:`/`keywords:` and put the prompt in the body. |
| `blanks/{name}/cue.md` | Folder-based blank with colocated script (e.g., `blankScript: ./volume-blank.sh`) or pointing at a runtime class. |

### Adding a new word source

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

Picked up automatically by `buildSourcesFromConfig()` via folder discovery.

**Per-word routing.** `RoutedWordSourceGroup` dispatches each highlighted word to ONE child source — never combines them into a giant prompt. The first source whose `match:` or `keywords:` claims the word wins (highest priority breaks ties). Words no source claims get no cue — they're not navigable.

Every word-cue source MUST declare `match:` or `keywords:` — sources without either are dropped at runtime (`opencues validate` warns). If you genuinely want a catch-all, declare it explicitly (`match: .*`).

### Adding a new blank

Pick a shape:

| Shape | Trigger | Implementation |
|---|---|---|
| **Typed blank with script** | `volume _`, `brightness _` | `blanks/<name>/cue.md` + `<name>-blank.sh` (responds to `get` / `set <value>`) |
| **List blank** (no script) | `affirmation _` | `blanks/<name>/cue.md` with `stepValues: [...]` |
| **Selector + Satellite** | `opencues settings _` | `blanks/<name>/cue.md` with `blankSatellite: true` |
| **Runtime-class blank** (LLM/HTTP) | `nvda _`, `weather _` | TS class in `packages/opencues-runtime/src/blanks/` + `blanks/<name>/cue.md` declaring `blankKeywords` (no `blankScript:`) |

The cue.md frontmatter:

```yaml
---
name: <name>
blankKeywords: <comma-separated triggers>
blankScript: ./<name>-blank.sh    # for shape 1
# or: stepValues: ["a", "b", "c"]  # for shape 2
# or: blankSatellite: true         # for shape 3
# or: (nothing extra)              # for shape 4 — class is registered in code
---
```

`BlankSource` watches every `_` in the input. If any `blankKeywords` phrase sits within `blankProximity` words of the `_`, that blank claims the slot. Otherwise the slot falls through to `FluidBlankSource` (free-form LLM lookup) when `fluid-blank-mode: on`.

See [docs/guides/adding-a-cue-blank.md](docs/guides/adding-a-cue-blank.md) for the full step-by-step.

### SourceConfig fields

Each `cues/<name>/cue.md` supports these YAML frontmatter fields:

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
import { createResolver, buildSourcesFromConfig, parseCuesMd, discoverFolderConfigs } from 'opencues-core';

const cuesCfg = parseCuesMd(fs.readFileSync('cues.md', 'utf8'));
const cuesFolders = await discoverFolderConfigs('.cues/cues', fsAdapter);
const blanksFolders = await discoverFolderConfigs('.cues/blanks', fsAdapter);

const sources = buildSourcesFromConfig(cuesCfg, cuesFolders, blanksFolders, {
  httpAdapter, endpoint, apiKey, defaultModel,
});
const resolver = createResolver(sources);

const result = await resolver.resolve({ text, words });
```

Place your integration in `integrations/<editor>/` with:
- Integration code (patches, plugins, extensions)
- `docs/` for editor-specific documentation
- `tests/` for integration tests

## 3. Contributing to opencues-core

The core library is pure TypeScript with no I/O dependencies.

### Setup

```bash
# From the repo root (pnpm workspace)
pnpm install
pnpm build
```

### Running tests

```bash
pnpm --filter @opencues/core test        # opencues-core unit tests
pnpm --filter @opencues/runtime test     # runtime tests (350)
pnpm test                                # all packages, via turbo
```

The test suite covers parsers, source building, per-word routing, blank dispatch, the fluid-blank pipeline, and end-to-end LLM behaviour with mocks. ~365 unit tests in core.

### Live benchmarks

Live LLM benchmarks live under `tests/benchmarks/` (TypeScript runners, one per pipeline):

```bash
GROQ_API_KEY=xxx npx tsx tests/benchmarks/agent-rewrite/run.ts        # AgentRewrite cadence + merge
GROQ_API_KEY=xxx npx tsx tests/benchmarks/transform-blank/run.ts      # 3-pass imperative pipeline
GROQ_API_KEY=xxx npx tsx tests/benchmarks/fluid-blank/run.ts          # free-form `_` lookup
```

Each runner emits a deterministic provider-router (default Groq + `gpt-oss-120b`); set `OPENCUES_BENCH_PROVIDER=gemini-flash-lite` to compare against Gemini. Results land in `tests/results/`. Word alternatives are inherently non-deterministic across runs; treat the score as a trend signal, not a pass/fail gate.

### Key source files

| File | Purpose |
|------|---------|
| `src/sources/config-source.ts` | Generic config-driven LLM source |
| `src/sources/routed-word-source-group.ts` | Per-word routing for folder-based cue sources |
| `src/sources/blank-source.ts` | Keyword-bound blank dispatcher (auto-populate + cycling) |
| `src/sources/fluid-blank-source.ts` | Free-form `_` lookup (P1 segment + P3 answer) |
| `src/sources/spelling-source.ts` | Typo correction on plain text |
| `src/sources/build-sources.ts` | Factory: .md configs → CueSource[] |
| `src/sources/parsers.ts` | Response parsers (math, compute, answer, alternatives, raw) |
| `src/cues-md.ts` | .md config file parser |
| `src/resolver.ts` | CueResolver orchestration |
| `src/types.ts` | Core interfaces (CueSource, CueContext, CueResult) |

### Architecture: per-word routing for cues, keyword binding for blanks

opencues-core has two dispatch strategies aligned with the dual-direction concept (see [concept.md](concept.md)).

**Words (per-word routing — `RoutedWordSourceGroup`).** Each highlighted word goes to ONE child source: the first domain whose `match:` or `keywords:` claims the word wins; otherwise the highest-priority default catches it. Words destined for the same source batch into one parallel LLM call — request rate stays linear in source count, not exponential. Resolver runs with `parallel: true`.

**Blanks (keyword binding — `BlankSource`).** Each `_` is bound to ONE blank: the first registered blank whose `blankKeywords` matches a phrase within `blankProximity` words of the `_` claims the slot. No classifier LLM call — the match is a substring scan. Slots no blank claimed fall through to `FluidBlankSource` (P1 segment + P3 answer — two LLM calls for free-form lookups) when `fluid-blank-mode: on`.

**Why no combining.** Earlier OpenCues combined word sources into one prompt. That broke down past ~5 sources (LLM confused by overlapping instructions) and let one bad source poison every word. Per-word routing is isolation-safe and scales linearly.

**Why no classifier for blanks.** Earlier OpenCues classified blanks into modes (math / factual / translation / etc.) via an LLM. After the fluid-blank pipeline shipped, fluid-blank's general P1+P3 prompts beat the classifier on benchmarks while saving the routing LLM call. The classifier pipeline (`ClassifiedSourceGroup`) was removed entirely.

If you add a new `cues/<name>/cue.md`, `RoutedWordSourceGroup` picks it up at next config load. If you add `blanks/<name>/cue.md` with `blankKeywords:`, `BlankSource` registers it. See `build-sources.ts` for the wiring.

### Pitfalls

**Reasoning models consume tokens differently.** Models like `openai/gpt-oss-120b` on Groq put their thinking in a `reasoning` field, not `content`. If `max_tokens` is too low, all tokens go to reasoning and `content` is empty. `ConfigSource`, `FluidBlankSource`, and `SpellingSource` all check both fields and pass `reasoning_effort: "low"` in their request bodies — Groq-specific and ignored by other providers.

**Keyword matching needs word boundaries.** `"in french"` as a keyword would match inside `"frozen in french toast"`. `BlankSource.blankKeywords` matches whole words/phrases (split on whitespace, consecutive match). When adding keywords, test for false positives with embedded matches.

**Priority breaks ties between domain sources.** When multiple `cues/<name>/cue.md` domains could match the same word, the highest-priority `priority:` wins. Default sources (no `match:`/`keywords:`) only fire on words no domain claimed.

**`blankProximity` defines how far the keyword can sit from `_`.** Default 0 (adjacent). For phrases that need looser matching ("dictionary _" elsewhere in a sentence), bump it: `blankProximity: 5`.

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
- **Follow existing patterns** — look at how existing blanks, sources, or features are built before starting something new.
- **Docs matter** — if you add a config field, document it in the relevant feature doc and the config table. If you add a feature, add test cases to `tests/user-test.md`.
