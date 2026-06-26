# Chrome runtime compatibility — making `@opencues/runtime` browser-safe

⚠️ **Canonical reference for the Node-vs-browser split in the shared runtime.**
Read this before adding *any* runtime feature that does HTTP, reads
`process.env`, requires a `node:*` module, or constructs a host-specific
adapter. The same `@opencues/runtime` code runs on **Node hosts** (Claude
Code, OpenCode, Gemini CLI, shell) **and inside a Chrome content script**.
Chrome has no `node:*`, no `process`, and no filesystem — so Node-isms that
are invisible on CC/OC silently break (or no-op) in the browser.

This doc exists because the BlankIntent gate shipped working on every native
host and **completely dead in chrome** for a long debugging session — the
classifier was Node-only and degraded silently. The fix + the pattern below
prevent the next one.

---

## The environment difference

| Capability | Node hosts (CC/OC/gemini/shell) | Chrome content script |
|---|---|---|
| `process`, `process.env` | ✅ | ❌ `ReferenceError: process is not defined` |
| `require('node:https')` / `node:fs` / `node:path` | ✅ | ❌ not available |
| `NodeHttpAdapter` (uses `node:https`) | ✅ real HTTP | ❌ **stubbed** to a no-op by esbuild |
| Filesystem config (`~/.cues/`) | ✅ direct read | ❌ reads `chrome.storage` (pushed bundle) |
| `require('@opencues/core')` | ✅ resolves on disk | ✅ resolves to the **bundled** copy (esbuild inlines it) |
| HTTP | `node:https` | `fetch` (a host-provided adapter) |

The chrome bundle is produced by `integrations/chrome/esbuild.config.mjs`,
which papers over *some* of this automatically:

- **`define`** replaces a fixed allowlist of `process.env.X` lookups with
  literals at bundle time (`process.env.HOME` → `'~'`, etc.). **Anything not
  in that list stays a live `process` reference and throws at runtime.**
- **`alias`** maps `@opencues/core/node-http-adapter` → a **stub**
  (`src/stubs/node-http-adapter-stub.ts`) so the import resolves, but the
  stub does no real HTTP.
- **`external`** leaves `node:fs` / `node:path` as dynamic imports the
  browser never executes (guarded by `try/catch` at the call sites).

esbuild does **not** save you from: a `process.env.NEW_VAR` you just added,
or constructing `NodeHttpAdapter` and expecting it to actually fetch.

---

## The two rules

### Rule 1 — never touch `process` unguarded
```ts
// ❌ crashes the whole content script
const x = process.env.OPENCUES_BRIDGE === '1';

// ✅ browser-safe (typeof short-circuits before `process` is evaluated)
const x = typeof process !== 'undefined' && process.env?.OPENCUES_BRIDGE === '1';
```
`typeof process` does **not** throw on an undefined identifier (special-cased
in JS), and `&&` short-circuits so `process.env.X` is never reached in the
browser. This is what `ConfigLoader.maybeReload()` now does — it was the
`ReferenceError` that killed config hot-reload (and the keystroke handler) in
chrome. Adding the var to esbuild's `define` list is the *alternative*, but
the `typeof` guard is preferred: it's defensive and doesn't require esbuild
to track every env var.

### Rule 2 — HTTP goes through a host-provided adapter, never a hard-coded `NodeHttpAdapter`
Any runtime module that makes HTTP calls must **accept an `httpAdapter`
parameter** and only fall back to `NodeHttpAdapter` when it's absent:

```ts
let httpAdapter: unknown;
if (httpAdapterOverride !== undefined) {
  httpAdapter = httpAdapterOverride;          // chrome's fetch-based adapter
} else {
  const { NodeHttpAdapter } = require('@opencues/core/node-http-adapter');
  httpAdapter = new NodeHttpAdapter({ ... }); // native hosts
}
```
The chrome adapter band (`adapters/chrome/v1/boot.ts`) builds a fetch-based
adapter (`host.httpAdapter`) and threads it in. Two runtime consumers do this
today:
- **`Resolver`** — via its `httpAdapter` option (`resolver.ts`). The original
  pattern.
- **`buildBlankIntentClassifier`** — via the `httpAdapterOverride` param,
  threaded from `BuildSharedRuntimeOptions.blankIntentHttpAdapter`
  (`boot-common.ts`). Added when this bug was fixed.

