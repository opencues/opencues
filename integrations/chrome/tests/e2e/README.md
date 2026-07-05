# Chrome extension end-to-end (silent-degrade) suite

Loads the **real unpacked extension** into Chromium and drives features
through the actual content script + service worker to observable output.
This is distinct from the write-path suite (`../playwright/*.pw.test.ts`),
which loads a `test-bundle.js` subset with a chrome-API stub and never
boots the extension.

It targets the "wired but inert in chrome, nothing logs" bug class the
static lints can't catch — including a security control that degraded
**open**. Two check categories:

- **security** (`security.e2e.test.ts`) — a control that should block
  still blocks. Each block is paired with a positive control so it can't
  pass trivially by the feature being dead everywhere.
- **scenario** (`scenario.e2e.test.ts`) — a real feature journey runs
  end-to-end to observable output.

## Run

Run-on-demand (not a CI gate):

```bash
npm run build            # extension dist/ must be current
npm run test:e2e:chrome
```

Loads the WSL-side `dist/` directly via `--headless=new` (no display, no
`/mnt/c` sync, no native-messaging host — config is seeded into
`chrome.storage` by the fixture).

**~11s** for all 10 tests. The extension is loaded **once per worker**
(worker-scoped context) and reused; `fullyParallel` + 3 workers spreads
individual tests across workers so the ~3–4s "prove nothing happened"
absence-waits overlap instead of summing. Per-test isolation on the
shared context is restored by the auto `_isolate` fixture (unroute,
close pages, clear `chrome.storage` after each test).

## How it works

- `extension.fixture.ts` — loads the extension into a **worker-scoped**
  persistent context (once per worker, reused across its tests), waits
  for the service worker, and exposes `seed()`,
  which writes the `chrome.storage.local` keys the native host would push
  (`opencues_bundle`, `opencues_host_keys`) via the SW context **before**
  the page's content script boots.
- `mock-llm.ts` — deterministic LLM. Every OpenCues LLM call in chrome is
  a POST proxied through the service worker, so we intercept with
  `context.route()` on the provider host (never `page.route()`). Groq +
  gpt-oss uses strict-JSON, so fluid-blank replies are JSON
  (`fluidBlankReply`).
- `seed-config.ts` — fixture config builders (OPENCUES.md pinned to the
  mockable `groq` provider, plus per-test cue/blank fixtures).
- `pages/` — minimal `textarea.html` (normal-input + sensitive fields)
  and `contenteditable.html` (full profile).

## Status

| Milestone | Coverage | State |
|---|---|---|
| M0 harness | extension loads, SW registers, config seeds, runtime boots + attaches | ✅ |
| M1 scenario | fluid-blank `_` lookup substitutes end-to-end | ✅ |
| M2 security | trust-gate (synthetic-event refusal), sensitive-field password no-attach + mistyped-CC heuristic (residual #25), site-filter off-site cue never fires — each with a positive control | ✅ |
| M3 host-dependent | scripted blanks / custom user-blanks (need a mock native-messaging host) | deferred |

All three security controls are mutation-verified: disabling the
control in source (isTrusted+credit gate, isSensitiveField,
applySiteCompatFilter) turns the corresponding test red, so each is a
genuine degraded-open detector, not a false pass.

> Note on folder cues from a seeded bundle: word-cues are gated behind
> `word-cues-mode: on` (resolver.ts) — a seeded folder-cue is discovered
> and merged, but the resolver builds no source for it unless the mode is
> on. The site-filter fixtures set `word-cues-mode: on`; see
> `seed-config.ts:opencuesMd`.

Adding a check: drop a `*.e2e.test.ts` under `tests/e2e/`, seed config
with `seed()`, install a `MockLlm` if the feature calls an LLM, and
assert the runtime contract (buffer changed / control blocked) — not a
specific LLM string.
