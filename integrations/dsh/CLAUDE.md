# CLAUDE.md — DeepSeek Harness (dsh) integration

> **Status: validated prototype, no shipping code in this repo yet.**
> The probe that produced everything below lives outside the tree (it was
> built in a scratch directory during the August 2026 spike). This file is
> the knowledge capture so the eventual `adapters/dsh/v0.1` band does not
> have to rediscover any of it. Nothing here is wired into `opencues
> install`.

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)
is a Cordis-based agent harness whose only interactive text surface is a
React web app served at `127.0.0.1:3080`. There is no TUI. So this is a
**browser** integration, and `adapters/chrome/v1` works as its band
unchanged: that adapter is explicitly DOM-agnostic and takes callback
bindings, exactly as `shell/v1` clones `oc/v1.14`.

**dsh accepts no external pull requests** (stated in their CONTRIBUTING.md).
Their sanctioned channels are a plugin plus GitHub Discussions, which is
why the seam we want for inline notes is a Discussion post and not a patch.

## Why this host is unusually cheap

`dsh plugin --profile web add <pkg>` and that is the whole install. Client
plugins are served at runtime from `/plugins` (content-revved, `no-cache`),
so there is no fork, no patch engine, no version pin, no binary surgery,
and no srcHash drift surface. The upgrade path is `pnpm update` inside a
profile.

## How it attaches

| Half | Role |
|---|---|
| **node** | A Cordis plugin. Registers one route via `ctx.webServer.register({kind:'exact', path:'/opencues/config'})` serving the real `~/.cues/` tree plus `process.env` keys as JSON. This replaces chrome's entire native-messaging host: no separate process, no manifest, no mirrored directory. |
| **browser** | A client plugin (lazy-CJS factory form, `window.__ModuleLoader__.load({id, factory})`). Takes a seat in the `conversation.input.dock` slot, binds dsh's composer to the runtime, and paints `RenderDirectives`. |

The browser half re-roots the served config onto the virtual
`/chrome-storage/.cues` namespace that `chrome/v1`'s band hardcodes, then
serves it through the adapter's `readFile`/`readDir`. Search-path
precedence (project before user) has to be applied client-side, because
collapsing several roots into one namespace means ConfigLoader can no
longer do it itself.

### dsh's composer is already an overlay editor

This is the load-bearing fact for every rendering decision:

```
.mirror     visibility:hidden   sizes the box, sets the wrap points
.backdrop   color: #0f1115      THE VISIBLE TEXT (real DOM text nodes)
.input      color: transparent  the textarea: caret, selection, keys only
```

Every visible glyph is a real DOM text node in `[data-input-backdrop]`.
The textarea's own glyphs are never seen. So the **CSS Custom Highlight
API** paints dim and highlight ranges directly over their text with no DOM
mutation and no upstream seam, and the alignment invariant they maintain
for their own chips is inherited for free. Their comment: "Backdrop MUST
share these metrics or the highlight ranges drift off the glyphs."

Paint every range in dsh's own `--dsw-alias-*` tokens, never a fixed
colour. `body[data-ds-dark-theme]` swaps them all, and a hardcoded
light-theme grey renders as unreadable mud on the dark card. `var()` does
resolve inside `::highlight()`, so one rule set covers both themes with no
theme listener.

## Inline notes: what is missing

**Today the note is a floating box** that we position above the flagged
span (anchored from `InlineNote.spanStart`/`spanEnd`, re-placed on scroll,
resize, and a `ResizeObserver` on the composer card). It is not inline in
the terminal sense of text spliced into the rendered line.

A true inline note is **not reachable from a plugin**, for three separate
reasons. Any future attempt should start here rather than re-deriving them:

1. **The Highlight API cannot add glyphs.** It supports `color`,
   `background-color`, `text-decoration`, `text-shadow` and stroke.
   There is no `content`, and highlights are not pseudo-elements. The
   channel that makes our dim and cue paint work is structurally
   incapable of introducing a character.

2. **The backdrop is React-owned and re-renders every keystroke.**
   Anything we insert into that subtree is reconciled away, so we would be
   re-inserting dozens of times a second against their renderer.

