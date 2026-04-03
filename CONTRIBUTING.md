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
| `blanks.md` | Blank fill-in modes (`## Prompt`) — math, factual, grammar, plus the `### classifier` that picks which mode to use. Each mode has `match`/`keywords` for fast detection and a `parser` type (`compute`, `answer`, `alternatives`, `raw`). |
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
# From repo root
node integrations/claude-code/tests/test-cues-modes.js     # Export tests
node integrations/claude-code/tests/test-blanks.js          # Blanks pipeline (66 tests)
node integrations/claude-code/tests/test-cues-core-integration.js  # Integration tests
```

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

### After making changes

```bash
# Build, deploy, and apply patches (handles everything)
integrations/claude-code/patches/setup.sh
# Then restart Claude Code
```
