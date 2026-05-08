# OpenCues — OpenStandard Notes

> **Living spec.** Captures the file layout, naming conventions, and ownership boundaries the OpenCues OpenStandard ships with. Anything not specified here is implementation detail.

---

## 1. Core concept

The standard reduces to **two directions of intent** on text:

| Direction | Surface | Trigger | What it is |
|---|---|---|---|
| **System → User** | **Cues** (highlights, alts) | plain text | The system offers alternatives the user didn't ask for |
| **User → System** | **Blanks** (substitutions) | text containing `_` | The user explicitly summons a value into a slot |

Every feature of the standard is one of these two things, dressed up.

The two **scopes** mirror the directions:
- `words` scope: cues fire on plain text (no `_` in input)
- `blanks` scope: cues fire on `_` slots

Cues and blanks are **sibling concepts**, not subtypes. They live as siblings in the layout (see §4).

---

## 2. Brand vs standard

Two namespaces. Keeping them separate makes implementations interchangeable.

| Term | What it is | Where it appears |
|---|---|---|
| **Cues** (the standard) | The OpenStandard for cueing text. Defines data shapes, file layout, scopes, parsers. | `.cues/`, `cues.md`, scope names (`words`, `blanks`), data shapes |
| **OpenCues** (the brand) | Anthropic's reference implementation: the runtime, the CLI, the integrations. | `opencues` CLI, `@opencues/*` packages, `OPENCUES.md`, repo name |

**Rule of thumb:** anything universal across implementations uses the standard's vocabulary. Anything that's runtime-specific or tool-specific uses the brand's vocabulary.

| Brand-owned | Standard-owned |
|---|---|
| `~/.cues/OPENCUES.md` (user runtime config) | `~/.cues/cues.md` + `~/.cues/blanks.md` (user cue/blank libraries) |
| `opencues install <host>` | `cues.md` (project manifest) |
| `@opencues/core`, `@opencues/runtime` (npm packages) | The data format inside cue.md / cues.md / source files |
| Settings schema (voice-mode, debug-mode, etc. — runtime-defined) | Source schema (match, keywords, scope, parser — standard-defined) |

A second OpenStandard implementation (FastCues, AnotherCues, …) would ship its own `~/.fastcuesrc` etc., but read the same `~/.cues/` library and the same `<project>/cues.md` manifests. The brand is replaceable; the standard isn't.

---

## 3. File layout

### User level (`$HOME`)

```
~/.cues/                 # user cue library — the standard's data
├── OPENCUES.md          # user runtime config — OpenCues tool's prefs (brand)
├── cues.md              # cue master file (project-overridable)
├── cues/                # per-cue files — domain word-cues
│   ├── tips.md          # static cue source (body JSON)
│   ├── legal.md         # LLM cue source (frontmatter match: + prompt body)
│   ├── medical.md
│   ├── financial.md
│   └── spelling.md      # spell-correction cue (regular ConfigSource, priority 80)
├── blanks.md            # blank master file
└── blanks/              # per-blank files
    ├── volume/          # folder when scripts are colocated
    │   ├── BLANK.md
    │   └── volume-blank.sh
    ├── stocks.md        # flat file when no script needed (runtime class)
    ├── weather.md
    └── ...
```

### Project level (a repo)

```
<project>/.cues/
├── cues.md              # project cue master (overrides user cues.md on conflicts)
├── cues/
│   └── project-jargon.md
├── blanks.md            # project blank master
└── blanks/
    └── project-blank/
        ├── BLANK.md
        └── project-blank.sh
```

Project layout mirrors user layout under `.cues/`. There is **no project-level OPENCUES.md** — the runtime config is user-level only, since system-wide settings (voice-mode, debug-mode, llm-provider, …) shouldn't change behaviour silently when you `cd` into a project.

---

## 4. Naming conventions

### `OPENCUES.md` — user runtime config

- **Format:** Markdown with YAML frontmatter; body is documentation. Sits alongside `cues.md` / `blanks.md` / `auditors.md` (planned) at the top of `~/.cues/`.
- **Content:** system settings (voice-mode, debug-mode, tips-mode, cursor-navigate, fluid-blank-mode, word-cues-mode), nested `settings:` block (per-setting tip + values), LLM provider overrides (`llm-provider`, `llm-model`, per-feature `<feature>-provider` / `<feature>-model`).
- **Schema owner:** the OpenCues runtime. Users edit values; the schema is fixed by the implementation.
- **Rationale for the name:** matches the repo's "uppercase-special, lowercase-content" convention (`CLAUDE.md`, `README.md`, `LICENSE`, `BLANK.md` for folder-blank masters). Uppercase signals "this configures the system, not category data." Sits inside `~/.cues/` rather than `$HOME` so the runtime install owns one consistent directory.
- **Earlier names retired:** `.opencuesrc` (rc-style YAML at `$HOME`), `opencues.md` (lowercase, predecessor). `seed-configs` migrates both to the new location on first run.

