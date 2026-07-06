# OpenCues Specification

**Current version: `0.6` (draft)**

This document is a short front door. The full standard — **Cues**, **Blanks**,
and **Auditors**, plus the shared `core.md` rules and the `identity-context`
sentinel format — lives in [`spec/`](spec/README.md); start there for the
complete surface-by-surface breakdown, the JSON schemas, and the conformance
fixture tree. This file exists for the version policy and a top-level pointer;
it deliberately doesn't duplicate `spec/README.md`'s content, to avoid the two
drifting out of sync.

The durable, host-agnostic format described by the standard covers word-cues,
blank-fills, and inline-rewrite auditors. It is separate from any single
implementation. A conforming reader is anything that can parse the formats
below and surface them to a user; this repo ships the reference implementation
(`@opencues/core` + `@opencues/runtime`), but the spec is intended to be
implementable independently.

The exported constant is `SPEC_VERSION` from `@opencues/core` — runtime hosts
and third-party readers pin to it the same way bundlers pin to ESM levels.

## What the spec covers

See [`spec/README.md`](spec/README.md#documents) for the full per-file
breakdown. Summary — the spec defines the wire format of:

1. **`CUES.md`** — the cue master config: frontmatter (project metadata) +
   `## Tips` / `## Ignore` / `## Prompt` sections (LLM cue source declarations).
   See `packages/opencues-core/src/cues-md.ts` for the canonical parser.

2. **`cues/<name>/CUE.md`** — folder-based cue configs (`type: tips` static
   tip groups, or LLM-backed word-cues with `match:` / `keywords:` /
   `priority:` / `scope:` routing).

3. **`blanks/<name>/BLANK.md`** — folder-based blank configs (declarative
   blanks: scripted, list-stepped, runtime-class-backed). Frontmatter declares
   `blankKeywords`, `blankScript`, `blankShapes`, `integration`, etc.

4. **`OPENCUES.md`** — runtime system settings (scalar key/value pairs;
   schema owned by the FEATURES + MENU_TUNABLES registry in
   `packages/opencues-core/src/feature-registry.ts`).

5. **`AUDITORS.md`** — inline-rewrite concern declarations (grammar, clarity,
   tone, etc.) composed at agent-tick time.

6. **Host-compat directives** — `on-host:` / `not-on-host:` / `on-site:` /
   `not-on-site:` frontmatter keys that scope a cue/blank to specific
   integrations or URLs.

7. **`IDENTITY.md` + sentinel tokens** — opt-in personal-data catalog.
   YAML frontmatter where each `key: value` derives a canonical
   bracket-token usable in LLM-bound prompts.

   **Token derivation** (deterministic, canonical across all
   conforming readers): camelCase / snake_case / kebab-case → space-
   separated UPPERCASE wrapped in brackets. Required by interop —
   two independent readers consuming the same `IDENTITY.md` MUST
   derive the same tokens.

   ```
   firstName        → [FIRST NAME]
   first_name       → [FIRST NAME]
   first-name       → [FIRST NAME]
   workCityHome     → [WORK CITY HOME]
   phoneE164        → [PHONE E164]
   ```

   See `packages/opencues-core/src/identity-context.ts:deriveToken`
   for the canonical algorithm (camelCase boundary insertion +
   separator collapse + uppercase). Collisions (two keys → same
   token) are rejected at write time; see
   `identity-validator.ts:validateSentinelWrite`. Capacity caps
   default to 64 fields × 256 chars/value (`DEFAULT_SENTINEL_CAPS`).

   **Catalog emission + post-processing** are implementation
   choices a reader MAY adopt: when emitted, the LLM sees the
   bracket-tokens (in `safe` mode just the tokens + descriptions;
   in `raw` mode tokens accompanied by their values), and the
   runtime substitutes any token that resolves against the catalog
   back to its value before the LLM output reaches the buffer.
   Unknown bracket-tokens MUST be stripped (hallucination
   defence) and bracket-strings already present in the user's
   buffer MUST be preserved verbatim. The mode is gated by the
   `identity-context-mode` scalar in `OPENCUES.md` (`off` /
   `safe` / `raw`; default `safe` since PR #161, 2026-06-18 — was
   `off` before that).

8. **`katas/<name>/KATA.md`** — guided in-editor scenarios (new in
   `0.5`). Frontmatter (`name` / `id` / `title` / `next` curriculum
   link) + `## ` step sections whose bodies are opaque coach-prompt
   material. The **file format** is spec; the coaching runtime (trace,
   coach tick, escape ladder, rendering) is reference-impl. See
   [`spec/kata-spec.md`](spec/kata-spec.md).

## What the spec does NOT cover

- The internal `CueSource` class hierarchy (`BlankSource`,
  `FluidBlankSource`, `TransformBlankSource`, etc.) — these are
  implementation details of the reference resolver, not part of the
  format a reader needs to support.
- LLM prompt internals (`@opencues/core/prompts/*`) — implementations
  are free to use different prompts as long as the output parser format
  agrees.
- The host-side runtime surface (`HostAdapter` contract, render directives,
  ZWS handling, etc.) — that is `@opencues/runtime`-specific.
- Per-prompt sentinel conventions internal to specific cue/blank
  pipelines (e.g. `CURSOR_SENTINEL` for TransformBlank cursor
  encoding). Only the public `IDENTITY.md`-derived sentinel tokens
  are wire format; per-pipeline sentinels are implementation
  details of the reference resolver.

## Version policy

- `0.x` versions are **draft** — incompatible format changes are allowed.
- `1.0` will be the first stable version. After that, additive changes
  bump the minor (`1.1`, `1.2`, …) and breaking changes bump the major.
- A conforming reader MUST refuse to parse a file whose declared spec
  version is higher than the reader's pinned `SPEC_VERSION`.

## Where the spec lives

- This file — top-level pointer + version policy.
- [`spec/`](spec/README.md) — the full per-surface spec files, JSON schemas, and conformance fixtures. Canonical.
- `packages/opencues-core/src/spec-version.ts` — the exported constant.
- The canonical parsers (`cues-md.ts`, `discover.ts`, frontmatter readers
  across the sources tree) — the executable form of the spec.

## Reference implementations

- **Reader + resolver**: `@opencues/core` (this repo).
- **Host integration runtime**: `@opencues/runtime` (this repo).
- **Hosts**: claude-code, opencode, gemini-cli, chrome, shell (this repo,
  under `integrations/`).

A second independent implementation is the litmus test for the spec being
genuinely portable. The `0.1` → `1.0` cutover should not happen until at
least one external reader exists.
