# CLAUDE.md — Firefox integration

The Firefox MV3 add-on. It is a **fork of `integrations/chrome/`** at the
build / manifest / install / `src/` layer, reusing everything below the
browser boundary. Read `integrations/chrome/CLAUDE.md` FIRST — the write-path
editor matrix, security model (trust-gate, credit accounting, site-scoping,
host sandbox), live-config-sync architecture, subprocess-exec protocol,
user-blank protocol, emoji-as-img handling, and "register a new blank in two
places" rule are **identical** and are not duplicated here. This file only
records the Firefox deltas.

## What is shared (do NOT fork)

- **`@opencues/core` + `@opencues/runtime`** — workspace deps, same as chrome.
- **The chrome v1 runtime adapter** (`packages/opencues-runtime/adapters/chrome/v1/`)
  — DOM-agnostic, binding-driven. Firefox's `boot.ts` supplies the same
  `ChromeBindings` and reuses `ChromeV1Adapter` with `hostName: 'chrome'`. So at
  the host-compat / site-filter layer, **Firefox IS chrome** — `on-host: chrome`
  configs run in Firefox out of the box.
- **The native-messaging host** (`integrations/chrome/host/host.cjs` +
  `host-validators.cjs`) — pure stdio framed-JSON, browser-agnostic. Firefox's
  `bin/install.cjs` points the native-host manifest `path` at the chrome host
  script. It is NOT copied — duplicating the security-sensitive sandbox +
  secret-guard code is forbidden (root CLAUDE.md § "Security guard hand-mirrored
  … drifts").

## The Firefox deltas (what this fork changes)

1. **Namespace: `chrome.*` → `browser.*`.** Firefox exposes the promise-based
   WebExtension API as `browser`; its `chrome` alias is callback-only. The
   chrome code already used the promise form, so this was a mechanical rename of
   the `chrome.storage` / `chrome.runtime` / `chrome.tabs` tokens (value AND type
   positions) to `browser.*`. `@types/firefox-webext-browser` provides the
   `browser` namespace for typechecking (`tsconfig.json` → `types`).
   - **Gotcha:** `browser.runtime.sendMessage` takes **no** result generic
     (unlike `@types/chrome`). Cast the returned Promise instead of using
     `sendMessage<A, B>(…)`. Three sites do this — `fetch-http-adapter.ts` +
     two in `opencues-bootstrap.ts`.

2. **Manifest background: event page, not service worker.** `manifest.json` uses
   `"background": { "scripts": ["dist/background.js"], "type": "module" }`.
   `background.ts` is written service-worker-style (top-level listener
   registration + a long-lived `connectNative` port + `scheduleReconnect`); that
   shape also works under Firefox's event-page suspension model — the
   `onDisconnect` → reconnect path covers a suspended/re-woken background. No
   logic change was needed, but re-verify port survival under load if you touch
   `background.ts`.

3. **`browser_specific_settings.gecko.id`** (default `opencues@opencues.dev`) +
   `gecko.strict_min_version: "140.0"` (first Firefox with the CSS Custom
   Highlight API the dim-render path needs — below it, highlights silently
   no-op). The gecko id MUST match the native-host manifest's
   `allowed_extensions`.

4. **Native-host registration** (`bin/install.cjs`, `install-host` /
   `uninstall-host`): Firefox manifest uses `allowed_extensions: [<gecko-id>]`
   (not chrome's `allowed_origins`), written to the Mozilla dirs
   (`~/.mozilla/native-messaging-hosts/` on Linux, the Mozilla
   `NativeMessagingHosts` dir on macOS, `HKCU\Software\Mozilla\NativeMessagingHosts`
   on Windows/WSL). On WSL the manifest is named `com.opencues.sync.firefox.json`
   so it coexists with the chrome integration's manifest in the same
   `%LOCALAPPDATA%\opencues\` dir, and reuses the same `sync-host.bat` shim
   (`wsl.exe -d <distro> --shell-type login -- node <chrome host.cjs>`).

5. **Extension scheme:** Firefox resource URLs are `moz-extension://` (random
   UUID). Only `popup.ts`'s restricted-URL guard cares — it now also matches
   `moz-extension:` / `resource:`.

## Dev workflow

Same rebuild → reload → hard-refresh discipline as chrome (see chrome CLAUDE.md
§ "Rebuild → sync → reload"), but the reload surface is `about:debugging`:

```bash
cd packages/opencues-core && pnpm build      # 1. if you changed core/runtime
cd ../opencues-runtime && pnpm build
cd ../../integrations/firefox && npm run build   # 2. bundle into dist/
# 3. (WSL) mirror dist/ + manifest.json to the Windows-side path (see --wsl)
# 4. about:debugging → Reload the OpenCues add-on → hard-refresh the page
```

Firefox temporary add-ons are dropped on browser restart — reload from
`about:debugging` after each restart.

## CLI wiring (where firefox plugs into `opencues`)

`firefox` is deliberately kept OUT of `@opencues/core`'s `HOSTS` (so
host-compat tests + runtime filtering stay unchanged — Firefox reports
`hostName: 'chrome'`). It's wired as a CLI-only install/sync target:

- `packages/opencues-cli/src/commands/install.cjs` — `loadHostResolver` adds
  `firefox` + `firefox-host` locally; `firefox-host` uses the `install-host`
  action + skips seed-configs (mirrors `chrome-host`).
- `sync.cjs` — `HOSTS` includes `firefox`; `syncChrome`/`resolveWslDeployPath`
  take a `host` param (`integrations/<host>/dist/configs`, `opencues-<host>`
  WSL path). Compat filter stays `chrome`.
- `uninstall.cjs` / `run.cjs` — `firefox` + `firefox-host` added to the local
  resolvers; `run firefox` prints add-on load instructions (no spawn, like
  chrome).
- `doctor.cjs` — a Firefox native-messaging-host section checks the Mozilla
  manifest dirs.
- `version-markers.cjs` — `enumerateInstalledHosts` includes
  `integrations/firefox/dist` for drift detection.

## Known gap — src/ fork drift

`src/` is a near-verbatim copy of chrome's. It WILL drift as chrome's
`opencues-bootstrap.ts` (etc.) evolve. Mitigation for a later PR: extract the
shared bootstrap into a common module both integrations import, or move to a
build-variant model. Until then, changes to chrome's write paths / security
controls should be mirrored here in the same PR. The unit/e2e test suites were
NOT ported in the first cut (tracked follow-up: a `playwright-firefox` config).
