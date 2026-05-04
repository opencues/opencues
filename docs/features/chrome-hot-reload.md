---
last_updated: 2026-04-22
---

# Chrome Hot-Reload

Config edits propagate into already-open Chrome tabs within ~2.5
seconds without an extension reload, page refresh, or user action.
The mechanism is different from the native hosts (CC, OC) —
those poll the filesystem on every keystroke (see `hot-reload-config.md`).
Chrome content scripts have no filesystem access, so the extension
polls a content-addressable hash file (`dist/configs/.version`)
instead.

This doc covers the end-to-end loop. For the source-discovery rules
that decide *what* gets bundled in the first place, see
`docs/features/chrome-sync.md`.

---

## Why it's different from native hosts

Native hosts read `~/.cues/` and `<cwd>/.cues/` directly. They
can poll mtimes, watch dirents, or just re-stat files cheaply.

Chrome content scripts run inside the page's renderer process under a
strict sandbox. They can't read `~/.cues/`. Everything they see
must be inside the extension's bundle (`dist/configs/`), which gets
populated by `opencues sync chrome`.

So the hot-reload story for chrome is two cooperating loops:

```
WSL/macOS side                      Chrome content script side
───────────────                      ───────────────────────────
~/.cues/cues.md edited           tick every 2.5s:
        ↓                                fetch dist/configs/.version
fs.watch fires (250ms debounce)          if hash changed:
        ↓                                    invalidate bundle index
syncChrome() re-runs                         await reloadConfig()
        ↓                                        ↓
dist/configs/* rewritten             ConfigLoader re-reads every source
.version = sha256(all files)         New tips/alts immediately live
        ↓
mirrored to Windows install path
```

The `--watch` flag is what makes the first column happen
automatically. Without it, you'd run `sync chrome` manually after
edits and the second column still wakes up within 2.5s.

---

## The `.version` file

`dist/configs/.version` holds a 16-char hex hash plus a trailing
newline. It's computed by `computeVersion()` in
`packages/opencues-cli/src/commands/sync.cjs`:

```js
// Hash of every relPath + content. Stable across machines so a no-op
// sync (re-run with same inputs) doesn't bump the version and trigger
// pointless reloads in the extension.
const h = crypto.createHash('sha256');
// ... walk distConfigs, sort files by relpath, skip .version itself ...
for (const f of files) {
  h.update(path.relative(rootDir, f));
  h.update('\0');
  h.update(fs.readFileSync(f));
}
return h.digest('hex').slice(0, 16) + '\n';
```

Two important properties:

- **Content-addressable.** Two syncs with identical inputs produce the
  same hash. A no-op `sync chrome` doesn't trigger a reload.
- **Round-trippable.** Edit a file, sync (hash flips), revert the
  edit, sync again — the hash returns to its original value. The
  in-page poller treats that as a normal change and re-loads.

The hash deliberately excludes `.version` itself so the file isn't
self-referential.

---

## The poll loop (in-page)

Lives in `integrations/chrome/src/opencues-bootstrap.ts` ~line 510:

```ts
const VERSION_POLL_MS = 2500;
let _lastKnownVersion: string | null = null;

function startVersionPoll(bootResult: BootResult): void {
  const tick = async () => {
    try {
      const url = chrome.runtime.getURL('dist/configs/.version');
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return;
      const version = (await res.text()).trim();
      if (_lastKnownVersion === null) {
        _lastKnownVersion = version;
        return;
      }
      if (version !== _lastKnownVersion) {
        _lastKnownVersion = version;
        _bundleIndexPromise = null;        // force index.json re-fetch
        await bootResult.reloadConfig();   // re-read every source
      }
    } catch { /* bundle absent / offline — next tick tries again */ }
  };
  void tick();                       // seed _lastKnownVersion
  setInterval(tick, VERSION_POLL_MS);
}
```

Key behaviours:

- **First tick seeds** `_lastKnownVersion` and does NOT trigger a
  reload — otherwise every page load would gratuitously re-read.