3. **In-flow text breaks the alignment invariant.** Insert a word
   mid-buffer and every glyph after it moves in the backdrop but not in
   the textarea above, so the visible text desynchronises from the caret.
   That is a worse defect than any note is worth. (Appending strictly at
   the END shifts nothing, which is what terminal hosts do, but it still
   fights React and a note long enough to wrap changes the composer's
   height without the sizing mirror knowing.)

Putting the note in the draft is of course not an option: the draft is the
submit value.

### The frustrating part

**dsh already has exactly the right mechanism.** Their ghost-text hint
(`data-decoration="hint"`) is display-only text rendered in the backdrop
that is not in the draft. That is a native inline note. It is produced by
`deriveDecorations` in
`packages/client/ui-conversation/src/client/input/decorations.ts`, whose
product is a closed union (`token` / `chips` / `textRefs` / `hint`) with no
contribution point.

**So the ask upstream is one seam:** a decorations contribution slot on
`conversation.input`. It would give us true inline notes rendered by their
own machinery, correctly aligned, theme-native, and reconciliation-safe,
and it is generically useful to them (spellcheck, grammar, any
input-decorating plugin wants the same thing). It is also the same seam
that would let us stop hand-rolling the paint overlay.

### Floating may be the better rendering here anyway

Do not treat the floating box purely as a compromise. Terminals append the
note below the buffer because a terminal is a fixed grid with no z-layer.
A browser has one, so anchoring above the flagged span points at the
actual words rather than trailing the line. The runtime anticipated this:
`InlineNote` carries `spanStart`/`spanEnd` and `adapter.ts` says the
coordinates exist "so a future painter can anchor the note to the span's
line/column", with append-below described as the v1 terminal behaviour.

Notes are also long (`❓ 2 | received (Recommended) (underscore to
cycle)`). Inline at the end of a wrapping composer, every cue would change
the card's height, which is a worse kind of jumping.

**Third option if the floating note ever feels wrong:**
`conversation.composer.dock`, the in-contract band under the card where
dsh's own stats line lives. Never moves, entirely native, but loses span
anchoring and reads as a status line rather than a note.

## LLM routing: two modes

**Harness mode (the default).** Every OpenCues call goes through dsh's own
`ctx.llm.stream()`, using whatever provider and model the user already
configured there. `GenerateOptions` is a free-standing one-shot ("a
hand-built one-shot passes any list"), so this creates no session and
writes nothing to the transcript. Three consequences: **no OpenCues API key
is needed**, credentials stay in the Node process where the browser cannot
see them even in principle, and the host's retry policy plus token metering
cover cue traffic.

The seam is `@opencues/core`'s `harness` provider (`transport: 'cli'`,
`registerHarnessDispatch(fn)`). The browser half binds a dispatch that
POSTs the neutral `ChatRequest` to `/opencues/llm`; the node half maps it
onto `GenerateOptions` and dispatches.

**OpenCues mode.** The runtime's own per-bucket routing (cues / auditors /
blanks) from OPENCUES.md, with OpenCues' own providers and keys. Unchanged
by any of this.

### Four things that are easy to get wrong

- **Harness mode must beat the BUCKET scalars, not just the global one.**
  The resolver's precedence is per-source > per-feature > bucket > global,
  and `providerOverride` only replaces the global tier. A bucket scalar in
  the user's OPENCUES.md silently wins, and the first cut of this routed
  cues to cerebras while believing it was on the harness. The fix is to
  compose the effective OPENCUES.md (rewriting every `*-llm-provider` to
  `harness` and dropping the model scalars) in the served virtual FS. The
  file on disk is never touched.
- **Never forward OpenCues' model scalar to the host.** OpenCues carries
  e.g. `gemma-4-31b`; sending that to `deepseek-official` asks DeepSeek for
  a Cerebras model, and adapters are explicitly told *not* to reject
  unlisted ids, so it is served as *something* rather than failing loudly.
  The node half validates the requested model against `listModels()` and
  falls back, reporting `modelFallbackFrom`.
- **Pin reasoning effort off.** Both DeepSeek models advertise
  `off | high | max` with **`defaultEffort: high`**, and at the default
  every response streams chain-of-thought as ordinary text — which OpenCues
  splices straight into the user's document ("We need to answer…"). Off
  also saves ~400ms. Efforts are adapter-owned opaque strings, so resolve
  them from `resolveModelInfo` rather than assuming a vocabulary.
