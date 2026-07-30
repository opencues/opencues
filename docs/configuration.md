# Configuration

Everything OpenCues reads from your filesystem, what each file does, and how cycleable settings flip live. For the formats defining these files, see [`spec/`](../spec/). This doc is the task-oriented user reference ("how do I do X"); the spec is the field-by-field reference (used today by config authors writing CUE.md / BLANK.md / AUDITOR.md files, and forward-looking by any future second runtime implementation).

## Directory shape

Your user-level OpenCues config lives at `~/.cues/`:

```
~/.cues/
├── OPENCUES.md                 # Runtime settings (voice-mode, tips-mode,
│                               # debug-mode, cursor-navigate, word-cues-mode,
│                               # transform-blank-mode, word-cues-mode,
│                               # agent-debounce-ms, llm-provider + per-feature
│                               # LLM keys). User-level only; project layer
│                               # cannot override.
├── IDENTITY.md                     # (Optional) your personal data, used by
│                               # fluid-blank when identity-context-mode: safe|raw.
│                               # OFF by default.
├── CUES.md                     # Cue master: project metadata + `ignore:` +
│                               # `disable:`. Frontmatter only.
├── cues/<name>/CUE.md          # Per-cue folder (spelling, more-formal, calendar, ...)
├── BLANKS.md                   # Blank master.
├── blanks/<name>/BLANK.md      # Per-blank folder (with optional colocated
│                               # scripts or runtime classes)
├── AUDITORS.md                 # Auditor master.
└── auditors/<name>/AUDITOR.md  # Per-auditor — body is the inline-rewrite
                                # prompt fragment.
```

Project-level overrides live at `<cwd>/.cues/` and merge on top of user-level for the native hosts (Claude Code, OpenCode, Gemini CLI). Chrome reads what `opencues sync chrome` has bundled (user-level by default; opt-in for projects) — see [`docs/features/chrome-sync.md`](features/chrome-sync.md).

## Search-path precedence

For native hosts, the runtime resolves configs from these locations in order — earlier shadows later:

1. **`$OPENCUES_HOME`** — env override. Top priority. Useful for CI and power users.
2. **`<cwd>/.cues/`** — project-level. Walks up from the runtime's working directory.
3. **`~/.cues/`** — user-level. Global defaults.

Missing directories are silently skipped — a user with no `.cues/` anywhere has empty config, not a crash.

`OPENCUES.md` is **user-level only** — runtime settings apply globally; projects can't override them. Every other file (CUES.md, BLANKS.md, AUDITORS.md, per-source folders) honours project-wins-on-conflict for names declared in both layers, except for `disable:` lists which subtract at the layer they appear.

Seed from the shipped defaults the first time:

```bash
pnpm exec opencues seed-configs            # user-level (~/.cues/)
pnpm exec opencues seed-configs --project  # from a project dir, into <cwd>/.cues/
```

Idempotent — copies any file that doesn't already exist at the destination, skips files you've already created.

## OPENCUES.md — runtime settings

Frontmatter keys at the top of `~/.cues/OPENCUES.md`. The same scalars are cyclable in-host via the `opencues settings _` selector-satellite blank, or live-editable in the file (hot-reload picks edits up in ~2s).

