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

It leads with **which model sees your text**, because harness mode inherits
the model configured for the user's agent conversation and they should be
told plainly rather than have it inferred from a dropdown they never
opened. The routing choice carries the measured latency, since the
trade-off is real.

Below that sits **every OpenCues feature scalar**, in a collapsed
disclosure. This is a browser host with no terminal to fall back to, so
"edit OPENCUES.md" is not an answer for someone who installed a plugin —
and the settings blank is a chicken-and-egg answer, since the features it
configures include the ones that make typing work.

The list is **generated from `getMenuDefinitions('chrome', parsed)`**, not
hand-written, which is the only detail here worth defending. `feature-registry.ts`
already owns which scalars exist, what each accepts, which values are menu
exposed and which are host scoped; a hand-listed copy would be a second
surface to keep in step, and the registry exists precisely so that adding
a feature is one entry and nothing else drifts. `hostName: 'chrome'` is
correct rather than expedient — the integration runs on the chrome adapter
band, so host-scoped tunables surface exactly as they do in that band's
cycling menu. 35 controls today, with no per-scalar code here.

Writes go to the **real `OPENCUES.md`** through a `POST /opencues/settings`
route, so a choice made here is the same choice the native hosts read.
Server side it validates the key against kebab-case and refuses any value
carrying a newline, because a settings write is a file write and a value
with a `\n` in it is a second scalar. Verified: `voice-mode` round-trips to
`~/.cues/OPENCUES.md`, and `inactive\nllm-provider: evil` is refused 400.

Mode currently persists in `localStorage`, so it applies instantly and per
browser. Moving it to a dsh settings namespace would make it follow the
user's `$DSH_HOME` across ports, and is the obvious next step. (Note the
asymmetry: feature scalars already live in the shared file and only the
harness/OpenCues routing choice is browser-local.)

## Host contract findings

Six bugs cost real time and all six generalise to any asynchronous or
React-based host, not just dsh:

1. **One runtime per page.** The dock can remount (session and workspace
   transitions, React double-invoke). A second runtime silently aborts the
   first's in-flight LLM calls. Symptom: every log line doubled and blanks
   that never land. Guard with a page-level singleton.

   **A page-level singleton is not enough when the second runtime is the
   chrome extension.** A content script runs in an *isolated world* — its
   own `window`, so `window.__ocSingleton` is invisible to it and its to us.
   What is shared is the document: same textarea, same key events, same
   `CSS.highlights`. Verified with both installed: the extension, keyless on
   a fresh profile, won the race and wrote
   `[OpenCues: no API key — open the extension popup]` over the plugin's
   answer — an error about a credential this host does not even need.

   Solved by `@opencues/core/page-ownership`: the plugin calls
   `claimPage('dsh')` (sets `data-opencues-host` on `<html>`) and the
   extension checks `pageClaimedByOther('chrome')` and stands down. **A DOM
   attribute, because a global cannot cross worlds.** The claim must be read
   LIVE at each action point, not cached at boot — the extension injects at
   `document_end` and this plugin boots later, so the claim usually appears
   *after* it. (The earlier note here said to "scope it off that origin",
   which was never a real fix: it would only have helped a developer running
   dsh on a known port, not a user with both installed.)

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

6. **A bare `process.X` in the runtime is a handler-killer, not a missing
   value.** Five sites read `process.env.HOME ?? '~'` to expand a
   `blankScript`'s `~`; in a browser that throws `ReferenceError` and takes
   the enclosing text-change handler down, so **every** script-backed blank
   went dead while dictionary (no script path) worked — six broken blanks
   as the symptom of one broken line, with nothing in any log. Fixed in
   `@opencues/runtime` 0.30.4 (`lib/home-dir.ts`). Note *why* it survived:
   chrome esbuild-`define`s `process.env.HOME`, and
   `lint-runtime-browser-safe.sh` exempted the name on that basis — making
   "replicate chrome's define list" an unwritten requirement of every
   future browser host. The exemption is gone. **If you are porting to a
   new browser host, run that lint rather than trusting chrome's silence.**

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
inlined at build time (30 files as of core 0.52.0 — `CUES.md`, `OPENCUES.md`, `RULES.md`, and every
`cues/*/CUE.md` and `blanks/*/BLANK.md`) and dropped into the same virtual
FS a real tree would populate. A real `.cues` directory always wins.

