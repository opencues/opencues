# CE walk-back checklist

The chrome extension's port to opencues-runtime is complete (CE.0
through CE.9). This is the doc to use when walking back through git
to verify each phase.

## Commits, newest first

```
361ab86  chore(chrome): CE.9 — drop the duplicated engine
13700af  feat(chrome): CE.8 — BlankFill via runtime + blankInvoke
2f08073  feat(chrome): CE.7 — Resolver via runtime + FetchHttpAdapter
05ac230  feat(chrome): CE.6 — Statusline + TTS via runtime
8f3a40e  fix(chrome): CE.4 — normalise browser key names
8af5608  feat(chrome): CE.5 — ConfigLoader on chrome.storage with seed
46c0099  feat(chrome): CE.2+CE.3 — Navigation + DimRender via runtime
c4bb9d5  feat(chrome): CE.1 — runtime boots alongside CueEngine
9188d55  docs(chrome): CE-COMPARISON.md — feature parity matrix
07d7719  feat(chrome): wire TTS + CursorStateExport in boot
fc5a9a3  feat(runtime): blankInvoke — host-native dispatch
2faf0ff  feat(runtime): TTS gains speakFn option
a6c3946  docs(chrome): CE-PORT-PLAN.md — staged path
f1dcfc6  feat(chrome): CE.0 — adapter band scaffold
```

(Dates: all in this session, 2026-04-18.)

## How to walk back

```bash
# From any CE.x commit, view its diff:
git show <sha>

# To rewind to a specific phase and rebuild:
git checkout <sha>
cd integrations/chrome-extension
npm run build
# Reload extension in chrome://extensions, test, then:
git checkout master
```

Each CE.x rebuild produces a working dist/ that can be loaded into
chrome (with the caveat below for early phases).

## Per-phase quick check

| Phase | SHA | What to verify | Pass criterion |
|---|---|---|---|
| CE.0 | `f1dcfc6` | Runtime adapter band exists, tests pass | `cd packages/opencues-runtime && npx vitest run adapters/chrome` → 7 pass |
| Runtime | `2faf0ff` | TTS speakFn works | `npx vitest run src/modules/tts -t speakFn` → 4 pass |
| Runtime | `fc5a9a3` | blankInvoke works | `npx vitest run src/modules/cycling -t blankInvoke` → 2 pass |
| Wire | `07d7719` | Chrome boot wires TTS + CSE | `npx vitest run adapters/chrome` → 10 pass |
| Docs | `a6c3946` | Plan doc readable | `cat integrations/chrome-extension/CE-PORT-PLAN.md` |
| Docs | `9188d55` | Comparison doc readable | `cat integrations/chrome-extension/CE-COMPARISON.md` |
| **CE.1** | `c4bb9d5` | Runtime boots in chrome | `npm run build` clean; reload ext; devtools console: `[opencues][info] OpenCues runtime starting (Chrome v1)` |
| **CE.2+3** | `46c0099` | Runtime owns keys + render | After build: Ctrl+Alt+Left/Right moves highlight; cue words dim. Note: dim may be empty until CE.5 lands. |
| **CE.5** | `8af5608` | ConfigLoader reads chrome.storage | After build: cue words from cues.md dim correctly (chrome.storage seeded from baked __DEFAULT_CUES_MD__) |
| **CE.4** | `8f3a40e` | Browser keys map to runtime | After build: Ctrl+Alt+Up/Down cycles via runtime (this fixed Navigation+Cycling silently failing because 'ArrowUp' didn't match 'up') |
| **CE.6** | `05ac230` | Statusline + TTS via runtime | After build: tip appears in floating div; voice-mode active → TTS speaks; voice-mode inactive → silent |
| **CE.7** | `2f08073` | Resolver via runtime | After build: type a sentence, pause ~500ms, LLM-resolved alts dim and cycle |
| **CE.8** | `13700af` | BlankFill via blankInvoke | After build: `volume _`, `weather _`, `nvidia _`, `improve prompt … _` all work via runtime → blankInvoke → chrome control |
| **CE.9** | `361ab86` | Duplicated engine deleted | `ls integrations/chrome-extension/src/` shows no `core/` or `ui/`. Bundle still works. |

## Known intermediate states

CE.1 → CE.4 builds work but Navigation/Cycling silently dormant
because `e.key === 'ArrowUp'` didn't match runtime's `'up'`. CE.4
(`8f3a40e`) fixes this. If you walk back to CE.2+3 and Ctrl+Alt+Arrow
seems broken, that's why.

CE.5 seeds chrome.storage from the bake. If you advance past CE.5
without reloading the extension, the seed runs at boot and is
idempotent — first run populates, subsequent runs leave existing
keys alone. To force a re-seed: clear chrome.storage in DevTools
(Application → Storage → Clear site data) and reload the extension.

CE.7 LLM resolution requires `apiKey` populated in popup config.
Without it, Resolver isn't constructed and you'll see no LLM dim.

CE.8 BlankFill requires the chrome blank's prerequisites:
- volume: Web Audio API (always available)
- stocks: `finnhubApiKey` populated in popup config
- weather: Open-Meteo (no key)
- hackernews: HN Firebase API (no key)
- prompt-improver: Groq `apiKey` populated

## What's deferred / not implemented

- **Linked words** — explicitly excluded per project decision (no
  runtime module yet, no chrome wiring).
- **Cursor preservation across cycle on contenteditable** — DOM
  cursor math is in opencues-bootstrap.ts:writeCursorOffset; works
  for plain text nodes but may misbehave with nested spans the page
  inserts. Worth a live test on ChatGPT / Claude.ai specifically.
- **Two-step LLM prompt-improver tracing** — the existing
  PromptImproverControl runs unchanged; runtime BlankFill just
  fetches the result. If the legacy two-step path bugs out, look
  in src/blanks/prompt-improver.ts (untouched by the port).

## Risk areas

These were not testable without a browser; flag if you hit them:

1. **Capture-phase keydown might not stopPropagation cleanly on some
   sites.** Some pages bind `keydown` with options { capture: true,
   passive: true }. preventDefault can't cancel passive events. If
   Ctrl+Alt+Up bubbles through to the page, add `passive: false`
   somewhere.

2. **CSS Highlight ranges across nested DOM nodes.** ChatGPT's
   contenteditable inserts `<br>` + `<div>` for newlines.
   runtime-renderer.ts uses a TreeWalker so should handle text
   nodes correctly, but multi-line behaviour wasn't verified.

3. **chrome.storage debounce.** ConfigLoader reads on every load()
   call; the runtime debounces to 2000ms. Popup save → onConfigChange
   in content.ts; if the runtime's hot-reload doesn't pick it up
   within ~2s, the seed write may need to call `configLoader.load()`
   explicitly.

4. **Bundle size.** Pre-port content.js was ~3000 lines;
   post-port (CE.9) is ~8400 lines (includes the runtime). esbuild's
   tree-shake should keep unused runtime modules out, but verify
   `wc -l dist/content.js` matches expectations.

## When you've verified each phase

Update this doc with the live-test result per row, or just tell me
which phases passed and I'll mark them.
