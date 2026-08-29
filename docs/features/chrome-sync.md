# Chrome — Native-Messaging Host

The chrome integration uses a local Node host (`opencues install
chrome-host`) for two distinct jobs that share one bidirectional pipe:

1. **Live `~/.cues/` sync** — host watches the filesystem and pushes
   bundles into `chrome.storage.local`. Edits land in every open tab
   in ~300ms with no page refresh.
2. **Subprocess execution** — host runs `.sh` / `.py` / etc. scripts
   for blanks like `volume _` and `brightness _`. Same protocol, same
   port, request/response shape.

Both ride the same `chrome.runtime.connectNative('com.opencues.sync')`
port. Below covers the protocol, install, and per-platform wiring.

There's also a **bake-time bundle** (`opencues sync chrome` + esbuild
constants) — what ships inside the extension build, used when no host
is installed. Static. Refreshed by rebuilding + redeploying the
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

### ⚠ Registering while Chrome is running requires `chrome://restart`

Chrome on Windows reads the `NativeMessagingHosts` registry key **at
browser startup** and caches it for the life of the browser process.
If you install (or re-install) the chrome-host while Chrome is already
running, every connection attempt keeps resolving against the stale
cached registry and fails — the extension retries every 30 seconds,
forever, with nothing visibly wrong: the registry entry, manifest, and
`.bat` shim are all correct on disk, and running the `.bat` by hand
works. Reloading the extension does **not** help (that restarts the
extension's service worker, not the browser process holding the
cache). Type `chrome://restart` in the address bar (keeps your tabs),
then confirm via the popup's **run self-check** — the `chrome-host:`
line should say connected — or the service-worker console (`native
host port opened` + `bundle stored`).

If it still won't connect after a restart, compare the extension ID
shown on the chrome://extensions card against the ID in the manifest's
`allowed_origins` — unpacked extension IDs change with the load path,
and a mismatch fails with "Access to the specified native messaging
host is forbidden" in the service-worker console. Re-run
`opencues install chrome-host --extension-id <current-id>` (and
restart Chrome again) to fix.

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

## Subprocess execution (`volume _`, `brightness _`, custom scripts)

The same port carries `exec` requests for blanks that invoke a local
script. Without the host, Chrome's `spawnProcess` returns exitCode
127 (it can't escape the content-script sandbox). With the host, the
runtime invokes the same shell scripts CC/OC do.

### Protocol

Bidirectional, framed JSON, layered on the existing port. The host
handles incoming `exec` messages alongside its outgoing bundle pushes.

| Direction | Message | Notes |
|---|---|---|
| extension → host | `{type:'exec', requestId, command, args, env, timeoutMs}` | requestId correlates the response; concurrent execs allowed |
| host → extension | `{type:'exec-result', requestId, exitCode, stdout, stderr, timedOut}` | matched against the SW's pending map |

### Path sandboxing

The runtime constructs script paths against its virtual
`/chrome-storage/.cues/...` root (no real filesystem from a content
script). On `exec`, the host rewrites any argument starting with that
prefix to `${CUE_ROOT}/...` (real `~/.cues/` or `$OPENCUES_HOME`) and
**refuses anything that would resolve outside CUE_ROOT**. The
sandbox prevents a malicious bundle from asking the host to run
`/etc/passwd`-style paths.

Arguments that don't start with the chrome-storage prefix pass
through unchanged — the runtime mixes paths and plain string args.

### Wire-up

```
runtime.spawnProcess(spec)
  ↓
ChromeV1Adapter.spawnProcess(spec)
  ↓  (uses bindings.spawnProcess when present, else returns 127)
opencues-bootstrap.ts spawnProcess binding
  ↓  chrome.runtime.sendMessage({type:'opencues:exec', ...})
background.ts (service worker)
  ↓  port.postMessage({type:'exec', requestId, ...})
host.cjs handleExec()
  ↓  child_process.spawn(command, args, {env, cwd: CUE_ROOT})
  ↑  on close → port.postMessage({type:'exec-result', requestId, ...})
SW's pending Map dispatches the matching response back through
sendResponse → the content script's ProcessHandle.result resolves.
```

### Capability advertisement

`ChromeV1Adapter` adds `'spawn-process'` to its capabilities list
only when the bootstrap supplied a `spawnProcess` binding — i.e.
only when the install layer wires it in. Capability-aware blanks can
inspect this if they need to gate on availability, though most just
let the 127 surface naturally.

### What the bundle ships vs runs from disk

| Source | Bundles | Runs |
|---|---|---|
| **chrome-host** (live) | BLANK.md + non-script colocated files (README, prompts) | The script runs from `~/.cues/blanks/<name>/` on disk |
| **bake-time** (`sync chrome`) | Same — scripts excluded by host-compat | n/a — no spawn path available |

Bundling script bytes would be wasteful: the extension can't execute
them anyway, the host has them on disk. Excluding them keeps the
bundle small (matters for very large `.cues/` trees).

### Adding a new subprocess blank

The blank shape is identical to CC/OC. Drop a folder under
`~/.cues/blanks/<name>/`:

```
~/.cues/blanks/clipboard/
  BLANK.md            ← blankKeywords: clipboard, blankScript: ./clip.sh
  clip.sh             ← responds to `get` / `set <value>`
```

Within ~300ms the host re-bundles + pushes; the blank is live in
every Chrome tab. No extension reload.

The script's CWD when the host invokes it is `${CUE_ROOT}` (i.e.
`~/.cues/`), not the blank's folder. Scripts that need their own
location can do `SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`
— the path passed in args[0] is the resolved absolute path.

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

## Security

Live config sync + subprocess execution share one bidirectional pipe.
Both directions are defended against hostile-page abuse:

- **Trust gate** — credit-based `_` accounting. Each genuine `_`
  keystroke / paste / drop buys exactly one underscore insertion in
  the runtime. Defeats the "user typed `_` once, page-injected `_`
  triggers a blank within 1s" replay attack.
- **Site scoping** — `on-site` / `not-on-site` frontmatter lets each
  entry scope to specific platforms / hostnames / paths. Filtered
  entries never reach the runtime.
- **Path sandbox** — host refuses any script path that resolves
  outside CUE_ROOT (including via symlinks; uses `realpath`).
- **Env-key whitelist** — only `CUES_*` env vars from the wire reach
  the spawned process.
- **Per-call timeout** — 10s default, configurable.

Trust model: scripts in `~/.cues/blanks/` run with the user's
permissions. Treat third-party cue packs like `.bashrc` additions —
the sandbox is path-shaped, not content-shaped.

Full spec: [`docs/architecture/chrome-security.md`](../architecture/chrome-security.md).

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