This is not a nicety. Verified on a clean HOME **before** the fallback
existed: the config route returned `"files":{}`, ConfigLoader reported
`0 cue entries, 0 blanks`, the resolver built no sources, and typing
`the capital of iceland is _` did nothing at all — **a silent no-op with no
error to explain it**, which for a plugin someone just installed reads as
broken. With the fallback the same user gets 97 blanks and that sentence
fills to `Reykjavik`, on the host's model, with no key anywhere.

### Force that state, and force it as a JOURNEY

`boot-dsh-virgin.sh` is the honest version of this test, and the difference
from the first attempt is worth stating because the first attempt passed.
That one emptied `HOME` only, so it still inherited every provider key from
the developer's shell — "no API keys detected" was never exercised, and
OpenCues mode looked available in a state where it would not be. The strict
version unsets `~/.cues`, `<cwd>/.cues`, `OPENCUES_HOME` **and every key any
OpenCues provider reads**, keeping only `DEEPSEEK_API_KEY`, which a dsh user
has by definition.

More importantly: **a snapshot of the fresh state passes while the journey
through it fails.** Four defects surfaced, and three were invisible until a
step boundary:

1. **The settings tab could not save anything.** The missing *file* was
   handled; the missing *parent directory* was not, so `writeFile` answered
   ENOENT — for exactly the users the shipped defaults exist to serve.
2. **The first write bricked the plugin.** The fallback triggered on
   `vfs.size === 0`, and the write created `~/.cues/OPENCUES.md`, making the
   tree non-empty. Next reload: `Resolver: no cuesConfig/blanksConfig,
   skipping build`. Every cue and blank dead, no error, **caused by using the
   feature**. Settings are not content, so the trigger is now "no cue or
   blank DEFINITIONS on disk" (`CUES.md` / `CUE.md` / `BLANK.md`) and the
   defaults gap-fill rather than replace — which also means a user with a
   real tree never has a default they deliberately deleted resurrected.
3. **A sparse write silently disabled two features.** Seeding
   `---\nvoice-mode: inactive\n---` puts a file on disk, and on-disk wins, so
   it shadowed the shipped default's explicit `word-cues-mode: on` /
   `transform-blank-mode: on` — 7 sources became 5. The first write now seeds
   from the shipped default verbatim (17.8 KB, emitted into the package at
   build time so the node half has it) and applies the change on top.
4. **The inline note floated above dsh's settings modal**, as a stray
   tooltip over unrelated UI. It is a `document.body` overlay, which is what
   lets it float over the composer without touching dsh's DOM. Fixed by
   hit-testing the composer rather than sniffing for a dialog selector — that
   covers modal, drawer, scrolled-out-of-view and collapsed panel for the
   same price. Found in a screenshot taken to check something else.

Each of 1–3 is the CLAUDE.md install-boundary pattern exactly: individually
reasonable steps whose *join* is broken. The lesson is not "test the fresh
state" — that was done — it is **test the fresh state as a sequence, and
reload between steps**, because state written by step N is what breaks
step N+1.

## Credentials

**No API key value ever reaches the page, in either mode.** This matters
more here than on most hosts: **dsh is a plugin host**, so the page context
is shared with third-party plugin code, and a key handed to the page is a
key handed to every plugin the user has installed.

Three parts:

- `/opencues/config` returns key **names** only, so a surface can report
  "cerebras, groq detected" without holding secrets. There is deliberately
  **no opt-in flag** to get values: any flag page code can set is a flag
  hostile page code can set. An earlier cut had a `?withKeys=1` escape
  hatch, which was exactly that mistake, and it is gone.
- The runtime is handed **placeholder** keys (`__OPENCUES_PROXY__`), which
  is enough for a provider to be selectable and for `buildRequest` to
  populate its auth header.
- `/opencues/llm/proxy` substitutes the real secret on the way out, for an
  **allowlisted https destination only** (the six provider hosts). Plain
  http is refused; unknown hosts are refused.

Stated plainly, because it is not absolute: a hostile plugin can still ask
the proxy to spend the user's quota — but it could equally just use the
harness model. What it can no longer do is **read the key and use it
elsewhere, forever, off this machine**. Exfiltration is the harm being
closed.

Verified by `probe-credentials.mjs`, which runs as a co-resident page
script would: four config-route variants return zero values, `window.__oc`
holds nothing secret-shaped, and the proxy answers 403 to both an
arbitrary destination and to plaintext http.

