# OpenCues — OpenStandard Notes

> **Living spec.** Captures the file layout, naming conventions, and ownership boundaries the OpenCues OpenStandard ships with. Anything not specified here is implementation detail.

---

## 1. Core concept

The standard covers **three directions of intent** on text:

| Direction | Surface | Operates on | Trigger | What it is |
|---|---|---|---|---|
| **System → User** | **Cues** | one word | plain text | The system offers alternatives the user didn't ask for. The user cycles through them. |
| **User → System** | **Blanks** | one `_` slot | text containing `_` | The user explicitly summons a value into a slot. |
| **System → Buffer** | **Auditors** | the whole buffer | every rewrite cycle | Composed inline-rewrite concerns (grammar, clarity, tone). Multiple auditors concatenate into one LLM call. |

The two scopes for cues mirror the first two directions:
- `words` scope: cues fire on plain text (no `_` in input)
- `blanks` scope: cues fire on `_` slots

Cues, blanks, and auditors are **sibling concepts**, not subtypes. They live as siblings in the layout (see §4).

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
| `~/.cues/OPENCUES.md` (user runtime config) | `~/.cues/CUES.md` + `~/.cues/BLANKS.md` + `~/.cues/AUDITORS.md` (user libraries) |
| `opencues install <host>` | `CUES.md` / `BLANKS.md` / `AUDITORS.md` (project manifests) |
| `@opencues/core`, `@opencues/runtime` (npm packages) | The data format inside `CUE.md` / `BLANK.md` / `AUDITOR.md` source files and master files |
| Settings schema (voice-mode, debug-mode, etc. — runtime-defined) | Source schema (match, keywords, scope, parser, priority — standard-defined) |

A second OpenStandard implementation (FastCues, AnotherCues, …) would park its own runtime-config file (e.g. `~/.cues/FASTCUES.md`) alongside, but read the same `~/.cues/` library and the same project-level `CUES.md` / `BLANKS.md` / `AUDITORS.md` manifests. The brand is replaceable; the standard isn't.

---

## 3. File layout

### User level (`$HOME`)

```
~/.cues/                 # user library — the standard's data
├── OPENCUES.md          # user runtime config — OpenCues tool's prefs (brand)
├── CUES.md              # cue master (project-overridable; frontmatter-only)
├── cues/                # per-cue folders — every cue is its own dir
│   ├── tips/CUE.md
│   ├── legal/CUE.md
│   ├── medical/CUE.md
│   ├── financial/CUE.md
│   └── spelling/CUE.md  # spell-correction cue (regular ConfigSource, priority 80)
├── BLANKS.md            # blank master
├── blanks/              # per-blank folders — every blank is its own dir
│   ├── volume/                  # has a colocated script
│   │   ├── BLANK.md
│   │   └── volume-blank.sh
│   ├── stocks/BLANK.md          # no script — pure runtime class
│   ├── weather/BLANK.md
│   └── ...
├── AUDITORS.md          # auditor master
└── auditors/            # per-auditor folders — every auditor is its own dir
    ├── grammar/AUDITOR.md
    └── clarity/AUDITOR.md
```

### Project level (a repo)

```
<project>/.cues/
├── CUES.md              # project cue master (composes with user CUES.md)
├── cues/
│   └── project-jargon/CUE.md
├── BLANKS.md            # project blank master
├── blanks/
│   └── project-blank/
│       ├── BLANK.md
│       └── project-blank.sh
├── AUDITORS.md          # project auditor master (with optional disable: list)
└── auditors/
    └── house-style/AUDITOR.md
```

Project layout mirrors user layout under `.cues/`. There is **no project-level OPENCUES.md** — the runtime config is user-level only, since system-wide settings (voice-mode, debug-mode, llm-provider, …) shouldn't change behaviour silently when you `cd` into a project.

---

## 4. Naming conventions

### File-naming convention — one rule

Every `.md` file in the standard is uppercase. Master files are uppercase plurals; per-source entry files are uppercase singulars; folders that contain sources are lowercase plurals.

| Layer | Master file | Source folder | Source entry |
|---|---|---|---|
| Cues | `CUES.md` | `cues/<name>/` | `CUE.md` |
| Blanks | `BLANKS.md` | `blanks/<name>/` | `BLANK.md` |
| Auditors | `AUDITORS.md` | `auditors/<name>/` | `AUDITOR.md` |