- **`cache: 'no-store'`** bypasses the HTTP cache (the extension URL
  scheme would otherwise serve a 200-OK from disk cache forever).
- **Index-cache invalidation.** The runtime caches `index.json`
  (the manifest of which files exist in the bundle); on version
  change, the cache is dropped before `reloadConfig` runs so newly
  added files are picked up.
- **Catch-and-continue.** Network errors (extension reloading, file
  briefly missing during atomic rewrite) just skip that tick.

---

## The watcher (CLI side, `--watch`)

`packages/opencues-cli/src/commands/sync.cjs` ~line 79:

```js
const DEBOUNCE_MS = 250;
const w = fs.watch(s.dir, { recursive: true }, (event, filename) => {
  if (!filename) return;
  if (filename.includes('~') || filename.endsWith('.swp') || filename.endsWith('.tmp')) return;
  trigger(filename);
});
```

Watches each resolved source dir (user-level by default;
`--include` adds more). On any non-noise change, debounces 250ms then
re-runs the same `syncChrome` code as a one-shot run. Logs whether
`.version` actually changed (`version <hash>` vs `no changes`).

The `fs.watch({ recursive: true })` API is OS-dependent:

- **macOS / Windows**: native FSEvents/ReadDirectoryChanges. Fires
  reliably for any descendant change.
- **Linux**: relies on inotify, which has a per-process watch limit.
  For large source dirs, you may need to bump
  `/proc/sys/fs/inotify/max_user_watches`.

---

## End-to-end timing

| Step | Latency |
|---|---|
| File save → `fs.watch` event | ~immediate |
| Watch event → debounce expiry → re-sync starts | 250ms |
| Re-sync runtime (read sources, write bundle, mirror) | ~50–200ms |
| Re-sync finish → next in-page poll tick | up to 2500ms |
| Poll tick → `reloadConfig` → new tip live | ~50–100ms |

**Worst case: ~3 seconds.** Typically ~1.5s. The 2.5s poll cadence is
the dominant term — if you need it tighter, drop `VERSION_POLL_MS`
in the bootstrap (cost: more `chrome.runtime.getURL` fetches per
tab per minute, all served locally so cheap).

---

## What triggers reload

