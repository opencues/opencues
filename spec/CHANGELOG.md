# Spec changelog

All notable changes to the OpenCues standards (`spec/` — Cues,
Blanks, Auditors, and the shared `core.md`) are recorded here. The reference implementation (`@opencues/core`)
maintains its own changelog at the repo root; this file tracks
only what would affect a third-party implementation.

This changelog follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format. Versions follow [SemVer](https://semver.org/) within the
`0.x` pre-release line — at this stage every change is potentially
breaking.

---

## [Unreleased]

---

## [0.4.0-alpha] — 2026-06-30

Spec bump: the blank routing boundary moves from the physical **line** to
the **sentence**. A keyword/shape now claims a `_` when it leads the
sentence containing `_`, where a sentence begins at the last sentence
terminator (`.`/`!`/`?` + whitespace, or a CJK/fullwidth `。`/`！`/`？`/`．`)
OR newline before `_`. Previously only a newline started a new routing
segment, so a command after a sentence terminator on the same line
(`let me check. volume _`) did not fire. The change is backward-compatible
in practice — strictly *more* commands route, none that fired before stop —
but the normative trigger text changed, so a `0.3-alpha` reader will refuse
`spec: opencues/0.4-alpha` files per the "newer-spec-refuse" rule
(`SPEC.md` § Version policy). The omit-default stays `0.1-alpha`.

### Changed

- **Blank trigger model** — `blankShapes` (and synthesized keyword shapes)
  are matched against the SENTENCE containing `_`, not the physical line.
  The segment begins at the last sentence terminator (`.`/`!`/`?` followed
  by whitespace — the whitespace lookahead keeps decimals like `3.5` /
  versions like `gpt-5.4` from splitting — or a CJK `。`/`！`/`？`/`．`) or
  newline before `_`. A command must still lead its segment with `_` at the
  trailing edge; a keyword merely mentioned mid-sentence does not fire.
  (`spec/blank-spec.md` § Trigger model, `core.md` § Routing.)

### Conformance

- `spec/conformance/routing/blank-shapes.json` — added sentence-boundary
  cases (`let me check. volume _` → volume, `done! weather oslo _` →
  weather, CJK `世界。weather kyoto _` → weather) and negative cases
  (`i turned the volume down. what a day _` → null; a connective before the
  keyword, `first the lights. then weather tokyo _` → null).

---

## [0.3.0-alpha] — 2026-06-29

Spec bump: blank routing + frontmatter surface slim-down. The blank
trigger model moves from per-blank `blankProximity` keyword distance to
deterministic, line-scoped `blankShapes` (keywords desugar to shapes).
Several optional frontmatter keys are removed from the standard. A
`0.2-alpha` reader will refuse `spec: opencues/0.3-alpha` files per the
"newer-spec-refuse" rule (`SPEC.md` § Version policy). The omit-default
stays `0.1-alpha`.

### Added

- **`blankShapes`** — anchored regex grammar (`{pattern, action,
  valueGroup?}`) matched against the line containing `_`. The single
  routing mechanism: a shape match claims the `_` deterministically with
  a typed action (`get` / `set` / `step`). When omitted, runtimes
  synthesize shapes from `blankKeywords` (+ `blankStep`).
- **`integration`** — additive output template with a `{value}` slot
  (`"volume is now {value}"`); shapes the inserted value only, never
  surrounding text.

### Changed

- **Blank trigger model** — routing is now line-scoped: a keyword (or
  shape) claims a `_` on its line, and a command MUST lead its line with
  `_` at the trailing edge. Prose that merely mentions a keyword mid-line
  no longer fires. Replaces the per-blank `blankProximity` word-distance
  model.

### Removed

- **`blankProximity`** — superseded by the line-scoped shape window.
- **`blankFormat`** — display-format hint (unused).
- **`blankAutoPopulate`** — auto-fill is now always on by default.
- **`blankReadOnly`** — cycleability is inferred (a blank cycles iff it
  declares `blankSatellite` / `stepValues` / `blankStep`).
- **`blankTip`** — folded into `tip` (one display-hint field).
- **`blankKeywordExpansions`** — superseded by self-contained blank
  output (the blank prints the display form it wants).
- **`blankReplace`** (runtime extension) — the replace/consume-mode
  machinery was deleted; fill is always-FILL with shape-derived clearing.

### Schema

- `spec/schemas/blank.schema.json` — added `blankShapes` + `integration`;
  removed the six keys above.

### Conformance

- Removed `routing/blank-proximity.json`; added `routing/blank-shapes.json`.
- Updated `valid/blank/*` fixtures to the new key set.

---

## [0.2.0-alpha] — 2026-06-04

Spec bump: extending the wire-format surface with the sentinel /
identity-context mechanism. Adds one new spec doc, one new section in
an existing spec, schema updates, and a host-rename. Additive over
`0.1-alpha`; a `0.1-alpha` reader will refuse `spec: opencues/0.2-alpha`
files per the "newer-spec-refuse" rule (`SPEC.md` § Version policy).

### Added

- **`identity-context-spec.md`** — new spec for `IDENTITY.md` (the
  user's personal-data catalog), the canonical sentinel-token
  derivation algorithm (`firstName` → `[FIRST NAME]`), and the
  catalog-injection / post-processing contract for runtimes that
  choose to personalise LLM-bound prompts. Opt-in via the
  `identity-context-mode` scalar in `OPENCUES.md`; default `off`.
  Includes capacity caps, collision-rejection, mode-gate composition
  with `blank-context-mode`, and the security-claim list a second
  implementation must honour.

- **`blank-spec.md` § Sentinel aspects** — new section defining
  how blanks participate in the sentinel mechanism:
  - `as-context: off | safe | raw` optional frontmatter for
    blank-as-context (the blank's value becomes an ambient
    `[BLANK NAME]` token in the LLM prompt);
  - `contextTtl` optional cache lifetime;
  - the reserved `sentinel` blank name (built-in keyword-bound
    write surface for `IDENTITY.md`), routed through the same
    validator chokepoint defined in `identity-context-spec.md`.

  User packs MUST NOT shadow `name: sentinel`. The pair makes the
  catalog mechanism a shared cross-cutting standard between blanks
  and identity-context, not a feature of either in isolation.

- **`core.md` § Spec-mandated scalars** — new section formalising
  which `OPENCUES.md` scalars are part of the wire contract (today:
  `identity-context-mode`, `blank-context-mode`) and which are
  runtime-only. Documents the mode-gate composition rule
  (`blank-context-mode: raw` MUST downgrade to `safe` when
  `identity-context-mode` is NOT `raw`). The filename is
  conventional; the scalar contract is normative.

### Fixed

- **`schemas/blank.schema.json`** — `blankProximity` default was `1`,
  matches the spec's `0` (adjacent default). Adds `as-context` and
  `contextTtl` properties so JSON-schema-driven validators / IDE
  hints no longer flag valid frontmatter as unknown.
- **`schemas/opencues.schema.json`** — adds the missing spec-level
  scalars (`identity-context-mode`, `blank-context-mode`,
  `ambient-context-mode`, `sentence-cues-mode`, `fluid-config-mode`,
  `blank-trigger-mode`, `nav-keymap`) plus the three LLM buckets
  (`blanks-llm-*`, `cues-llm-*`, `auditors-llm-*`).
- **`core.md` § Known host names** — `terminal` was listed as a
  reserved host; the canonical name is now `shell`. Runtimes MUST
  resolve the legacy `terminal` alias to `shell` for back-compat
  (the reference impl already does this via
  `HOST_ALIASES` in `host-compat.ts`).

### Changed

- **Conformance routing fixtures** now ship as JSON, not YAML
  ([`conformance/routing/*.json`](./conformance/routing/)). No parser
  dependency required for runners. Fixture shape is unchanged — just
  the serialization format. Implementers who prefer YAML can translate;
  the JSON shape is intentionally minimal.
- **Conformance wire fixtures** gained an optional `words` field on
  each case. When present, the runner passes it as the input-words
  array to the parser; when absent, the runner synthesizes
  `["word0", "word1", ...]`. Required for cases that exercise the
  numeric-only-word skip rule (per `cue-spec.md` § Wire format).
- **`valid/blank/*.md` fixtures** now declare `type: blank` explicitly.
  Spec text unchanged (the field is still "rarely needed" because
  production runtimes infer from path). Explicit discriminator makes
  fixtures parser-portable so runners can load by content alone.

### Added

- **`SECURITY.md`** in `spec/` — scopes the spec's normative trust
  claims (auditor trust model, blank-script carve-out, capability
  contract for user-shipped JS blanks) + links to the reference
  impl's full threat model. Closes the gap vs MCP's and OpenAPI's
  spec-scoped security docs.
- **`proposals/`** directory — seeded with `README.md` (process doc)
  and `template.md` (7-section template). Models the SEPs / proposals
  pattern every peer open standard has. Not yet exercised — no
  proposals as of `0.1-alpha`.

### Moved

- `opencues-runtime.md` moved from `spec/` to
  `packages/opencues-runtime/SPEC.md`. The file is non-normative
  (reference-impl extensions) and belongs with the reference impl,
  not in the spec dir. Every peer (MCP, OpenAPI, JSON Schema,
  CommonMark) keeps ref-impl docs out of the spec repo. All cross-
  references updated; `spec/README.md` still links to it as a
  reading-order signpost.

### Added (May 2026 — earlier in `[Unreleased]`)

- **Conformance suite** at [`conformance/`](./conformance/) — fixture tree
  any conformant runtime can exercise against. Seeds with 12 valid examples,
  12 invalid examples (with sibling `.expected.json` declaring the linter
  rule each MUST trigger), 10 LLM-wire-format parser cases, and 4 routing
  scenarios. The reference runtime (`@opencues/core`) is the current
  primary user — it exercises the suite as its parser regression net.
  A future second runtime would target the same fixtures. See the suite's
  [`README`](./conformance/README.md) for the runner template and the
  contribution model. No spec field changed — purely additive infrastructure.

---

## [0.1-alpha] — 2026-05-08

Initial open-source publication of the standard. Sets the
baseline that future changes diff against.

### Surfaces

Three normative surfaces, one folder format each:

- **Cues** — LLM → user, surfaced over plain text.
  `cues/<name>/CUE.md` defines a source.
  See [`cue-spec.md`](./cue-spec.md).
- **Blanks** — user → system, `_`-gated value substitutions.
  `blanks/<name>/BLANK.md` defines a source.
  See [`blank-spec.md`](./blank-spec.md).
- **Auditors** — LLM → buffer, composed inline rewrites.
  `auditors/<name>/AUDITOR.md` defines a source.
  See [`auditor-spec.md`](./auditor-spec.md).

### Master files

Four master files at the root of any `.cues/` directory:

- `OPENCUES.md` — runtime settings (voice-mode, llm-provider,
  feature flags). User-level only.
- `CUES.md` — cue-surface master (project metadata + `ignore[]` +
  `disable[]`).
- `BLANKS.md` — blank-surface master.
- `AUDITORS.md` — auditor-surface master.

### Cross-cutting

- Project layout + search paths in [`core.md`](./core.md).
- Runtime contracts a conformant implementation must satisfy in
  [`opencues-runtime.md`](../packages/opencues-runtime/SPEC.md)
  (moved out of `spec/` 2026-05-21 — reference-impl docs stay with
  the reference impl).
- JSON schemas (`Draft 7`) for every config file in
  [`schemas/`](./schemas/).

### Out of scope (deliberately)

- UI rendering (how alternatives display, how keys cycle them, how
  the cursor moves) — each integration decides.
- Prompt design — the LLM-mode wire format (`INDEX:alt1,alt2`) is
  normative; the prompts themselves are runtime-private.
- LLM provider selection / routing — left to the implementation.

---

## How to add an entry

When a spec field changes:

1. Move the `[Unreleased]` heading to a new versioned heading
   (`[0.1-beta] — YYYY-MM-DD` or whatever the next version is).
2. Add the bumped `[Unreleased]` heading back at the top.
3. Each entry: one line describing what changed, plus a link to
   the PR / commit that made the change.
4. Group entries by `### Added`, `### Changed`, `### Deprecated`,
   `### Removed`, `### Fixed`, `### Security` per Keep a Changelog.

Reference-implementation-only changes (TypeScript API, internal
helpers, build tooling) do NOT go here — they belong in the root
`CHANGELOG.md`. Only changes a third-party implementation would
need to know about belong here.