**Data blanks go through the same proxy.** `finnhub.io` is allowlisted with
`FINNHUB_API_KEY` substituted server side, so the stocks blank never holds
the key — the same placeholder-plus-substitute shape as the LLM path, which
is why the fix was an allowlist entry rather than a second mechanism.
Substitution covers both `key=` and `token=` query params, since providers
disagree on the name.

The keyless data hosts are allowlisted too (hacker-news.firebaseio.com,
api.open-meteo.com, geocoding-api.open-meteo.com,
nominatim.openstreetmap.org, api.dictionaryapi.dev, api.coingecko.com,
status.anthropic.com) for a different reason: no secret is involved, but a
page-context fetch to any of them is CORS-blocked, so they need the hop
regardless.

Reaching the blanks needed `BuiltinBlankContext.fetchFn`, added in
`@opencues/runtime` 0.31.0. Each blank already accepted a `fetchFn`; the
registry had no way to pass one. Two host-side wiring notes that cost time:
**`blanks` and `blankInvoke` are both required** — supplying `blanks`
alone registers them and never invokes them — and this whole path was dead
behind the `process.env.HOME` ReferenceError described under Host contract
findings, so fix that first or the allowlist appears not to work.

Verified: `nvidia _` → `NVDA: $225.16`, `weather in london _` →
`London: 22°C Overcast`, `serendipity dictionary _` → full definition,
`hackernews _` → current top story, with the config route still reporting
`{"values":0,"withheld":true}`.

## What is verified working

Real `@opencues/runtime` against real `~/.cues/` and real cerebras calls:
transform-blank, fluid-blank, sentence-cues, spelling word-cues, per-word
dim plus highlight, the runtime's own inline note text, `_`-to-cycle,
`Ctrl+Alt+→` navigation, `Ctrl+Alt+↑`/`↓` cycling and reverting, typing
after a substitution, identity-context (12 fields, safe mode), chips via
our own `@` trigger source, and cerebras prefix caching at 99.2 to 99.6%.
Also the four data blanks over the credential proxy (stocks, weather,
dictionary, hackernews) and the settings tab writing a scalar into the real
`OPENCUES.md` while refusing a newline-injected value. A headless
regression suite covered 18 contract assertions.

Separately verified on a **genuinely fresh machine state** (see § Force that
state): the shipped defaults (29 at the time; 30 with RULES.md) load with nothing on disk, 7 sources build,
`the capital of iceland is _` → `Reykjavik` and `i has three cats fix typos _`
→ `i have three cats` on the host's model with **no OpenCues key in the
environment at all**, a settings write creates `~/.cues/` from the shipped
default, and the same three blanks still resolve after a reload following
that write.

`Ctrl+Alt+↑` requires Navigation to have activated a word first
(`Ctrl+Alt+→`). Pressing it with nothing active correctly returns
not-consumed. That is not a bug.

Also verified end to end: **session-contradiction** (see the next section).
Typing `Let's use Node as the runtime for this project.` against a watchlist
holding `Runtime is Bun, not Node.` paints
`⚠ 2 | Runtime is Bun, not Node.`, three runs out of three, while the
agreeing sentence draws only the unrelated more-formal cue. The ask-cue half
(`sentence-cue:tool-ask`) fires on the same rail.

## Session contradiction: the first browser host that can do it

The feature needs a watchlist distilled from the session transcript, which
chrome could never have — a web page is not a session. dsh keeps one on disk
and **this integration has a node half**, so the producer/consumer split the
native hosts use works here unchanged:

| Half | Job |
|---|---|
| **node** | Kicks `opencues extract-commitments <session> --format dsh --cwd <workspace>` on a timer, and serves the result at `/opencues/session-commitments` |
| **browser** | Polls that route every 20s and mutates the holder the chrome band re-reads each resolve pass |

Four things cost time here, all of them generalising past dsh:

1. **This file is ESM, so `require` is a ReferenceError, not a missing
   module** — and it lands in the same `catch` written to handle a missing
   dependency. The producer never ran, the route answered
   `{"commitments":[]}` forever, and nothing logged, on a machine where
   everything was installed. Use the module-level `nodeRequire`
   (`createRequire(import.meta.url)`) for anything optional, and log when a
   feature really is inert.
