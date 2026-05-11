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
| `ctx.fetch(url, init?)` | `network: [host1, host2]` | Fetch a URL whose hostname is in the allow-list. http/https only. Throws on disallowed origin. |
| `ctx.llm({prompt, model?, maxTokens?})` | `llm: <provider>` | Send a prompt through the runtime's existing LLM stack. Provider is fixed; user can't pick endpoints. |
| `ctx.storage.get(key)` / `.set(key, value)` | `storage: <namespace>` | Read/write namespaced state. Other namespaces are unreadable. |
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
chaining). `import` statements are stripped (the blank can't load
other modules — it's a single file). Anything inside the function
body that doesn't reference unbound globals runs fine.

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

A Web Worker per blank. Worker code is a small harness that:

1. Eval's the user's `blank.js` (after stripping `import`/`export
   default` to vanilla CommonJS-style)
2. Listens for `invoke` messages: builds `ctx` with capability
   proxies that `postMessage` to the main thread
3. Returns results via `postMessage`

The main thread fulfils `ctx.*` calls after re-checking the
allow-list — defence in depth. The Worker context has no DOM, no
`chrome.*`, no access to the content script's globals.

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

Per-capability checks happen in both layers:

- **`network`**: The user's `ctx.fetch` parses the URL, refuses
  non-http(s), refuses hostnames not in the declared list. On
  chrome, the main thread re-validates before issuing the actual
  HTTP request via the SW.
- **`storage`**: All reads/writes go through the namespace. There's
  no way for a blank to access another blank's namespace — the
  namespace is bound at registration and not exposed in `ctx`.
- **`llm`**: The provider is fixed at frontmatter time. The user
  can't pass `endpoint:` or override the provider — they get
  whatever the runtime is configured for. Endpoints are validated
  against the stock provider allow-list (see
  `docs/architecture/chrome-security.md`).

A blank that declared no capabilities can still call `ctx.now()`
and `ctx.log(...)`, but `ctx.fetch`, `ctx.llm`, `ctx.storage` will
all be `undefined`. Trying to invoke a missing method is a
synchronous TypeError inside the user's code — the blank fails
visibly.

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
  warn on undeclared (probably author forgot), warn on unknown LLM
  providers, warn when the JS file doesn't exist on disk.
- **Spec update** — `spec/blank-spec.md` describes `impl:` as a
  registry name only; needs a section on the relative-path form.
- **TypeScript .d.ts** so authors get autocomplete for `ctx`.
- **The chrome LLM bridge** — `ctx.llm` currently throws "not yet
  wired in chrome". The chrome runtime has a Resolver but
  routing user-blank LLM calls through it from the Worker needs
  one more pipe.

These are tracked as follow-ups. The Node side is fully wired and
end-to-end verified; the chrome side has the Worker, capability
bridge, and registration but the LLM path needs one more step.
