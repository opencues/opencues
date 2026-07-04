# core — shared rules across cue-spec and blank-spec

> **Status:** `0.4-alpha`. Expect changes.

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
| `identity-context-mode`, `blank-context-mode` | `OPENCUES.md` (or runtime equivalent) | Spec-level mode gates for the sentinel-catalog machinery. See § Spec-mandated scalars below + [`identity-context-spec.md`](./identity-context-spec.md) and [`blank-spec.md`](./blank-spec.md) § Sentinel aspects. |
| Anything else (voice, debug, navigation, fluid-/transform-blank toggles, per-feature LLM routing) | `OPENCUES.md` | Runtime knobs — not part of this standard. See [`@opencues/runtime`'s `SPEC.md`](../packages/opencues-runtime/SPEC.md). |

A conformant runtime MUST refuse to honor surface settings declared in the wrong master file. Runtime-owned settings (TTS, debug, fluid-blank toggles, etc.) are NOT part of this spec and live in `OPENCUES.md`; another implementation that parks its runtime config in a different file is conformant.

### Spec-mandated scalars

The following kebab-case scalars are part of the **wire contract** —
they gate spec-level behaviour (sentinel catalogs, host-compat
classifications) and a conformant runtime MUST honour them as
specified. The OPENCUES.md filename is conventional; an alternate
runtime MAY store them elsewhere, but the scalar name + value enum +
default + mode-gate composition rules are normative.

| Scalar | Values | Default | Defined in |
|---|---|---|---|
| `identity-context-mode` | `off` / `safe` / `raw` (`raw` MUST be hidden from cycling menus) | `safe` | [`identity-context-spec.md`](./identity-context-spec.md) |
| `blank-context-mode` | `off` / `safe` / `raw` | `safe` | [`blank-spec.md`](./blank-spec.md) § Sentinel aspects |

> Both defaulted to `off` before June 2026; the reference runtime flipped
> both to `safe` (PR #161) since token-name-only catalogs carry no PII to
> the provider — `off` was a stricter-than-necessary default for the
> common case. This is a wire-contract default, so a conformant runtime
> that ships `off` here diverges from spec.

**Mode-gate composition.** When `blank-context-mode: raw` is set but
`identity-context-mode` is NOT `raw`, conformant runtimes MUST
downgrade `blank-context-mode` to `safe`. This prevents a footgun
where the user opts blanks into raw values without realising
identity-context is still in safe mode (which would leak ambient
blank values to the LLM provider while user-identity values stay
locally substituted — an inconsistent privacy posture). See
`identity-context-spec.md` § Mode-gate composition.

Other scalars the reference impl reads from `OPENCUES.md` (per-bucket
LLM routing, debug-mode, voice-mode, etc.) are documented in
[`@opencues/runtime`'s `SPEC.md`](../packages/opencues-runtime/SPEC.md)
and are NOT part of this standard — a second implementation MAY
ignore or replace them.

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

Every cue source MUST declare `match:` or `keywords:` (or both). Sources with neither are rejected at construction time — there is no implicit "default" mechanism via field absence. A catch-all behaviour is expressed as `match: .*` paired with a low `priority:` so domain-specific sources win first; the shipped `defaults/cues/spelling/CUE.md` (priority `10`, `match: .*`) is the canonical example.

Resolution algorithm:

1. Among all sources whose `match:` or `keywords:` hits the word, pick the highest `priority`.
2. On priority ties, declaration order wins (sources from earlier search-path entries first; then file-system order within a directory).
3. If no source claims the word, the word produces no cue (it's not navigable).

For blanks, routing is by `blankShapes` — anchored whole-segment grammar matched against the SENTENCE containing `_` (keywords desugar to shapes; a keyword claims a `_` when it leads its sentence — the segment after the last sentence terminator (`.`/`!`/`?` + whitespace, or CJK `。！？．`) or newline before `_`). Tie resolution: by source priority (declaration order if equal). The fluid-blank fallback (when implemented) handles `_` that no shape claims. Runtimes that ship a transform-blank surface alongside fluid-blank SHOULD ensure their fluid-blank fallback refuses inputs that look like transform-blank task triggers — otherwise a mistyped task command falls through to the lookup pipeline and gets hallucinated as an answer (see [`@opencues/runtime`'s `SPEC.md` § Task-trigger guard](../packages/opencues-runtime/SPEC.md#task-trigger-guard) for the OpenCues runtime's implementation).

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
- `shell` (`terminal` is a deprecated back-compat alias resolving to `shell`)

Runtimes MAY define additional host names. Other implementations SHOULD ignore unknown host names rather than failing.

The constants `HOSTS` and `NATIVE_HOSTS` in OpenCues' `@opencues/core` library (`packages/opencues-core/src/host-compat.ts`) are non-normative reference values that enumerate the above set; `shell`, `claude-code`, `gemini-cli`, and `opencode` are members of `NATIVE_HOSTS` (can spawn subprocesses and touch the filesystem without a bridge); `chrome` is the lone non-native host. Conformant runtimes MUST resolve the legacy `terminal` alias to `shell` for back-compat.

---

## Hot-reload

A conformant runtime SHOULD detect changes to any file in the search path and apply them without restart. The reference cadence is a fixed-interval filesystem poll (~100ms in `@opencues/runtime`, see `event-bridge.ts`'s `POLL_INTERVAL_MS`); a runtime MAY instead drive the poll off user-input events as long as edits are picked up within a few hundred milliseconds of saving. Atomic / locked files SHOULD be skipped until they settle.

A runtime that mutates files in the search path (e.g. an `OpenCuesSettingsBlank`-equivalent) MUST suppress its own re-read for at least 2 seconds after writing, to avoid races where the in-memory state and the file disagree mid-flight.

---

## CLI surface

A conformant runtime SHOULD ship a CLI exposing at least these commands. Names are normative; semantics are normative; flags are runtime-specific.

| Command | Semantics |
|---|---|
| `validate [--project] [--user] [--strict] [--json]` | Run the linting rules above against the search path (project + user by default; `--project`/`--user` restrict to one). Exit 0 if all pass (or only `info`/`warn`); exit 1 if any `error` rule fires. Flag names are runtime-specific — a directory-targeting flag (rather than the reference impl's cwd-relative `--project`) is an equally conformant shape. |
| `list [--cues] [--blanks] [--auditors] [--all\|-a]` | Enumerate discovered sources, one per line (defaults to cues; the kind flags restrict the listing; `--all` shows every kind). MUST display `name`, `description`, source kind (cue / blank / auditor), and trigger summary (`match:` / `keywords:` / `blankKeywords:` for cues and blanks; `priority:` for auditors). |
| `seed-configs [--silent]` | Copy shipped defaults into the user search path on first install; idempotent on subsequent runs. Idempotently migrate legacy filenames. Runtime-specific in detail. |

Runtimes MAY add commands; the three above are the interop surface that authoring tools (editors, CI, doc generators) can rely on. Flag *names* are non-normative (each runtime's CLI conventions differ) — only the command names and their semantics are part of the interop surface.

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

A conformant validator (`opencues validate` or equivalent) MUST report the rules in the first table below. Severity column: `error` blocks load; `warn` allows load but surfaces the issue; `info` is observational.

| Rule | Severity | What it checks |
|---|---|---|
| `cue-missing-name` | error | `CUE.md` frontmatter has no `name`. |
| `cue-missing-trigger` | error | `CUE.md` declares neither `match:` nor `keywords:`. |
| `cue-empty-body` | warn | `CUE.md` body has neither a JSON tip-group block nor non-empty prompt text. |
| `blank-missing-name` | error | `BLANK.md` lacks `name`. |
| `blank-missing-keywords` | error | `BLANK.md` lacks both `blankKeywords` AND `blankShapes` — `blankKeywords` is friendly shorthand that desugars to `blankShapes` (the actual routing mechanism, § Routing), so a blank declaring `blankShapes` directly is equally reachable and must NOT be flagged. |
| `blank-no-binding` | warn | `BLANK.md` declares zero binding profiles (no `stepValues` / `blankScript` / `impl`) — allowed to be a warn rather than error because implicit-impl-by-name MAY still resolve the blank at runtime. |
| `blank-multiple-bindings` | error | `BLANK.md` declares more than one binding profile. |
| `blank-script-missing` | error | `blankScript:` references a relative path that doesn't exist on disk. |
| `auditor-missing-name` | error | `AUDITOR.md` frontmatter has no `name`. |
| `auditor-empty-body` | error | `AUDITOR.md` body is empty or whitespace-only. |
| `unknown-host` | error | A host name in `on-host` / `not-on-host` is not in the known set. |
| `name-collision` | error | Two loaded sources share the same `name:` within a single layer. |
| `spec-too-new` | error | File declares a `spec:` newer than the runtime supports. |
| `parse-failed` | error | A source file's frontmatter + body failed to parse. |
| `master-malformed` | error | A master file (`CUES.md` / `BLANKS.md` / `AUDITORS.md`) has unparseable frontmatter. |
| `source-empty-folder` | warn | A source folder exists but has no primary entry file (`CUE.md` / `BLANK.md` / `AUDITOR.md`). |

Runtimes MAY add their own implementation-specific rules under a vendor prefix (e.g. `opencues-cc-…`).

### Reference-runtime-only rules (not spec-mandated)

The OpenCues reference validator (`opencues validate`) additionally implements these checks. They're useful and other runtimes MAY adopt them, but they aren't required for conformance — promote a rule to the table above via the usual [promotion path](#promotion-path--runtime-specific-to-standard) if it proves universally useful.

| Rule | Severity | What it checks |
|---|---|---|
| `blank-script-not-executable` | warn | `blankScript:` target exists but lacks the executable bit. |
| `blank-sandbox-unset` | warn | A script-backed blank has no explicit sandbox declaration. |
| `blank-impl-missing` | error | `impl:` points at a JS file that doesn't exist. |
| `blank-impl-no-capabilities` | warn | A JS `impl:` blank declares no capability grants (network/LLM/storage/secrets). |
| `blank-secret-binding-orphan` | warn | `secrets:` names a binding no capability references. |
| `blank-secret-binding-unreachable` | warn | A secret binding is declared but unreachable from the blank's own capability grants. |
| `blank-secret-unused` | warn | A bound secret is never referenced in the blank's body/script. |
| `endpoint-invalid` | error | A custom `endpoint:` fails basic URL validation. |
| `endpoint-custom` | warn | A custom `endpoint:` overrides the provider default (informational flag, not necessarily wrong). |
| `host-compat-empty` | warn | Host-compat resolution (`on-host`/`not-on-host`) produces zero hosts — the entry can never run. |

### Spec text without a reference implementation yet (tracked gap)

These rules are useful validator behaviour that a future spec revision may promote into the MUST-report table, but they are **not implemented by the reference `opencues validate` today** — don't rely on them:

`cue-missing-description`, `cue-multiple-defaults`, `cue-host-contradiction`, `blank-missing-description`, `blank-script-on-chrome`, `auditor-missing-description`, `auditor-name-mismatch`, `disable-unknown`, `unknown-field`, `master-zero-byte`, `field-summary`.

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