### `cues.md` — project manifest

- **Format:** Markdown with YAML frontmatter. Body is human-readable description.
- **Content:** project metadata (`name`, `description`), `ignore` list, `disable` list (cue sources to suppress in this project), `requires` (compatibility gate), optional project-specific `words:` map, optional `llm-model` override.
- **Schema owner:** the standard.
- **Rationale for the name:** matches `package.json`, `Cargo.toml`, `.editorconfig` — visible, generic, brand-neutral. Drops at the root of a repo and signals "this project speaks Cues" to any reader. Markdown body lets the project document its OpenCues setup inline (a tiny CONTRIBUTING.md for the cue domain).

### `~/.cues/` and `<project>/.cues/` — cue library directory

- **Naming:** standard-named (`cues`), no brand. Both implementations and projects use this layout.
- **Asymmetry on visibility:** user-level is **dotted** (`.cues/`) per Unix convention for hidden user configs. Project-level is **dotted** (`.cues/`) so it doesn't clutter `ls` at a project root. Visibility comes from `cues.md` at the project root, not the cues directory.
- **Contents:** two scope subdirectories, `words/` and `blanks/`. No other top-level entries.

### `cues/` and `blanks/` — per-item subdirs

- **Naming:** matches the master file at the same level (`cues.md` + `cues/`, `blanks.md` + `blanks/`). The master file holds category-wide settings + inline definitions for short items; the folder holds standalone per-item files.
- **Symmetry:** both plural, both can contain flat `.md` files or folders. Visual: `ls .cues/` → `cues.md  cues/  blanks.md  blanks/  OPENCUES.md`.
- **Earlier name retired:** `words/` was used for an interim period to avoid confusion with the broader "cues" paradigm at a time when `.opencuesrc` lived as a sibling and "OpenCues settings" got conflated with "cues category." Once settings moved into `OPENCUES.md` (uppercase, distinct enough from `cues.md`), the naming-collision rationale dissolved and `cues/` was restored. `words/` is accepted as a legacy alias by the runtime and migrated by `seed-configs`.

### Source files inside `words/` and `blanks/`

- **Flat file (`<name>.md`)**: when the source has no colocated assets.
  - All word-cues: flat. They never need scripts (LLM cues are pure prompts; static cues are pure data).
  - Blanks backed by a runtime class (StocksBlank, WeatherBlank, etc.): flat.
- **Folder (`<name>/cue.md`)**: when the source has colocated assets (scripts, helpers, .cs files for compilation).
  - Most blanks with a `blankScript:` reference.

The runtime accepts both shapes for any source. Folder-vs-flat is purely a "do I have stuff to colocate?" question.

### Source naming inside source files

- Flat: filename **is** the source name. `legal.md` → source `legal`.
- Folder: folder name is the source name. `volume/cue.md` → source `volume`. Frontmatter `name:` should match the folder name (the validator warns if not).

---

## 5. Ownership matrix

Who is allowed to write each piece, and at what scope.

| Path | Schema owner | Write scope | Hot-reload? |
|---|---|---|---|
| `~/.cues/OPENCUES.md` | runtime (OpenCues) | user-level only | yes (next keystroke) |
| `~/.cues/cues/<name>.md` | standard | user (own library) | yes |
| `~/.cues/blanks/<name>/...` | standard | user (own library) | yes |
| `<project>/.cues/cues.md` | standard | project author | yes |
| `<project>/.cues/cues/<name>.md` | standard | project author | yes |
| `<project>/.cues/blanks/<name>/...` | standard | project author | yes |

### What overrides what

Resolution order at runtime (highest priority first):

1. `$OPENCUES_HOME` (env override — for CI / containers / tests)
2. `<cwd>/.cues/` (project-level overrides)
3. `~/.cues/` (user-level baseline)