2. **Do not name that binding `req`.** Every route handler in `index.js`
   takes the HTTP request as `req`, so a short name is shadowed inside
   exactly the handlers that need it, and "req is not a function" reaches
   the same catch — a second way to look uninstalled while installed.
3. **Key the watchlist on the SESSION's cwd, not `process.cwd()`.** A dsh
   server runs from wherever it was launched; each session records the
   workspace it belongs to. `locateNewestDshSession` returns `{path, cwd}`
   for this reason — the header's cwd is the only correct key, and using the
   server's directory serves an empty list while the right file sits on disk.
4. **The freshness window is real.** The node half only kicks for a session
   younger than ~10 minutes, so on a newly opened page the route answers
   `[]` for a kick or two and then fills. A test that types before that is
   testing a matcher with nothing to match against.

**The default LLM mode changes the sensitivity, not the wiring.** Through the
harness bridge, `deepseek-v4-flash` answers `[]` to a prompt that
cerebras/gemma-4-31b flags 3/3 — confirmed by sending the exact matcher
prompt through `/opencues/llm` and reading the raw reply. Both paths are
correctly wired; the host's model is simply more conservative here. Worth
knowing before concluding the feature is broken.

## Where this plugin is listed

Published as `@opencues/dsh` on npm (2026-08-17, v0.1.1). The ecosystem has
roughly a dozen directories, and they split into two kinds — which is the
only thing worth remembering here, because it decides whether a new release
needs any action at all.

**Auto-collected from the `dsh-plugin` GitHub topic.** Nothing to submit;
the topic on `opencues/opencues` is the entire mechanism, and it is also the
one dsh's own README endorses.

