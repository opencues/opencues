# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in OpenCues, please report it
responsibly.

**Do not open a public issue.** Instead, email **hello@opencues.com**
with:

- A description of the vulnerability
- Steps to reproduce
- The potential impact
- Any suggested fix (if you have one)

We will acknowledge your report within 48 hours and aim to provide a
fix or mitigation within 7 days for critical issues.

---

## Trust model

OpenCues runs locally on your machine. The fundamental trust
assumption: **anything you put in `~/.cues/` is trusted code, just
like `.bashrc` or `~/.config/<tool>/`**. The runtime executes scripts
under `blanks/<name>/<name>.sh` with your user permissions; it sends
your current draft as prompt context to whichever LLM endpoint each
cue/blank/auditor specifies. Both are user-authorised behaviours.

The standard formalises this in `spec/blank-spec.md § Trust model`:

- `stepValues:` blanks (static lists) and `impl:` blanks (in-process
  classes that must exist in the runtime ahead of time) are
  **registry-safe** — no code execution from a `BLANK.md` alone.
- `blankScript:` blanks invoke shell scripts. v1.0 carves these out
  of any future registry distribution: a conformant runtime MUST
  source them only from local directories (`<root>/blanks/<name>/`)
  or shipped defaults (`defaults/blanks/<name>/`), MUST NOT
  auto-install from a network source, MUST NOT trust frontmatter
  flags (`trusted: true`, `signed: ...`) as a substitute for user
  inspection, and SHOULD log script invocations.

A future revision MAY introduce a registry mechanism with
cryptographic provenance, sandboxed execution, or signed publisher
manifests — all of which are needed before script distribution is
safe. v1.0 deliberately omits them.

---

## Boundaries in place (cross-host)

