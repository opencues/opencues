# Chrome end-to-end (silent-degrade) test — plan

> Status: **M0–M2 IMPLEMENTED** (`integrations/chrome/tests/e2e/`, run
> with `npm run test:e2e:chrome`). Harness + scenario liveness + two of
> three security controls are live and green; site-filter is a documented
> `test.fixme`; M3 (host-dependent) is deferred. See
> `integrations/chrome/tests/e2e/README.md` for the status table. This
> doc is the design rationale. Tracked from `security-audit.md` § Open
> follow-ups.

## The bug class this targets

The recurring, expensive chrome bug shape is **"a feature is wired,
ships, and runs completely inert in the browser — with no error
surfaced anywhere."** Concrete instances we've already paid for:

- `ConfigLoader.maybeReload` read `process.env.OPENCUES_BRIDGE`
  unguarded → `ReferenceError: process is not defined` killed config
  hot-reload **and** the keystroke handler in the content script.
- `buildBlankIntentClassifier` constructed a `NodeHttpAdapter`
  (`node:https`, stubbed in the bundle) → returned `null` → the gate
  silently degraded to a plain GET with **no log**. Users got
  `volume 40 _` → `volume 40 100%` for hours.
- A new `dist/<subdir>/` the patch required but `setup.sh` didn't copy
  → `require()` threw, outer catch swallowed it, OpenCues came up
  `failed=true` on every session — no cues, no blanks, no log line.

The common signature: **CC/OC (Node) work; chrome is dead; nothing
logs.** Unit tests run on Node so they stay green. The static lints
(`lint-runtime-browser-safe`, the esbuild `node:*` check) catch the two
*build-visible* shapes (unguarded `process.X`, unmarked `NodeHttpAdapter`,
bad `node:*` import). They do **not** catch a feature that builds
cleanly, loads cleanly, and then does nothing — or, worse, a **security
control that degraded open** (e.g. the trust-gate stopped rejecting
synthetic events but nothing errored).

## Why the existing Playwright suite doesn't cover it

`integrations/chrome/tests/playwright/*.pw.test.ts` is real Chromium,
but it loads a **`test-bundle.js` subset** exposing
`window.__OC.{publishTarget, replaceAllText}` into harness HTML pages,
with `chrome-stub.ts` faking the chrome APIs. It verifies **write-path
call-shape** (does `replaceAllText` land one undo entry in real
Lexical/PM/Draft) — deliberately bypassing the parts where silent-
degrade lives: the **extension boot**, **config resolution from
`chrome.storage`**, the **resolver + httpAdapter**, and the
**trust-gate**. It's the right tool for its job; it structurally cannot
see a "wired but inert" feature.

**The gap: no test loads the real unpacked extension and drives a real
feature to observable output.** That's what this plan adds.

## What we're building — a run-on-demand E2E system, not a CI gate

This is **not** a required CI check. It's a solid, locally-runnable
end-to-end harness the team drives on demand (and optionally nightly),
organized around the two check categories that actually matter here:

1. **Security checks** — a control that *should* block still blocks;
   nothing has degraded *open*. trust-gate, sensitive-field refusal,
   site-scoping, secret-binding on the chrome path. These are the
   highest-value tests: a silently degraded-open control is the worst
   failure mode and no unit test or static lint sees it.
2. **Scenario checks** — a real multi-step feature journey runs
   end-to-end through the actual loaded extension to observable output
   (type → cue cycle → type → blank fill), the same "assert the runtime
   contract across a user journey" philosophy as the CC/OC agentic
   scenarios, but in a real browser.

Framing it as a dev/nightly harness (not a `pre-pr.sh` / required-CI
gate) keeps browser flakiness and build cost out of the fast path while
still giving a real end-to-end signal on demand — which is what catches
the "wired but inert" and "degraded open" classes the lints can't.

## Approach

Load the **actual built MV3 extension** into Chromium via Playwright's
persistent-context extension loading, seed a known config, stub the LLM
deterministically, drive a feature from a real keystroke, and assert
**positive observable output** (buffer changed the expected way) plus
**security-control liveness** (a control that should block, blocks).

A silently-dead build fails because the observable output never
appears; a degraded-open control fails because the block never happens.

### Components to build

1. **Extension-load fixture** (`extension.fixture.ts`). A Playwright
   fixture that `chromium.launchPersistentContext('', { args: [
   '--disable-extensions-except=<distDir>', '--load-extension=<distDir>',
   '--headless=new' ] })`, waits for the MV3 **service worker** to
   register (`context.serviceWorkers()` / `waitForEvent('serviceworker')`),
   and exposes the extension id. Fails loudly if the SW never boots.
   (Open question: MV3 + headless — see Decisions.)

2. **Mock LLM server** (`mock-llm.ts`). A tiny local HTTP server
   returning canned OpenAI-shape completions keyed by a marker in the
   prompt (so `fix typos _` → deterministic output). Wired in by
   pointing the extension's provider **endpoint** at `localhost:<port>`
   via seeded `chrome.storage` keys + an OPENCUES.md provider override,
   **or** via Playwright `context.route('**/api.groq.com/**', …)`.
   Deterministic, offline, no real key. This is what lets us assert
   exact output.

3. **Config seeding** (`seed-config.ts`). Write a fixture bundle
   (CUES.md + OPENCUES.md + one or two cue/blank folders with a feature
   enabled) into `chrome.storage.local['opencues_bundle']` from the
   test, mirroring what the native-messaging host would push — so **no
   host process is needed** for content-script features. Keeps M1/M2
   host-independent.

