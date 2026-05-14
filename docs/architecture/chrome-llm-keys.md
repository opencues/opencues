# Chrome — LLM API keys

How API keys flow from the user's environment into the chrome
extension's resolver, how the system surfaces misconfiguration, and how
mid-session key changes are applied without a tab reload.

Read this before touching any of:

- `integrations/chrome/src/adapters/chrome-storage-adapter.ts`
- `integrations/chrome/src/opencues-bootstrap.ts:verifyLlmKeyAtBoot`
- `integrations/chrome/src/opencues-bootstrap.ts:auditProvidersAgainstKeys`
- `integrations/chrome/src/opencues-bootstrap.ts:updateRuntimeApiKeys`
- `packages/opencues-runtime/adapters/chrome/v1/boot.ts:updateApiKeys`
- `packages/opencues-core/src/llm-provider.ts:resolveLLM` (warn paths)

## The problem this design solves

Chrome content scripts can't read `process.env` or `~/.cues/.env` —
they're sandboxed. Every other host (CC, OpenCode, gemini-cli) reads
those directly. So if the user pins `llm-provider: gemini` in
`~/.cues/CUES.md`, terminal hosts find `GEMINI_API_KEY` automatically
while chrome must be told.

The May 2026 regression that motivated this design: chrome's storage
adapter only mapped `GROQ_API_KEY` and `FINNHUB_API_KEY` onto the
StoredConfig shape. Every other provider key the native-messaging host
pushed got silently dropped. Setting `llm-provider: gemini` worked on
opencode, silent no-op on chrome — confusing because the runtime/core
code was bit-identical between hosts.

## How keys reach the runtime

Three sources, merged in priority order:

```
DEFAULT_CONFIG.llmApiKeys (bake-time, empty in published bundle)
       ↓ (lowest priority)
opencues_host_keys (native-messaging host push of process.env)
       ↓
opencues_config.llmApiKeys (popup save)
       ↓ (highest priority)
runtime startOpenCues({ llmApiKeys })
       ↓
BootResult constructs Resolver with apiKeys: { GROQ_API_KEY: '…', GEMINI_API_KEY: '…', … }
       ↓
On every LLM dispatch, resolveLLM(opts) reads apiKeys[provider.envKeyName]
```

**Storage adapter contract** (`chrome-storage-adapter.ts`):

- Reads `opencues_host_keys` (set by `background.ts` when the native
  host's `config` message lands) and forwards every `*_API_KEY` into
  the merged config's `llmApiKeys`. Whitespace trimmed; empty strings
  filtered.
- Reads `opencues_config` (set by the popup) and overlays
  user-edited fields on top. The popup's legacy `apiKey` field
  bridges into `llmApiKeys.GROQ_API_KEY` so popup-only users (no
  native host installed) still authenticate.
- Returns `StoredConfig` with both the multi-provider bag
  (`llmApiKeys`) AND the legacy single-key fields (`apiKey`,
  `finnhubApiKey`) — the popup UI still reads the legacy fields,
  the resolver reads `llmApiKeys`. Both must surface the same key
  bytes.

**Content script forwarding** (`content.ts`):

- Reads the merged config at boot via `loadConfig()`.
- Passes `llmApiKeys: config.llmApiKeys` to `startOpenCues`.

  > **Critical**: without forwarding the multi-provider bag,
  > the bootstrap would only have the legacy single Groq key.
  > Was the source of the May 2026 silent no-op.

**Runtime resolver** (`@opencues/core:resolveLLM`):

- Reads `apiKeys[providerAdapter.envKeyName]` for the configured
  provider. Returns null if the key is missing (was silent — now
  warns, see below).

## Failure modes + how each is surfaced

| Failure | When detected | Surface |
|---|---|---|
| No key configured at all | Boot | `verifyLlmKeyAtBoot` → `console.warn` |
| Configured key invalid (HTTP 401) | Boot, then per-call | `verifyLlmKeyAtBoot` probes provider's `/models` endpoint; runtime LLM calls also log via `FetchHttpAdapter` |
| `llm-provider: gemini` but no `GEMINI_API_KEY` | Boot AND first LLM call | `auditProvidersAgainstKeys` scans merged `OPENCUES.md` and warns once at boot; `resolveLLM` also warns once-per-(provider, env-var) on first dispatch as a backstop |
| Provider name typo (`gimini`) | Boot AND first call | Same as above — audit and `resolveLLM` both warn |
| Per-feature override missing key (`agent-provider: anthropic` with no `ANTHROPIC_API_KEY`) | First call to that feature | `resolveLLM` warns once-per-pair |
| Key revoked mid-session (HTTP 401 mid-call) | Per-call | `FetchHttpAdapter.post` logs `[opencues] LLM call failed — HTTP 401` |
| Whitespace-only key | Boot (filtered) | Skipped during forwarding; resolver behaves as if no key |
| User installs chrome-host AFTER tab opened | When native-messaging port opens | Host pushes keys → storage onChanged fires → `updateRuntimeApiKeys` rebuilds resolver — see "Real-time updates" below |
| Key rotated in `.env` while tab is open | When fs.watch fires + host re-pushes | Same path as install-after-open |
| User edits API key in popup | On popup save | Same path |
| Chrome starts with zero keys, host installed later | Same trigger | Surfaces a warn — page reload required (see "Edge cases") |

## Boot-time probes

Two-phase audit at startup, both in `opencues-bootstrap.ts`:

**Phase 1 — `verifyLlmKeyAtBoot(opts)`**: pings each configured
provider's lightest read-only endpoint (mirrors
`opencues check-keys`) via the background SW (which has network
access). 401/403 → loud error. Network failure → warn with cause.
Healthy → quiet info.

