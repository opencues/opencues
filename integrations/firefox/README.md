# @opencues/firefox

OpenCues as a Firefox MV3 add-on — inline cues, blanks, cycling, and dim
rendering in any web text field. Feature-parity with the Chrome extension
(`integrations/chrome/`); the two share `@opencues/core`, `@opencues/runtime`,
the chrome v1 runtime adapter, and the native-messaging host.

## Install (from a clone)

```bash
git clone https://github.com/opencues/opencues ~/opencues
cd ~/opencues && pnpm install
pnpm exec opencues install firefox        # builds dist/ + prints the load path
```

Then load it in Firefox:

1. open `about:debugging#/runtime/this-firefox`
2. click **Load Temporary Add-on…**
3. select `integrations/firefox/manifest.json` (the path the installer printed)

> Temporary add-ons are removed when Firefox restarts — reload after each restart.
> A signed `.xpi` for permanent install is a separate (post-launch) task.

### Live config sync + scripted blanks (optional)

Install the native-messaging host so edits to `~/.cues/` reach open tabs live
and script-backed blanks (`volume _`, `brightness _`) work:

```bash
opencues install firefox-host --extension-id opencues@opencues.dev
```

The `--extension-id` is `manifest.json` → `browser_specific_settings.gecko.id`
(default `opencues@opencues.dev`), also shown at `about:debugging` on the
OpenCues card. Without the host, the add-on still works from the bake-time
bundled defaults (grammar/cues), but `~/.cues/` edits won't propagate and
scripted blanks exit 127.

## What differs from Chrome

Everything below the browser boundary is shared. The Firefox-specific pieces:

| Piece | Chrome | Firefox |
|---|---|---|
| WebExtension namespace | `chrome.*` | `browser.*` (native promise API) |
| Background | MV3 `service_worker` | MV3 event page (`background.scripts` + `type: module`) |
| Add-on identity | derived from load path | `browser_specific_settings.gecko.id` |
| Native-host manifest | `allowed_origins: [chrome-extension://…]` | `allowed_extensions: [<gecko-id>]` |
| Native-host manifest dir | `~/.config/google-chrome/NativeMessagingHosts/` etc. | `~/.mozilla/native-messaging-hosts/` (Linux), Mozilla dir (macOS), `HKCU\Software\Mozilla\…` (Windows/WSL) |
| Load flow | `chrome://extensions` → Load unpacked | `about:debugging` → Load Temporary Add-on |
| Min version | Chrome 121 | Firefox 140 (CSS Custom Highlight API) |

The native host **script** (`integrations/chrome/host/host.cjs`) is reused
verbatim — it's pure stdio framed-JSON and browser-agnostic. The Firefox
installer just registers it under the Mozilla dirs with a Firefox-shaped
manifest.

## Build / dev

```bash
cd integrations/firefox
npm run build      # typecheck + esbuild → dist/
npm run watch      # rebuild on change; reload the add-on at about:debugging
```

Rebuild → reload → hard-refresh the page after any change to `src/`,
`@opencues/core`, or `@opencues/runtime`. See `CLAUDE.md` for the full
dev-loop notes (they mirror Chrome's, linked from there).

## Config sync (bake-time)

```bash
opencues sync firefox            # bundle ~/.cues/ into dist/configs/
opencues sync firefox --wsl      # + mirror to the Windows-side install path
```

The bundle format is identical to Chrome's — Firefox reuses the chrome
adapter so host-compat filtering treats it as `chrome`.
