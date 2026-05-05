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
| **OpenCues** (the brand) | Anthropic's reference implementation: the runtime, the CLI, the integrations. | `opencues` CLI, `@opencues/*` packages, `.opencuesrc`, repo name |

**Rule of thumb:** anything universal across implementations uses the standard's vocabulary. Anything that's runtime-specific or tool-specific uses the brand's vocabulary.

| Brand-owned | Standard-owned |
|---|---|
| `~/.opencuesrc` (user runtime config) | `~/.cues/` (user cue library) |
| `opencues install <host>` | `cues.md` (project manifest) |
| `@opencues/core`, `@opencues/runtime` (npm packages) | The data format inside cue.md / cues.md / source files |
| Settings schema (voice-mode, debug-mode, etc. — runtime-defined) | Source schema (match, keywords, scope, parser — standard-defined) |

A second OpenStandard implementation (FastCues, AnotherCues, …) would ship its own `~/.fastcuesrc` etc., but read the same `~/.cues/` library and the same `<project>/cues.md` manifests. The brand is replaceable; the standard isn't.

---

## 3. File layout

### User level (`$HOME`)

```
~/.opencuesrc            # user runtime config — OpenCues tool's prefs (brand)
~/.cues/                 # user cue library — the standard's data
├── words/               # word-scope cues
│   ├── tips.md          # static cue source (body JSON)
│   ├── legal.md         # LLM cue source (frontmatter match: + prompt body)
│   ├── medical.md
│   └── financial.md
└── blanks/              # blank-scope cues
    ├── volume/          # folder when scripts are colocated
    │   ├── cue.md
    │   └── volume-blank.sh
    ├── stocks.md        # flat file when no script needed (runtime class)
    ├── weather.md
    └── ...
```

### Project level (a repo)

```
<project>/
├── cues.md              # project manifest — visible, marketing surface
└── .cues/               # project-specific cues (optional)
    ├── words/
    │   └── project-jargon.md
    └── blanks/
        └── project-blank/
            ├── cue.md
            └── project-blank.sh
```

Project layout mirrors user layout under `.cues/`. The visible `cues.md` at project root is the manifest.

---

## 4. Naming conventions

### `.opencuesrc` — user runtime config

- **Format:** YAML (no markdown, no `---` fences). Pure config.
- **Content:** system settings (voice-mode, debug-mode, tips-mode, cursor-navigate, fluid-blank-mode, spelling-mode, word-cues-mode), nested `settings:` block (per-setting tip + values), LLM provider overrides (`llm-model`, `llm-endpoint`).
- **Schema owner:** the OpenCues runtime. Users edit values; the schema is fixed by the implementation.
- **Rationale for the name:** `rc`-suffix dotfile is the conventional Unix pattern for tool-runtime config (`.bashrc`, `.npmrc`, `.gitconfig`). The brand-name prefix says "this is OpenCues' rc file." YAML inside, no markdown framing — honest naming.

### `cues.md` — project manifest

- **Format:** Markdown with YAML frontmatter. Body is human-readable description.
- **Content:** project metadata (`name`, `description`), `ignore` list, `disable` list (cue sources to suppress in this project), `requires` (compatibility gate), optional project-specific `words:` map, optional `llm-model` override.
- **Schema owner:** the standard.
- **Rationale for the name:** matches `package.json`, `Cargo.toml`, `.editorconfig` — visible, generic, brand-neutral. Drops at the root of a repo and signals "this project speaks Cues" to any reader. Markdown body lets the project document its OpenCues setup inline (a tiny CONTRIBUTING.md for the cue domain).

### `~/.cues/` and `<project>/.cues/` — cue library directory

- **Naming:** standard-named (`cues`), no brand. Both implementations and projects use this layout.
- **Asymmetry on visibility:** user-level is **dotted** (`.cues/`) per Unix convention for hidden user configs. Project-level is **dotted** (`.cues/`) so it doesn't clutter `ls` at a project root. Visibility comes from `cues.md` at the project root, not the cues directory.
- **Contents:** two scope subdirectories, `words/` and `blanks/`. No other top-level entries.

### `words/` and `blanks/` — scope subdirs

