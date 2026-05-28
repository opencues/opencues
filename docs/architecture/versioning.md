# Versioning policy

Until May 2026 every internal package sat at `0.1.0` regardless of what landed — the version field was inert. That stops now. Going forward, treat versions as load-bearing and bump them on every shipping change.

## Semver, applied per package

- **`0.x.y` = pre-stable.** Minor (`0.1 → 0.2`) for breaking changes; patch (`0.1.0 → 0.1.1`) for additive features, fixes, and refactors that preserve the public API. We expect to stay <1.0 across all packages until the first public launch.
- **`1.0.0` = first stable.** The first version a package is committed to publish with API stability guarantees. Don't reach for it before then. After 1.0, standard semver: major for breaking, minor for additive, patch for fixes.

## When to bump, by package class

- **`@opencues/core`** — bump on any source change that ships externally (resolver behaviour, source classes, parsers, registry shape, SPEC parser surface). The version is what hosts and external readers will depend on.
- **`@opencues/runtime`** — bump on any change to public exports, the `HostAdapter` contract, render-directive shape, state-class shape, or per-host adapter band. Per-host bands count: a CC-only fix that doesn't touch shared modules still bumps runtime.
- **Integration packages** (`@opencues/claude-code`, `chrome`, …) — bump when *the integration's own code* changes (patch source, host shim, bootstrap). Don't bump just because core/runtime did — the integration picks up the new versions via its `dependencies` field and the version there reflects integration-level work.
- **`opencues` CLI** (`packages/opencues-cli`) — bump on any change to the command surface, install flow, or `seed-configs` behaviour.
- **`SPEC_VERSION`** (the cues-spec, exported from `@opencues/core`) — bumps independently of packages. Only move when the wire format of `CUES.md` / `CUE.md` / `BLANK.md` / `OPENCUES.md` / `AUDITORS.md` changes, or when a documented frontmatter key is added/removed/repurposed. Implementation-detail refactors in the parsers don't bump the spec. See `SPEC.md` for the spec definition.

## Discipline

- Bump the version in the **same commit/PR** as the change. Don't batch bumps separately — that disconnects the version from the diff that motivated it and makes git blame less useful for "when did X become available?"
- When `@opencues/core` or `@opencues/runtime` bumps, integrations that depend on it update their `dependencies` field in the same PR (or the next one) so versions don't drift in lockfiles.
- The version snapshot table in CLAUDE.md will go stale fast. Regenerate it with the one-liner whenever versions matter for context; don't treat the literal table as ground truth.

## Why this matters here specifically

OpenCues ships as multiple bundled copies (CC fork's `node_modules/`, chrome's bake bundle, OC's `node_modules/`, etc.). When source has a fix but one bundled copy is stale, debugging is brutal because every copy claims the same `0.1.0`. Real version bumps make "is this build current?" answerable by `cat package.json` instead of by inspecting the resolver internals.

This is also one of the recurring failure modes called out in CLAUDE.md's "Rebuild EVERY fork after a runtime/core fix" rule — version bumps make the rebuild gap detectable.
