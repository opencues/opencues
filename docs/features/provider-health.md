---
last_updated: 2026-07-04
---

# Provider Health

Classifies LLM-call failures into a small taxonomy (auth / quota / rate-limit
/ outage / model-missing) and exposes the current failure as a status-line
signal, so a broken provider reads as an honest error instead of a cue or
blank that simply stopped doing anything.

> **Status: shipped as a library module, not yet wired into any live host.**
> Everything described below exists in source and is covered by scenario
> tests, but no adapter band constructs a `ProviderHealth` bus today, and no
> `CueSource` reports into one. See [Current wiring state](#current-wiring-state)
> before relying on this for a real failure.

---

## The problem it solves

`packages/opencues-runtime/src/modules/provider-health.ts` opens with the
incident that motivated it: in May 2026 the agentic harness turned up a
Cerebras API key that had been out of credit for **weeks**. Every call
returned HTTP 402, every cue source caught the throw and returned
`{ results: [], error }`, and the resolver silently dropped the `error`
field. The user-visible symptom was not an error message — it was fluid-blank
(`_`) looking "broken": type `_`, get nothing back, no indication why. A
payment failure and a flaky network and a typo'd model name were all
indistinguishable from each other and from "the LLM just didn't have an
answer this time."

`ProviderHealth` exists to turn that into a small, honest, UX-budgeted
signal: five failure kinds, one line in the status line, sticky vs.
self-clearing depending on whether the user can fix it by waiting or has to
edit a config file.

---

## The taxonomy

Five kinds, deliberately capped — per the module's own comment, "a status
line that shows seven different failure modes is the same as no status
line." Classification lives in `classifyProviderError(input)`
(`provider-health.ts:78`), which takes an HTTP status, a response body, and/or
a thrown `Error`, and returns a `ProviderHealthEvent | null` (`null` means
"looks healthy, report nothing").

| Kind | Sticky? | Detected by |
|---|---|---|
| `auth` | yes | `status === 401 \| 403`, or body/message matching `unauthorized`, `invalid_api_key`, `authentication failed`, `invalid token` |
| `quota` | yes | `status === 402`, or body/message matching `payment_required`, `insufficient_quota`/`credit`/`balance`, `out_of_credit` |
| `model-missing` | yes | `status === 404` **and** the body mentions "model", or message matching `model X is not supported` / `unknown model` / `model not found` |
| `rate-limit` | no (auto-clears) | `status === 429`, or body/message matching `too_many_requests` / `rate_limit` |
| `outage` | no (auto-clears) | `status` in 5xx, a network-error message (`ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `ECONNRESET`, "fetch failed"), or body/message matching `server_error` / `service_unavailable` / `overloaded` / `timeout` / a full queue. Also the catch-all: any non-empty failure signal that doesn't match another category is classified `outage` with the raw (truncated) message, "so the user at least sees SOMETHING rather than a silent dead-cue." |

**Precedence when signals overlap** (documented in the function's header
comment and enforced by check order): quota is checked before rate-limit
(402 is more specific than a generic 429); an HTTP auth status wins over
body-text sniffing; model-missing requires a 404 **plus** a model-shaped body
hint, so a bare 404 from an unrelated proxy doesn't get misattributed.

"Sticky" vs. not is a recovery-path distinction, not a severity one: auth /
quota / model-missing require a config edit (new key, top-up billing, fix
`llm-model:`) — waiting doesn't help, so the event persists until an explicit
`ProviderHealth.clear()`. Rate-limit and outage are conditions that resolve
on their own, so they auto-clear after `transientTtlMs` (default 10 000 ms)
via an internal `setTimeout` armed on every `report()`.

---

## The bus (`ProviderHealth` class)

A tiny single-slot pub/sub, not an audit log — only the most recent event is
retained:

- `report(ev)` stamps `at: Date.now()` (or an injected clock), overwrites
  `_current` unconditionally, re-arms the auto-clear timer if the new event
  is non-sticky, and notifies subscribers.
- `reportFrom(input)` is `classifyProviderError(input)` + `report()` in one
  call; returns the classified event (or `null`) so a defensive caller can
  ignore the result.
- `clear()` is the explicit "the user fixed it" path — cancels any pending
  auto-clear timer and nulls `_current`.
- `subscribe(fn)` returns an unsubscribe function; a bad subscriber throwing
  is swallowed so it can't take down the others.

---

## How it reaches the status line

`Statusline` (`packages/opencues-runtime/src/modules/statusline.ts`) takes an
**optional** 9th constructor argument, `providerHealth?: ProviderHealth`.
When present:

- `subscribe()` also subscribes to the bus and calls `adapter.forceRender?.()`
  on every change, so a sticky error (auth/quota) becomes visible without
  waiting for the user's next keystroke.
- `maybeWrite()` re-merges `currentProviderError()` into the payload on
  *every* render pass — including the early `{ active: false }` return path —
  so the error is orthogonal to whatever the highlight state is doing.
- The payload gains a `providerError` field:
  ```ts
  providerError?: {
    kind: 'auth' | 'quota' | 'rate-limit' | 'outage' | 'model-missing';
    message: string;
    sticky: boolean;
    provider?: string;
    model?: string;
  } | null;
  ```
  `undefined` means no `ProviderHealth` bus is wired at all (back-compat: a
  host that hasn't adopted this feature sees no field, not a null); `null`
  means a bus is wired but currently healthy; a populated object is the
  active failure.

A code comment on the field (`statusline.ts:66`) describes the intended
consumer rendering: *"the shell consumer renders this as a prefix like
`[opencues: bad / missing API key]`."* That rendering does not currently
exist — see below.

---

## Retry / backoff and the auto-fallback interaction

`ProviderHealth` itself does no retrying — it is a passive classifier + UI
bus. The actual retry/fallback machinery lives in `llm-provider.ts` and is
**not** wired through `classifyProviderError` in production:

- **`withFallback(base, fallback)`** — the groq↔cerebras auto-fallback used
  by ordinary cue/blank sources (`FALLBACK_PAIRS`, wire-compatible pairs
  only). It decides "was that transient?" with its own internal
  `looksTransient(body)` heuristic, not `classifyProviderError`, and it has
  **no failure-reporting hook at all**. If the primary fails and the
  fallback succeeds, the caller never learns the primary failed — success is
  success. If both fail, the *original* provider's error is what bubbles up
  to the source's own catch block (see below), never through
  `ProviderHealth`.
- **`withFreePool(base, opts)`** / **`dispatchWithFreePool`** — the
  OpenCode Zen free-model-pool walker. This one *does* expose an
  `onFailure?: (info: { model; status?; body?; cause? }) => void` callback,
  shaped to be handed straight to `ProviderHealth.reportFrom` (proven by a
  passing integration test — see below) — but the only production call site,
  `wrapAdapterForBlank()` in `packages/opencues-core/src/sources/build-sources.ts`,
  calls `withFreePool(options.httpAdapter)` with **no `onFailure`**. The hook
  exists and is contract-tested; nothing currently passes it a function.

So today, a provider outage that auto-fallback or free-pool-walking silently
absorbs is invisible everywhere (by design — it recovered). A failure that
survives fallback/pool-walking is currently surfaced only via each source's
*own*, older, separate classifier — `classifyLlmError` / `classifyHttpError`
in `fluid-blank-source.ts` (also used by TransformBlank and ConfigIntent) —
which maps a thrown `Error` to a `FluidBlankErrorReason`
(`invalid-api-key` / `network` / `rate-limit` / `endpoint-not-found` /
`model-not-found` / `insufficient-credits` / `bad-request`) and, if a host
supplies `formatErrorAsSubstitute`, writes a visible **in-buffer** error
string at the `_` site. That mechanism is separate from `ProviderHealth`,
overlaps with it category-for-category, ships today, and is not covered by
this document.

---

## Settings / on-by-default

There is no scalar or config gate for this feature. `classifyProviderError`
is a pure function and `ProviderHealth` has no persistence — a host either
constructs the bus and wires it in, or the feature is entirely absent for
that host. It isn't listed in `packages/opencues-core/src/feature-registry.ts`
because there's nothing for a user to configure.

---

## Current wiring state

Checked directly against every adapter band's `boot.ts`
(`packages/opencues-runtime/adapters/{cc/v2.1,oc/v1.4,oc/v1.14,gemini/v0.41,shell/v1,chrome/v1}/boot.ts`):
every one of them constructs `Statusline` with the same 6 positional
arguments (`adapter, hlState, dynDefs, options, configLoader, spanFillState,
selectorSatelliteState, agentTaskState`) and **none** passes a 9th
`providerHealth` argument. `Statusline`'s own property test pins the
resulting behavior: `'providerError' in payload` is `false` when no bus is
wired — which is the state of every shipping host today.

Separately, no `CueSource` implementation calls `classifyProviderError` or
holds a `ProviderHealth` reference to report into. The only production
"failure classification" that actually executes today is the
`classifyLlmError`/`FluidBlankErrorReason` path described above.

Concretely, for a maintainer who wants to finish wiring this up, the gaps
are:

1. Each `boot.ts` needs to construct a `ProviderHealth` instance and pass it
   as `Statusline`'s 9th constructor argument.
2. That same instance needs to reach the sources — `build-sources.ts`'s
   `BuildSharedRuntimeOptions` has no `providerHealth` field today, so there
   is no channel for a source's catch block to call `.reportFrom()`.
3. `wrapAdapterForBlank()`'s `withFreePool(options.httpAdapter)` call needs
   an `onFailure` argument wired to that instance (the hook already exists
   and is contract-tested; it's just unconnected).
4. `withFallback` has no equivalent hook at all — adding one (or accepting
   that fallback-absorbed failures should stay invisible, which is
   arguably correct) is an open design question, not a bug.
5. `integrations/claude-code/patches/highlight-statusline.sh` — the actual
   status-line rendering script — has no reference to `providerError` at
   all. Even a host that completed steps 1-4 would need this script updated
   before Claude Code users saw anything; the `[opencues: bad / missing API
   key]` prefix described in `statusline.ts`'s comment is aspirational.

---

## Tests

- `packages/opencues-runtime/src/modules/provider-health.test.ts` — unit
  coverage of `classifyProviderError`'s precedence rules and the bus's
  sticky/auto-clear/subscribe behavior.
- `packages/opencues-runtime/src/modules/provider-health.scenarios.test.ts`
  — end-to-end journeys (per this repo's scenario-testing convention) proving
  the `ProviderHealth → Statusline` wiring *would* work if a host adopted it:
  401 → sticky auth in the payload, 402 → sticky quota, 429 → transient that
  auto-clears after the TTL, explicit `clear()` after a config fix, and the
  `withFreePool`-shaped `onFailure` → `reportFrom` integration contract. These
  tests construct their own `ProviderHealth` and pass it to `Statusline`
  directly — they do not exercise any adapter band's `boot.ts`, which is why
  the gap in [Current wiring state](#current-wiring-state) doesn't fail CI.

---

## See also

- [Tip Priority](tip-priority.md) / [Secondary Display](secondary-display.md)
  — the same `Statusline.buildPayload()` / export-file mechanism this feature
  piggybacks its `providerError` field onto.
- `docs/architecture/llm-routing.md` — the bucket/provider-resolution system
  (`cues-llm-provider:`, `blanks-llm-provider:`, auto-fallback pairs) that
  `withFallback`/`withFreePool` sit underneath.
