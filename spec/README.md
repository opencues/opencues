# OpenCues — Open Standard

> **Status:** `0.1-alpha`. Expect changes.

This directory holds the open standard for **Cues** and **Blanks** — two file formats that any text editor, IDE, or LLM-pipeline can implement to interoperate. The standard is licensed under the same terms as this repository (see [`LICENSE`](../LICENSE)).

## What the standard is

OpenCues reduces to two ideas (see [`../concept.md`](../concept.md)):

| Direction | Surface | File format | Trigger |
|---|---|---|---|
| LLM → user | **Cues** — alternatives surfaced over plain text | [`cue-spec.md`](./cue-spec.md) | regex `match` / `keywords` list |
| user → system | **Blanks** — `_`-gated value substitutions | [`blank-spec.md`](./blank-spec.md) | `_` adjacent to `blankKeywords` |

The standard covers two file shapes (`cue.md`, `blank.md`), the master files that aggregate them (`cues.md`, `blanks.md`), and the runtime contracts a conformant implementation must satisfy.

## What the standard is *not*

- Not a UI spec. How alternatives render (ANSI dim, CSS highlight, popup), what keys cycle them (Up/Down, Tab, voice), how the cursor moves — all out of scope. Each integration decides.
- Not a prompt-design spec. The LLM-mode wire format (`INDEX:alt1,alt2`) is normative; the prompts themselves are runtime-private.
- Not the same as SKILL.md. Skills are LLM-routed by `description`. Cues and blanks fire deterministically on text content. See [`cue-spec.md` § Trigger model](./cue-spec.md#trigger-model).

## Documents

| File | What it covers |
|---|---|
| [`cue-spec.md`](./cue-spec.md) | The `cue.md` format and the cue runtime contract |
| [`blank-spec.md`](./blank-spec.md) | The `blank.md` format and the blank runtime contract |
| [`core.md`](./core.md) | Shared rules: search-path, host-compat, hot-reload, master `cues.md` / `blanks.md`, routing |
| [`opencues-runtime.md`](./opencues-runtime.md) | **Non-standard.** OpenCues-runtime-only knobs (voice-mode, debug-mode, cursor-navigate) plus implementation specs for fluid blank and transform blank. Documents the promotion path from runtime-specific to standard. |
| [`schemas/cue.schema.json`](./schemas/cue.schema.json) | JSON Schema for `cue.md` frontmatter. Editor integrations may use this for live validation. |
| [`schemas/blank.schema.json`](./schemas/blank.schema.json) | JSON Schema for `blank.md` frontmatter. |

## Reading order

Implementers building a new runtime: read `cue-spec.md`, `blank-spec.md`, `core.md` in that order. `opencues-runtime.md` is reference-only and can be skipped.

Authors writing `cue.md` / `blank.md` files: read the §§ Configuration spec and Examples in each spec doc. Skip the Runtime contract sections — those are for runtime implementers.

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
