# Cues Specification

**Current version: `0.1` (draft)**

This document declares the **Cues spec** — the durable, host-agnostic format that
describes word-cues and blank-fills. It is separate from any single
implementation. A conforming reader is anything that can parse the formats
below and surface them to a user; this repo ships the reference implementation
(`@opencues/core` + `@opencues/runtime`), but the spec is intended to be
implementable independently.

The exported constant is `SPEC_VERSION` from `@opencues/core` — runtime hosts
and third-party readers pin to it the same way bundlers pin to ESM levels.

## What the spec covers

The `0.1` spec defines the wire format of:

1. **`CUES.md`** — the cue master config: frontmatter (project metadata) +
   `## Tips` / `## Ignore` / `## Prompt` sections (LLM cue source declarations).
   See `packages/opencues-core/src/cues-md.ts` for the canonical parser.

2. **`cues/<name>/CUE.md`** — folder-based cue configs (`type: tips` static
   tip groups, or LLM-backed word-cues with `match:` / `keywords:` /
   `priority:` / `scope:` routing).

3. **`blanks/<name>/BLANK.md`** — folder-based blank configs (declarative
   blanks: scripted, list-stepped, runtime-class-backed). Frontmatter declares
   `blankKeywords`, `blankScript`, `blankReplace`, etc.

4. **`OPENCUES.md`** — runtime system settings (scalar key/value pairs;
   schema owned by the FEATURES + MENU_TUNABLES registry in
   `packages/opencues-core/src/feature-registry.ts`).

5. **`AUDITORS.md`** — inline-rewrite concern declarations (grammar, clarity,
   tone, etc.) composed at agent-tick time.

6. **Host-compat directives** — `on-host:` / `not-on-host:` / `on-site:` /
   `not-on-site:` frontmatter keys that scope a cue/blank to specific
   integrations or URLs.

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

## Version policy

- `0.x` versions are **draft** — incompatible format changes are allowed.
- `1.0` will be the first stable version. After that, additive changes
  bump the minor (`1.1`, `1.2`, …) and breaking changes bump the major.
- A conforming reader MUST refuse to parse a file whose declared spec
  version is higher than the reader's pinned `SPEC_VERSION`.

## Where the spec lives

- This file — high-level overview + version policy.
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