- **Naming:** matches the `SourceConfig.scope` field exactly. The directory IS the scope.
- **Symmetry:** both plural, both scope-named, both can contain flat `.md` files or folders. Visual semantic is honest: `ls .cues/` → `words/  blanks/`.
- **Why not "cues" / "blanks":** the parent already says "cues" (`.cues/`). Repeating "cues" inside is redundant and creates the `.cues/words/` collision. Using scope names (the runtime's existing terminology) avoids both problems.

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
| `~/.opencuesrc` | runtime (OpenCues) | user-level only | yes (next keystroke) |
| `~/.cues/words/<name>.md` | standard | user (own library) | yes |
| `~/.cues/blanks/<name>/...` | standard | user (own library) | yes |
| `<project>/cues.md` | standard | project author | yes |
| `<project>/.cues/words/<name>.md` | standard | project author | yes |
| `<project>/.cues/blanks/<name>/...` | standard | project author | yes |

### What overrides what

Resolution order at runtime (highest priority first):

1. `$OPENCUES_HOME` (env override — for CI / containers / tests)
2. `<cwd>/.cues/` (project-level overrides)
3. `~/.cues/` (user-level baseline)

Settings are user-level only — projects do **not** override `~/.opencuesrc`. Projects override **content** (cue sources, blank registrations, ignore list) but never the runtime's behavior toggles. Reasoning: cd'ing into a project should not silently change whether TTS speaks, whether the spell-checker fires, etc. Those are user prefs.

A project's `cues.md` ignore list **adds to** the user's ignore list. A project's `disable: [<source>]` removes specific cue sources from this project's resolution path without touching the user-level config.

---

## 6. The two formats

| Format | Used for | Rationale |
|---|---|---|
| **YAML (no fences)** | `~/.opencuesrc` | Pure config. No prose body. Pure rc convention. |
| **Markdown frontmatter + body** | `cues.md`, all source files (`words/<name>.md`, `blanks/<name>/cue.md`) | Frontmatter for structured config; body for prose (descriptions, prompts) or JSON code blocks (static data). One parser, used everywhere data has both metadata and content. |

The `parseSingleCueMd` parser:
- Reads YAML frontmatter between `---` fences.
- Reads body for: prose (LLM prompts), JSON code blocks (static data, the legacy array shape `[{id, words?, groups?}]`), `## Ignore` legacy section (back-compat).
- Distinguishes static-vs-LLM cue sources by data shape: presence of body JSON ⇒ static, presence of `match:` / `keywords:` + prose body ⇒ LLM.

There's no `type:` discriminator in frontmatter. Inference > declaration.

---

## 7. What's gone (deliberately removed)

- ❌ `opencues.md` as a separate file at user level. Settings consolidated into `.opencuesrc`.
- ❌ `blanks.md` as a separate file. Folder-based blanks under `blanks/<name>/`.
- ❌ `## Tips`, `## Blanks`, `## Ignore` body sections in cues.md. Frontmatter + folders only.
- ❌ `type: tips` / `type: prompt` discriminators. Parser infers from data shape.
- ❌ Catch-all "default" word-cue sources. Every cue source must declare `match:` or `keywords:`.
- ❌ `ClassifiedSourceGroup` (legacy classifier-routed blank modes). Fluid-blank covers the territory.
- ❌ `output-format` / `display mode` settings. Had no consumer.

---

## 8. Migration path from the old layout

For users with the pre-OpenStandard layout (`.cues/` with `cues.md` + `cues/<name>/cue.md` + `blanks/<name>/`), `opencues seed-configs` runs an **idempotent migration** that:

1. Renames `~/.cues/` → `~/.cues/`
2. Extracts settings from `cues.md` frontmatter → writes `~/.opencuesrc` (YAML, no fences)
3. Renames `cues/` subdir → `words/`
4. Flattens single-file source folders: `cues/legal/CUE.md` → `words/legal.md`
5. Consolidates the `tips/cue.md` body JSON into `words/tips.md` (already done in the previous arc)
6. Renames `blanks/` stays (already correct)
7. Flattens script-less blank folders: `blanks/stocks/BLANK.md` → `blanks/stocks.md`

Idempotent: re-running detects the new layout (presence of `~/.opencuesrc`) and skips.

---

## 9. Implementation pointers (for the OpenCues runtime)

- Search paths in order: `$OPENCUES_HOME`, `<cwd>/.cues`, `~/.cues`. Folder discovery walks each, builds a CuesMdConfig, merges with project-precedence.
- `OpenCuesSettingsBlank` reads/writes `~/.opencuesrc` only. Project-level cues.md is read-only from this blank's perspective.
- `parseSingleCueMd` accepts both flat `<name>.md` and `<name>/cue.md` shapes. Source name comes from the filename or folder name.
- Folder-discovered configs merge into the master cuesConfig: `combineCueConfigs` concatenates `tips`, merges `promptConfig.sources`, merges `blanks`, concatenates `ignore`.
- Hot-reload: `ConfigLoader` polls all search paths on every keystroke; reads change → triggers a rebuild.
