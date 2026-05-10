---
last_updated: 2026-04-06
---

# Hot-Reload Config

Config file changes take effect within ~2 seconds, without restarting the integration. All `.md` config files are polled via a TTL cache rather than file watchers.

> **Chrome is different.** Content scripts can't read the filesystem,
> so the chrome extension uses content-addressable hash polling
> (`dist/configs/.version`) instead of the per-keystroke TTL described
> below. See `docs/features/chrome-hot-reload.md`.

---

## How It Works

1. **At startup**, `_configLoadedAt = 0` and `_reloadCuesConfig()` runs immediately, parsing all config files and building the resolver
2. **On every analysis pass** (when the user types), the auto-submit code checks: `Date.now() - _configLoadedAt > 2000` and `!_dynPending` and `!_configReloading`. If all conditions are met, `_reloadCuesConfig()` fires
3. **`_reloadCuesConfig()`** sets `_configReloading = true`, then parses all config files into local variables:
   - `CUES.md` (frontmatter: settings, current values, selector/satellite tips, ignore array — **user-level only**, `~/.cues/CUES.md`)
   - `cues/{name}/CUE.md` (folder-based cue sources via `discoverFolderConfigs` — static cues with body JSON, or LLM cues with prompt body)
   - `blanks/{name}/BLANK.md` (folder-based cue-blanks)
4. **Atomic apply** — all parsed results are assigned to globals in a single block (`_cueBlankOverrides`, `_localCueMap`, `_cuesIgnoreWords`, etc.). If parsing throws, the previous config is preserved (`_applied` stays false and the resolver rebuild is skipped)
5. **Resolver rebuild** — `_cueResolver` is constructed from the new sources, `_resolverGeneration` is incremented, and `_dynLastAnalyzed` is cleared so all visible words re-analyze against the new config
6. **`_configLoadedAt`** is set to `Date.now()`, restarting the 2-second TTL

---

## What Hot-Reloads

- `CUES.md` — settings, current values, selector/satellite tips, `ignore:` array (`_openCuesSettings`, `_openCuesCurrent`, `_openCuesTips`, `_openCuesSatTips`, `_cuesIgnoreWords`). **User-level only** for the system-settings half (`~/.cues/CUES.md`); projects can't override system settings.
- `cues/{name}/CUE.md` — folder-based cue sources (adding or removing a folder; static + LLM)
- `blanks/{name}/BLANK.md` — folder-based cue-blanks (adding or removing a folder)

The `_localCueMap` is rebuilt from scratch on every reload (not merged), so deleting a tip from a `cues/<name>/CUE.md` removes it immediately.

---

## What Requires Restart

- **opencues-core module** — loaded once at process start via `require()`, not reloadable
- **HTTPS connection pool** — `NodeHttpAdapter` is independent of config
- **TTS speed/script path** — set at patch-generation time from `~/claude-code-cues/.opencues/patch-state/config.json`
- **Patch code** — the injected JavaScript in `cli.js` is fixed at setup time

---

## Portability

### Standard (opencues-core)

- All parsers are stateless functions (`parseCuesMd`, `parseSingleCueMd`, `discoverFolderConfigs`) — call them at any time to get a fresh parse
- No built-in caching, TTL, or file-watching mechanism
- Resolver construction is cheap and can be rebuilt on every config change
- A failed parse throws — the caller decides whether to keep the previous config or surface the error

### Integration responsibilities

- Implement a caching strategy (TTL polling, file watchers, storage events) to decide when to re-parse
- Rebuild the resolver when config changes and increment a generation counter to discard stale in-flight results
- Clear the analyzed-word cache so all visible words re-analyze against the new config
- Guard against concurrent analysis during the config rebuild window (e.g., a reloading flag)
- Choose an appropriate TTL or watch mechanism for the platform (file system events, polling interval, editor API hooks)