Settings are user-level only — projects do **not** override `~/.cues/OPENCUES.md`. Projects override **content** (cue sources, blank registrations, ignore list) but never the runtime's behavior toggles. Reasoning: cd'ing into a project should not silently change whether TTS speaks, which LLM provider is used, etc. Those are user prefs.

A project's `cues.md` ignore list **adds to** the user's ignore list. A project's `disable: [<source>]` removes specific cue sources from this project's resolution path without touching the user-level config.

---

## 6. The two formats

| Format | Used for | Rationale |
|---|---|---|
| **Markdown frontmatter + body** | `~/.cues/OPENCUES.md`, `cues.md`, `blanks.md`, all source files (`cues/<name>.md`, `blanks/<name>/BLANK.md`) | Frontmatter for structured config; body for prose (descriptions, prompts), documentation, or JSON code blocks (static data). One parser, used everywhere data has both metadata and content. |
| **YAML (no fences, legacy)** | Pre-2026-05 `~/.opencuesrc` | Retired. The runtime's parser still accepts the format during migration; `seed-configs` rewrites legacy files to frontmatter form on first run. |

The `parseSingleCueMd` parser:
- Reads YAML frontmatter between `---` fences.
- Reads body for: prose (LLM prompts), JSON code blocks (static data, the legacy array shape `[{id, words?, groups?}]`), `## Ignore` legacy section (back-compat).
- Distinguishes static-vs-LLM cue sources by data shape: presence of body JSON ⇒ static, presence of `match:` / `keywords:` + prose body ⇒ LLM.

There's no `type:` discriminator in frontmatter. Inference > declaration.

---

## 7. What's gone (deliberately removed)

- ❌ `opencues.md` (lowercase) and `.opencuesrc` (rc-style at `$HOME`) as the runtime config file name. Both retired in favour of `~/.cues/OPENCUES.md` (markdown + frontmatter, sits inside the cues library).
- ❌ `blanks.md` as a separate file. Folder-based blanks under `blanks/<name>/`.
- ❌ `## Tips`, `## Blanks`, `## Ignore` body sections in cues.md. Frontmatter + folders only.
- ❌ `type: tips` / `type: prompt` discriminators. Parser infers from data shape.
- ❌ Catch-all "default" word-cue sources. Every cue source must declare `match:` or `keywords:`.
- ❌ `ClassifiedSourceGroup` (legacy classifier-routed blank modes). Fluid-blank covers the territory.
- ❌ `output-format` / `display mode` settings. Had no consumer.

---

## 8. Migration path from the old layout

For users with the pre-OpenStandard layout (`.cues/` with `cues.md` + `cues/<name>/cue.md` + `blanks/<name>/`), `opencues seed-configs` runs an **idempotent migration** that:

1. Renames `~/.opencues/` → `~/.cues/`
2. Extracts settings from `cues.md` frontmatter → writes `~/.cues/OPENCUES.md` (markdown with frontmatter; was `~/.opencuesrc` rc-style YAML in an earlier arc)
3. Renames `cues/` subdir → keeps as `cues/` (post-2026-05; an interim arc had it as `words/`)
4. Flattens single-file source folders: `cues/legal/CUE.md` → `cues/legal.md`
5. Consolidates the `tips/cue.md` body JSON into `cues/tips.md` (already done in the previous arc)
6. Renames `blanks/` stays (already correct)
7. Flattens script-less blank folders: `blanks/stocks/BLANK.md` → `blanks/stocks.md`
8. Migrates legacy `~/.cues/words/` → `~/.cues/cues/` (for users who installed during the brief words/ era)

Idempotent: re-running detects the new layout (presence of `~/.cues/OPENCUES.md` + `~/.cues/cues/`) and skips.

---

## 9. Implementation pointers (for the OpenCues runtime)

- Search paths in order: `$OPENCUES_HOME`, `<cwd>/.cues`, `~/.cues`. Folder discovery walks each, builds a CuesMdConfig, merges with project-precedence.
- `OpenCuesSettingsBlank` reads/writes `~/.cues/OPENCUES.md` only. Project-level cues.md is read-only from this blank's perspective.
- `parseSingleCueMd` accepts both flat `<name>.md` and `<name>/cue.md` shapes. Source name comes from the filename or folder name.
- Folder-discovered configs merge into the master cuesConfig: `combineCueConfigs` concatenates `tips`, merges `promptConfig.sources`, merges `blanks`, concatenates `ignore`.
- Hot-reload: `ConfigLoader` polls all search paths on every keystroke; reads change → triggers a rebuild.
