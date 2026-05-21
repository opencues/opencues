# core — shared rules across cue-spec and blank-spec

> **Status:** `0.1-alpha`. Expect changes.

This document covers concerns shared by `cue-spec.md`, `blank-spec.md`, and `auditor-spec.md`: the project search-path, the master `CUES.md` / `BLANKS.md` / `AUDITORS.md` files at the root, host compatibility, hot-reload, routing, and the promotion path from runtime-specific knobs to standard fields.

---

## Project layout

A conformant project tree:

```
<root>/
├── CUES.md                  # master — cue-surface settings + ignore[]
├── BLANKS.md                # master — blank-surface settings + ignore[]
├── AUDITORS.md              # master — auditor-surface settings + disable[]
├── cues/                    # one directory of cue sources
│   └── <name>/
│       └── CUE.md           # the source spec (with optional bundled resources)
├── blanks/                  # one directory of blank sources
│   └── <name>/
│       └── BLANK.md         # the source spec (with optional bundled resources)
└── auditors/                # one directory of auditor sources
    └── <name>/
        └── AUDITOR.md       # the source spec (with optional bundled resources)
```

Every cue, blank, and auditor source is a folder containing an uppercase entry file (`CUE.md`, `BLANK.md`, `AUDITOR.md`). The folder name is the source id. There is no flat-file shape: a source that ships nothing alongside its spec still gets its own folder, so adding a helper script later is a drop-in operation rather than a flat→folder migration.

Every `.md` file in the standard is uppercase. Master files (`CUES.md`, `BLANKS.md`, `AUDITORS.md`) declare the surface as a whole. Per-source entry files (`CUE.md`, `BLANK.md`, `AUDITOR.md`) declare individual sources. Same convention as `OPENCUES.md`, `CLAUDE.md`, `README.md` — uppercase signals "this file declares a unit"; lowercase paths (`cues/`, `blanks/`, `auditors/`) are containers for those units.

### Bundled resources

A source folder MAY ship bundled resources alongside its spec file. The standard reserves three subdirectory names by convention; runtimes treat them per the table below.

```
<root>/blanks/<name>/
├── BLANK.md              (required — the spec file)
├── <name>-blank.sh       (or any sibling file referenced by frontmatter)
├── scripts/              (optional — additional executable code)
├── references/           (optional — documentation the runtime may load on demand)
└── assets/               (optional — non-code resources)
```

| Subdir | Purpose | Load semantics |
|---|---|---|
| sibling files | Direct dependencies of `BLANK.md` (e.g. `volume-blank.sh`). Referenced explicitly via `blankScript:`, `impl:` resolution, or compiled artefact path. | Loaded when the source loads. |
| `scripts/` | Additional supporting scripts. | Authors reference them by relative path; runtimes do not auto-load. |
| `references/` | Long-form documentation, prompt fragments, examples. | Authors may load on demand (e.g. via `promptPath:`); not in context by default. |
| `assets/` | Templates, fonts, sample data. | Not loaded into LLM context — used by scripts at runtime. |

Bundled resources MUST be relative to the folder source. A `CUE.md` or `BLANK.md` MUST NOT reference paths outside its folder; runtimes MAY reject sources that do.

Compile artefacts (`.exe`, `.dll`, etc.) are conventionally produced from sibling source files (`.cs`, `.cpp`) at install time. The standard does not specify the compile toolchain — that's a runtime concern.

---

## Master files: `CUES.md`, `BLANKS.md`, `AUDITORS.md`

Each surface has a master file at the project root. The master files configure the surface as a whole and contribute project-wide settings.

> **Note on `name:` / `description:`.** These fields appear at three levels — master file, per-source file, and (for runtime settings) `OPENCUES.md`. They mean different things at each level. On the master file, they identify the **project** as a whole. On a per-source file, they identify the **individual source**. Validators MUST scope uniqueness checks to the level where the field appears: `name-collision` only fires for duplicate per-source names, never between a source name and a master name.

### `<root>/CUES.md`

```yaml
---
name: <project-name>
description: <short description>
spec: opencues/0.1-alpha
tips-mode: on             # whether static tip-group cues fire
word-cues-mode: on        # whether LLM word-cue sources fire
ignore: [TODO, FIXME]     # words never to cue, regardless of any source
---

Optional Markdown body — human-readable project notes.
```

