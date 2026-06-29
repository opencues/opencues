# OpenCues — Open Standard

> **Status:** `0.3-alpha`. Expect changes.

This directory holds three open file-format standards — **Cues**, **Blanks**, and **Auditors** — that any text editor, IDE, or LLM-pipeline can implement to interoperate. Each surface has its own spec file and its own conformance contract; a runtime can implement one and be conformant for that surface (you don't have to implement all three). Licensed under the same terms as this repository (see [`LICENSE`](../LICENSE)).

## What the standard is

OpenCues defines three surfaces over text (see [`../concept.md`](../concept.md)):

| Direction | Surface | Operates on | File format | Trigger |
|---|---|---|---|---|
| LLM → user | **Cues** — alternatives surfaced over plain text | one word | [`cue-spec.md`](./cue-spec.md) | regex `match` / `keywords` list |
| user → system | **Blanks** — `_`-gated value substitutions | one `_` slot | [`blank-spec.md`](./blank-spec.md) | `_` adjacent to `blankKeywords` |
| LLM → buffer | **Auditors** — composed inline rewrite concerns | the whole buffer | [`auditor-spec.md`](./auditor-spec.md) | every rewrite cycle (no per-source gating) |

The standard covers three source-folder entry files (`CUE.md`, `BLANK.md`, `AUDITOR.md`), the master files that aggregate them (`CUES.md`, `BLANKS.md`, `AUDITORS.md`), and the runtime contracts a conformant implementation must satisfy.

## What the standard is *not*

- Not a UI spec. How alternatives render (ANSI dim, CSS highlight, popup), what keys cycle them (Up/Down, Tab, voice), how the cursor moves — all out of scope. Each integration decides.
- Not a prompt-design spec. The LLM-mode wire format (`INDEX:alt1,alt2`) is normative; the prompts themselves are runtime-private.
- Not the same as SKILL.md. Skills are LLM-routed by `description`. Cues and blanks fire deterministically on text content. See [`cue-spec.md` § Trigger model](./cue-spec.md#trigger-model).

## Documents

| File | What it covers |
|---|---|
| [`cue-spec.md`](./cue-spec.md) | The `CUE.md` format and the cue runtime contract |
| [`blank-spec.md`](./blank-spec.md) | The `BLANK.md` format and the blank runtime contract |
| [`auditor-spec.md`](./auditor-spec.md) | The `AUDITOR.md` format and the auditor runtime contract |
| [`identity-context-spec.md`](./identity-context-spec.md) | The `IDENTITY.md` format, canonical sentinel-token derivation, and the catalog-injection / post-processing contract |
| [`core.md`](./core.md) | Shared rules: search-path, host-compat, hot-reload, master `CUES.md` / `BLANKS.md` / `AUDITORS.md`, routing |
| [`@opencues/runtime`'s `SPEC.md`](../packages/opencues-runtime/SPEC.md) | **Non-standard, lives outside `spec/`.** Documents OpenCues-runtime-only knobs (voice-mode, debug-mode, cursor-navigate) plus implementation details for fluid blank and transform blank. Reference-impl documentation; not part of the standard a future second runtime would need to implement. |
| [`schemas/cue.schema.json`](./schemas/cue.schema.json) | JSON Schema for `CUE.md` frontmatter. Editor integrations may use this for live validation. |
| [`schemas/blank.schema.json`](./schemas/blank.schema.json) | JSON Schema for `BLANK.md` frontmatter. |
| [`schemas/auditor.schema.json`](./schemas/auditor.schema.json) | JSON Schema for `AUDITOR.md` frontmatter. |
| [`schemas/cues-master.schema.json`](./schemas/cues-master.schema.json) | JSON Schema for the `CUES.md` master file. |
| [`schemas/blanks-master.schema.json`](./schemas/blanks-master.schema.json) | JSON Schema for the `BLANKS.md` master file. |
| [`schemas/auditors-master.schema.json`](./schemas/auditors-master.schema.json) | JSON Schema for the `AUDITORS.md` master file. |
| [`schemas/opencues.schema.json`](./schemas/opencues.schema.json) | JSON Schema for the `OPENCUES.md` runtime config file (non-standard — OpenCues-specific). |
| [`conformance/`](./conformance/) | Executable test fixtures any conformant runtime can exercise against — valid + invalid examples for every surface, wire-format cases for the LLM parser, and routing scenarios. See its [`README`](./conformance/README.md). |
| [`SECURITY.md`](./SECURITY.md) | Spec-scoped security claims (auditor trust model, blank-script carve-out, capability contract for user-shipped JS blanks). Links to the reference impl's full threat model. |
| [`proposals/`](./proposals/) | Where spec-change proposals land. Template + process modeled on MCP SEPs. Seeded but not yet exercised — no proposals as of `0.1-alpha`. |

## Reading order

**Authors writing `CUE.md` / `BLANK.md` / `AUDITOR.md` files** (the everyday audience): read the §§ Configuration spec and Examples in each spec doc. Skip the Runtime contract sections — those are for runtime implementers.

**Anyone contemplating a second runtime implementation** (a non-JS port, an alternative impl): also read the Runtime contract sections + `core.md` in full. As of `0.1-alpha`, no second implementation exists; the spec is designed so one could ship, and the conformance suite ([`conformance/`](./conformance/)) is the contract such a runtime would target.

The OpenCues reference-runtime extensions doc ([`../packages/opencues-runtime/SPEC.md`](../packages/opencues-runtime/SPEC.md)) is reference-only — describes how *this* runtime extends the standard with its own non-normative knobs (TTS, debug-mode, etc.). Authors and second implementers can both skip it.

## Status & versioning

This is an alpha specification. Field names, behavior, and conformance rules may change. Files declare a version pin in their frontmatter:

```yaml
spec: opencues/0.1-alpha
```

Runtimes MUST refuse files declaring a `spec:` newer than they support. Files MAY omit `spec:` — runtimes treat absent `spec:` as "0.1-alpha".

## Contributing

Inconsistencies, missing fields, real-world patterns the spec doesn't capture — open an issue or PR against the parent repository.

## Disclaimer

This is an alpha specification. The spec, frontmatter schema, and conformance rules are under active development. Field names and semantics may change between minor versions. Implementers MAY ship runtimes that target this alpha, but production interop guarantees only begin at `1.0`. Do not depend on this spec for security-sensitive workloads.
