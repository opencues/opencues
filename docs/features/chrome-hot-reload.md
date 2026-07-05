---
last_updated: 2026-07-04
---

# Chrome Hot-Reload

> ⚠️ **Superseded.** Everything below the "Current mechanism" section
> describes the pre-May-2026 poll-based design, which has been
> **fully removed** from the codebase. It's kept here as a historical
> record since older references (including this doc's own earlier
> revisions) describe it as current. [`docs/features/chrome-sync.md`](chrome-sync.md)
> is the canonical, current doc for how config changes reach Chrome —
> read that first.

Config edits propagate into already-open Chrome tabs without an extension reload, page refresh, or user action. The mechanism is different from the native hosts (CC, OC) — those poll the filesystem on every keystroke (see [Hot-Reload Config](hot-reload-config.md)). Chrome content scripts have no filesystem access, so the browser side needs an out-of-band channel.

---

## Current mechanism (as of May 2026 — see `chrome-sync.md` for full detail)

A local **native-messaging host** process (installed via `opencues install chrome-host`) watches `~/.cues/` (or `$OPENCUES_HOME`) directly on the filesystem side, and **pushes** the rebuilt bundle into `chrome.storage.local['opencues_bundle']` whenever something changes. Chrome's `chrome.storage.onChanged` event then fires in every open tab:

```
~/.cues/ edited                     Every open tab's content script
        ↓                                  ↓
native-messaging host detects        chrome.storage.onChanged fires
        ↓                                  ↓
rebuilds bundle,                     invalidates its in-memory
chrome.storage.local.set(...)        bundle-index cache, calls
                                      reloadConfig(), re-walks
                                      every source against the
                                      new bundle
```

Typical propagation: **~300ms**, no polling interval involved — it's a genuine push, not a timer tick. There's also a separate **bake-time bundle** (`opencues sync chrome` + esbuild-inlined constants) used as a static fallback when the native-messaging host isn't installed; that one only refreshes when you rebuild/redeploy the extension.

For the full protocol, install steps, source-resolution rules, and the storage read-priority chain (`chrome.storage.local` → bake-time bundle → esbuild-inlined defaults → null), see [`docs/features/chrome-sync.md`](chrome-sync.md).

---

## Why the old poll-based design was replaced

The retired design (below) worked, but had two real costs the current push model doesn't: up to ~2.5s latency between a save and the reload firing, and a requirement to keep a `sync chrome --watch` terminal process running. The native-messaging host removes both — it's a genuine push, and it's a background-installed service rather than something you have to remember to run.

---

## Retired: the `.version`-poll design (pre-May-2026, removed)

This section is preserved for historical context only — **none of the code below exists anymore.**

Before May 2026, Chrome had no live-push channel, so the extension polled a content-addressable hash file instead:

- `dist/configs/.version` held a sha256 hash of every bundled file's path+content, computed by `packages/opencues-cli/src/commands/sync.cjs`'s `computeVersion()`.
- The in-page bootstrap (`integrations/chrome/src/opencues-bootstrap.ts`) ran `startVersionPoll()` — a `setInterval` fetching `dist/configs/.version` every `VERSION_POLL_MS` (2500ms) and calling `reloadConfig()` when the hash changed.
- `opencues sync chrome --watch` ran an `fs.watch`-based CLI daemon that re-synced the bundle (and bumped `.version`) on any source-dir change, with a 250ms debounce.

Worst-case latency was cited at ~3 seconds, typically ~1.5s, dominated by the 2.5s poll cadence. `startVersionPoll`, `VERSION_POLL_MS`, and the `--watch` daemon are all gone from the current source — grepping for any of them in `integrations/chrome/src/` or `packages/opencues-cli/src/commands/sync.cjs` returns nothing.

---

## Portability

### Standard (opencues-core / opencues-runtime)

- `BootResult.reloadConfig` is host-agnostic — every adapter exposes the same handle for triggering a re-read of all sources.
- The runtime doesn't know or care what triggered the reload — filesystem watch, storage push, or (for a hypothetical future host) something else entirely.

### Integration responsibilities

- Decide *when* to call `reloadConfig` based on whatever observable channel the host gives you (filesystem polling for native hosts, `chrome.storage.onChanged` for chrome).
- Avoid hammering `reloadConfig` — debounce or rate-limit at the trigger layer; the runtime treats every call as a full re-parse.
- Invalidate any host-specific caches (e.g. chrome's bundle-index promise) before calling `reloadConfig`.