| Surface | Refresh |
|---|---|
| [DSH-Plugins-Marketplace](https://github.com/bradeGithub/DSH-Plugins-Marketplace) (in-GUI, one-click install) | CI every 2h |
| [AdamPlatin123/awesome-dsh-plugins](https://github.com/AdamPlatin123/awesome-dsh-plugins) | scan every 6h |
| [Zhiyuan-Fan/Awesome-DeepSeek-Harness-Plugins](https://github.com/Zhiyuan-Fan/Awesome-DeepSeek-Harness-Plugins) | curated daily |
| [bruc3van/awesome-dsh-plugin](https://github.com/bruc3van/awesome-dsh-plugin) | scraped daily, then hand-verified |
| dshmarketplace.dev, dshplugin.app, dshplugin.org | index the topic |

**Hand-curated, submitted by PR** (2026-08-17):

| List | PR | Notes |
|---|---|---|
| [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) (7.5k★) | [#1508](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/1508) | **The authoritative catalog.** One YAML at `data/plugins/opencues__opencues--integrations-dsh.yml`, then `npm ci && node scripts/generate-readme.mjs`. [dsh-market](https://github.com/dsh-market/dsh-market) reads its `plugins.json` daily, so this entry is what puts OpenCues in the in-dsh market — do not submit to dsh-market directly, it says so itself |
| [0xsline/awesome-deepseek-harness](https://github.com/0xsline/awesome-deepseek-harness) (687★) | [#374](https://github.com/0xsline/awesome-deepseek-harness/pull/374) | Hand-edited README; **both `README.md` and `README.zh-CN.md` must be updated together**. Category: `Input & Editing` |
| [Anil-matcha/awesome-dsh-plugin](https://github.com/Anil-matcha/awesome-dsh-plugin) (927★) | [#26](https://github.com/Anil-matcha/awesome-dsh-plugin/pull/26) | Single README, alphabetical within section, `—` separator. No input category; `UI Enhancements` is where composer plugins live |
| [Dominic789654/awesome-deepseek-harness](https://github.com/Dominic789654/awesome-deepseek-harness) (123★) | [#122](https://github.com/Dominic789654/awesome-deepseek-harness/pull/122) | Requires a **`dsh`** topic rather than `dsh-plugin`. Both READMEs, different separators per language (` — ` en, ` —— ` zh). Category: `UI / Clients` |

**The 20-topic cap is the thing to know here.** GitHub allows a repository
twenty topics and `opencues/opencues` sits at exactly twenty, so every dsh
topic was a swap, not an addition: `dsh-plugin` cost `gpt-oss`, and `dsh`
(needed only by the list above) cost `chatgpt`. Adding a third would mean
dropping something that earns its place, and `dsh-plugin` is the one that
matters — it is what dsh's own README endorses and what every auto-collector
scrapes. For scale: ~6,700 repos carry `dsh-plugin`, ~3,300 carry `dsh`.

### Why `client.js` is committed (the marketplaces do not use npm)

**The marketplaces install by CLONING this repo**, not from npm. Read from
`lib/index.js` of DSH-Plugins-Marketplace rather than inferred from its prose:
it runs `npm install --omit=dev --ignore-scripts`, with
**`allowScripts=false` as the safe default**, then copies the result into
`~/.dsh/profiles/web/node_modules/<pkg>`. Its own fallback message states the
expectation outright — *"using the build artifacts committed in the repo"*.

So a gitignored bundle would simply not exist on that path: `prepublishOnly`
never runs, `--ignore-scripts` guarantees nothing builds it, and the user gets
the node half with no browser half. The config route answers, and nothing ever
paints or fills — a broken install with no error anywhere. They have already
been bitten by this bug class by another plugin (their issue #54, where a
package's content lived only in the published tarball), which is why
`installNpmTargetToTemp` exists as a fallback at all.

**Hence `client.js` and `default-opencues.md` are committed**, which is the
opposite of what this repo does everywhere else — `integrations/chrome/dist/`
is not committed. That is not a change of principle: chrome is not distributed
by clone-scraping marketplaces, and dsh is.

Two things pay for it:

- **`minify: true`** in `build.mjs` — 1.71MB → 1.01MB, so the per-change cost
  in git history is halved, and every dsh page load gets the smaller bundle.
- **`scripts/check-dsh-bundle-fresh.sh`** — committed derived output goes
  stale silently, which is the worst failure mode in this codebase's history.
  esbuild is byte-reproducible for identical inputs (two consecutive builds
  hash identically), so the gate rebuilds and diffs: exact, not heuristic. It
  builds core + runtime first, because the bundle inlines their dist and a
  stale dist would otherwise let a genuinely stale bundle pass. Runs in
  `pre-pr.sh` and CI.

**If you change anything under `src/`, rebuild and commit the bundle with it.**

Verified by reproducing the marketplace path exactly — `git clone`, copy the
plugin directory into a profile, no npm tarball anywhere, no build step: 29
shipped defaults load, 7 sources build, and `the capital of iceland is _` fills
to `Reykjavik`.

Their scraper does handle monorepos: `findPluginRoots` walks to depth 3 and
requires each sub-package to declare `dsh` itself, which `integrations/dsh`
(depth 2) does. Note their CLI-hint detection reads the **repo root**
`package.json`, whose name is `opencues`, not `@opencues/dsh` — so the npm
path is found via the install command in the root README rather than the
manifest. One more reason not to depend on the npm path being taken.

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
- **The same missing frame stalls CSS transitions, which makes visible UI
  read as hidden.** The inline note carries `transition: opacity .12s`, and
  headless it sits at inline `opacity: 1` while `getComputedStyle` reports
  `0` with a `CSSTransition` stuck at `playState: "running"` indefinitely —
  20+ seconds later, with no further style mutations. Any is-it-visible
  assertion then fails on a note that is, product-wise, showing. This cost
  an hour of chasing a paint bug that did not exist. **Drive anything
  opacity-animated headed**, or assert on the inline style. Verified both
  ways against the same build: headed `1`, headless `0`.
- dsh's theme preference is injected server-side from
  `$DSH_HOME/settings.yaml` (`ui-theme.preference`), so Playwright's
  `colorScheme` emulation does **not** flip it. Edit the file and restart.
- The loading animator replaces `_` with a frame glyph, so "no trailing
  underscore" is TRUE mid-call and a test will race ahead and clear the
  buffer under an in-flight request. **Do not settle on a frame-glyph
  denylist** — that needs the frame set, and the DEFAULT animation is
  `BOUNCE_FRAMES = ['_', '-', '‾', '-']`, not the spinner `▖▘▝▗`. An earlier
  version of this note listed only the spinner set, and on a fresh user (no
  OPENCUES.md selecting an animation) that predicate read `-` as settled and
  reported `the capital of iceland is -` as the *result* of a fluid-blank —
  a fake product bug, twice. Settle on **"value unchanged across 3
  consecutive polls, and different from what was typed"**: it needs to know
  nothing about the animator, so it cannot go stale when the frames change.