| Boundary | CC | OC | Gemini | Chrome | Source |
|---|---|---|---|---|---|
| **`blankScript:` carve-out** (scripts can't ship via registry) | ✓ | ✓ | ✓ | ✓ | `spec/blank-spec.md` |
| **Path sandbox** — refuse `blankScript:` resolving outside CUES roots, realpath-based to defeat symlinks | ✓ | ✓ | ✓ | ✓ | `packages/opencues-runtime/src/security/spawn-sandbox.ts` |
| **OS-level sandbox** (opt-in via `sandbox: strict`) — read-only FS outside `/tmp`, no network by default, isolated PID/IPC namespaces. bwrap-based on Linux/WSL. | ✓ | ✓ | ✓ | ✓ | `packages/opencues-runtime/src/security/sandbox-runner.ts` + `docs/architecture/sandbox.md` |
| **User-shipped JS blanks** — `impl: ./blank.js` runs in a capability-constrained context (vm.Context on Node, Web Worker in chrome). Only declared `network:`/`llm:`/`storage:` capabilities are available; no fs/process/runtime-internals access. | ✓ | ✓ | ✓ | ✓ | `packages/opencues-runtime/src/user-blanks/` + `docs/architecture/user-blanks.md` |
| **Audit log** — append every script invocation to `<root>/.opencues-log` (timestamp, host, command, args, exit, ms) | ✓ | ✓ | ✓ | ✓ | `spawn-sandbox.ts` |
| **Env-key whitelist** — only `CUES_*` env vars from a script spec reach the spawned process | — | — | — | ✓ | `integrations/chrome/host/host.cjs` |
| **Endpoint validation** — flag custom LLM endpoints at `opencues validate` (error on unknown provider / invalid URL; warn on stock-override) | ✓ | ✓ | ✓ | ✓ | `packages/opencues-core/src/llm-provider.ts:validateEndpoint` |
| **Runtime endpoint warning** — log once per `(provider, endpoint)` when a custom URL is resolved | ✓ | ✓ | ✓ | ✓ | `resolveLLM` in same module |
| **Trust gate** — drop `input` events with `isTrusted=false`; require credit-backed `_` keystroke before forwarding to runtime | — | — | — | ✓ | `integrations/chrome/src/trust-gate.ts` |
| **Site allow/deny** — `on-site` / `not-on-site` frontmatter scopes entries to platforms / hostnames / paths | — | — | — | ✓ | `inferSiteCompat` + `site-filter.ts` |
| **`allowed_origins`** on the native-messaging manifest — only the registered extension can talk to the host | — | — | — | ✓ | manifest written by `chrome-host` installer |
| **Per-call timeout** on subprocess invocation | ✓ | ✓ | ✓ | ✓ | each host's spawn wrapper |

Test coverage: `packages/opencues-core/src/host-compat.test.ts` (44),
`integrations/chrome/src/trust-gate.test.ts` (15),
`integrations/chrome/src/site-filter.test.ts` (23),
+ the existing 62 in `llm-provider.test.ts`.

Detailed per-area:

- **Chrome integration** — `docs/architecture/chrome-security.md`
  (boundaries, threat model, known gaps).
- **Trust gate (chrome)** — `integrations/chrome/src/trust-gate.ts` +
  test. Credit-based: each trusted `_` introduction (keydown of `_`,
  paste / drop containing `_`) buys exactly one underscore insertion
  in the runtime. Defeats the "user typed `_` once, page injects `_`
  via execCommand within 1s" replay attack.
- **Path sandbox (native hosts)** —
  `packages/opencues-runtime/src/security/spawn-sandbox.ts`. Refuses
  any absolute script path that resolves outside `$OPENCUES_HOME` /
  `<cwd>/.cues` / `~/.cues`. Uses `fs.realpathSync` so a symlink at
  `~/.cues/blanks/evil/script.sh -> /etc/passwd` is refused even
  though the symlink itself is inside a root.
- **Audit log** — appended to `<first-CUES-root>/.opencues-log` on
  every script invocation. Schema is tab-separated:
  `ISO-timestamp\thost\tcommand\targs(comma-joined)\texit=N[\tms=N][\ttimedOut=true]`.
  Cheap to grep, append-only, swallow write errors.

---

## Threat actors we defend against

| Actor | Goal | Defended by |
|---|---|---|
| **Hostile web page** | Trigger an OpenCues capability without user intent (system-volume change, scripted blank, draft exfiltration) | Trust gate (`isTrusted` + credit-based `_` accounting), site allow/deny lists, `allowed_origins` on the native port |
| **Malicious cue pack** the user installed without reading | Run code outside CUES roots, exfiltrate the user's draft, smuggle env vars into the spawned process | Path sandbox (realpath), env-key whitelist (chrome), endpoint validation, audit log |
| **Other browser extensions** | Read OpenCues state, talk to the host | Manifest `allowed_origins` (only the registered extension); `chrome.storage.local` is per-extension |

## Actors we DO NOT defend against

| Actor | Why | Mitigation |
|---|---|---|
| **Yourself with DevTools open on a page** | You can write arbitrary bundles to your own `chrome.storage.local`; the path sandbox still applies so script execution is bounded to CUES roots | Don't open DevTools on untrusted pages and execute arbitrary JS there |
| **An attacker with write access to `~/.cues/`** | Same trust level as write access to `.bashrc`. The script-bearing carve-out is path-shaped, not content-shaped — scripts inside CUES roots run unmodified | Standard OS file permissions; don't share user accounts |
| **An attacker who replaces `@opencues/runtime` binaries** | The runtime is npm-installed (or `pnpm` in this monorepo); standard supply-chain assumptions apply | Pin versions; verify checksums; eventual signed publishes |

---

## Known gaps (deferred to post-v1.0)

The spec's "future revision" commitment captures these:

- **Default-on sandbox.** The OS-level sandbox shipped as opt-in:
  blanks declare `sandbox: strict` to receive it. Existing shipped
  blanks (volume, brightness) need `/mnt/c/` filesystem access for
  Windows-side binaries (`VolCtl.exe`) and won't run inside the
  sandbox until they declare those permissions explicitly. Migration
  plan: audit each default blank, attach `sandbox: strict` or
  `sandbox: off` with rationale, then flip the runtime default.
- **Syscall-level confinement.** The bwrap sandbox is filesystem-
  and namespace-shaped, not syscall-shaped. A future revision could
  layer `--seccomp <fd>` to block `ptrace`, `chroot`, `mount`, etc.
- **Sandbox cycling (`set` calls).** Today only the blank-fill
  `get` path applies the sandbox. Cycling Up/Down on a sandboxed
  blank fires `set <value>` unsandboxed. Plumbing the sandbox config
  through `cycling.ts`'s `invokeOrSpawn` helper closes this; tracked
  as follow-up.
- **Cryptographic provenance for cue packs.** Once a registry
  exists, `opencues add <pack>` should verify a signature against
  the publisher's manifest. Today's distribution model is "publish
  the `BLANK.md` + script verbatim as documentation; users copy
  manually after reading."
- **Rate limiting on subprocess invocation.** A pathological cue
  pack could call `volume-blank.sh` in a tight loop. Per-call
  timeout caps each invocation but not the rate.
- **Auditor endpoint policy.** Auditors get the entire draft as
  input. Today `validateEndpoint` flags custom URLs at config-load
  and warns at runtime, but doesn't refuse them. A "require user
  confirmation for non-stock auditor endpoints" mode would harden
  this further.
- **Cue-pack version constraints.** Packs don't declare which
  runtime version they target. A pack written for v0.1 might
  exploit a v0.2 contract change.
- **Storage tampering via DevTools.** Documented as "self-pwn only"
  — the path sandbox still applies, so the max damage is
  config-shaped, not execution-shaped.

---

## Disclosure timeline

OpenCues does not yet have formal releases. Security fixes are
applied to the `master` branch.

| Version | Supported |
|---------|-----------|
| master  | Yes       |

For paid / contractual deployments (none today): tagged versions
and back-ports would be added here.