- Editing any file inside a source dir (`~/.cues/`, an
  `--include`'d path, or `<cwd>/.cues/` under `--project`)
- Adding or removing a folder cue (`cues/<name>/cue.md`) or blank (`blanks/<name>/cue.md`)
- Running `opencues sync chrome` manually (the `.version` flips even
  outside `--watch`)
- Calling `opencues sync chrome --pack` or `--source` to swap source
  sets entirely

## What does NOT trigger reload

- Editing files outside the resolved source dirs (the watcher isn't
  watching them; there's no leak from arbitrary cwd)
- Editing `dist/configs/*` directly — `sync` overwrites these on next
  run, and `.version` won't update without a sync
- Re-running `sync chrome` with identical inputs — hash is stable
- Editing `cues.md` frontmatter user-level scalars (voice-mode,
  debug-mode, etc.) — those round-trip through `chrome.storage.local`,
  NOT the bundle. The bootstrap's storage-change listener picks them
  up separately. See `OpenCuesSettingsBlank` for the storage path.

---

## Code locations

| Concern | File | Symbol |
|---|---|---|
| In-page polling | `integrations/chrome/src/opencues-bootstrap.ts` | `startVersionPoll`, `VERSION_POLL_MS` |
| Bundle index cache | same file | `_bundleIndexPromise` |
| Re-read on change | runtime (`@opencues/runtime`) `bootResult` | `reloadConfig` |
| `.version` write | `packages/opencues-cli/src/commands/sync.cjs` | `computeVersion`, `syncChrome` |
| Watch loop | same file | `syncChromeWatch` |
| Sync sources | same file | `resolveSources` (see `chrome-sync.md` for the rules) |

---

## Trade-offs

**Polling here isn't a trade-off we *chose* — it's the only option
Chrome gives us.** Push would be cleaner if it existed, but it
doesn't for bundle files.

### What "push" would look like (and why it doesn't exist for us)

Chrome has exactly one push channel for content scripts:
`chrome.storage.onChanged`. It fires when something writes to
`chrome.storage.{local,sync}`. Files inside the extension's own
package (`dist/configs/...`) have no event API — Chrome treats the
bundle as immutable from the content script's view, even though we
know the CLI is mutating it from outside.

We *could* fake push by having the CLI write the version to
`chrome.storage.local` instead of a file. Two problems:

1. **The CLI runs outside Chrome.** It has no `chrome.storage` API.
   We'd need a bridge (native messaging host, or a popup the CLI
   talks to). That's a real piece of infrastructure for a marginal
   gain.
2. **The bundle stops being self-describing.** Right now
   `dist/configs/.version` lives next to the data it describes —
   atomically synced together, no possibility of drift. If the
   version moves to storage, you can have storage saying "v3" while
   the bundle on disk is still v2.

`chrome.runtime.requestUpdateCheck` is also not it — that API only
checks for *extension updates from the Chrome Web Store*, not for
changes to packaged files mid-session.

### Costs of polling (as actually experienced)

| Cost | Magnitude | Notes |
|---|---|---|
| **Latency** | up to 2500ms between sync finishing and reload firing | Dominant cost. Tunable via `VERSION_POLL_MS`. |
| **Idle CPU/IO** | 1 fetch per tab per 2.5s, served from local disk | Negligible — `.version` is 17 bytes. 100 tabs ≈ 40 fetches/sec, all in-process. |
| **Battery** | tiny | Same reason — local disk, no network, no parsing on unchanged hash. |
| **No back-pressure** | can't dynamically slow under load | Doesn't matter at this volume. |
| **Wasted reloads on round-trip** | edit → sync → revert → sync = bundle reloaded twice for net-zero change | Cheap (just re-parses configs). Acceptable. |

### Counterfactual: if push were available

| Pro / Con | Notes |
|---|---|
| 0ms latency | the genuine win |
| No idle traffic | also genuine, but baseline is already negligible |
| One more API surface to keep healthy | native messaging hosts can break silently across Chrome updates |
| Bridges between CLI and extension | adds installer complexity, a new failure mode for users |
| Bundle no longer self-describing | version-in-storage can drift from files-on-disk |

**Verdict.** Even if push were available natively (it isn't), polling
is the right call here. The only real cost is the 2.5s latency, fine
for a dev-iteration workflow. If we ever hit a use case that needed
sub-second propagation we'd have to do real work to get it.

### Why 2.5s and not 500ms?

Every open tab polls independently. With 20 tabs open: 500ms ≈ 40
fetches/sec; 2.5s ≈ 8 fetches/sec. All served from local disk so
the absolute cost is small either way, but the cadence was tuned for
"feels live during dev" not "feels instantaneous in production." Drop
the constant if you find yourself wishing edits propagated faster.

---

## Portability

### Standard (opencues-core / opencues-runtime)

- `BootResult.reloadConfig` is host-agnostic — every adapter exposes
  the same handle for triggering a re-read of all sources.
- The runtime doesn't know or care what triggered the reload.

### Integration responsibilities

- Decide *when* to call `reloadConfig` based on whatever observable
  channel the host gives you (filesystem polling for native, content-
  addressable hash polling for chrome, IPC events for hypothetical
  future hosts).
- Avoid hammering `reloadConfig` — debounce or rate-limit at the
  trigger layer; the runtime treats every call as a full re-parse.
- Invalidate any host-specific caches (e.g. chrome's `index.json`
  promise) before calling `reloadConfig`.

---

## Verification

End-to-end pass-through is verified in
`integrations/chrome/docs/chrome-extension-progress.md` § "Phase 6
verification" (2026-04-22). Edit `~/.cues/cues.md`, observe
`.version` flip, observe Chrome pick up the change without page
refresh, revert the edit, observe `.version` round-trip back to its
original hash.
