---
last_updated: 2026-07-05
status: v1 built (band + scaffold + glue + wiring); Phase-0 spikes and the manual test pass still pending on a real VS Code window
---

# VS Code Integration Plan (`vscode` host)

Implementation plan for an OpenCues VS Code extension. This document
governs the work the way `integrations/claude-code/reintegration/refactor.md`
governed the CC refactor: decisions recorded here are settled unless a
phase surfaces evidence against them, in which case update this file in
the same PR.

Companion reading (in order): `docs/guides/adding-an-integration.md`
(the file checklist this plan instantiates),
`docs/guides/porting-to-new-integration.md` (resolver contract +
pitfalls), `docs/architecture/universal-integration.md` (the
no-cycling profile + `resetBufferState()` trigger list — it names
VS Code explicitly).

---

## Why VS Code is the easiest full-featured host yet

VS Code is the first host that combines the two best properties of the
existing five:

- **No patching** (like chrome). VS Code has a first-class, stable
  extension API. No fork, no `pin.json` treadmill, no seam anchors, no
  UPGRADING runbook. The entire built-artifact/source-patch machinery
  is skipped.
- **Full Node access** (like CC/OC/gemini/shell). The extension host is
  a Node process: `ConfigLoader` reads the filesystem directly,
  `NodeHttpAdapter` works, `spawnProcess` works, script blanks
  (volume/brightness/weather) work, `.cues/` hot-reload works. None of
  chrome's storage-bundle push machinery is needed.

It is also the first integration that could be installed **without
cloning the repo** (Marketplace `.vsix`) — deferred to post-launch, but
it shapes the scaffold (the extension must be self-contained once
built).

---

## Settled design decisions