Same convention as `OPENCUES.md`, `CLAUDE.md`, `README.md`, `LICENSE` — uppercase signals "this file declares a unit"; lowercase paths (`cues/`, `blanks/`, `auditors/`) are containers for those units.

### `OPENCUES.md` — user runtime config

- **Format:** Markdown with YAML frontmatter; body is documentation. Sits alongside `CUES.md` / `BLANKS.md` / `AUDITORS.md` at the top of `~/.cues/`.
- **Content:** system settings (voice-mode, debug-mode, tips-mode, cursor-navigate, fluid-blank-mode, transform-blank-mode, word-cues-mode), nested `settings:` block (per-setting tip + values), LLM provider overrides (`llm-provider`, `llm-model`, per-feature `<feature>-provider` / `<feature>-model`, including `auditors-provider` / `auditors-model`).
- **Schema owner:** the OpenCues runtime. Users edit values; the schema is fixed by the implementation.
- **Rationale for the name:** uppercase + brand-prefixed signals "this configures the runtime, not the standard data." Sits inside `~/.cues/` rather than `$HOME` so the runtime install owns one consistent directory.

### `CUES.md` / `BLANKS.md` / `AUDITORS.md` — surface masters

- **Format:** Markdown with YAML frontmatter. Body is human-readable description.
- **Content:** project metadata (`name`, `description`, `spec`), per-surface `ignore:` (cues/blanks only — word lists), `disable:` (every master — list of source ids to subtract from this layer's composition).
- **Schema owner:** the standard.
- **Rationale for the names:** uppercase plurals match `package.json`, `Cargo.toml`, `.editorconfig` in spirit — generic, visible at the project root, brand-neutral. Markdown body lets the project document its OpenCues setup inline.

### `~/.cues/` and `<project>/.cues/` — library directory

- **Naming:** standard-named (`cues`), no brand. Both implementations and projects use this layout.
- **Visibility:** user-level is **dotted** (`.cues/`) per Unix convention for hidden user configs. Project-level is **dotted** (`.cues/`) so it doesn't clutter `ls` at a project root. Visibility comes from the masters (`CUES.md`, etc.) at the project root, not the cues directory.
- **Contents:** three scope subdirectories — `cues/`, `blanks/`, `auditors/` — and the matching uppercase master files. No other top-level entries.

### `cues/`, `blanks/`, `auditors/` — per-item subdirs

- **Naming:** lowercase plural, matches the master at the same level (`CUES.md` ↔ `cues/`, `BLANKS.md` ↔ `blanks/`, `AUDITORS.md` ↔ `auditors/`). The master holds surface-wide settings; the folder holds standalone per-item sources.
- **Contents:** every entry is a folder. No flat `<name>.md` files at this level.

### Source files inside `cues/`, `blanks/`, `auditors/`

Every source is a folder containing an uppercase entry file:

- **Cues:** `cues/<name>/CUE.md`
- **Blanks:** `blanks/<name>/BLANK.md`
- **Auditors:** `auditors/<name>/AUDITOR.md`

There is no flat-file shape. A source that ships nothing alongside its entry file (most word-cues, runtime-class-backed blanks like `stocks` / `weather`, most auditors) still gets its own folder. This mirrors the SKILLS.md convention — the folder *is* the unit, and adding a helper script later is a drop-in operation rather than a flat→folder migration.

### Source naming

Folder name **is** the source name. `cues/legal/CUE.md` → source `legal`. `blanks/volume/BLANK.md` → source `volume`. `auditors/grammar/AUDITOR.md` → source `grammar`. Frontmatter `name:` should match the folder name (the validator warns if not).

---

## 5. Ownership matrix

Who is allowed to write each piece, and at what scope.

| Path | Schema owner | Write scope | Hot-reload? |
|---|---|---|---|
| `~/.cues/OPENCUES.md` | runtime (OpenCues) | user-level only | yes (next keystroke) |
| `~/.cues/CUES.md` | standard | user (own library) | yes |
| `~/.cues/BLANKS.md` | standard | user (own library) | yes |
| `~/.cues/AUDITORS.md` | standard | user (own library) | yes |
| `~/.cues/cues/<name>/CUE.md` | standard | user (own library) | yes |
| `~/.cues/blanks/<name>/...` | standard | user (own library) | yes |
| `~/.cues/auditors/<name>/AUDITOR.md` | standard | user (own library) | yes |
| `<project>/.cues/CUES.md` | standard | project author | yes |
| `<project>/.cues/BLANKS.md` | standard | project author | yes |
| `<project>/.cues/AUDITORS.md` | standard | project author | yes |
| `<project>/.cues/cues/<name>/CUE.md` | standard | project author | yes |
| `<project>/.cues/blanks/<name>/...` | standard | project author | yes |
| `<project>/.cues/auditors/<name>/AUDITOR.md` | standard | project author | yes |

### What overrides what

Resolution order at runtime (highest priority first):

1. `$OPENCUES_HOME` (env override — for CI / containers / tests)
2. `<cwd>/.cues/` (project-level overrides)
3. `~/.cues/` (user-level baseline)

Settings are user-level only — projects do **not** override `~/.cues/OPENCUES.md`. Projects override **content** (cue sources, blank registrations, ignore list) but never the runtime's behavior toggles. Reasoning: cd'ing into a project should not silently change whether TTS speaks, which LLM provider is used, etc. Those are user prefs.

A project's `CUES.md` / `BLANKS.md` `ignore:` list **adds to** the user's ignore list (UNION across layers). A master's `disable: [<source>]` SUBTRACTs specific source ids from the resolution path at that layer, without touching other layers — same semantics across cues, blanks, and auditors.

---

## 6. The one format

| Format | Used for | Rationale |
|---|---|---|
| **Markdown frontmatter + body** | `OPENCUES.md`, `CUES.md`, `BLANKS.md`, `AUDITORS.md`, all source files (`cues/<name>/CUE.md`, `blanks/<name>/BLANK.md`, `auditors/<name>/AUDITOR.md`) | Frontmatter for structured config; body for prose (descriptions, prompts), documentation, or JSON code blocks (static data). One parser shape, used everywhere data has both metadata and content. |

Per-source body content:
- **CUE.md:** prose for LLM-mode cues, fenced ` ```json ` block for static tip-group cues, or both (combined-mode files use static for matched words + LLM fallback for the rest).
- **BLANK.md:** typically empty — the binding (`stepValues:` / `blankScript:` / `impl:`) lives in frontmatter. Body MAY hold `## <Name>` prompt sections for AI-driven blanks (transform-blank, fluid-blank).
- **AUDITOR.md:** body is the prompt fragment that gets concatenated into the rewrite call.

There's no `type:` discriminator in frontmatter. The parser infers source kind from path (`cues/` vs `blanks/` vs `auditors/`) and from data shape (body JSON ⇒ static cue, prose ⇒ LLM cue or auditor body).

---

## 7. What's gone (deliberately removed)

- ❌ Flat `<name>.md` source files. Every source is `<name>/<UPPERCASE>.md`.
- ❌ Lowercase master files (`cues.md`, `blanks.md`, `auditors.md`). Masters are uppercase plurals.
- ❌ `## Tips`, `## Blanks`, `## Ignore` body sections in master files. Frontmatter + folders only.
- ❌ `type: tips` / `type: prompt` discriminators. Parser infers from path + data shape.
- ❌ Catch-all "default" word-cue sources. Every cue source must declare `match:` or `keywords:`.
- ❌ `ClassifiedSourceGroup` (legacy classifier-routed blank modes). Fluid-blank covers the territory.
- ❌ `output-format` / `display mode` settings. Had no consumer.

---

## 8. Implementation pointers (for the OpenCues runtime)

- Search paths in order: `$OPENCUES_HOME`, `<cwd>/.cues`, `~/.cues`. Folder discovery walks each, builds a `CuesMdConfig`, merges with project-precedence.
- `OpenCuesSettingsBlank` reads/writes `~/.cues/OPENCUES.md` only. Standard masters (`CUES.md`, etc.) are not edited by the runtime.
- `parseSingleCueMd` / `parseSingleAuditorMd` accept folder-only `<name>/<UPPERCASE>.md`. Source name comes from the folder name.
- Folder-discovered configs merge into a single `CuesMdConfig`: `combineCueConfigs` concatenates `tips`, merges `promptConfig.sources`, merges `blanks`, merges `auditors`, concatenates `ignore`, unions `disable` lists.
- Hot-reload: `ConfigLoader` polls all search paths on every keystroke; reads change → triggers a rebuild.
