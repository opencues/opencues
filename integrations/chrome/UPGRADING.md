# Upgrading the Chrome integration

Chrome's "upgrade" surface is structurally different from the other three
integrations. We don't patch an upstream fork — the extension IS our code.
What can move under us:

- **Chrome MV3 surface** — manifest schema, service-worker lifecycle,
  permissions model, native-messaging API.
- **CSS Custom Highlight API** — the rendering primitive the extension
  depends on. Stable since Chrome 121, but spec changes are possible.
- **Per-editor write paths** — Lexical, ProseMirror, Draft.js, Slate, and
  the dozen contenteditable variants we attach to. Each can change its
  internal selection model or paste-handler shape independently of Chrome
  itself.
- **Node runtime on the chrome-host side** — the native-messaging host is a
  long-running local Node process; major Node releases occasionally drop
  APIs the host uses (less common, but worth flagging on Node major
  bumps).

This document covers all four. Most actual upgrade work concerns the
per-editor write paths (matrix in `CLAUDE.md`); MV3 + Highlight API
upgrades are rare events.

## Prerequisites

- Built extension at `integrations/chrome/dist/` (or wherever your last
  build lives).
- For WSL → Windows Chrome flows: the deployed extension at
  `/mnt/c/Users/<you>/AppData/Local/opencues-chrome/`.
- For native-messaging changes: chrome-host installed via `opencues install
  chrome-host` (see chrome README's "Updating configs without rebuilding").

## Trigger 1 — Chrome browser version bump (MV3 / API surface)

When Chrome ships a new stable release, browser-side APIs the extension
depends on can shift. Most of these are silent — your extension keeps
working — but the loud failures are catastrophic (extension fails to load,
service worker can't register, content script gets rejected on every
page).

### 1.1 Verify the manifest still validates

```bash
# Re-load the extension at chrome://extensions (Developer mode).
# Watch for red "Errors" badge — manifest schema errors surface there.
```

If the badge is red, click it. Common cases:
- Permissions deprecation (e.g. `tabs` narrowing to specific scopes).
- Manifest fields that became required (Chrome announces these in
  release notes 2-3 versions ahead).

Fix in `integrations/chrome/manifest.json`, re-build, re-load.

### 1.2 Verify the service worker registers

```
chrome://extensions → OpenCues card → "service worker" link → DevTools
```

Should show: `[opencues] native host port opened` (if chrome-host is
installed) or just attach without errors. A failed registration usually
points at:
- Module-resolution changes (Chrome 122+ tightened MV3 import semantics).
- API drop (e.g. `chrome.runtime.connectNative` permissions tightened).

### 1.3 Verify content-script attach + rendering

Open a contenteditable site (e.g. gmail.com compose), check the page
console for:

```
[opencues][info] OpenCues runtime starting (Chrome v1)
```

If missing, the content script didn't load — usually a manifest
`content_scripts.matches` regression or CSP tightening on the page.

### 1.4 Re-verify the per-editor matrix

After any Chrome major (e.g. 121 → 130), walk the full editor matrix in
`integrations/chrome/CLAUDE.md` § "Verified working sites" before
shipping. Per-editor write paths are the most likely thing to drift —
not because OpenCues changed, but because the editor framework might
have shipped its own changes during the interval.

## Trigger 2 — `@opencues/core` or `@opencues/runtime` updated

Most common upgrade trigger. The flow is the rebuild → sync → reload dance
documented in `CLAUDE.md` § "Rebuild → sync → reload":

```bash
# 1. Rebuild the changed package
cd packages/opencues-core && pnpm build    # (or opencues-runtime)

# 2. Rebuild chrome (bundles the freshly built core/runtime dists)
cd integrations/chrome && npm run build

# 3. Sync to the Windows-side unpacked extension (WSL only)
cp -r integrations/chrome/dist/* /mnt/c/Users/wilfred/AppData/Local/opencues-chrome/dist/
cp integrations/chrome/manifest.json /mnt/c/Users/wilfred/AppData/Local/opencues-chrome/manifest.json

# 4. Reload at chrome://extensions + hard-refresh test page (Ctrl+Shift+R)
```

**Verify the bundle landed** (the silent-failure mode that bites every
time):

```bash
grep -c "YOUR_NEW_SYMBOL" /mnt/c/Users/wilfred/AppData/Local/opencues-chrome/dist/content.js
```

If grep returns 0, one of steps 1-3 didn't take. Investigate before
reloading. See `CLAUDE.md` § "Rebuild → sync → reload" for the per-step
failure-mode table.

## Trigger 3 — Adding a new runtime blank

Chrome explicitly registers every runtime blank in
`integrations/chrome/src/blanks/index.ts`. Implementing the class in
`packages/opencues-runtime/src/blanks/` is necessary but **not** sufficient
— without the chrome registration, the blank's keyword dispatches, finds
no handler, falls through to `spawnProcess`, the chrome adapter resolves
with exitCode 127, and the user sees nothing.

Two edits in `integrations/chrome/src/blanks/index.ts`:

1. Import at the top:
   ```ts
   import { ..., YourBlank, ... } from '@opencues/runtime/dist/src/blanks';
   ```
2. Register inside `createBlanks`:
   ```ts
   blanks.set('your-blank', new YourBlank(...));
   ```

Then re-run the rebuild → sync → reload dance from Trigger 2.

Real example from May 2026 — `claude-status` had the runtime impl, tests,
and `BLANK.md` synced into `dist/configs/`. Chrome silently no-op'd on
"is claude down" until the two-line fix landed.

## Trigger 4 — Native-messaging host (chrome-host) Node bump

The chrome-host runs as a long-running local Node process. Major Node
releases (18→20→22) occasionally remove APIs.

```bash
# Verify the host runs:
node ~/.config/opencues/chrome-host/host.cjs --version 2>&1 | head -5

# Re-install to ensure the launcher shims use the right node:
opencues install chrome-host --extension-id <your-extension-id>
```

On WSL the launcher is a Windows `.bat` shim that invokes
`wsl.exe -d <distro> --shell-type login -- node <host path>`. The
`--shell-type login` flag is **load-bearing** — without it, wsl spawns
a non-login shell whose PATH only contains system Node (often ancient),
and the host crashes on modern syntax. If you see "host port opened"
followed by an immediate disconnect, login-shell init isn't running.

## Trigger 5 — Per-editor write-path regression

When a site (Reddit, ChatGPT, LinkedIn, Gmail, etc.) updates its editor
framework or schema, the write path documented in `CLAUDE.md` § "The
biggest issue: writing into managed contenteditables" may break.
Symptoms:

- Cycling writes work but cursor goes to end-of-buffer.
- Transform-blank writes get reverted within ~1 frame.
- Paste-based writes double-render (the input event AND the paste handler
  both insert).
- Plain text shows literal `**bold**` markers (markdown styling no longer
  applied).

Don't fix the regression by unifying the per-editor ladder. Each row in
the matrix was discovered by trial and error against that specific
engine's quirks. Add a hostname carve-out in `replaceAllText` (examples:
`isLuma`, `isPasteFiltered`) and keep the carve-out minimal.