| Setting | Values | Default | Description |
|---|---|---|---|
| `voice-mode` | `active` / `inactive` | `inactive` | TTS reads tips aloud on navigation. |
| `tips-mode` | `on` / `off` | `on` | Show secondary-display tips (status line, side pane). |
| `debug-mode` | `on` / `off` | `off` | Verbose logging in the host's debug surface. |
| `cursor-navigate` | `active` / `inactive` | `inactive` | Highlight follows cursor to navigable words. |
| `word-cues-mode` | `on` / `off` | `on` | LLM word-cue surface (spelling + any custom vocabularies) registered. |
| `transform-blank-mode` | `on` / `off` | `on` | Imperative `_` + agent-task lifecycle (`agentically X _`) registered. |
| `sentence-cues-mode` | `on` / `off` | `off` | Cues with `scope: sentence` (whole-sentence rewrites) registered. |
| `fluid-config-mode` | `on` / `off` | `off` | Natural-language settings phrases (`enable debug logging _` → flips `debug-mode`). FEATURES-only scope; never routes to user blanks. |
| `blank-trigger-mode` | `immediate` / `spaced` | `immediate` | Whether `_` fires on insertion or only on a confirming space. `spaced` lets markdown `_italic_` typists keep their formatting. |
| `ambient-context-mode` | `on` / `off` | `off` | (Chrome only) Forward focused field's label / placeholder / page-title to fluid-blank for disambiguating lookups. |
| `identity-context-mode` | `off` / `safe` / `raw` | `safe` | Inject `~/.cues/IDENTITY.md` personal data into fluid-blank as identity-context tokens. `safe` = tokens-only catalog, values substituted post-LLM; `raw` = values inlined into the prompt. Defaulted to `off` before PR #161 (2026-06-18). |
| `agent-debounce-ms` | number | `1000` | Pause-after-keystroke before the inline agent fires. Misparse → 1000. |
| `llm-provider` | `cerebras` / `groq` / `openai` / `anthropic` / `openrouter` / `gemini` (+ `opencode-zen` / `ollama` / `claude-code-cli`, file-edit-only) | `cerebras` | Global fallback LLM provider, used by any bucket left on `inherit`. |
| `llm-model` | string | provider-default | Default model for the global provider. |
| `blank-context-mode` | `off` / `safe` / `raw` | `safe` | Local blanks (weather, stocks, ...) surfaced as ambient catalog context for fluid-blank/transform-blank. Same mode semantics as `identity-context-mode`; defaulted to `off` before PR #161. |
| `integration-weave-mode` | `on` / `off` | `off` | Let a blank with `integration-weave: true` weave its output into surrounding prose via one LLM call, instead of the static `{value}` template. |
| `max-thinking` | `on` / `off` | `on` | Per-model reasoning-effort ceiling for reasoning-capable models (Groq/Cerebras/OpenAI gpt-oss + gpt-5). `off` trades reasoning depth for speed. |
| `sentinel-language` | `bare` / `typed` | `bare` | `typed` upgrades identity/blank-context tokens to a typed grammar, unlocking the `ai-callable` on-demand parameterized-fetch tier. |
| `blank-loading-animation`, `blank-loading-interval-ms` | mode / number | `bounce` / `150` | Per-frame glyph + timing for the loading indicator shown at a `_` slot while its source resolves. |
| `nav-keymap` | `auto` / `ctrl-alt` / `ctrl-shift` | `auto` | Modifier combo for word navigation + alt cycling. `auto` resolves to ctrl-alt everywhere. |
| `dim-mix` | `0`-`100` | `45` | (Chrome only) How far the dim (unfocused) colour blends toward the page background. |

### LLM routing — three buckets

Most surfaces route through **three buckets**, each with one provider/model scalar pair, rather than per-surface scalars:

| Bucket | Scalars | Covers |
|---|---|---|
| `cues` | `cues-llm-provider`, `cues-llm-model` | word-cues, sentence-cues (prose-bearing) |
| `auditors` | `auditors-llm-provider`, `auditors-llm-model` | auditors, agent-rewrite (background prose rewriter) |
| `blanks` | `blanks-llm-provider`, `blanks-llm-model` | fluid-blank, transform-blank, fluid-config, keyword blanks (the opt-in `_` surface) |

