# Chrome Config Sync

Two mechanisms keep the Chrome extension in step with your `~/.cues/`:

1. **Native-messaging host** (`opencues install chrome-host`) — a tiny
   local process that watches `~/.cues/` and pushes bundles into
   `chrome.storage.local` over Chrome's native-messaging pipe. **Live.
   Push-based. The primary mechanism.** Edits land in every open tab in
   ~300ms with no page refresh.
2. **Bake-time bundle** (`opencues sync chrome` + esbuild constants) —
   what ships inside the extension build, used when no host is
   installed. Static. Refreshed whenever you rebuild + redeploy the
   extension.

The native hosts (claude-code, opencode, gemini-cli) read `~/.cues/`
from the filesystem directly. Chrome can't (no FS access from a
content script), so the host process becomes the bridge.

---

## How the live sync works

```
WSL / Linux / macOS                 │   Windows / macOS / Linux (Chrome)
                                    │
  ~/.cues/                          │
    │  edited                       │
    ▼                               │
  fs.watch fires                    │
    │                               │
    ▼                               │
  host.cjs rebuilds bundle          │
    │  framed JSON on stdout        │
    │  ─────────────────────────────►  Chrome receives, delivers to SW
    │                               │      │
    │                               │      ▼
    │                               │  chrome.storage.local.set({ opencues_bundle })
    │                               │      │
    │                               │      ▼  onChanged broadcast
    │                               │  every tab's bootstrap clears its cache,
    │                               │  calls reloadConfig(), runs against new bundle
```

The host is spawned by Chrome on demand when the extension calls
`chrome.runtime.connectNative('com.opencues.sync')`. Each tab's content
script never touches the host directly — it reads the bundle from
`chrome.storage.local` after the service worker stores it.

### What it watches

The host treats `~/.cues/` (or `$OPENCUES_HOME` if set) as its single
source. It does **not** know about cwd — Chrome has no cwd, and the
host has no notion of which project you're "in".

To bundle project configs into the live push, either:
- `export OPENCUES_HOME=/path/to/project/.cues` and restart Chrome
  (drops the user-level dir from the watch — point of `$OPENCUES_HOME`
  is to wholly override)
- Or maintain symlinks under `~/.cues/` (e.g.
  `~/.cues/cues/my-project -> /path/to/project/.cues/cues/my-project`)

Multi-source merge (the model `opencues sync chrome --include` used to
offer for the bake-time bundle) is not implemented for the live host
yet. Open an issue if you need it.

### Filter

The host applies the same host-compat filter as `opencues sync chrome`:
entries marked `not-on-host: [chrome]`, or with auto-detected `.sh` /
`.exe` scripts, are dropped. Drops save bundle size + avoid the runtime
trying to spawn subprocesses that fail with exit 127 in the browser.

---

## Install

```bash
# 1. Build + load the extension (one time)
pnpm exec opencues install chrome --wsl
# Then chrome://extensions → Developer mode → Load unpacked from
# the path the installer prints.

# 2. Copy the extension's ID at chrome://extensions
#    (32 lowercase letters under the name, visible in Developer mode).

# 3. Install the host
pnpm exec opencues install chrome-host --extension-id <id>

# 4. Reload the extension once so its service worker reconnects.
```

What `install chrome-host` writes (platform-specific):

| Platform | Files |
|---|---|
| **WSL → Chrome on Windows** | `%LOCALAPPDATA%\opencues\sync-host.bat` (re-enters WSL via `wsl.exe`) + `%LOCALAPPDATA%\opencues\com.opencues.sync.json` (manifest) + `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.opencues.sync` (registry pointer to the manifest). |
| **Linux native** | `~/.config/google-chrome/NativeMessagingHosts/com.opencues.sync.json` (also Chromium / Brave parallel dirs). `path` points at the host script in the repo. |
| **macOS** | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.opencues.sync.json` (also Chromium / Brave parallel dirs). |

Uninstall: `pnpm exec opencues uninstall chrome-host`. Cleans up
manifests, the WSL `.bat` shim, and the registry key.

### Why WSL is the trickiest platform — and what makes it work

1. Chrome runs as a Windows process. It can only spawn Windows
   executables. So the `path` in the manifest is a `.bat` shim, not
   the WSL Node script directly.
2. The `.bat` runs `wsl.exe -d <distro> --shell-type login -- node
   /full/wsl/path/to/host.cjs`. `--shell-type login` is load-bearing
   — without it wsl.exe spawns a non-login shell with a stripped PATH
   (system Node v12), and the host crashes on modern syntax like
   optional chaining. Login shells source the user's nvm / volta /
   asdf init in `.profile` and pick up the modern Node.
3. Chrome pipes stdio over the wsl.exe bridge. The framed-JSON
   protocol flows through unchanged — wsl.exe is bidirectional and
   binary-safe.
4. `fs.watch` runs natively on the WSL filesystem (not via UNC mounts
   from Windows), so events are fast and reliable.

---

## The bake-time bundle (`opencues sync chrome`)

This still exists, and matters in two cases:

- **No host installed** — the extension reads `dist/configs/` for cues
  + the `__DEFAULT_*__` esbuild constants for the absolute fallback.
  `sync chrome` populates `dist/configs/` from your local `.cues/`.
- **Published Chrome Web Store builds** — whatever's in `dist/configs/`
  at extension-build time ships frozen to users who don't run the host.

Source-discovery rules for `sync chrome` (low-priority → high; later
overlays earlier on same-name files):

1. `$OPENCUES_HOME` — if set, becomes the sole source.
2. `~/.cues/` — user-level default. Always first unless `$OPENCUES_HOME` is set.
3. `--include <path>` — added in order, stackable.
4. `--project` — adds `<cwd>/.cues/` (highest priority).

`--pack <name>` and `--source <path>` short-circuit the chain. The
flags and `--watch` mode behave exactly as before; see history.

### When to use which

| Goal | Tool |
|---|---|
| I'm developing my own cues and want them in browser tabs *now* | `install chrome-host` (live) |
| I'm building a Chrome Web Store release with my cues baked in | `sync chrome` then build |
| I'm offline / on a machine with no host installed | Bake-time defaults already cover the no-host case |
| I want a project's `.cues/` live in Chrome | `export OPENCUES_HOME=/path/.cues` (single-source override) or symlink into `~/.cues/` |

---

## Resolution order at runtime

The bootstrap walks this chain on every `readFile()`:

1. `chrome.storage.local['opencues_bundle']` ← native-messaging push
2. `chrome.runtime.getURL('dist/configs/<rel>')` ← bake-time bundle
3. `__DEFAULT_CUE_FOLDERS__[name]` / `__DEFAULT_BLANK_FOLDERS__[name]`
   ← esbuild-inlined absolute fallback
4. null

The first hit wins. Storage-level on-changed events invalidate the
in-memory bundle-index cache and call `reloadConfig()` so the runtime
re-walks every source.

---

## Migration from the version-poll model

Before May 2026, the extension polled `dist/configs/.version` every
2.5s and ran `opencues sync chrome --watch` from a terminal to keep
that file bumped. Both are gone:

- The poll is removed from `opencues-bootstrap.ts` (no more 2.5s
  fetches against `chrome.runtime.getURL`).
- The `sync chrome --watch` daemon is no longer needed for live sync;
  use the host instead. `sync chrome` (one-shot) still exists for
  bake-time.
