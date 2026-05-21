# Spec changelog

All notable changes to the OpenCues standard (`spec/`) are
recorded here. The reference implementation (`@opencues/core`)
maintains its own changelog at the repo root; this file tracks
only what would affect a third-party implementation.

This changelog follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format. Versions follow [SemVer](https://semver.org/) within the
`0.x` pre-release line — at this stage every change is potentially
breaking.

---

## [Unreleased]

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
  scenarios. Non-executable; each implementation wires its own runner. See
  the suite's [`README`](./conformance/README.md) for the runner template
  and the contribution model. No spec field changed — this is purely
  additive infrastructure for second implementers.

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