Each provider scalar defaults to `inherit` (falls through to the global `llm-provider`). `blanks` is the only bucket that exposes `opencode-zen` (free pool, trains on input — the `_` keystroke is the user's consent gate); `cues` and `auditors` refuse training-pool providers since they're prose-bearing.

Precedence, highest wins: **per-source override > per-feature override > bucket scalar > global `llm-provider` > auto-fallback.** Per-aspect overrides (`word-cues-provider`, `agent-provider`, `fluid-blank-provider`, `<surface>-max-tokens`, `<surface>-temperature`, ...) remain available as file-edit-only advanced knobs, deliberately kept out of the `opencues config` menu. Full design: [`docs/architecture/llm-routing.md`](architecture/llm-routing.md).

Full reference for every key: [`packages/opencues-core/src/feature-registry.ts`](../packages/opencues-core/src/feature-registry.ts) (the FEATURES + MENU_TUNABLES single source of truth), or run `opencues config` for a browsable, always-current menu.

### Hoisted-blank writes are race-protected

When a setting flips via the in-host selector blank (`opencues settings _` → cycle to `voice-mode` → cycle to `active`), the runtime:

1. Updates `opencuesState` in-memory **synchronously**.
2. Kicks off the host's **async** file/storage write.
3. Suppresses its own ConfigLoader reload for 2.5s so the in-memory value isn't clobbered by reading the still-stale file.

If you flip a scalar by editing `~/.cues/OPENCUES.md` directly while a host is running, hot-reload picks it up on the next debounce settle (~2s on native hosts; ~300ms in chrome with `chrome-host`).

## CUES.md / BLANKS.md / AUDITORS.md — surface masters

Each surface has a master file at the root of any `.cues/` directory. Frontmatter only — the body is documentation. A missing or 0-byte master file is treated as absent (defensive against truncation).

### CUES.md

```yaml
---
name: my-project
description: Short project description
spec: opencues/0.1-alpha
tips-mode: on             # whether static tip-group cues fire
word-cues-mode: on        # whether LLM word-cue sources fire
ignore: [TODO, FIXME]     # words never to cue
disable: [spelling, example] # cue source ids to skip at this layer
---
```

`ignore:` and `disable:` are surface-scoped. `disable:` is SUBTRACT (named cues are skipped at this layer without modifying the user-level library).

### BLANKS.md

```yaml
---
name: my-project
spec: opencues/0.1-alpha
ignore: [_placeholder]    # `_`-prefixed forms that never auto-fill
disable: [stocks]         # blank ids excluded at this layer
---
```

### AUDITORS.md

```yaml
---
name: my-project
spec: opencues/0.1-alpha
disable: [grammar, jargon]  # auditor ids excluded at this layer
---
```

User-level and project-level libraries compose ADD-by-default; `disable:` is opt-in subtraction.

## Per-source folders

Cues, blanks, and auditors each live in their own folder under `cues/<name>/`, `blanks/<name>/`, `auditors/<name>/`. Every folder has an uppercase entry file:

- `cues/<name>/CUE.md` — see [`spec/cue-spec.md`](../spec/cue-spec.md)
- `blanks/<name>/BLANK.md` — see [`spec/blank-spec.md`](../spec/blank-spec.md)
- `auditors/<name>/AUDITOR.md` — see [`spec/auditor-spec.md`](../spec/auditor-spec.md)

A folder may ship sibling executables (`<name>-blank.sh`), helper scripts (`scripts/`), prompt fragments (`references/`), or assets (`assets/`). See [`spec/core.md` § Bundled resources](../spec/core.md) for what each subdir means.

### Adding a cue or blank

Scaffold via the CLI:

```bash
opencues new cue <name>                 # ~/.cues/cues/<name>/CUE.md
opencues new blank <name>               # ~/.cues/blanks/<name>/BLANK.md
opencues new cue <name> --project       # writes to <cwd>/.cues/ instead
opencues new blank <name> --dry-run     # prints the plan, creates nothing
```

`<name>` must match `/^[a-z][a-z0-9-]*$/`. The scaffold ships every supported shape inline-commented — pick one block, delete the rest. Refuses to overwrite an existing file. Hot-reload picks the new file up within ~2.5s of saving.

**Prefer copy-and-edit?** The shipped `example/` packs are deliberately tiny working references:
- [`defaults/cues/example/CUE.md`](../defaults/cues/example/CUE.md) — minimal word-cue (`hi|hey|hello` → three formal greetings)
- [`defaults/blanks/example/BLANK.md`](../defaults/blanks/example/BLANK.md) + [`time-blank.sh`](../defaults/blanks/example/time-blank.sh) — minimal script-blank (`time _` → `HH:MM`)

Each is ~30-70 lines with every field commented inline.

### Cue scopes

Cues declare `scope:` in their CUE.md frontmatter — pick what the cue operates on:

| `scope:` | What it operates on | Example shipped cue |
|---|---|---|
| `words` (default) | Each highlighted word individually. The classic "navigate to word, cycle synonyms" surface. | `defaults/cues/spelling/CUE.md`, `defaults/cues/example/CUE.md` |
| `sentence` | Whole sentences. The runtime registers a passive DynDef at the first word; cycling Up swaps the entire sentence for an alternative rewrite. | `defaults/cues/more-formal/CUE.md` |
| `blanks` | Only runs when the buffer contains `_`. Rare for cues — most blank-shaped surfaces are blanks proper. | (no shipped defaults today) |
| `all` | Runs in both prose-flow and `_`-flow contexts. | (no shipped defaults today) |

Sentence-scope cues need `sentence-cues-mode: on` in `~/.cues/OPENCUES.md` (off by default). Word-scope cues are always on if `word-cues-mode: on` (default).

### Blank shapes

A blank is a `_`-triggered slot. Four shapes — pick by what your blank does:

| Shape | Trigger | Implementation |
|---|---|---|
| **Typed blank with script** | `volume _`, `brightness _` | `BLANK.md` + `<name>-blank.sh` (responds to `get` / `set <value>`) |
| **List blank** (no script) | `affirmation _` | `BLANK.md` with `stepValues: [...]` |
| **Selector + Satellite** | `opencues settings _` → expands to `<setting> <value>` | `BLANK.md` with `blankSatellite: true` |
| **Runtime-class blank** (LLM/HTTP) | `nvda _`, `weather _`, `define X _` | TS class in `packages/opencues-runtime/src/blanks/` + `BLANK.md` declaring `blankKeywords` |

For free-form `_` lookups (`capital of france _`, `unicode for em dash _`) there's no per-blank config — `FluidBlankSource` handles any `_` the keyword-bound blanks didn't claim.

Full guide: [`docs/guides/adding-a-cue-blank.md`](guides/adding-a-cue-blank.md).

## Word-cue routing

Every `### alternatives` section in `CUES.md` (or `cues/<name>/CUE.md`) becomes one `ConfigSource`. `buildSourcesFromConfig` wraps the whole set in ONE `RoutedWordSourceGroup` that dispatches each highlighted word to **exactly one** child source — never combines them into a giant prompt.

Routing per word: walk every source in priority-descending order, claim each word for the FIRST source whose `match:` regex hits or whose `keywords:` list contains the word. If no source claims it, the word isn't navigable.

```yaml
# Vocabulary cue — high priority, narrow match
name: concise
priority: 70
match: very|really|just|actually

# Catch-all fallback — low priority, broad match
name: spelling
priority: 10
match: .*
```

With this layout: `very` → concise (priority 70 > spelling 10); `hello` → spelling (no narrow match, spelling's `.*` catches it). Flip priorities and spelling would suppress every other cue.

Why per-word dispatch matters (and why we don't merge prompts):

- **Isolation** — a hijacking prompt in one source cannot poison words that source isn't called for.
- **Symmetry** — each word gets ONE source, the way each `_` gets ONE blank (`BlankSource` matches on `blankKeywords`, falling back to `FluidBlankSource` for unbound `_`).

Full spec: [`docs/features/word-cue-routing.md`](features/word-cue-routing.md).

## IDENTITY.md — personal-data injection (opt-in)

When `identity-context-mode: safe` (or `: raw`) is set in `OPENCUES.md`, the runtime reads `~/.cues/IDENTITY.md` frontmatter and forwards it to FluidBlankSource as a catalog of identity-context tokens for personalising `_` lookups.

```yaml
---
firstName:    Wilfred
lastName:     Kasekende
email:        wilfred@example.com
workCity:     London
homeCountry:  UK
github:       https://github.com/wkasekende
---
```

In `safe` mode (recommended), the LLM only sees a catalog of token names + descriptions (`[EMAIL] — user's email`); it emits tokens like `[EMAIL]`, and a runtime post-processor swaps in the real value AFTER the response — your PII never reaches the provider's logs.

In `raw` mode, actual values inline into the prompt (better prose register for transform-blank-style outputs, worse privacy). Sensitive fields (password / OTP / payment / PII heuristics) refuse to attach regardless of mode.

Full design + threat model: [`docs/architecture/identity-context.md`](architecture/identity-context.md). Default-off until you flip the scalar.

## Hot-reload

Every `.md` file under the search path is polled per text-change event (debounced). Edits land in ~2s on native hosts; ~300ms in chrome with `chrome-host` installed (via `fs.watch` over the native-messaging pipe).

When a runtime mutates `OPENCUES.md` (e.g. `opencues settings _` flipping a scalar), it suppresses its own re-read for 2.5s to avoid races where the in-memory state and the file disagree mid-flight. See [`packages/opencues-runtime/src/modules/config-loader.ts`](../packages/opencues-runtime/src/modules/config-loader.ts) for the `_suppressReloadUntil` guard.

## See also

- [`spec/`](../spec/) — the standards themselves (`CUE.md`, `BLANK.md`, `AUDITOR.md`, master files, runtime contracts)
- [`spec/conformance/`](../spec/conformance/) — executable fixture tree; used today as `@opencues/core`'s parser regression suite, available to any future second runtime
- [`docs/glossary.md`](glossary.md) — terminology reference
- [`docs/features/`](features/) — 40+ feature concepts grouped into 10 chapters
- [`docs/architecture/`](architecture/) — deep dives on each pipeline (transform-blank, agent-rewrite, fluid-config, sentence-cues, ambient/user context, ...)
- [`docs/guides/llm-providers.md`](guides/llm-providers.md) — per-provider setup, per-feature routing, bench data
- [`docs/guides/adding-a-cue-blank.md`](guides/adding-a-cue-blank.md) — authoring a new cue or blank from scratch
