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

## How it works

- `extension.fixture.ts` — launches a persistent context with the
  extension loaded, waits for the service worker, and exposes `seed()`,
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
| M2 security | trust-gate (synthetic-event refusal), sensitive-field (password no-attach), each with a positive control | ✅ |
| M2 security | site-filter off-site cue dropped | ⏸ `test.fixme` — a seeded folder-cue isn't discovered from the storage bundle under Playwright (chrome cue-discovery-from-seed gap, not the control). See the TODO in `security.e2e.test.ts`. |
| M3 host-dependent | scripted blanks / custom user-blanks (need a mock native-messaging host) | deferred |

Adding a check: drop a `*.e2e.test.ts` under `tests/e2e/`, seed config
with `seed()`, install a `MockLlm` if the feature calls an LLM, and
assert the runtime contract (buffer changed / control blocked) — not a
specific LLM string.