| # | Decision | Choice | Grounding |
|---|---|---|---|
| D1 | Patch strategy | **Self-owned / inline-runtime** — we own the artifact; `@opencues/{core,runtime}` dist staged into the extension and bundled by esbuild | chrome + shell precedent (`adding-an-integration.md` § patch strategies) |
| D2 | Host class | **Native** — add to `NATIVE_HOSTS` (direct `child_process` + `fs`, no auxiliary helper) | `packages/opencues-core/src/host-compat.ts:41` definition |
| D3 | Multi-document model | **One runtime per VS Code window, re-targeted.** A single current-editor pointer; all adapter closures read through it; `resetBufferState()` on active-editor change (bail if same document) | chrome's `publishTarget()` (`integrations/chrome/src/opencues-bootstrap.ts:254`); shared state is single-current-buffer by design (`boot-common.ts:resetSharedBufferState`) — wiped on switch, never keyed per buffer |
| D4 | Per-document gating | `supportsCycling()` returns the language-allowlist verdict for the focused document. No new mechanism: the probe is already a live callback folded into the resolver's build key, so sources rebuild on editor switch automatically | `resolver.ts:computeBuildKey` includes `adapter.supportsCycling?.()`; `resetBufferState` nulls `_lastBuildKey` so a pure focus switch also rebuilds |
| D5 | Rendering | `TextEditorDecorationType` consuming the transport-neutral `RenderDirectives` ranges (dim/highlight/markdown/colored). Advertise `render-rgb-color`, consume the `rgb` field. Do NOT use `applyDirectives` (that is the terminal/ANSI path) | chrome proves the non-ANSI directive path; `src/render-directives.ts` is terminal-only |
| D6 | Secondary display | `statusSnapshotHook` → `StatusBarItem` (in-process; no `statusFilePath` temp-file polling) | shell wires the hook for exactly this in-process-UI case (`integrations/shell/src/bootstrap.ts:353`) |
| D7 | HTTP | Omit `httpAdapter` (lazy `NodeHttpAdapter` fallback). The shared `FetchHttpAdapter` is the drop-in for a future web-extension variant | `boot-common.ts` httpAdapter seam; `src/blanks/http-adapter.ts` |
| D8 | v1 surface scope | **Prose text editors only.** Language allowlist, default `markdown`, `plaintext`, `git-commit`, `restructuredtext`, `latex`; user-configurable via `contributes.configuration`. Everything else (code files) off by default | `_` is everywhere in code (`const _ = require(...)`) → blank misfires; whole-buffer sources on a 5k-line TS file is wrong on cost. Policy, not correctness: the runtime is buffer-size agnostic (no caps anywhere in the resolve path) |
| D9 | SCM commit input box | **Deferred to phase 2** as a no-cycling surface. It is a real document (languageId `scminput`, `onDidChangeTextDocument` fires) but NOT exposed as a `TextEditor` — no decorations, so no cycling surface. Maps exactly onto the existing `supportsCycling: false` profile (FluidBlank/TransformBlank/compute blanks still work via value get/set) | web research 2026-07-05; `universal-integration.md` no-cycling profile |
| D10 | Long documents | Wire the existing `agent-window-words` scalar as the token-cost bound for AgentRewrite on long docs. No new windowing mechanism in v1 | `agent-rewrite.ts:computeWindow` — opt-in sliding window, default off, already shipped |
| D11 | Key handling | Contributed commands + keybindings (VS Code exposes no raw key events). Handlers synthesize `KeyEvent`s into `dispatchKey`. `when` clauses scoped by context keys so OpenCues only shadows multi-cursor when a cue is navigable | Ctrl+Alt+Up/Down is add-cursor-above/below on Win/Linux — see Quirks Q1 |
| D12 | Write path | `setText` diffs old→new into minimal `TextEditor.edit` range edits (one undo entry; cursor + decorations survive). Never whole-buffer replace | chrome's one-history-entry lesson (`project_chrome_replaceall_undo`) |
| D13 | Source reclassification | **Mandatory**, not optional. VS Code echoes programmatic edits back through `onDidChangeTextDocument` (the Lexical/ProseMirror shape). Every write path wraps with `createSourceReclassifier` (250 ms TTL) or runtime writes fire as `'user'` and Navigation deactivates | `boot-common.ts:createSourceReclassifier` + the documented runaway-loop bug |
| D14 | Cue-analysis bound for large documents | **v1: word-cue/sentence-cue analysis gated by document size** (default ≤ ~500 words; configurable). `RoutedWordSourceGroup` dispatches EVERY word in the buffer and the shipped spelling catch-all claims `match: .*`, so a 2,000-word file would send ~2,000 words per completed-word pause — cost, latency, and the never-overload-the-LLM batching failure. Blanks / FluidBlank / TransformBlank stay available at any size (user-invoked via `_`); AgentRewrite bounded by `agent-window-words` (default ON for this band). Proper fix — a `cues-window-words` cursor window in the runtime resolver, mirroring `agent-window-words` — is a shared-module follow-up (benefits chrome long-field cases too), not a v1 blocker | `routed-word-source-group.ts:getCues` (verified: full word list, minus in-progress word, LRU keyed on exact word set — any completed word is a cache miss); `defaults/cues/spelling/CUE.md:10` |
| D15 | Remote/WSL execution | `extensionKind: ["workspace"]` in the manifest — the extension MUST run in the remote extension host (WSL/SSH/containers) where `~/.cues/`, Node, and `spawnProcess` live. A UI-kind classification silently breaks config + blanks | VS Code remote architecture; this machine's own setup is WSL |
| D16 | TTS | Wire via the `speakFn` seam (the chrome Web Speech path), not the spawn path — `tts.ts` hard-codes `command: 'bash'` + a staged `speak.sh`, which breaks on Windows VS Code hosts. Fallback order: `speakFn` → platform-checked script → skip | `tts.ts` spawn path; chrome `speakFn` precedent |

---

## Surfaces

| Surface | API access | v1? |
|---|---|---|
| Text editors on allowlisted languages (incl. `COMMIT_EDITMSG`) | Full: decorations, keybindings, range edits, selection API | **Yes — the flagship.** Full cycling profile |
| Notebook markdown cells | Cells are `TextDocument`s with real editors | Yes if the Phase-0 spike confirms; else fast-follow |
| SCM commit input box | Document events yes; **no decorations** (not a `TextEditor`) | Phase 2, no-cycling profile |
| Comment editors (e.g. GitHub PR extension reply boxes) | Real documents (`comment` scheme); decoration support unverified | Phase 2 spike |
| Copilot / chat input | No extension API | Never (no seam exists) |
| QuickInput / InputBox | Value get/set only | Skip |
| Integrated terminal | No buffer access | Skip — covered by `oc-shell` |

