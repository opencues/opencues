# CLAUDE.md — Chrome integration

This document captures hard-won knowledge for the chrome extension that
isn't obvious from the code alone. Read this before changing anything in
`opencues-bootstrap.ts`'s write paths.

## Live config sync — native-messaging host (May 2026)

Live `~/.cues/` sync replaced the 2.5s version-poll. The mechanism:

- A Node host at `integrations/chrome/host/host.cjs` runs locally,
  watches `~/.cues/` via `fs.watch`, and pushes bundles to the
  extension over Chrome's native-messaging API.
- The extension's service worker (`src/background.ts`) opens the port
  with `chrome.runtime.connectNative('com.opencues.sync')`, receives
  framed-JSON `{ type: 'bundle', files: {...} }` messages, writes them
  to `chrome.storage.local.opencues_bundle`.
- The content script's bootstrap resolves configs in this order:
  storage bundle → bake-time `dist/configs/` → esbuild
  `__DEFAULT_*__` constants. Storage `onChanged` invalidates the
  in-memory bundle-index cache and calls `reloadConfig()`.

Install via `opencues install chrome-host --extension-id <id>`. On
WSL it drops a `.bat` shim on the Windows side that invokes
`wsl.exe -d <distro> --shell-type login -- node <host path>`. The
`--shell-type login` flag is **load-bearing** — without it, wsl
spawns a non-login shell whose PATH only contains system Node (often
ancient), and the host crashes on modern syntax. Login shells source
nvm/volta init from the user's profile.

Don't reintroduce the version-poll. If a bug looks like "config edit
not reaching tab", check the service worker logs for `native host
port opened` + `bundle stored` — the bridge is up if both appear.

Full spec: `docs/features/chrome-sync.md`. Per-platform manifest paths
(macOS / Linux / Windows registry / WSL→Win) live in
`integrations/chrome/bin/install.cjs`.

## Subprocess execution — exec protocol (May 2026)

Same native-messaging port carries `spawnProcess` requests for
scripted blanks (volume, brightness, any user `.sh`/`.py`-backed
blank). Without the host, these return exitCode 127. With the host,
they run the same script CC/OC would run, on the host filesystem.

Protocol (bidirectional, framed JSON over the existing port):

| Direction | Message | Notes |
|---|---|---|
| extension → host | `{type:'exec', requestId, command, args, env, timeoutMs}` | requestId is a per-port-session string; concurrent execs allowed |
| host → extension | `{type:'exec-result', requestId, exitCode, stdout, stderr, timedOut}` | matched against pending Map in background.ts |

Path translation: the runtime constructs script paths relative to its
virtual `/chrome-storage/.cues/...` root. The host rewrites any
argument starting with that prefix to `${CUE_ROOT}/...` (the real
filesystem path) and **refuses anything that would resolve outside
CUE_ROOT** — basic sandbox.

Wiring (forward path):

```
runtime.spawnProcess(spec)
  → adapter.bindings.spawnProcess(spec)               (chrome v1)
  → chrome.runtime.sendMessage({type:'opencues:exec', ...spec})   (content script → SW)
  → port.postMessage({type:'exec', requestId, ...})    (SW → native host)
  → child_process.spawn(...)                            (host)
  → port.postMessage({type:'exec-result', requestId, ...})
  → pending.get(requestId)(result)                      (SW dispatches reply)
  → sendResponse(...)                                   (back to content script)
  → ProcessHandle.result resolves
