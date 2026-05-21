# Proposals

How to propose a change to one of the OpenCues standards (Cues, Blanks, Auditors, or the shared `core.md` rules). Modeled on MCP's [SEPs](https://github.com/modelcontextprotocol/modelcontextprotocol/tree/main/seps) and OpenAPI's [`proposals/`](https://github.com/OAI/OpenAPI-Specification/tree/main/proposals).

This directory is **seeded but not yet exercised** — no external proposers as of `0.1-alpha`. The structure is here so the first proposal has a place to land.

## When to write a proposal

Open a proposal when you want to:

- **Add a new field** to a CUE.md, BLANK.md, AUDITOR.md, or master file's frontmatter.
- **Change the semantics** of an existing field (e.g. change a default, add a new value).
- **Add a new behaviour mode** to one of the three surfaces.
- **Promote a runtime-specific scalar** to the standard, per [`core.md` § Promotion path](../core.md#promotion-path--runtime-specific-to-standard) (requires two independent runtime implementations adopting the scalar first).
- **Add a new normative MUST / SHOULD / MAY** to a runtime contract.

You do NOT need a proposal for:

- Bug fixes to the spec text (typos, broken anchors, clarifications that don't change behaviour) — just open a PR.
- New conformance fixtures that pin existing behaviour — add to `spec/conformance/` directly.
- Reference-implementation changes — those live in `packages/opencues-runtime/SPEC.md` and don't require spec changes unless a field is being promoted.
- Per-host integration changes — those live in `integrations/<host>/` and don't touch the standard.

## How to write one

1. **Copy the template.** `cp template.md proposals/<short-name>.md`. Pick a short, kebab-case name describing the change (`sentence-cue-stride.md`, `auditor-per-source-llm.md`).
2. **Fill in the sections.** Be concrete. Cite spec line numbers when you reference existing behaviour. Show the BEFORE / AFTER of any file format example.
3. **Open a PR.** The PR description should link to the proposal file. CI will check for typos and broken links.
4. **Discussion happens in the PR.** Inline comments on the proposal file, or general design comments in the PR conversation.
5. **Acceptance.** A proposal is accepted when a spec maintainer merges it. The merge commit MUST also update [`spec/CHANGELOG.md`](../CHANGELOG.md) with an entry under `[Unreleased]` linking to the proposal file.

## Status states

A proposal carries one of four `status:` values in its frontmatter:

| Status | Meaning |
|---|---|
| `draft` | Open for discussion. May change substantially. |
| `accepted` | Merged into the spec. The proposal stays in this directory as historical context; the actual spec change lives in `spec/<file>.md` and is recorded in `CHANGELOG.md`. |
| `withdrawn` | Author closed without merging. Reason explained in the proposal's final revision. |
| `rejected` | Maintainer declined. Reason explained in the PR + the proposal's final revision. |

Rejected and withdrawn proposals stay in this directory — future proposers can see what was tried and why it didn't land.

## Versioning impact

Every accepted proposal lands in the `[Unreleased]` section of [`spec/CHANGELOG.md`](../CHANGELOG.md). When the next spec version cuts, the `[Unreleased]` block becomes the new version's release notes.

While the spec is `0.1-alpha`, every accepted proposal is potentially breaking — the alpha tag is the disclaimer. Once the spec hits `0.1`, the changelog convention switches to SemVer-equivalent rules:

- `### Added` — backwards-compatible new fields, behaviours, or contracts. Minor bump.
- `### Changed` — backwards-incompatible behaviour change. Major bump.
- `### Deprecated` — field will be removed in a future major. Minor bump.
- `### Removed` — field is gone. Major bump.
- `### Fixed` — clarification that doesn't change behaviour. Patch bump.

Per [`core.md` § Consumer behavior — unknown content](../core.md#consumer-behavior--unknown-content), unknown frontmatter fields MUST be preserved (warn at validate time, don't error at load). This is what makes additive changes possible without a major bump.

## Reviewer rubric

Reviewers assess proposals against four criteria:

1. **Concreteness.** Does the proposal show the BEFORE and AFTER? A frontmatter field added without a concrete example of where it goes in `CUE.md` / `BLANK.md` / `AUDITOR.md` is hard to evaluate.
2. **Independent value.** Does this change have value to a third-party runtime, or only to the reference implementation? Reference-only changes belong in `packages/opencues-runtime/SPEC.md`, not here.
3. **Backwards compatibility.** Does it break existing valid files? If yes, the proposal must justify the break against the (currently `alpha`) versioning policy.
4. **Conformance impact.** Does it add a new MUST / SHOULD / MAY to a runtime contract? If yes, the proposal must include the test fixture(s) that would land in `spec/conformance/` to pin the new behaviour.

A proposal that doesn't address criterion 4 is structurally incomplete — the conformance suite is the contract.

## Currently accepted proposals

(None yet. This directory exists; no proposals have been accepted as of `0.1-alpha`.)

## See also

- [`spec/`](../) — the standard itself
- [`spec/CHANGELOG.md`](../CHANGELOG.md) — accepted spec changes, grouped by version
- [`spec/conformance/`](../conformance/) — the fixture tree that every accepted proposal must extend
- [`core.md` § Promotion path](../core.md#promotion-path--runtime-specific-to-standard) — how runtime-specific scalars graduate to the standard
