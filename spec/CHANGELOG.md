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

## [0.9.0-alpha] — 2026-07-25

### Added — `blankMultilineIsAnswer` blank frontmatter key (`0.8-alpha → 0.9-alpha`)

`blank-spec.md` § Frontmatter (optional) + § Flag obligations document a new optional boolean, `blankMultilineIsAnswer` (default `false`). When `true`, a runtime MUST commit a multi-line `get` result as ONE joined answer rather than splitting it into cycleable alternatives (the default list-blank behaviour). This lets a single-card blank — a location "map" card (name / address / map link), a status block — deliver its whole card at `_` instead of only its first line, while list blanks (top-N feeds) keep per-line cycling by omitting the key. Additive + optional with a behaviour-preserving default; `0.8` readers ignore the unknown key under the unknown-frontmatter rule (schema `additionalProperties: true`). `spec/schemas/blank.schema.json` documents the key. Closes opencues #339 (multi-line `map _` truncation).

### Removed — `fluid-blank-mode` from the `OPENCUES.md` schema (`0.7-alpha → 0.8-alpha`)

`spec/schemas/opencues.schema.json` no longer documents the `fluid-blank-mode` key, and the valid-masters conformance fixture no longer carries it. The reference runtime retired the gate when static resolution made the fluid blank the always-on base layer; the schema had lagged. Third-party impact: fluid-blank enablement is not configurable via `OPENCUES.md` — a conformant runtime treats the fluid surface as always available (files that still carry the key are preserved-but-ignored under the unknown-frontmatter rule). Per-feature routing keys (`fluid-blank-provider` / `fluid-blank-model` / `fluid-blank-endpoint`) are unchanged.

### Changed (editorial)

- `blank-spec.md` § Flag obligations — clarified that a `get` shape's
  `valueGroup` captures the **arg** dispatched to the blank's `get`, that the
  arg may precede the keyword (trailing-keyword shapes like
  `^(.+?)\s+location\s*_$`), and that runtimes MUST dispatch the
  shape-captured arg rather than re-deriving it positionally from
  keyword→`_`. Shaped command-span clearing wording updated to "the whole
  matched segment" (covers trailing-keyword shapes; identical behaviour for
  keyword-leading shapes). Authored shapes were already arbitrary anchored
  regexes, so no wire-format change — `SPEC_VERSION` unchanged.

---

## [0.7.0-alpha] — 2026-07-07

### Removed

- **`CueResult.linked` field** removed from the cue data shape (`cue-spec.md` § Runtime data shape table + the "MAY implement linked-word cycling" runtime-contract bullet). The field declared "other word indices that cycle in lockstep" for a Linked Words feature that was never implemented — no source ever populated it and no runtime consumed it. Removing it narrows the standard's surface. A reader that had implemented `linked` cycling against `0.6` MAY keep that behaviour as a non-standard extension; the field is simply no longer part of the standard. The routing suite's "not covered" note about `linked:` cross-word coordination is dropped with it.

### Fixed

- `core.md` § Hot-reload: corrected the reference-runtime cadence description. The reference implementation reloads config off user input with a ~2s debounce plus a ~5s background poll (`config-loader.ts`), not a ~100ms filesystem poll — the previously cited `event-bridge.ts` `POLL_INTERVAL_MS` timer is the inject-file/state poller, unrelated to config reload. The SHOULD pickup window is restated as "within a couple of seconds" to match the reference implementation (was "a few hundred milliseconds", which the reference runtime itself never met).

---

## [0.6.0-alpha] — 2026-07-06

Spec bump: `identity-context-mode: safe` becomes **bidirectional**. The
mode previously claimed only the catalog direction (values never enter
prompt blocks; the LLM emits tokens the runtime hydrates locally).
`0.6` adds the buffer direction as a normative requirement —
**dehydration**: catalog values the user TYPED into the buffer MUST be
replaced with their canonical tokens before any buffer-derived text
ships in an LLM request, on every dispatch channel (messages,
speculative prediction hints, ambient/context blocks). See
`identity-context-spec.md` § Dehydration for the six normative
requirements (coverage, matching floor, visible residual, buffer
immutability, round-trip precedence, fail-safe).

No file-format or frontmatter change — `IDENTITY.md` files authored
against `0.4` parse identically. The bump is normative-behaviour-only
(the meaning of the spec-mandated `safe` value strengthens), following
the `0.3 → 0.4` precedent.

### Changed

- `identity-context-spec.md` § Modes — `safe` is documented as the
  default (an absent scalar MUST resolve to `safe`; explicit
  unrecognised values MUST fail closed to `off`), fixing a
  contradiction with `core.md` § Spec-mandated scalars that had
  survived since the default flip. The two-tier rule is now
  explicitly required at EVERY re-parse site.
- `identity-context-spec.md` § Security claims — "Default-off"
  replaced by "Default-safe" + "Bidirectional in safe mode" (a reader
  implementing only the catalog half MUST NOT claim `safe`
  conformance against `0.6`).

### Added

- `identity-context-spec.md` § Dehydration (outbound) — the normative
  contract for the buffer-direction scrub and its interaction with
  the post-processor's user-typed-bracket preservation rule
  (preserve wins on the ambiguous both-present case; conflicts
  SHOULD be surfaced).

---

## [0.5.0-alpha] — 2026-07-06

Spec bump: adds the **`KATA.md` guided-scenario file format** as a new
standard surface ([`kata-spec.md`](./kata-spec.md)). A kata is an ordered,
in-editor scenario a runtime walks a user through.

Normative additions:

- **`katas/<name>/KATA.md`** under the standard `.cues/` search path
  (project- and user-level, normal precedence). Frontmatter keys
  `name` / `id` / `title` / `next` (all optional); `## ` headings
  delimit ordered steps; a file with zero steps MUST be treated as
  absent. Step bodies are **opaque** — instruction prose plus the
  non-normative `coach:` convention — handed verbatim to whatever
  coaching mechanism a runtime implements.
- **Curriculum link** (`next:`) resolves to a kata by `name` or `id`;
  a dangling link degrades silently.
- **Security floors** a kata-consuming runtime MUST honour: consent to
  start (no self-start), a deterministic model-independent exit, and
  display-only coaching (no buffer writes / exec / side-effects; at
  most a bounded, never-backward step counter).

Deliberately **out of the standard** (reference-impl only): the coaching
runtime — trace model, coach tick, LLM prompt prose, escape-ladder
phrasing, progress persistence, rendering. Enablement is a runtime knob
(the reference impl's `katas-mode` scalar), not a spec-mandated scalar.

New JSON schema: [`schemas/kata.schema.json`](./schemas/kata.schema.json).
New conformance fixtures: `conformance/valid/kata/`,
`conformance/invalid/kata/`.

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