4. **Test pages** (`pages/*.html`). Minimal pages: a plain
   `<textarea>` (normal-input profile) and a generic
   `<div contenteditable>` (full profile). Reuse the existing
   `pages/` harnesses for managed-editor coverage later.

5. **Assertion helpers** (`assert.ts`). Read the target's buffer;
   read the extension's console / `/tmp/opencues.log` for the
   feature-fired signal; a `expectFeatureLive(name)` that asserts the
   observable effect **and** the log line, and an
   `expectControlBlocks(name)` for the degraded-open detectors.

### Test shape — the two invariants

```ts
// Liveness: a real feature produces its real effect end-to-end.
test('fluid-blank substitutes in a real content script', async ({ page, ext }) => {
  await seedConfig(ext, FIXTURE_WITH_FLUID_BLANK);
  await mockLlm.reply(/what is 2\+2/i, '4');
  await page.goto('/pages/textarea.html');
  await page.locator('#t').type('what is 2+2 _');
  await expect(page.locator('#t')).not.toHaveValue(/_/);     // substitution happened
  await expect(page.locator('#t')).toHaveValue(/4/);          // and it's the mock's answer
  // A dead build leaves "what is 2+2 _" untouched → this fails.
});

// Degraded-open detector: a control that should block, blocks.
test('trust-gate rejects a synthetic _ event', async ({ page, ext }) => {
  await seedConfig(ext, FIXTURE_WITH_VOLUME_BLANK);
  await page.goto('/pages/contenteditable.html');
  await page.evaluate(() => {                                 // hostile page injects
    const el = document.querySelector('#ce');
    el.textContent = 'volume 100 _';
    el.dispatchEvent(new InputEvent('input', { bubbles: true })); // isTrusted:false
  });
  await page.waitForTimeout(500);
  await expect(page.locator('#ce')).toHaveText('volume 100 _'); // NOT filled → control live
  // If the trust-gate degraded open, the blank fires and this fails.
});
```

Note these follow the agentic-scenario rule (assert the **runtime
contract**, not a specific LLM string): liveness asserts "buffer
changed / `_` consumed," the control test asserts "block held." The
mock LLM removes model variance where an exact string is asserted.

## Milestones

- **M0 — harness.** Extension-load fixture + mock LLM + config seeding +
  one smoke test asserting the boot line
  (`[opencues][info] OpenCues runtime starting (Chrome v1)`). This alone
  catches the whole "boot threw, everything dead" class (the `failed=true`
  bug). Highest value per unit effort — land first.
- **M1 — feature liveness (host-independent).** Word-cue cycle,
  fluid-blank substitution, sentence-cue, on textarea + generic CE.
  Catches the `process.env` / `NodeHttpAdapter`-degrade class.
- **M2 — security-control liveness (degraded-open detectors).**
  trust-gate synthetic-event rejection (#13), sensitive-field no-attach
  (#25), site-scoping off-site no-fire (#14). This is the security
  payoff: a control that silently degraded open is caught on the next
  run of the harness. Arguably the primary reason the system exists —
  worth building even before M1 if security coverage is the priority.
- **M3 — host-dependent paths (deferred).** Scripted blanks + custom
  user-blanks need a mock native-messaging host process. Heavier; scope
  separately once M0–M2 are stable.

## Decisions needed (before M0)

1. **MV3 + headless.** Extension service workers historically needed
   headed Chromium or `--headless=new`. Confirm the CI runner can run
   `--headless=new` with `--load-extension`; else run headed under
   `xvfb-run` (WSL/Linux CI). **Recommendation:** `--headless=new`,
   fall back to xvfb.
2. **Mock-LLM wiring:** seeded provider endpoint override vs Playwright
   `context.route`. **Recommendation:** `context.route` on the provider
   host — no product code needs a test-only endpoint path, and it
   intercepts both content-script and SW fetches.
3. **Run model:** a plain local command — `npm run test:e2e` in
   `integrations/chrome/` after `npm run build` — that a dev runs on
   demand (optionally a nightly/manual invocation). **Not** wired into
   `pre-pr.sh` or a required CI job. The fixture loads the **WSL-side**
   `integrations/chrome/dist/` directly (Chromium runs headless in WSL),
   so it needs neither the `/mnt/c` sync nor the Windows extension
   mirror. Keep it self-contained: `npm run build` → `npm run test:e2e`,
   no external state.
4. **Reuse vs new config file.** New `playwright.e2e.config.ts` (extension
   project) alongside the existing write-path config, or one config with
   two projects. **Recommendation:** separate config — different launch
   model (persistent context) and different `testMatch`
   (`*.e2e.test.ts`).

## Risks / non-goals

- **Flakiness.** Extension boot + SW registration is async; the fixture
  must wait on concrete signals (SW registered, boot line logged), never
  fixed sleeps. Budget for this in M0.
- **Not a substitute for the write-path suite.** This drives features to
  output; it does not replace the per-editor undo/call-shape tests.
- **Not full site coverage.** Real sites (Gmail/Reddit/…) are out of
  scope — synthetic pages only. Site-specific write quirks stay in the
  existing suite.
- **Managed-editor liveness** (Lexical/PM/Draft feature runs end-to-end)
  is a natural M1.5 once the generic pages pass, reusing the existing
  `pages/` harnesses.

## First PR (M0) — concrete deliverable

`integrations/chrome/tests/e2e/` containing: `extension.fixture.ts`,
`mock-llm.ts`, `seed-config.ts`, `playwright.e2e.config.ts`, and
`boot.e2e.test.ts` (the boot-line smoke), plus an
`npm run test:e2e` script. No CI wiring — a local run-on-demand
command. Green M0 already exercises the highest-severity variant
(silent total death) and gives the security (M2) + scenario (M1)
suites their scaffolding.
