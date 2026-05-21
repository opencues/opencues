# Spec security

What the OpenCues standard claims about security, and where the reference implementation's full threat model lives.

This file scopes to the **standard's** security claims — the trust model baked into the file formats and runtime contracts. For the reference runtime's full security posture (sandbox mechanism, capability enforcement, ANSI sanitization, the eight closed attack classes from the May 2026 hardening sprint), see [`docs/architecture/security-audit.md`](../docs/architecture/security-audit.md) at the repo root.

For reporting security vulnerabilities, see the repo-level [`SECURITY.md`](../SECURITY.md).

## What the standard requires

Three normative trust claims live in the spec. A conformant runtime MUST honour them; they're not optional polish.

### Auditor trust model — user-trusted only

Per [`auditor-spec.md` § Trust model](./auditor-spec.md#trust-model):

A conformant runtime:

1. MUST source auditors only from `<root>/auditors/` directories (user-level `~/.cues/auditors/` and project-level `<cwd>/.cues/auditors/`) or shipped defaults.
2. MUST NOT auto-install auditors from a network source without explicit per-pack user confirmation, including a display of the auditor's body (the prompt fragment) for inspection.
3. MUST NOT treat any frontmatter field (`trusted:`, `signed:`, `verified:`, etc.) as a substitute for user inspection. Trust derives from file **provenance**, not file content.

The standard deliberately omits a registry / marketplace / `add <pack>` mechanism for auditors in v1.0. A future revision MAY introduce one with cryptographic provenance and structural output validation — but not before then.

### Blank-script carve-out

Per [`blank-spec.md` § Trust model](./blank-spec.md#trust-model):

A conformant runtime:

1. MUST source `blankScript:` blanks only from local directories or shipped defaults.
2. MUST NOT auto-install a `blankScript:` blank from a network source without explicit per-pack user confirmation, including a display of the script's contents for inspection.
3. MUST NOT treat any frontmatter field as a substitute for user inspection.
4. SHOULD log `blankScript:` invocations in a way that makes the source path and exit code visible.

`stepValues` and `impl` blanks (no executable code in the `BLANK.md` itself) are NOT subject to this restriction — both are safe to grow registry distribution as the standard evolves.

### Capability contract for user-shipped JS blanks

Per [`blank-spec.md` § Profile 3a — `impl: ./blank.js`](./blank-spec.md#profile-3a--impl-blankjs-user-shipped-js-module):

A conformant runtime MUST:

1. Load the JS file relative to the BLANK.md's folder. Refuse absolute paths or `../` escapes outside the user's `.cues/` roots.
2. Strip `import` statements before evaluation (no module loading).
3. Strip ESM `export default` syntax to a CommonJS-style module export.
4. NOT expose `fs`, `path`, `os`, `process`, `Buffer`, `require`, `__dirname`, `__filename`, or any runtime internals to the user's module.
5. Enforce the declared `network:` allow-list as hostname-exact (no wildcards in v1.0).
6. Bind storage to the declared namespace; blank A MUST NOT be able to read blank B's namespace.

These six are conformance MUSTs — a runtime that violates any of them is not conformant for the `impl: ./blank.js` profile.

## What the standard does NOT require

- **OS-level sandboxing.** [`blank-spec.md` § Opt-in OS-level sandbox](./blank-spec.md#opt-in-os-level-sandbox-v10) defines an OPTIONAL frontmatter syntax (`sandbox: strict`, `sandbox-net`, `sandbox-fs`) for runtimes that want to confine `blankScript:` execution. The reference implementation honours it via bubblewrap on Linux/WSL and `sandbox-exec` on macOS; a future second runtime would be free to omit the sandbox entirely.
- **Network egress restrictions** on the standard's own LLM calls. Each runtime decides how it routes provider traffic.
- **PII handling rules** beyond the `user-context` runtime feature, which is itself non-normative — see [`@opencues/runtime`'s `SPEC.md`](../packages/opencues-runtime/SPEC.md).
- **Cryptographic provenance** for cue/blank/auditor packs. Deferred until a registry mechanism exists.

## Out-of-band channels

A core security property the spec relies on: **there is no out-of-band action channel from LLM output to the system.** A runtime MUST NOT route LLM-generated text from the fluid-blank, transform-blank, sentence-cue, or auditor pipelines into tool execution, fetch, clipboard writes, MCP exec, or any other side-effect layer. Worst-case prompt injection in any of those surfaces lands as user-visible text the user reviews before submitting — it CANNOT trigger an action.

This is the structural defence the standard's threat model rests on. Any runtime that wires an LLM-output → side-effect channel invalidates the threat model and MUST re-review its security posture before shipping.

## Where to look next

- Repo-level [`SECURITY.md`](../SECURITY.md) — vulnerability reporting + supported versions
- [`docs/architecture/security-audit.md`](../docs/architecture/security-audit.md) — reference-impl threat model + attack-class table + sprint history
- [`docs/architecture/sandbox.md`](../docs/architecture/sandbox.md) — OS-confinement mechanism
- [`docs/architecture/chrome-security.md`](../docs/architecture/chrome-security.md) — Chrome's six boundaries (isTrusted gate, credit-based `_` accounting, on-site filter, host path sandbox, env whitelist, per-call timeout)
- [`docs/architecture/user-blanks.md`](../docs/architecture/user-blanks.md) — capability contract for JS blanks (the reference-impl side of the `impl: ./blank.js` profile)
- [`docs/architecture/ambient-context.md`](../docs/architecture/ambient-context.md), [`docs/architecture/user-context.md`](../docs/architecture/user-context.md) — threat models for the two opt-in LLM-context features