If a brand new editor family appears, add a new branch to
`replaceAllText`, a detector to the helpers near the top of
`opencues-bootstrap.ts`, and extend `isManagedEditor`. See `CLAUDE.md`
§ "Adding a new editor / site" for the playbook.

After ANY write-path edit, re-verify the full matrix:

| Site | Engine |
|---|---|
| Gmail compose | generic contenteditable |
| Reddit | Lexical |
| Twitter/X | Draft.js |
| LinkedIn | ProseMirror |
| ChatGPT | ProseMirror |
| claude.ai | ProseMirror |
| Luma | ProseMirror (outlier) |
| YouTube comments | generic contenteditable |

Don't ship a write-path change that fixes one site and silently breaks
another. The matrix is the test surface.

## Trigger 6 — `manifest.json` permissions or origins changing

If you add a new permission (e.g. `notifications`, a new `host_permissions`
entry), users get a re-grant prompt on next reload. For published
extensions this is a meaningful UX cost; for the unpacked dev install,
re-load is enough.

Audit new permissions against the security model in
`docs/architecture/chrome-security.md` before adding. Particularly: any
permission that broadens what content scripts can read should pair with
a `not-on-site` default for sensitive sites.

## Commit shape

```
chore(chrome): <one-line description>
```

For runtime-only updates, prefer the existing scope (`feat(runtime)`,
`fix(core)`) rather than `chore(chrome)` — the chrome dance is just the
deploy step, not the substance.

## Reference

- `integrations/chrome/CLAUDE.md` — full architecture, write-path matrix,
  security boundaries
- `integrations/chrome/README.md` — install + verify
- `docs/architecture/chrome-security.md` — security model
- `docs/architecture/chrome-llm-keys.md` — LLM key handling
- `docs/features/chrome-sync.md` — `~/.cues/` sync via native-messaging host
- `docs/features/chrome-normal-inputs.md` — normal-input attach mode