- **Consume `text-delta` only.** `StreamChunk` is a discriminated union
  where `reasoning-delta` carries chain-of-thought. Filtering on a generic
  `.text` field picks up both.

### Measured, same prompt and machine

| Route | TTFT | Total |
|---|---|---|
| groq / gpt-oss-120b | 211 ms | 218 ms |
| cerebras / gemma-4-31b | 260 ms | 268 ms |
| deepseek-v4-flash (reasoning off) | 826 ms | 979 ms |
| deepseek-v4-pro (reasoning off) | 1162 ms | 1310 ms |

Prefix caching works well on DeepSeek (3584 of 3598 tokens reused, 99.6%),
so OpenCues' stable-system-prompt design pays off. But a cached call with
**14 input and 5 output tokens still takes 837 ms**, which is a round-trip
floor rather than inference: it will not tune away. Fine for `_` blanks,
where the user is already waiting; noticeably behind for passive cues.
That is why the choice stays the user's, and why the settings tab states
the numbers instead of hiding them.

`listConfigurableProviders()` returns ~36 dormant routes including
cerebras, groq and openai: dsh's LLM layer is a generic multi-provider
adapter (`llm-pi-ai`) with `apiKeyEnv` as a credential *reference*. So a
user wanting speed can activate cerebras **inside dsh** and keep every
benefit of harness mode.

## Settings

Contributed into dsh's own Settings > Plugins section through the public
`settings.plugins.tab` slot, so it sits beside their Plugin configuration
and Plugin list tabs rather than being a parallel UI.

It deliberately contains only two things: **which model sees your text**
(harness mode inherits the model configured for the user's agent
conversation, and they should be told plainly rather than have it inferred
from a dropdown they never opened) and the routing choice with the measured
latency attached. Every other OpenCues scalar stays in OPENCUES.md and the
in-buffer `_` settings blank; mirroring forty scalars into a second surface
would be a drift surface with no upside.

Mode currently persists in `localStorage`, so it applies instantly and per
browser. Moving it to a dsh settings namespace would make it follow the
user's `$DSH_HOME` across ports, and is the obvious next step.

## Host contract findings

Five bugs cost real time and all five generalise to any asynchronous or
React-based host, not just dsh:

1. **One runtime per page.** The dock can remount (session and workspace
   transitions, React double-invoke). A second runtime silently aborts the
   first's in-flight LLM calls. Symptom: every log line doubled and blanks
   that never land. Guard with a page-level singleton. Note the chrome
   extension attaching to `localhost:3080` is a *second* instance on top
   of the plugin, so scope it off that origin.

2. **Normalise key names.** Navigation and Cycling filter on
   `['left','right','up','down']`, not the DOM's `ArrowUp`. An unmapped
   name is silently declined with no error anywhere. This is the whole
   "Ctrl+Alt does nothing" failure mode.

3. **Async writes need an optimistic shadow.** `setDraft` goes through the
   input machine and React, so a runtime write is not readable back via
   `getText()` immediately. Without a shadow every write-then-compare
   fails. The visible symptom is `TransformBlank: skipping — live text
   changed since resolve` with **identical lengths**, because the
   difference is the loading animator's frame glyph.

4. **Use `createSourceReclassifier` + `markRuntimeWrite`** before each
   write, so the echo classifies as `runtime` rather than `user`.

5. **Dedupe notifications.** Repeat `notifyTextChange` calls for unchanged
   text supersede and abort the resolver's own in-flight request.

Drive the runtime through the **`BootResult`** API (`dispatchKey`,
`notifyTextChange`, `notifyCursorChange`, `collectRenderDirectives`). The
`register*Handler` bindings are the adapter's internal subscriptions, not
a driving path. The `httpAdapter` must be core's shape
(`post(url, body, headers, opts) => Promise<string>`), and every fetch has
to go through a closure because a detached `fetch` throws "Illegal
invocation".

Bundle with chrome's esbuild externals: `node:fs`, `node:path`, `node:os`,
`node:child_process`, `https`.

## Install

```
dsh plugin --profile web add @opencues/dsh
```