A missing `CUES.md` is equivalent to one with no settings. A 0-byte `CUES.md` MUST be treated as missing (defensive against truncation).

> **Note on spelling.** Spelling correction is a regular word-cue source — `cues/spelling/CUE.md` with `match: .*` and a spell-check prompt — not a separate flag. The `word-cues-mode` toggle gates it alongside every other word-cue.

### `<root>/BLANKS.md`

```yaml
---
name: <project-name>
description: <short description>
spec: opencues/0.1-alpha
ignore: [_placeholder]    # `_`-prefixed forms that never auto-fill
disable: [stocks]         # blank ids excluded at this layer
---
```

Same defensive treatment: missing or 0-byte = treated as absent.

### `<root>/AUDITORS.md`

```yaml
---
name: <project-name>
description: <short description>
spec: opencues/0.1-alpha
disable: [grammar, jargon]  # auditor ids excluded at this layer
---
```

Same defensive treatment: missing or 0-byte = treated as absent. See [`auditor-spec.md`](./auditor-spec.md) for the full surface specification, including how `disable:` SUBTRACTs auditors from the user→project ADD-by-default composition.

### Frontmatter ownership

| Field | Lives in | Why |
|---|---|---|
| `name`, `description`, `spec` | every master | Identifies the project / library + spec version. |
| `tips-mode`, `word-cues-mode` | `CUES.md` | Cue-surface enable flags. (Spelling no longer has its own flag — it's a regular word-cue at `cues/spelling/CUE.md`.) |
| `ignore: [<word>, ...]` | `CUES.md`, `BLANKS.md` | Per-surface ignore lists. Words/blanks the runtime never surfaces, regardless of source matches. |
| `disable: [<source-id>, ...]` | every master | Subtract a named source from this layer's composition without modifying the user-level library. Symmetric across cues, blanks, auditors. |
| Anything else (voice, debug, navigation, fluid-/transform-blank toggles, per-feature LLM routing) | `OPENCUES.md` | Runtime knobs — not part of this standard. See [`@opencues/runtime`'s `SPEC.md`](../packages/opencues-runtime/SPEC.md). |

A conformant runtime MUST refuse to honor surface settings declared in the wrong master file. Runtime-owned settings (TTS, debug, fluid-blank toggles, etc.) are NOT part of this spec and live in `OPENCUES.md`; another implementation that parks its runtime config in a different file is conformant.

---

## Search path

Runtimes resolve project files from these locations in order. Earlier entries shadow later ones.

1. **`$OPENCUES_HOME`** — environment override. Top priority. Useful for CI and power users.
2. **`<cwd>/.cues/`** — project-level. Walks up from the runtime's working directory.
3. **`~/.cues/`** — user-level. Global defaults.

Missing directories MUST be silently skipped — a user with no `.cues/` anywhere has empty config, not a crash.

A runtime MUST NOT auto-write to any of these locations except via the user's explicit action (e.g. an `opencues seed-configs`-equivalent command). Hot-reload is read-only.

---

## Routing — which source handles a word

For cues, every matched word is routed to **exactly one** source.

1. **DOMAIN sources** — declare `match:` and/or `keywords:`. Fire only on matches.
2. **DEFAULT sources** — declare neither `match:` nor `keywords:`. Catch-all for words no DOMAIN claims.

Resolution algorithm:

1. Among all DOMAIN sources whose `match:` or `keywords:` hits the word, pick the highest `priority`.
2. On priority ties, declaration order wins (sources from earlier search-path entries first; then file-system order within a directory).
3. If no DOMAIN matches, route to the highest-priority DEFAULT source.
4. If no DEFAULT exists, the word produces no cue (it's not navigable).

Per-project rules:
- At most one DEFAULT source SHOULD exist. Validators warn on multiple defaults at the same priority.
- A project with zero DEFAULT sources is valid; words outside any `match:`/`keywords:` simply produce no cue.

For blanks, routing is by `blankKeywords` exact match, with `blankProximity` controlling word distance from `_`. Tie resolution: by source priority (declaration order if equal). The fluid-blank fallback (when implemented) handles `_` with no `blankKeywords` match. Runtimes that ship a transform-blank surface alongside fluid-blank SHOULD ensure their fluid-blank fallback refuses inputs that look like transform-blank task triggers — otherwise a mistyped task command falls through to the lookup pipeline and gets hallucinated as an answer (see [`@opencues/runtime`'s `SPEC.md` § Task-trigger guard](../packages/opencues-runtime/SPEC.md#task-trigger-guard) for the OpenCues runtime's implementation).

---

## Host compatibility

Some sources only work in some runtimes. A shell-script blank can't run in a browser; an LLM-mode cue using a Node-only HTTP adapter can't run in a content script.

### Auto-detected hosts

A source's allowed hosts are auto-detected from its binding profile and script extensions:

- A blank with `blankScript: foo.{sh,bash,ps1,bat,cmd,exe,py,rb,pl}` is **native-only** (excluded from browser hosts).
- A cue or blank with no script reference defaults to **all hosts**.

### Explicit override

Authors may override auto-detection:

```yaml
on-host: [chrome, claude-code, gemini-cli, opencode]   # allow-list — only these may load
not-on-host: [chrome]                      # deny-list — everyone except these
```

Resolution:
1. If `on-host:` is present, it replaces auto-detection.
2. `not-on-host:` filters the resulting allow-list.

### Known host names

The standard reserves these host identifiers:

- `claude-code`
- `opencode`
- `chrome`
- `gemini-cli`

Runtimes MAY define additional host names. Other implementations SHOULD ignore unknown host names rather than failing.

The constants `HOSTS` and `NATIVE_HOSTS` in OpenCues' `@opencues/core` library are non-normative reference values.

---

## Hot-reload

A conformant runtime SHOULD detect changes to any file in the search path and apply them without restart. The reference cadence is one filesystem poll per user keystroke (debounced). Atomic / locked files SHOULD be skipped until they settle.

A runtime that mutates files in the search path (e.g. an `OpenCuesSettingsBlank`-equivalent) MUST suppress its own re-read for at least 2 seconds after writing, to avoid races where the in-memory state and the file disagree mid-flight.

---

## CLI surface

A conformant runtime SHOULD ship a CLI exposing at least these commands. Names are normative; semantics are normative; flags are runtime-specific.

| Command | Semantics |
|---|---|
| `validate [--path <dir>]` | Run the linting rules above against a search-path directory. Exit 0 if all pass (or only `info`/`warn`); exit 1 if any `error` rule fires. |
| `list [--path <dir>] [--type cue\|blank\|auditor]` | Enumerate discovered sources, one per line. MUST display `name`, `description`, source kind (cue / blank / auditor), and trigger summary (`match:` / `keywords:` / `blankKeywords:` for cues and blanks; `priority:` for auditors). |
| `seed-configs [--silent]` | Copy shipped defaults into the user search path on first install; idempotent on subsequent runs. Idempotently migrate legacy filenames. Runtime-specific in detail. |

Runtimes MAY add commands; the three above are the interop surface that authoring tools (editors, CI, doc generators) can rely on.

---

## Promotion path — runtime-specific to standard

Fields not in this spec live in `OPENCUES.md` (see [`@opencues/runtime`'s `SPEC.md`](../packages/opencues-runtime/SPEC.md)). Other runtimes ignore that file.

If a runtime-specific field proves universally useful, it can be **promoted** to this spec in a future version:

1. Two or more independent runtime implementations adopt the field.
2. A pull request against the spec adds the field to `cue-spec.md`, `blank-spec.md`, `auditor-spec.md`, or `core.md` as appropriate.
3. The spec version bumps (e.g. `0.1-alpha` → `0.2-alpha`).
4. The promoted field MAY remain in `OPENCUES.md` for backward compat for one minor version.

Promotion candidates appear in [`@opencues/runtime`'s `SPEC.md` § Future surfaces](../packages/opencues-runtime/SPEC.md#future-surfaces). The criterion is independent adoption: a setting becomes a candidate once a second conformant runtime ships it, not before.

---

## Consumer behavior — unknown content

Forward compatibility depends on runtimes treating unknown content gracefully. The standard fixes the rules:

| Scenario | Behavior |
|---|---|
| Unknown frontmatter field | Preserve; warn at validate time; do NOT error at load time. |
| Frontmatter field with wrong type | Reject the file (`load-error` / linter `error`). |
| Unknown markdown section in body | Preserve; do not error. |
| Duplicate `name:` across sources | Reject the second-loaded file (`name-collision` error). |
| File declaring `spec:` newer than the runtime supports | Reject the file (`spec-too-new` error). |
| File omitting `spec:` | Treat as `opencues/0.1-alpha`. |
| Unknown host name in `on-host` / `not-on-host` | Reject the file (`unknown-host` error). |
| Unknown `impl:` value (foreign runtime class) | Skip the source (`impl-unsupported` warn). |
| Unknown binding profile combination on a blank | Reject the file (`binding-conflict` error). |

The principle: **at parse time, accept the unfamiliar; at validate time, surface it.** Runtimes that error on unknown fields make the spec hostile to extension.

---

## Linting rules

A conformant validator (`opencues validate` or equivalent) MUST report the following. Severity column: `error` blocks load; `warn` allows load but surfaces the issue; `info` is observational.

| Rule | Severity | What it checks |
|---|---|---|
| `cue-missing-name` | error | `CUE.md` frontmatter has no `name`. |
| `cue-missing-trigger` | error | `CUE.md` declares neither `match:` nor `keywords:`. |
| `cue-empty-body` | error | `CUE.md` body has neither a JSON tip-group block nor non-empty prompt text. |
| `cue-missing-description` | warn | `CUE.md` lacks a `description:`. |
| `cue-multiple-defaults` | warn | More than one DEFAULT cue source at the same priority. |
| `cue-host-contradiction` | warn | Explicit `on-host` contradicts auto-detection from script extensions. |
| `blank-missing-name` | error | `BLANK.md` lacks `name`. |
| `blank-missing-keywords` | error | `BLANK.md` lacks `blankKeywords`. |
| `blank-no-binding` | error | `BLANK.md` declares zero binding profiles (no `stepValues` / `blankScript` / `impl`). |
| `blank-multiple-bindings` | error | `BLANK.md` declares more than one binding profile. |
| `blank-script-missing` | error | `blankScript:` references a relative path that doesn't exist on disk. |
| `blank-readonly-conflict` | warn | `blankReadOnly: true` paired with a binding that produces multiple values. |
| `blank-script-on-chrome` | warn | `on-host: chrome` declared alongside `blankScript:` (browser can't spawn). |
| `blank-missing-description` | warn | `BLANK.md` lacks a `description:`. |
| `auditor-missing-name` | error | `AUDITOR.md` frontmatter has no `name`. |
| `auditor-empty-body` | error | `AUDITOR.md` body is empty or whitespace-only. |
| `auditor-missing-description` | warn | `AUDITOR.md` lacks a `description:`. |
| `auditor-name-mismatch` | warn | `name:` differs from the folder basename. |
| `disable-unknown` | warn | A master file's `disable:` lists a name with no corresponding source folder at any layer. |
| `unknown-host` | error | A host name in `on-host` / `not-on-host` is not in the known set. |
| `unknown-field` | warn | A frontmatter key is not in the canonical schema for this surface. Helps catch typos. |
| `name-collision` | error | Two loaded sources share the same `name:` within a single layer. |
| `spec-too-new` | error | File declares a `spec:` newer than the runtime supports. |
| `master-zero-byte` | warn | `CUES.md`, `BLANKS.md`, or `AUDITORS.md` exists but is 0 bytes. |
| `field-summary` | info | Summary count of sources discovered, broken down by type. |

Runtimes MAY add their own implementation-specific rules under a vendor prefix (e.g. `opencues-cc-…`).

---

## In scope

- Project layout, master files, search path.
- Routing & priority resolution.
- Host compatibility (allow/deny lists, auto-detection rules).
- Hot-reload contract.

## Out of scope

- The runtime's own settings file (`OPENCUES.md`) — see the runtime doc.
- Per-host install conventions (e.g. how Chrome bundles configs at build time).
- Specific filesystem permissions / atomicity requirements beyond "skip in-flight files".