```

Why volume isn't a chrome-native blank anymore: the local `VolumeBlank`
class (`src/blanks/volume.ts`) used the Web Audio API to control TAB
audio. It's still in the source for future re-use under a different
keyword (`tab-volume`?), but unregistered from `createBlanks` so the
`volume _` keyword falls through to the host's system-volume script —
keeping behaviour consistent with CC/OC.

Capability advertised conditionally: `'spawn-process'` is in
`ChromeV1Adapter.capabilities` only when the bootstrap supplied a
`spawnProcess` binding. Code paths that check capabilities (rare in
the chrome path) won't try to spawn when the host isn't installed.

Where the bake-time bundle differs: the chrome-host bundle **includes**
script-bearing blank folders (host can run them), but **excludes** the
script bytes themselves (host runs from disk; bytes would just bloat
the payload). `opencues sync chrome` (bake-time) excludes both — no
host means no spawn, and the auto-detected host-compat filter
correctly drops the folder.

Don't ship long-running / streaming scripts through this protocol —
it's request/response, no `stdout` stream until close. Future
streaming variant would add an `exec-chunk` message.

## Trust gate + site scoping (May 2026)

Two security boundaries closed in the May 2026 native-messaging push:

**1. `isTrusted` gate** (`src/content.ts`). The `input` event handler
drops events where `event.isTrusted === false`. Browser-issued events
from real user keystrokes always have `isTrusted: true`; programmatic
`dispatchEvent(new InputEvent(...))` from a hostile page is false and
gets ignored. This blocks the "attacker page injects `volume 100 _`
into a hidden contenteditable and fires synthetic input" vector.

Our own runtime writes go through `execCommand` / direct `.data`
mutation; the resulting input events are either trusted (execCommand)
or not fired at all (.data) — neither path triggers a spurious blank
fire because we mark runtime writes via `sourceReclassifier` before
the next event lands. No regression for legit writes.

**2. Site-scoped allow/deny lists** (`on-site` / `not-on-site` in
frontmatter). Cues / blanks / auditors can scope themselves to specific
sites: `on-site: [reddit.com]`, `on-site: [reddit.com/r/claudeai]`,
`on-site: [*.reddit.com]`, etc. Filter applies at bundle-read time in
`applySiteCompatFilter` (opencues-bootstrap.ts) — entries that don't
match the current `location.hostname`+`pathname` never reach the
runtime. SPA navigation re-triggers the filter via `popstate` +
monkey-patched `pushState`/`replaceState`. Spec:
`docs/features/host-compat.md`-adjacent section in top-level CLAUDE.md.

For destructive blanks (anything taking free-form args that acts on
the system), recommend pairing `on-site` with a known-good origin
list rather than firing globally.

## Verified working sites (May 2026)

| Site | Engine | Path used |
|---|---|---|
| Gmail compose | generic contenteditable | `execCommand('delete')` + paste with `<br>`-joined HTML |
| Reddit | Lexical | editor API or keyboard sim + paste with `<p>` HTML |
| Twitter/X | Draft.js | keyboard sim + paste with `text/plain` |
| LinkedIn | ProseMirror | `execCommand('insertText')` |
| ChatGPT | ProseMirror | `execCommand('insertText')` |
| claude.ai | ProseMirror | `execCommand('insertText')` |
| Luma | ProseMirror (outlier) | keyboard sim + paste with `<p>` HTML |
| YouTube comments | generic contenteditable | `execCommand('delete')` + paste with `<br>`-joined HTML |

If you regress one of these while fixing another, that's a structural
problem with the change. Re-verify the full matrix after every write-path
edit, not just the site you're targeting.

## The biggest issue: writing into managed contenteditables

Most modern web apps use a managed-editor framework (Lexical, ProseMirror/
TipTap, Slate, Draft.js) that owns the contenteditable as a React-style
surface. Their model is the source of truth; the DOM is just rendered
output; their MutationObservers REVERT direct DOM mutations that don't
match expected shape; their selection models DON'T sync from
`window.getSelection()` set by us.

There is no universal programmatic write strategy that works across all
of them — each engine and even each app has its own quirks. The chrome
adapter's write paths in `replaceAllText` and `applyTextDiff` (in
`src/opencues-bootstrap.ts`) implement a per-editor ladder discovered by
trial and error. Don't unify it without testing every entry below.

### The matrix (current state)

| Engine | Sites | Write path | Why this and not others |
|---|---|---|---|
| **Lexical** | Reddit | `__lexicalEditor.update($getRoot().clear())` (or keyboard sim Ctrl+A + Backspace fallback) → synthetic `paste` event with `<p>`-per-paragraph HTML in DataTransfer | Lexical's selection model doesn't sync from browser selection. Direct DOM mutations get reverted. Only its editor API or keydown-pipeline events are honored. Paste handler accepts text/html when paragraph blocks match the `<p><span data-lexical-text>` shape Lexical builds natively. |
| **Draft.js** | Twitter/X | Keyboard sim Ctrl+A + Backspace → synthetic `paste` event with `text/plain` (NOT html) | Draft.js's keydown pipeline accepts synthetic Ctrl+A and Backspace. Its `onPaste` handler reads `e.clipboardData.getData('text')` only — html paste gets rejected. |
| **ProseMirror/TipTap default** | LinkedIn, ChatGPT, claude.ai, and presumably most ProseMirror sites | `execCommand('insertText', false, text)` (text passed as-is) | These all reject programmatic paste events outright (paste filters / sanitization extensions). insertText routes through ProseMirror's plain-text-insertion command, which the paste filter doesn't intercept. With selection set to all (via `selectNodeContents` at top of `replaceAllText`), insertText replaces. Browser dispatches `inputType: insertParagraph` for each `\n`; LLM `\n\n` produces one paragraph break (web convention). |
| **ProseMirror/TipTap exception** | Luma | Keyboard sim Ctrl+A + Backspace → synthetic `paste` event with `<p>`-per-paragraph HTML | Luma's TipTap config maps EACH `\n` (in insertText) to a hard paragraph break, so LLM `\n\n` becomes double-spacing. Their paste handler accepts the `<p>` HTML cleanly with correct single-paragraph spacing. |
| **Generic contenteditable** | Gmail, plain `<div contenteditable>` | `execCommand('delete')` → synthetic `paste` event with `<br>`-joined HTML | Gmail's own Enter-key emits `<br>` per line, and its paste handler honors `<br>`-separated content. `<p>` per line would inherit extra paragraph margins. |

### Key learnings (do not re-discover)

1. **`document.execCommand('delete')` is a no-op on managed editors.** Their
   beforeinput handlers read INTERNAL selection, which doesn't sync from
   browser selection. The visible-only DOM clear (`removeChild`,
   `innerHTML=''`, `textContent=''`) gets REVERTED by the editor's
   reconciler within milliseconds. Either use the editor's own API or
   simulate keyboard events that route through the editor's keydown
   pipeline.

2. **`execCommand` returns `true` even when the editor preventDefaults
   the resulting beforeinput.** There's no synchronous "did the write
   actually take" signal. Don't build fallback chains based on
   post-execCommand DOM length comparisons — the second fallback fires
   while the first is still being processed asynchronously by the
   editor, causing double-renders.

3. **`InputEvent('input', { inputType: 'insertFromPaste', data: text })`
   dispatched after a paste DOUBLES the content** in editors whose
   input-event handler reads the `data` field as plaintext to insert
   (Lexical, ProseMirror). The paste handler already inserted the text
   from DataTransfer; the input event's `data` field then gets inserted
   on top. Don't dispatch `input` events alongside paste.

4. **LLM `\n\n` is the universal paragraph-break convention. Don't
   collapse it generically.** LinkedIn / ChatGPT / claude.ai treat `\n\n`
   as one paragraph break (collapsing internally per web convention).
   Luma's TipTap is the outlier — it treats EACH `\n` as a hard
   paragraph break, so we collapse `\n+` → `\n` only for Luma.

5. **`writeCursorOffset` no-ops in managed editors.** Their selection
   models sync model→DOM, never the other way. Setting browser selection
   externally fights with their next render and the model usually wins
   (often snapping to end-of-buffer). For single-text-node splices the
   editor naturally keeps the caret at the prior character offset
   within the mutated node, which is what we want anyway.

6. **`applyTextDiff` only mutates text nodes safely on
   non-managed editors AND on managed editors when the change is
   single-segment.** Multi-segment splices get reverted by Lexical/PM
   reconcilers (only the first changed node survives, rest revert).
   For multi-segment changes in managed editors, route to
   `replaceAllText` instead.

7. **`pushText` (cycling) and `setText` (transform-blank) both go through
   `diffWriteText`.** Originally we routed setText straight to
   `replaceAllText` thinking it always meant "whole body replace", but
   cycling.ts uses setText for every word cycle — that put the cursor at
   end-of-buffer in Lexical on every cycle. The diff's single-segment vs
   multi-segment check is the right discriminator.

### Adding a new editor / site

1. Identify the engine via DOM inspection — typical markers:
   - `[data-lexical-editor="true"]` → Lexical
   - `.public-DraftEditor-content` / `data-block="true"` → Draft.js
   - `.ProseMirror` → ProseMirror/TipTap
   - `[data-slate-editor="true"]` → Slate
2. Try the matching path from the matrix first (no code changes needed if
   the engine is already detected — `isManagedEditor`/`isLexicalEditor`/
   `isDraftJsEditor` cover it).
3. If the default path for that engine doesn't work for this site, add a
   hostname carve-out in `replaceAllText`. Examples already in code:
   `isLuma`, `isPasteFiltered`. Keep the carve-outs minimal and
   well-documented (engine quirk, not a fundamental rewrite).
4. If it's a brand new engine family, add a new branch to
   `replaceAllText`, a detector to the helpers near the top of
   `opencues-bootstrap.ts`, and extend `isManagedEditor`.

### Adding a new blank — register it in TWO places

Every runtime blank (anything in `packages/opencues-runtime/src/blanks/`)
needs to be **explicitly registered in chrome's blanks registry** at
`integrations/chrome/src/blanks/index.ts`. Implementing the class in
the runtime is necessary but NOT sufficient for chrome.

Failure mode: when missing the chrome registration, the blank's keyword
dispatches but finds no handler. The runtime falls through to
spawnProcess, which the chrome adapter resolves with exitCode 127.
The user sees nothing — the trigger silently does nothing.

The two edits in `integrations/chrome/src/blanks/index.ts`:

1. Add to the import list at the top:
   ```ts
   import { ..., YourBlank, ... } from '@opencues/runtime/dist/src/blanks';
   ```
2. Add to the registry inside `createBlanks`:
   ```ts
   blanks.set('your-blank', new YourBlank(...));
   ```

Real-world example: `claude-status` (May 2026) had the runtime impl,
tests, and a dist build, AND its `BLANK.md` was being synced into
`dist/configs/blanks/claude-status/`. But chrome's registry didn't
import it, so the keyword "is claude down" looked broken until the
two-line fix landed.

### Reddit/Lexical content-loss prevention (related)

Two protections live in the runtime/core (NOT chrome-only) that prevent
data loss when LLM/pipeline glitches produce undersized rewrites for
multi-paragraph bodies:

- `packages/opencues-runtime/src/state/dyn-defs.ts` —
  `reconstructAsTyped` skips transform-blank-typed defs. Their
  `originalWord` is the FULL prior body INCLUDING the prior trigger
  phrase; reverting it bleeds two instructions into the next EXTRACT
  input, producing pipe-composed instructions or worse. See
  `docs/architecture/transform-blank.md` § "asTypedText reconstruction
  — TransformBlank defs are SKIPPED".
- `packages/opencues-core/src/sources/transform-blank-source.ts` —
  refuses to substitute when the rewrite is < 10% of target length AND
  target > 100 chars. Backstop against APPLY/VERIFY hallucinating tiny
  rewrites for big bodies.

Both apply to all hosts (CC, OC, chrome) but were discovered via chrome
debugging.