---

## Verified runtime mechanics (checked in code, 2026-07-05)

Three behaviours that differ in a whole-document host vs the
prompt-sized buffers every existing host has:

1. **Blank detection is token-based, not char-based.**
   `context.words.some(w => w === '_')` (`blank-source.ts:70`,
   `config-source.ts:118`, `routed-word-source-group.ts:171`) — a
   standalone whitespace-delimited `_`. Markdown's `_emphasis_` and
   code's `snake_case` do NOT flip the buffer into blank scope. (The
   porting guide's "ANY `_` character" phrasing overstates the
   implementation.)
2. **…but the scope filter is buffer-global.** One lone `_` token
   anywhere in the document disables ALL word-cues document-wide until
   it's consumed. Transient in a prompt buffer; potentially persistent
   in a document (a fill-in template, a leftover from a prior session).
   Document in README; a cursor-window resolve (D14 follow-up) fixes it
   structurally.
3. **Word-cue dispatch is whole-buffer.** See D14. This is the single
   biggest v1 scale risk and the reason for the document-size gate.

---

## Feature support by surface

What actually works where. "Full editor" = allowlisted-language
`TextEditor` under the D14 size gate; "large doc" = allowlisted but
over the gate; "SCM input" = the phase-2 no-cycling surface.

> Implementation note (v1, as built): the D14 gate is implemented via
> the existing `supportsCycling: false` profile — over-gate documents
> behave exactly like chrome's plain-`<input>` mode (every cycleable
> source pruned; `_`-invoked single-answer features survive). That
> reuses a tested profile instead of inventing a word-cue-only filter;
> the `cues-window-words` follow-up (Deferred #5) restores cycling on
> large docs properly.

| Feature | Full editor | Large doc | SCM input (P2) | Notes |
|---|---|---|---|---|
| Word-cues (LLM alternatives, spelling) | ✅ | ❌ gated (D14) | ❌ pruned (no cycling) | |
| Static tips / tip groups | ✅ status bar + hover | ✅ | ✅ status bar | display-only, no cycling needed |
| Sentence-cues (`scope: sentence`) | ✅ | ❌ gated (D14 — per-sentence calls scale with doc) | ❌ pruned | passive DynDefs; multiple coexist |
| Keyword/shape blanks — compute/get (weather, stocks, dictionary, time) | ✅ | ✅ | ✅ | single-answer results pass the no-cycling filter |
| Keyword/shape blanks — list / script-cycling (countries, volume, brightness) | ✅ | ❌ pruned | ❌ pruned | need Ctrl+Alt+arrows + paint |
| Selector/satellite (`opencues settings _`) | ✅ | ❌ pruned | ❌ pruned | cycling-dependent |
| FluidBlank (free-form `_`) | ✅ | ✅ | ✅ | WIPE guard already protects multi-paragraph buffers |
| TransformBlank (`fix typos _`, `translate _`) | ✅ | ✅ (whole-buffer call — user-invoked, cost is consented) | ✅ | three-way merge protects concurrent edits |
| ConfigIntent / fluid-config | ✅ | ❌ pruned | ❌ pruned (emits selector-satellite) | |
| AgentRewrite / auditors | ✅ | ✅ with `agent-window-words` ON (D14) | ⚠️ probe off in v1 — revisit | `supportsAgentRewrite` probe |
| Markdown styling render | ✅ **all six range types** — first non-terminal host to do so (chrome manages 3/6) | ✅ | ❌ no decorations | bold/italic/strike/code via decorations; heading/list soft-styled; un-expressible ranges DROP (never garbled syntax) |
| Identity-context | ✅ | ✅ | ✅ | provider-side, host-agnostic |
| Blank-context / ai-callable blanks | ✅ | ✅ | ✅ | native host |
| Ambient-context | ❌ v1 (chrome-only gatherer) | ❌ | ❌ | future: filename/languageId/nearest heading as the field metadata |
| Voice-mode TTS | ✅ via `speakFn` (D16) | ✅ | ✅ | spawn path Windows-broken |
| Secondary display | ✅ StatusBarItem (+ hover tips) | ✅ | ✅ | |
| Dim / navigation / highlight | ✅ decorations | ✅ (nav works even when cues gated — blanks still register) | ❌ | |

Off-allowlist languages (code files): everything off. The allowlist is
the consent gate, same role the `_` keystroke plays for blank routing.

---

## Phase 0 — Spikes (~0.5 day)

Three cheap experiments before committing to the scaffold. Each
produces a yes/no recorded back into this file.

- **S1 — decorations on non-file editors.** Confirm
  `setDecorations` + contributed keybindings work on (a) a
  `COMMIT_EDITMSG` editor, (b) a notebook markdown cell editor.
  Expected: both work (they are ordinary `TextEditor`s).
- **S2 — context-key scoping.** `setContext('opencues.cueActive', …)`
  gating `ctrl+alt+up/down/left/right` and Escape. Confirm the
  keybindings shadow multi-cursor ONLY while a cue is navigable, and
  restore default behaviour otherwise. Pick final `when` clauses.
- **S3 — external-mutation detection.** Validate
  `TextDocumentChangeEvent.reason` for Undo/Redo (native — better than
  chrome's `beforeinput` sniffing) and a large-multi-char-insertion
  heuristic for paste. IME: check `onDidChangeTextDocument` behaviour
  during composition. Output: the concrete `resetBufferState()` trigger
  list for Phase 3.

---

## Phase 1 — Scaffold: `integrations/vscode/` (~0.5 day)

- **`package.json`** — dual-purpose: `@opencues/vscode` workspace
  package AND the VS Code extension manifest:
  - `engines.vscode` (pick current stable minus ~6 months for reach),
    **`extensionKind: ["workspace"]`** (D15 — must run in the remote
    extension host on WSL/SSH),
    `activationEvents: ["onLanguage:markdown", "onLanguage:git-commit", …]`
    (derived from the default allowlist),
  - `contributes.commands` (nav/cycle/escape/toggle),
    `contributes.keybindings` (with S2's `when` clauses),
    `contributes.configuration` (`opencues.languages` allowlist,
    `opencues.enabled`),
  - `@opencues/{core,runtime}` deliberately NOT npm deps — staged by
    setup.sh into `node_modules/@opencues/` (shell's model,
    `integrations/shell/package.json:30`, avoids pnpm↔npm
    workspace-resolution drift).
- **`bin/install.cjs`** — install = build core/runtime → stage dist →
  esbuild the extension → `writeMarker('vscode', <PKG_DIR>/node_modules/@opencues, ctx)`.
  Uninstall removes staged output + built extension. `--dry-run`,
  `--target`, `--help` per convention.
- **`patches/setup.sh`** — full-recursive `cp -r dist/` for both
  packages. **Never a hard-coded subdir list** (the PR #117
  `providers/` regression class).
- **`esbuild.config.mjs`** — one entry, `src/extension.ts` →
  `dist/extension.js`, format CJS, `external: ['vscode']` only.
  Unlike chrome: Node builtins bundle/resolve normally (real Node at
  runtime), no `node-http-adapter` stub, no `__DEFAULT_*__` config
  bakes (filesystem access means `seed-configs` + `~/.cues/` is the
  config path, same as every native host).
- **`compat.json`** — `{ "compatibility": { "vscode": ">=<engine>" } }`.
- **`CLAUDE.md`** (dev notes, quirks, manual test pass, documented
  `resetBufferState` call sites) + **`README.md`** (standard section
  order incl. "Where things live (blast radius)").

## Phase 2 — Adapter band: `packages/opencues-runtime/adapters/vscode/v1/` (~1 day)

Shell's band is the size model (~440 lines / 2 files); chrome's is the
behaviour model for dynamic probes.

- **`adapter.ts`** — `VscodeV1Adapter implements HostAdapter` over a
  `VscodeBindings` struct. Capabilities: `file-read`, `file-write`,
  `spawn-process`, `blank-invoke`, `force-render`, `dim-ranges`,
  `highlight-range`, `selection`, `render-rgb-color`,
  `change-source`. All buffer closures route through the bindings'
  current-editor accessor. `supportsCycling()` delegates to the
  bindings (language-allowlist verdict). `getSelection()` from
  `editor.selection` (real — unlike shell's hardcoded `null`).
- **`boot.ts`** — `boot(host: HostInfo): BootResult`. Wires
  `buildSharedRuntime` (config search paths:
  `$OPENCUES_HOME` → `<workspace root>/.cues` → `~/.cues`; never
  `process.cwd()` — Q13). **`await configLoader.load()` before wiring
  Resolver/BlankFill** (Q12). Then conditionally: Statusline
  (`statusSnapshotHook`, driven on every state change — Q19), Resolver
  (constructed with the shared `MarkdownRender` instance — Q17),
  AgentRewrite (`supportsAgentRewrite` probe; `agent-window-words`
  default ON per D14), TTS via `speakFn` (D16). Installs
  `createSourceReclassifier` and exposes it to the glue's write paths.
  The band's `resetBufferState` includes `MarkdownRender.resetState()`
  (Q17). Cue-source building honours the D14 document-size gate via
  the `supportsCycling`-style live-probe pattern.
  Returns the standard `BootResult` (`dispatchKey`,
  `notifyTextChange`, `notifyCursorChange`, `collectRenderDirectives`,
  `resetBufferState`, `dispose`).
- **`boot.test.ts`** — pins:
  1. runtime writes re-tagged `source: 'runtime'` by the reclassifier;
  2. `resetBufferState()` clears DynDefs / highlight / span-fill /
     selector-satellite AND resolver state on target switch;
  3. `supportsCycling` participates in the build key (source rebuild on
     verdict flip);
  4. directive batches map to the expected decoration range sets;
  5. Escape routed through the runtime's Navigation handler.
- **`REPAIR.md`** — opens with the standard "runtime is never in this
  loop" disclaimer; seeded from the Quirks table below.

## Phase 3 — Extension glue: `integrations/vscode/src/extension.ts` (~1–1.5 days)

The largest new file; chrome's `opencues-bootstrap.ts` is the model.
Split into `extension.ts` (activation/wiring) + `target.ts`
(current-editor tracking) + `render.ts` (decorations) if it grows past
~500 lines.

- **Activation**: on allowlisted-language editor. First-run: probe
  `~/.cues/`, offer to run seed-configs (`opencues seed-configs`
  equivalent in-process — it's all `fs`); read LLM keys from
  `~/.cues/.env` (existing `set-key` path) + process env.
- **Target tracking** (`publishTarget` equivalent):
  `onDidChangeActiveTextEditor` → if different *document*, re-point +
  `resetBufferState()`. Bail when same document (split editors showing
  one document share text; active editor's cursor wins — the chrome
  spurious-focusin lesson). Additional reset triggers from S3: doc
  close, `TextDocumentChangeReason.Undo/Redo`, paste heuristic, IME
  composition commit, workspace `.cues/` unavailable→available flips.
- **Events in**: `onDidChangeTextDocument` filtered to the current
  document → synthesize the runtime's `TextChangeEvent` (full text +
  reclassified source); `onDidChangeTextEditorSelection` →
  `notifyCursorChange` (offset via `document.offsetAt`).
- **Keys**: five contributed commands (nav left/right, cycle up/down,
  escape) dispatching synthesized `KeyEvent`s into `dispatchKey`.
  Maintain `opencues.cueActive` via `setContext` from the runtime's
  highlight/nav state so the keybindings only exist while meaningful.
- **Writes out**: `setText` → text diff → minimal `TextEditor.edit`
  range edits, ALL segments atomically in one `edit()` callback (one
  undo entry; multi-segment splices are where cursors snap and
  reconcilers partially revert — chrome key-learnings #5–#7), with
  selections explicitly preserved/rebuilt. `pushText` applies
  immediately + triggers a repaint (Q10). Both wrapped by the
  reclassifier (D13). Edit failure → Q9 handling.
- **Eligibility gates**: language allowlist AND scheme/writability
  (Q16) AND single selection (Q15 — multi-cursor suspends dispatch)
  AND external-mutation detector armed (Q14).
- **Render**: `collectRenderDirectives` consumed per change/cycle AND
  after every async fill (Q10); ranges coalesced per decoration type
  (Q11), then wholesale repaint per batch so VS Code's automatic
  decoration range-tracking never fights the runtime (Q2).
  Decoration types: dim (opacity ~0.55), highlight
  (background/border, `ThemeColor`-aware), markdown ranges
  (bold/italic/code/strike/heading/list via font-style decorations),
  colored ranges (blank-loading animator, `rgb` field).
- **Blanks**: `createBlankInvoke(new Map([...]))` with the same
  runtime-class registry as shell + `spawnProcess` fallback for script
  blanks. Full native blank surface (volume/brightness/weather/…).
- **Status bar**: `StatusBarItem` fed by `statusSnapshotHook`
  (word `(idx/n)` + cue tip + task badge, shell's format). Cheap win:
  the same tip as a hover provider on the highlighted range.
- **Teardown**: `deactivate()` → `dispose()`; every subscription in
  `context.subscriptions`.

## Phase 4 — Shared-code wiring (~0.5 day, mechanical)

Master registration first, then the per-command arrays that haven't
migrated to the core source of truth yet:

- `packages/opencues-core/src/host-compat.ts` — `HOSTS` (+`'vscode'`,
  alphabetical), `NATIVE_HOSTS`, `HOST_ALIASES` (`code`, `vs-code`).
- `packages/opencues-cli/src/lib/version-markers.cjs` — one
  `candidates` row: `{ host: 'vscode', root: <repo>/integrations/vscode/node_modules/@opencues }`.
  No `BUNDLED_SOURCE_DIRS` change (same two packages → existing
  srcHash covers drift; self-heal via `opencues run`'s
  `ensureFreshBundle` then works generically).
- CLI per-command arrays: `install.cjs` (fallback HOSTS map; no
  dispatch code needed — generic `runHostInstaller` finds
  `integrations/vscode/bin/install.cjs`), `run.cjs` (fallback map +
  `runVscode()` — see Open Questions), `uninstall.cjs`, `update.cjs`
  (aliases, `ALL_HOSTS`, `markerDirFor` case, install-detector),
  `doctor.cjs` (staged-runtime existence + marker drift + extension
  bundle check), `version.cjs` (self-owned: `readUpstreamVersion`
  returns null, marker dir shown directly), `which.cjs`,
  `completion.cjs`, `help.cjs`. `set-key.cjs`: nothing (provider-keyed,
  host-agnostic).
- JSON schemas: `on-host` enums in `spec/schemas/{cue,blank,auditor}.schema.json`
  (the gemini-reintegration bite — don't skip).
- Docs/spec sweep per `adding-an-integration.md`'s tables: root
  `README.md` + `CLAUDE.md` integration lists and host tables,
  `docs/architecture/repo-structure.md`, `docs/glossary.md`,
  `docs/features/host-compat.md`, `spec/core.md` known-host names,
  templates (`cue.md`/`blank.md` host-compat docstrings), issue
  templates, runtime host-list comments.
- Versioning: `@opencues/vscode` starts at 0.1.0; `@opencues/runtime`
  bumps (new band) + root `CHANGELOG.md`, per
  `docs/architecture/versioning.md`. **No `SPEC_VERSION` bump** — a
  new host is not a wire-format change (host names in spec docs get a
  parenthetical mention only).

## Phase 5 — Testing + gates (~0.5 day)

- Band unit pins per Phase 2; extend
  `reset-buffer-state.scenarios.test.ts` patterns where a vscode-shaped
  trigger isn't covered.
- Manual test-pass checklist in `integrations/vscode/CLAUDE.md`
  (cycle → cycle → type → cycle journeys; two documents open; split
  editors on one document; undo mid-cycle; paste over a span; commit
  message editor; blank `weather london _`; script blank `volume 40 _`).
- `bash scripts/pre-pr.sh` — all gates. Notably test hermeticity (any
  test touching `~/.cues` mkdtemps) and version-bump.
- **Stretch, not a v1 blocker**: headless agentic-harness lane via
  `@vscode/test-electron` + `OPENCUES_BRIDGE=1`. The shared
  `"host": "any"` scenarios cover state invariants; host-specific
  render bugs are pinned structurally in `boot.test.ts` (headless
  bypasses the render path anyway).

## Phase 6 — Deferred increments (explicitly out of v1)

1. SCM commit input box as a no-cycling surface (D9).
2. Comment-editor surfaces (GitHub PR reply boxes) — needs the
   decoration spike.
3. Marketplace `.vsix` publishing — blocked on repo going public;
   requires the extension to seed bundled defaults on first run
   (chrome's bake-time fallback pattern) for users without the repo.
4. vscode.dev / web extension host — no Node; reuses the chrome
   browser-safe work (`lint-runtime-browser-safe.sh` guarantees) +
   `FetchHttpAdapter`; `spawnProcess`/script blanks drop out,
   capability flags degrade gracefully.
5. **`cues-window-words`** — a cursor-window bound on word-cue /
   sentence-cue analysis in the runtime resolver, mirroring
   `agent-window-words` (shared-module change; lifts the D14 size gate
   and fixes the buffer-global `_` scope filter as a side effect).
   Benefits any future large-buffer host, so land it as prep work per
   the `adding-an-integration.md` shared-gaps convention.
6. Windowed virtual buffer for code files (hand the runtime the
   cursor's paragraph, translate offsets in the adapter) — strains the
   whole-buffer three-way-merge assumptions in
   `docs/architecture/blank-sources.md`; needs its own design pass.
7. Ghost-text (inline completion) / inlay-hint rendering experiments
   for cue tips.

---

## Quirks register (REPAIR.md seeds)

| # | Quirk | Mitigation |
|---|---|---|
| Q1 | `ctrl+alt+up/down` = add-cursor-above/below on Win/Linux | Context-key-scoped `when` clauses (`opencues.cueActive`); document rebinding in README |
| Q2 | VS Code auto-shifts decoration ranges on edits — can drift from runtime-owned ranges | Wholesale repaint per directive batch; never rely on VS Code's range tracking between batches |
| Q3 | Programmatic edits echo through `onDidChangeTextDocument` as if user-typed | `createSourceReclassifier` around every write (D13); pinned in `boot.test.ts` |
| Q4 | Paste has no dedicated event | S3 heuristic (multi-char insert not matching a pending runtime write) → `resetBufferState()` |
| Q5 | IME composition fires intermediate document changes | S3 decides: suppress dispatch during composition, reset on commit |
| Q6 | Split editors: two `TextEditor`s, one `TextDocument` | Target keyed by document; active editor supplies cursor; no reset on same-document editor switch |
| Q7 | Extension host restart / window reload wipes the runtime silently | Acceptable — clean boot; state is per-session by design. Note in CLAUDE.md |
| Q8 | Multiple windows = independent extension hosts | Independent runtimes by construction; shared `~/.cues` hot-reload keeps configs consistent |
| Q9 | `TextEditor.edit` can fail (editor closed mid-await) OR silently lose to a concurrent edit — no reliable "did the write take" signal | Check return value; on failure, log + `resetBufferState()` — never retry blind (no-logical-landmines rule). Don't build fallbacks on post-edit buffer-length checks (chrome key-learning: length-comparison fallback chains double-fire) |
| Q10 | Async fills (blank scripts, resolver post-processing) have no upcoming key dispatch to drain pending state — the value "sits there" until the user types (CC #5, OC LF-8, gemini LF-1) | `pushText` applies immediately + explicit decoration repaint after EVERY async write. There is no React/host render to piggyback on — drive the repaint yourself. Pin in `boot.test.ts` |
| Q11 | Overlapping dim ranges (cue word nested inside a span dim) paint patchy (CC #7) | Sort + merge overlapping/adjacent ranges per decoration type BEFORE `setDecorations` — wholesale repaint (Q2) needs coalesced input, not just a repaint |
| Q12 | Resolver/BlankFill wired before async config load resolves → zero sources registered, LLM never fires, no error (OC LF-6) | `await configLoader.load()` before wiring resolver + blank-fill in `boot.ts`. Pure ordering discipline |
| Q13 | Config loaded from `process.cwd()` — extension host cwd is arbitrary (OC LF-4) | Search paths explicitly `$OPENCUES_HOME` → workspace root `.cues/` → `~/.cues/`; never `process.cwd()` |
| Q14 | Other extensions / formatters mutate the buffer (format-on-save, Copilot accept, snippet insert, file-reload on branch switch) — `onDidChangeTextDocument` doesn't say who edited | Heuristic external-mutation detector: multi-range edits, or large edits not adjacent to the cursor, that aren't a pending runtime write → treat as external → `resetBufferState()`. S3 spike validates |
| Q15 | Multi-cursor: N selections typing simultaneously; runtime assumes one cursor | `selections.length > 1` → deactivate highlight + suppress dispatch + block cycle commands (context key goes false) until back to a single selection |
| Q16 | Readonly / diff / virtual documents (scheme ≠ `file`/`untitled`) accept decorations but reject edits | Gate target eligibility by scheme + writability alongside the language allowlist |
| Q17 | Stale `MarkdownRender` cache re-injects style markers into the next document's first LLM call | `MarkdownRender.resetState()` is part of every `resetBufferState()`; construct ONE shared `MarkdownRender(adapter)` and pass it to the `Resolver` constructor so rich-text re-injection survives chained transforms |
| Q18 | Silent activation/boot failure — extension errors land in the Extension Host output channel nobody reads (the chrome BlankIntent-inert-for-hours class) | Status bar item has an explicit error state; boot logs a `[vscode]`-prefixed line to `/tmp/opencues.log`; doctor checks marker drift + bundle presence. Anything that can degrade on one host gets a boot diagnostic |
| Q19 | Status surface refreshes only on host events, not on typing/cycling (CC #4) | `statusSnapshotHook` pushes on every runtime state change; the StatusBarItem is driven, never polled |

---

## Upgrade path (stated per CLAUDE.md rule)

For a repo-clone user: (1) `opencues install vscode` (builds + stages +
bundles + writes marker), (2) install/reload the extension in VS Code
(`code --install-extension` on the built `.vsix`, or the dev-path
instructions the installer prints), (3) `export GROQ_API_KEY` (or
`opencues set-key`) if not already set. Two steps beyond the universal
key setup; source-drift self-heal covers rebuilds via `opencues run
vscode`'s `ensureFreshBundle`, but the **extension reload** after a
rebuild remains a manual step (chrome-mirror-push-shaped) — doctor
should surface a stale-extension warning (marker vs installed-extension
version), tracked as part of Phase 4's doctor section.

---

## Effort estimate

~4 days fresh / ~2.5–3 with the guides internalized: spikes 0.5,
scaffold 0.5, band 1, glue 1–1.5, wiring 0.5, testing 0.5. Risk
concentrates in Phase 3's event-model quirks (paste/IME/undo), which is
why they are front-loaded as Phase-0 spikes.

## Open questions (decide before Phase 1)

1. **`opencues run vscode` semantics.** Recommended: run the drift
   check/rebuild (`ensureFreshBundle`) and print load/reload
   instructions, mirroring chrome's reload story — rather than
   launching `code` itself.
2. **Default-on vs opt-in.** Recommended: enabled by default on the
   prose allowlist (matches every other host), with
   `opencues.languages` + `opencues.enabled` in settings for
   tightening.
3. **Notebook markdown cells in v1** — pending spike S1; include if
   free, defer if quirky.