**Phase 2 — `auditProvidersAgainstKeys(keys)`**: reads the merged
`OPENCUES.md` frontmatter from chrome.storage, regex-extracts every
`(<feature>-)?provider:` line, cross-references against the `keys`
bag. Emits one multi-line summary listing every misconfigured
directive. Catches the "I set `llm-provider: gemini` but have no
gemini key" failure at page load, before the user types a trigger.

The runtime's `resolveLLM` warning is a lazy backstop for cases the
boot audits miss (e.g. CUES.md edits mid-session).

## Real-time updates — no tab reload

The runtime's `BootResult.updateApiKeys(newKeys)` method mutates the
live `apiKeys` reference held by the Resolver and force-rebuilds its
sources. The chrome integration calls this when
`chrome.storage.onChanged` fires for the host-keys or popup-config
slot AND the env-var fingerprint changed (sorted name list,
secret-free).

Wire:

```
chrome-host fs.watch(.env) → host pushes config message
  → background.ts → chrome.storage.local['opencues_host_keys']
  → onChanged
  → chrome-storage-adapter.onConfigChange callback in content.ts
  → updateRuntimeApiKeys(newKeys)
  → BootResult.updateApiKeys (runtime chrome v1 adapter)
  → wipe apiKeys ref + repopulate + resolver.rebuildResolver()
  → next LLM dispatch uses new credentials
```

**Why the reference must stay alive** (not be replaced): the
Resolver holds the bag in `options.apiKeys` from construction.
Reassigning `options.apiKeys` would not propagate; mutating the
same object does.

**Fingerprint-gated**: popup saves that don't change the key set
(e.g. user adjusts `dimMix`) don't trigger a resolver rebuild —
the fingerprint is the sorted list of env-var names (NEVER values),
diffed against the previous tick.

## Edge cases

- **Boot with zero keys, then host installs**: the runtime didn't
  construct a Resolver at boot, so `updateApiKeys` has nothing to
  rebuild. Surfaces a warn. Page reload required to wire the
  resolver up fresh. Building a resolver from nothing mid-session
  would require also tearing down + recreating AgentRewrite, which
  is out of scope. Documented here as the "first key" case.

- **In-flight LLM call when key changes**: completes with old
  credentials. Acceptable — calls are sub-second; the next one
  uses the new key.

- **Concurrent edits to popup + host push**: last-writer wins per
  the merge order in `loadConfig` (popup config overlays host
  keys). Both trigger `onConfigChange`; the resolver rebuilds
  twice in quick succession. Idempotent, no harm done.

- **Service worker stops** (MV3 sleeps SWs after ~30s idle):
  chrome.runtime.sendMessage from content script re-wakes it.
  Native port re-opens; bundle re-pushes; storage re-syncs.
  Real-time updates resume.

- **Empty `.env` value pushed by host**: the storage adapter's
  empty-string filter drops it during forwarding, so the
  fingerprint doesn't flip and the resolver isn't unnecessarily
  rebuilt. Important when a user has `GROQ_API_KEY=` (empty) in
  their `.env` after rotating.

## Why opencode + CC + gemini-cli don't need any of this

They read `process.env` and `~/.cues/.env` at boot. No storage
indirection, no native-messaging proxy. A key changed in the
environment requires a host restart to pick up — that's the
existing contract for those hosts and it's fine because they're
long-lived background processes the user already restarts as part
of their workflow.

Chrome is the outlier because the content script's lifetime is
the tab's lifetime, and forcing a tab reload to pick up a key
rotation is a significantly worse UX than what terminal hosts
demand.

## What to test if you change the key path

The scenario tests:

- `integrations/chrome/src/adapters/chrome-storage-adapter.test.ts` —
  6 scenarios: multi-provider forwarding, legacy bridge, popup-only
  bridge, empty-string filter, whitespace trim, no-key empty state.
- `packages/opencues-runtime/src/modules/resolver.test.ts` —
  "picks up apiKeys mutations on rebuild" — pins that
  `Resolver.options.apiKeys` must be a live ref, not a snapshot.
- `packages/opencues-core/src/llm-provider.test.ts` (misconfiguration
  warnings) — 7 scenarios pinning warn-once contracts on missing
  key, unknown provider, per-tier overrides, happy path.

Run `npm test` in the chrome integration AND `npm test` in
opencues-runtime AND `npm test` in opencues-core. All three test
suites pin different parts of this contract.
