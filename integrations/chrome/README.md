# OpenCues Chrome Extension

`@opencues/chrome` — an MV3 extension that adds real-time word alternatives, blanks, and cue-blanks to any `contenteditable` on the web. Renders via the CSS Custom Highlight API; no DOM mutation, no caret disruption.

> **What works in Chrome vs native hosts**: cycling, blanks, opencues-settings (`opencues settings _`), prompt-improver, stocks/weather/HackerNews — all work. **What doesn't**: brightness / volume cue-blanks (no subprocess access in browsers — these spawn shell scripts on native hosts). TTS uses the Web Speech API (not `speak.sh`). Live `~/.cues/` sync works via a local native-messaging host (`opencues install chrome-host`) — see `docs/features/chrome-sync.md`. Without the host, the extension uses whatever defaults were baked in at build time.

| Field | Value |
|---|---|
| Version | 0.1.0 |
| Compatible with | Chrome 121+ (CSS Custom Highlight API) |
| Source | `integrations/chrome/` |
| Runtime | `@opencues/core`, `@opencues/runtime` (workspace-linked via `pnpm` symlinks) |

---

## Install (from a clone)

```bash
git clone https://github.com/opencues/opencues
cd opencues
pnpm install
pnpm --filter @opencues/chrome dev-install
```

This builds the extension and prints the path to load as an unpacked extension. By default the load path is `integrations/chrome/` itself — works on macOS / Linux / native Windows where Chrome and the build directory share a filesystem.

### WSL → Windows Chrome

Chrome runs on Windows; the build runs in WSL. Use `--target` to deploy the built extension to a path Chrome can see:

```bash
pnpm --filter @opencues/chrome dev-install -- \
  --target /mnt/c/Users/USERNAME/Desktop/opencues-chrome
```

Re-run the same command after each rebuild — the deploy step copies `dist/` + `manifest.json` to the target. Then click the reload button on the extension card at `chrome://extensions`.

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

| Test | Expected |
|---|---|
| Click into a `contenteditable` div, type a few words | Words with alternatives get a slightly darker mid-tone |
| Ctrl+Alt+Right | Highlights the next navigable word in bright white |
| Type `weather _ paris` | `_` fills with current Paris weather |
| Type `improve prompt write a poem _` | After ~2s, full text is replaced with an improved version; cycle Up/Down to toggle between the rewrite and the original |
| `chrome://extensions` console shows `[opencues][info] OpenCues runtime starting (Chrome v1)` | Bootstrap booted |

If you see legacy `[OpenCues] ...` logs but **no** `[opencues][info] OpenCues runtime starting` line, you loaded a stale bundle — re-run `dev-install` (and re-deploy via `--target` if applicable).

---

## Update workflow

```bash
cd opencues
git pull
pnpm install                              # picks up dep changes
pnpm --filter @opencues/chrome dev-install   # rebuilds + redeploys
# Reload the extension card at chrome://extensions
```

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
pnpm exec opencues install chrome-host --extension-id <id>
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

## What this extension cannot do

- **Native `<input>` / `<textarea>`** — the CSS Custom Highlight API can't reach into form-control internals (Chromium UA shadow DOM doesn't expose Text nodes to scripts). The extension only attaches to `contenteditable` elements. A "mirror div" workaround is possible but not currently implemented.
- **Lexical-managed editors (e.g., Reddit's comment composer)** — Lexical's controlled-DOM model rejects external mutations. Highlights will appear, but cycling won't change the underlying text. A page-world Lexical bridge is possible but adds significant complexity; not currently implemented.
- **tiptap / ProseMirror editors** work fully; the runtime renders highlights through the Highlight API and uses a post-reconcile `requestAnimationFrame` to keep Range objects pointed at the editor's reconciled Text nodes.

---

## Removing

```bash
# Disable / remove via chrome://extensions
# Then optionally:
rm -rf integrations/chrome/dist
rm -rf /mnt/c/Users/USERNAME/Desktop/opencues-chrome   # if you used --target
```

---

## See also

- [`docs/architecture/repo-structure.md`](../../docs/architecture/repo-structure.md) — repo layout + stage tracker
- [`integrations/chrome/docs/rendering.md`](docs/rendering.md) — CSS Custom Highlight API + reconciliation strategy
- [`integrations/chrome/src/runtime-renderer.ts`](src/runtime-renderer.ts) — the actual paint logic (~120 lines, well-commented)