If you add a third HTTP-making module, **copy this shape**. A `NodeHttpAdapter`
constructed unconditionally is a chrome outage waiting to happen — and it
fails *silently* (the stub resolves, so there's no error; requests just never
complete).

---

## Fail *loud*, not silent

The reason this bug took so long: every failure mode in chrome was **silent**.
`buildBlankIntentClassifier` returned `null` (no key / no core / Node adapter)
and the gate degraded to a plain GET with no log. Two diagnostics now make the
gate path observable (both `debug`-level, enable `debug-mode: on`):

- `BlankIntent: boot — gate WIRED / NOT WIRED` — once per boot. Tells you
  whether the gate object was even constructed (i.e. did `getApiKeys` reach
  `buildSharedRuntime`).
- `BlankIntent: gate OFF for "<blank>" — blank-intent-mode=… (settings map: N
  keys, …)` — when a gated keyword fires but the mode reads off. The map-size
  distinguishes "empty settings map (config never reached this runtime)" from
  "genuine off".

**When you add a feature that can silently degrade on one host, add a
boot-time + a per-decision diagnostic the same way.** A `debug` log that says
*why* a feature is inert is worth an hour of live debugging.

---

## The classifier-cache gotcha (chrome keys arrive async)

Chrome's API keys arrive via the native-messaging host push **after** boot. A
feature that builds an LLM client **once and caches the result** will cache a
*failed* build if the first invocation races ahead of the key push — and stay
dead for the whole session. The gate now **retries the build until it
succeeds** (never caches a `null` classifier) instead of a one-shot
`_biBuilt` flag. Any lazily-built, key-dependent client in the runtime should
do the same on browser hosts.

---

## Checklist — before you ship a runtime feature

1. Does it read `process` / `process.env`? → `typeof` guard (Rule 1).
2. Does it make HTTP calls? → accept an `httpAdapter` param (Rule 2); the
   chrome band passes `host.httpAdapter`.
3. Does it `require`/`import` a `node:*` module? → lazy-require inside
   `try/catch`, or add an esbuild `alias`/`external`. Top-level `node:*`
   imports break Bun hosts too (see CLAUDE.md § "Top-level Node-only native
   import").
4. Does it build a key-dependent client once and cache it? → retry on failure;
   don't cache `null` (chrome keys are async).
5. Can it degrade silently on one host? → add a `debug` boot + per-decision
   diagnostic.
6. **Build the chrome bundle** (`cd integrations/chrome && npm run build`) —
   esbuild fails on unmarked `node:*` imports, and a manual `volume 40 _` /
   relevant `_` in the browser is the only real test that the feature actually
   runs in a content script.

---

## Enforcement

Rules 1 and 2 are caught automatically by **`scripts/lint-runtime-browser-safe.sh`**
(wired into `scripts/pre-pr.sh` and the CI `runtime-browser-safe` job). It
flags, in `packages/opencues-{core,runtime}/src`:

- `process.X` accesses that aren't `typeof process`-guarded (within a few
  lines), not an esbuild-`define`d key, and not in an allowlisted Node-only
  module;
- `new NodeHttpAdapter` without a `// BROWSER-SAFE-ALLOW: <reason>` marker.

These are the two shapes the esbuild build **cannot** see (it covers unmarked
`node:*` imports). Opt a specific line out with a `// BROWSER-SAFE-ALLOW:
<reason>` marker (e.g. a `NodeHttpAdapter` that's only a native-host fallback),
or add a genuinely Node-only module to the `NODE_ONLY` allowlist at the top of
the script.

What the lint **can't** prove: a feature that's wired in chrome but inert
end-to-end (the silent-degrade itself). That gap wants a Playwright chrome E2E
that fires a gated `_` and asserts the gate engages — a tracked follow-up. The
`debug` boot/gate diagnostics above are the interim safety net.

## Related

- `docs/architecture/cerebras.md`, `docs/features/chrome-sync.md` — chrome's
  config-bundle push model (why config arrives async).
- `docs/architecture/security-audit.md` — chrome's sandboxed content-script
  threat model.
- CLAUDE.md § "Common drift-bug patterns" — the Bun-crash row
  (`node-loader.ts` top-level native import) is the same class of bug for a
  different non-Node host.
- `integrations/chrome/esbuild.config.mjs` — the `define` / `alias` /
  `external` lists that make the bundle browser-safe.
