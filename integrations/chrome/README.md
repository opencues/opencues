# OpenCues Chrome Extension

> Part of **[OpenCues](../../README.md)**. Other integrations:
> [Claude Code](../claude-code/README.md) · [OpenCode](../opencode/README.md) ·
> [Gemini CLI](../gemini-cli/README.md) · [Shell](../shell/README.md).

`@opencues/chrome` — an MV3 extension that adds real-time word alternatives, blanks, and cue-blanks to any `contenteditable` on the web. Renders via the CSS Custom Highlight API; no DOM mutation, no caret disruption.

> **What works in Chrome vs native hosts**: with `opencues install chrome-host` installed, parity is essentially complete — cycling, blanks (including `volume _` / `brightness _` / any user `.sh`-backed blank), opencues-settings, prompt-improver, stocks/weather/HackerNews. TTS uses the Web Speech API (not `speak.sh`). Live `~/.cues/` sync and subprocess execution both ride the same native-messaging pipe — see `docs/features/chrome-sync.md`. Without the host, the extension still works using the bake-time defaults; scripted blanks return exit 127 (the keyword is recognised but the script can't run from a content script).

| Field | Value |
|---|---|
| Version | 0.1.0 |
| Compatible with | Chrome 121+ (CSS Custom Highlight API) |
| Source | `integrations/chrome/` |
| Runtime | `@opencues/core`, `@opencues/runtime` (workspace-linked via `pnpm` symlinks) |

---

## Install

### Prerequisites

You need the `opencues` CLI on PATH. If you haven't set that up yet,
follow [Quickstart → Bootstrap the `opencues` CLI](../../README.md#2-bootstrap-the-opencues-cli)
in the root README — that covers Node, pnpm, the clone, and the
shell alias.

### Install command

```bash
opencues install chrome
```

This builds the extension and prints the path to load as an unpacked
extension. By default the load path is `integrations/chrome/` itself —
works on macOS / Linux / native Windows where Chrome and the build
directory share a filesystem.

### WSL → Windows Chrome

Chrome runs on Windows; the build runs in WSL. Use `--target` to deploy
the built extension to a path Chrome can see:

```bash
opencues install chrome -- --target /mnt/c/Users/USERNAME/Desktop/opencues-chrome
```

Re-run the same command after each rebuild — the deploy step copies
`dist/` + `manifest.json` to the target. Then click the reload button
on the extension card at `chrome://extensions`.

### Optional: live `~/.cues/` sync + subprocess execution

For full parity with the native hosts (scripted blanks like `volume _`
and `brightness _`, live config sync from your filesystem), also
install the native-messaging host:

```bash
opencues install chrome-host --extension-id <id-from-chrome://extensions>
```

Without it, the extension still works using the bake-time defaults;
scripted blanks return exit 127.

---

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the path the installer printed
5. The extension icon appears in the toolbar

---

## Configure

Click the extension icon to open the popup:

| Field | Required | Description |
|---|---|---|
| **API Key** | Yes | Groq API key (`gsk_...`) for LLM word alternatives |
| **Model** | No | Default: `openai/gpt-oss-120b` (Groq) |
| **API URL** | No | Default: `https://api.groq.com/openai/v1/chat/completions` |
| **Finnhub API Key** | No | For stock price lookups. Free at [finnhub.io](https://finnhub.io) |
| **Target Selector** | Yes | CSS selector for the input element. Default: `[contenteditable="true"]` |
| **CUES.md / BLANKS.md / OPENCUES.md** | No | Paste config content; otherwise the bake-time defaults are used |
| **Tips JSON** | No | Pre-computed word alternatives |
| **TTS** | No | Enable text-to-speech (Web Speech API); `Rate` 1–5, default 2 |

Click **Save**. The extension reinitializes on the active page.

---

## Verify

Open Gmail (compose), ChatGPT, claude.ai, LinkedIn, or any
`contenteditable` site and try:

| Test | Expected |
|---|---|
| `[Your prompt] improve prompt _` | The whole text becomes a structured, improved version of your rough draft. Cycle Up/Down to toggle between the rewrite and the original. |
| `[Your draft] add a paragraph about security _` | Extends your existing draft with the requested addition, in place. **Transform blank**. |
| `[your list] format as bullet points _` | The list is reformatted as bullets. **Transform blank** — `format as <style>` (also `as a table`, `as JSON`, …). |
| `[your text] translate to french _` | The text is replaced with its French translation. |
| Click into the editable, type a few words | Words with alternatives get a slightly darker mid-tone (cue marker). |
| Ctrl+Alt+Right | Highlights the next navigable word in bright white. Ctrl+Alt+Up/Down cycles alternatives. |
| Service worker console shows `[opencues][info] OpenCues runtime starting (Chrome v1)` | Bootstrap booted (open via `chrome://extensions` → service-worker link). |

If you see legacy `[OpenCues] ...` logs but **no** `[opencues][info] OpenCues runtime starting` line, you loaded a stale bundle — re-run `dev-install` (and re-deploy via `--target` if applicable).

### Debug logging

The page console is quiet by default — only `Content script loaded`,
`OpenCues runtime starting`, `storage bundle loaded`, plus any
warnings / errors. Per-keystroke trace logs (`diffWriteText`,
`replaceAllText`, `readFile` resolution, `Attaching to`) are gated
behind `debug-mode: on` in `~/.cues/OPENCUES.md`. Three ways to
toggle:

1. **In-page selector blank** (works on any contenteditable, any tab):
   ```
   opencues settings _
   ```
   Cycle Ctrl+Alt+Up/Down to `debug-mode`, cycle again to flip
   `on`/`off`, navigate away to save. Live across all open tabs in
   ~300ms.

2. **Edit the file directly**:
   ```bash
   sed -i 's/debug-mode: off/debug-mode: on/' ~/.cues/OPENCUES.md
   ```
   The chrome-host's `fs.watch` picks it up; no page refresh needed.

3. **From any other host** (Claude Code / OpenCode / Gemini CLI):
   same `opencues settings _` invocation — the setting is global
   across hosts.

Warnings and errors always surface regardless of the flag.

---

## Update workflow

```bash
opencues update              # pull + rebuild + redeploy every installed host
opencues update chrome       # this integration only
# Then RELOAD the extension at chrome://extensions (Chrome can't auto-reload unpacked extensions)
```

Chrome is the one integration where the user has to do a manual
post-update click: the unpacked extension keeps running the prior
bundle until you click the reload arrow on the OpenCues card at
`chrome://extensions`. This goes away when the extension ships to
the Chrome Web Store (which handles auto-update).

For continuous development, `pnpm --filter @opencues/chrome watch` runs esbuild in watch mode (no test/typecheck). Pair it with a separate copy step or just point Chrome directly at `integrations/chrome/`.

---

## Updating configs without rebuilding

**Recommended: install the native-messaging host.** A small Node
process watches `~/.cues/` and pushes changes into the extension over
Chrome's native-messaging API. Edits land in every open tab in ~300ms;
no rebuild, no page refresh, no long-running daemon. Works under WSL
(via a `.bat` shim + `wsl.exe`), native Linux, and macOS.

```bash
# 1. Copy the extension ID from chrome://extensions (Developer mode)
# 2. Install the host:
opencues install chrome-host --extension-id <id>
# 3. Reload the extension once at chrome://extensions
```

Verify by opening the service worker DevTools (chrome://extensions →
inspect views: service worker) — you should see:

```
[opencues] native host port opened
[opencues] bundle stored (N files, reason=initial)
```

And on every subsequent edit to `~/.cues/`:

```
[opencues] bundle stored (N files, reason=change)
```

Uninstall: `pnpm exec opencues uninstall chrome-host`.

### Subprocess blanks (volume, brightness, custom scripts)

With the host installed, any blank that ships a `.sh` / `.bash` / `.py`
script — including the stock `volume`, `brightness`, and anything you
author yourself — runs in Chrome the same way it runs in Claude Code
and OpenCode.

Example: type `volume _` in any contenteditable (Gmail, ChatGPT,
Reddit, etc.). The blank fills with your current OS volume. Cycle
with Ctrl+Alt+Up / Down — each press steps by 6% and the runtime
calls the script with `set <newvalue>`, so your *system* volume
actually changes as you cycle.

Same pattern for `brightness _`, and for any blank you add to
`~/.cues/blanks/<name>/<name>-blank.sh`. The host walks the request:

```
content script  ──┐
   chrome.runtime ▼
   sendMessage   →  service worker  ──┐
                                 port ▼
                                       native-messaging host (WSL/Linux/macOS)
                                       │
                                       ▼ child_process.spawn
                                       script under ~/.cues/blanks/<name>/
                                       │
                                       ▼ stdout/stderr/exitCode
                                       framed JSON back through the port
```

Host translates the chrome-internal path `/chrome-storage/.cues/...`
to the real `~/.cues/...` and refuses any path that would escape the
sandbox. Default per-call timeout is 15s. Without the host, scripted
blanks return exit 127.

### Bake-time bundle (fallback)

`opencues sync chrome` still exists. It populates `dist/configs/` from
your local `.cues/` so the extension build ships with current
defaults. Useful for offline / no-host installs and for Chrome Web
Store builds. Not needed if the host is installed.

```bash
pnpm exec opencues sync chrome --wsl                    # user-level only
pnpm exec opencues sync chrome --include ~/proj/.cues --wsl
```

Full spec (resolution order, per-platform manifest paths, WSL bridge
detail): [`docs/features/chrome-sync.md`](../../docs/features/chrome-sync.md).

---

## State + sync model — chrome.storage vs the file on disk

OpenCues settings (cycled scalars in `OPENCUES.md`) live in one of two
places depending on whether the chrome-host is installed.

### Without the host

In-page cycling — typing `opencues settings _` and toggling
`voice-mode`, `tips-mode`, `blank-loading-animation`, etc. — persists
**only in `chrome.storage.local`**. The file on disk at `~/.cues/`
isn't touched by chrome alone (chrome has no filesystem access).

- ✅ Settings survive page reloads and Chrome restarts.
- ❌ They DON'T appear in `~/.cues/OPENCUES.md` — so Claude Code,
  OpenCode, and Gemini CLI won't see your chrome-side changes.
- ❌ Edits you make to `~/.cues/OPENCUES.md` from any editor or other
  host DON'T flow into chrome — there's no live watcher.
- ❌ Custom JS user-blanks and script-bearing blanks (`volume`,
  `brightness`, anything `.sh`/`.py`-backed) require the host anyway.

You're effectively running a chrome-only OpenCues. Fine for trying it
out, awkward as soon as you also use one of the CLI hosts.

### With the host installed

`opencues install chrome-host` flips chrome into the same source-of-
truth model as the CLI hosts: **the file on disk wins**.

- In-page cycling writes through to `~/.cues/OPENCUES.md` via a
  `write-file` message to the host. The host's `fs.watch` then pushes
  the updated bundle back into `chrome.storage` (≈ 300 ms round-trip).
- Edits you make to `~/.cues/OPENCUES.md` from any editor are picked up
  by `fs.watch` and propagated into chrome on the next debounce
  (≈ 300 ms).
- Every host (CC, OC, gemini-cli, chrome) reads the same file. State
  stays in lockstep.

### Transitioning from no-host to host-installed (auto-heal)

If you used chrome standalone for a while and then install the host,
the two views may briefly disagree:

- chrome.storage has whatever scalars you cycled in-page (`A` set).
- The on-disk `~/.cues/OPENCUES.md` may have a different set (`B`,
  possibly the shipped defaults).

What happens automatically when the host comes online:

1. The chrome-host pushes its first bundle (set `B` — the file's
   content).
2. The content script's onboot sync overwrites chrome.storage's
   per-key OPENCUES.md entry to match the bundle.
3. Any subsequent in-page cycling writes through to the file — both
   sides converge to set `C` (whatever you cycle next).

In practice: your chrome-only cycling done before host install **is
lost** the moment the host comes online. The file is the new source
of truth.

**Recommended:** install the host first, then cycle. The file
captures everything and every host stays in sync.

If you have important chrome-only settings you want to preserve
before installing the host, copy the values into `~/.cues/OPENCUES.md`
manually first (open the file, edit the scalars to match what chrome
shows). The host's first push will then be a no-op rather than an
overwrite.

---

## What this extension cannot do

- **Native `<input>` / `<textarea>`** — the CSS Custom Highlight API can't reach into form-control internals (Chromium UA shadow DOM doesn't expose Text nodes to scripts). The extension only attaches to `contenteditable` elements. A "mirror div" workaround is possible but not currently implemented.
- **Subprocess blanks without the host** — `volume _`, `brightness _`, and any other `.sh`-backed blank need `opencues install chrome-host` to actually run their scripts. Without the host they return exit 127. (Most other blanks — stocks, weather, prompt-improver, etc. — run pure in-browser via `fetch` and work with or without the host.)
- **Editor coverage** — Lexical (Reddit), ProseMirror (LinkedIn / ChatGPT / claude.ai / Luma), Draft.js (Twitter/X), Slate, and generic contenteditables (Gmail / YouTube) all work for cycling and blanks. Caret-restore after splices is handled per-engine — see `CLAUDE.md` for the engine matrix.

## Emoji preservation across transforms

Gmail (and Slack, Twitter/X, Reddit, most chat apps) convert pasted
emojis into inline `<img alt="😊">` elements behind the scenes. The
extension reads the `alt` content so emojis in your buffer survive
any transform you apply afterwards.

Example — type `Tu 😊 es 😊 le _ make bluh bold _` and the bold
transform now preserves all four emojis:

```
Before:  Tu 😊 es 😊 le  (with the bold instruction)
After:   Tu 😊 es 😊 **le**  (emojis kept, "le" bolded)
```

Before this was handled, the emojis got dropped from the buffer
during the first read after paste — every subsequent rewrite operated
on emoji-free text and wrote it back without them.

---

## Removing

```bash
# Disable / remove via chrome://extensions
# Then optionally:
rm -rf integrations/chrome/dist
rm -rf /mnt/c/Users/USERNAME/Desktop/opencues-chrome   # if you used --target
```

---

## Security model

Six boundaries defend against hostile pages triggering OpenCues
capabilities (subprocess blanks, system-volume changes, etc.) without
user intent:

1. **`isTrusted` gate** on input events — drops events from
   `dispatchEvent` outright.
2. **Credit-based underscore gate** — each trusted `_` keystroke /
   paste / drop buys exactly one underscore insertion. Defeats the
   "blessed window" replay attack.
3. **`on-site` / `not-on-site` frontmatter** — scope cues / blanks /
   auditors to specific sites (`reddit.com`, `*.reddit.com`,
   `reddit.com/r/claudeai`, etc.). Bundle filtered at read time.
4. **Path sandbox** — host refuses any script path that resolves
   outside `~/.cues/`, including via symlink (uses `realpath`).
5. **Env-key whitelist** — only `CUES_*` keys from the wire reach
   the spawned process. `PATH` / `LD_PRELOAD` etc. are filtered.
6. **Per-call timeout** — 10s default in host, 5s safety net in SW.

What's **not** defended against (user responsibility):

- Scripts you place in `~/.cues/blanks/` run with your user
  permissions. Treat third-party cue packs like `.bashrc` additions.
- DevTools self-pwn (you can write a malicious bundle to your own
  `chrome.storage.local`; the path sandbox still applies, so the
  worst case is "runtime tries a script that doesn't exist").

Full spec: [`docs/architecture/chrome-security.md`](../../docs/architecture/chrome-security.md).

Test coverage: `src/trust-gate.test.ts` (15 tests),
`src/site-filter.test.ts` (23 tests),
`packages/opencues-core/src/host-compat.test.ts` (9 new tests for
`inferSiteCompat`).

---

## See also

- [`docs/architecture/chrome-security.md`](../../docs/architecture/chrome-security.md) — full security model
- [`docs/architecture/repo-structure.md`](../../docs/architecture/repo-structure.md) — repo layout + stage tracker
- [`integrations/chrome/docs/rendering.md`](docs/rendering.md) — CSS Custom Highlight API + reconciliation strategy
- [`integrations/chrome/src/runtime-renderer.ts`](src/runtime-renderer.ts) — the actual paint logic (~120 lines, well-commented)