That is all of it. pnpm links the package, dsh reads its `dsh.bundle`
manifest and appends it to `dsh.profile.bundles`, and the next boot serves
the client half from `/plugins`. Reload the tab. Removal is
`dsh plugin --profile web remove @opencues/dsh`.

No fork, no patch engine, no version pin, no binary surgery, no
`opencues install` step. The published package carries a prebuilt
`client.js` with `@opencues/core` and `@opencues/runtime` inlined (~1.2 MB),
so both can stay private packages; the node half has no dependencies
beyond `node:fs`.

**A user with an existing OpenCues install** gets their `~/.cues/` tree and
env keys picked up automatically, and can choose either LLM mode.

**A user who has never heard of OpenCues** gets the shipped defaults,
inlined at build time (29 files: `CUES.md`, `OPENCUES.md`, and every
`cues/*/CUE.md` and `blanks/*/BLANK.md`) and dropped into the same virtual
FS a real tree would populate. A real `.cues` directory always wins.

This is not a nicety. Verified on a clean HOME **before** the fallback
existed: the config route returned `"files":{}`, ConfigLoader reported
`0 cue entries, 0 blanks`, the resolver built no sources, and typing
`the capital of iceland is _` did nothing at all — **a silent no-op with no
error to explain it**, which for a plugin someone just installed reads as
broken. With the fallback the same user gets 97 blanks and that sentence
fills to `Reykjavik`, on the host's model, with no key anywhere.

## Credentials

`/opencues/config` **withholds API key values by default** and returns only
the key NAMES, so a surface can say "cerebras, groq detected" without
holding the secrets. Values are sent only when the client asks with
`?withKeys=1`, which it does exclusively in OpenCues mode, where the
runtime dispatches to providers from the page and genuinely needs them.

In harness mode the page therefore never receives a credential at all.
That matters more here than on most hosts: **dsh is a plugin host**, so
the page context is shared with third-party plugin code, and a key handed
to the page is a key handed to all of them. The first cut of this route
sent every value unconditionally; that was wrong and is fixed.

## What is verified working

Real `@opencues/runtime` against real `~/.cues/` and real cerebras calls:
transform-blank, fluid-blank, sentence-cues, spelling word-cues, per-word
dim plus highlight, the runtime's own inline note text, `_`-to-cycle,
`Ctrl+Alt+→` navigation, `Ctrl+Alt+↑`/`↓` cycling and reverting, typing
after a substitution, identity-context (12 fields, safe mode), chips via
our own `@` trigger source, and cerebras prefix caching at 99.2 to 99.6%.
A headless regression suite covered 18 contract assertions.

`Ctrl+Alt+↑` requires Navigation to have activated a word first
(`Ctrl+Alt+→`). Pressing it with nothing active correctly returns
not-consumed. That is not a bug.

## Known gaps

- **Inline notes** as above.
- **Firefox untested.** The Highlight API needs 140+; feature-detect
  `CSS.highlights` and fall back to the in-contract dock mode.
- **dsh is `0.1.0-rc` and warns of breaking changes.** The two contracts we
  build on are annotated "frozen" (`ui-conversation/src/client/input/contract.ts`,
  `ui-input-trigger/src/client/contract.ts`), which is the best signal
  available, but expect maintenance.

## Environment notes

- `directory-picker-auto` resolves to a **blocking zenity dialog** when
  `DISPLAY`/`WAYLAND_DISPLAY` are set. Unset both to get the in-browser
  picker (required for any headless driving).
- `waitUntil: 'networkidle'` never settles: the client holds an open
  downlink WebSocket.
- Headless Chrome on WSL never commits a compositor frame, so screenshots
  and screencast hang. Run headed against WSLg's display (`DISPLAY=:0`,
  `--enable-unsafe-swiftshader`), the same trick `~/opencues-recording/record.mjs --headed` uses.
- dsh's theme preference is injected server-side from
  `$DSH_HOME/settings.yaml` (`ui-theme.preference`), so Playwright's
  `colorScheme` emulation does **not** flip it. Edit the file and restart.
- The loading animator replaces `_` with a spinner glyph, so "no trailing
  underscore" is TRUE mid-call. Any settle predicate must exclude
  `[_▖▘▝▗]` or a test will race ahead and clear the buffer under an
  in-flight request.
