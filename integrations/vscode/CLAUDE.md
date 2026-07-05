# CLAUDE.md — OpenCues VS Code integration

Dev notes for the VS Code extension. Design + full risk register:
[`PLAN.md`](PLAN.md). Host quirks with symptoms/fixes:
[`packages/opencues-runtime/adapters/vscode/REPAIR.md`](../../packages/opencues-runtime/adapters/vscode/REPAIR.md).

## How this integration works (no patching)

Self-owned host: `package.json` doubles as the VS Code extension
manifest; esbuild bundles `src/extension.ts` + the STAGED
`@opencues/{core,runtime}` dist into `dist/extension.js`. There is no
fork, no pin, no seam anchors. `opencues install vscode`:

1. seeds `~/.cues/` (shared `seed-configs`),
2. builds core + runtime, stages their `dist/` into
   `node_modules/@opencues/` (full-recursive `cp -r` — never a
   hard-coded subdir list, the PR #117 rule),
3. bundles the extension,
4. writes the drift marker (`node_modules/@opencues/version.json`),
5. symlinks this folder into every detected extensions dir
   (`~/.vscode/extensions`, `~/.vscode-server/extensions` for WSL/SSH
   remotes, insiders variants).

The symlink is the whole dev loop: rebuild (`opencues run vscode`
drift-heals, or `bash patches/setup.sh` directly) → `Developer: Reload
Window`. No reinstall.

**The extension MUST stay `extensionKind: ["workspace"]`** — it runs in
the remote extension host on WSL/SSH where `~/.cues/`, Node, and
`spawnProcess` live. A UI-kind classification silently breaks config
loading and every blank.

## Buffer-state reset call sites (grep `resetBufferState`)

Per `docs/architecture/universal-integration.md`, every site is listed
here. All live in `src/extension.ts`:

| Trigger | Where |
|---|---|
| Active editor switched to a DIFFERENT document | `publishTarget()` (same-document split-editor switches deliberately do NOT reset) |
| Focus left every eligible editor / doc closed | `publishTarget(undefined)` via `onDidChangeActiveTextEditor` + `onDidCloseTextDocument` |
| Undo / redo | text-change handler, `TextDocumentChangeEvent.reason` (authoritative, not heuristic) |
| External mutation (formatter, paste, Copilot accept, file reload) | text-change handler via `looksLikeExternalMutation` (multi-range edit, or single edit ≥ 24 chars) |
| Rejected `TextEditor.edit` | `applyTextEdit` failure path (no blind retry) |

## Things that look like bugs but aren't

- **Word-cues dead in a long document** — the D14 gate
  (`opencues.maxCueDocumentWords`, default 500). Over the gate the
  document gets the no-cycling profile: `_`-invoked features
  (FluidBlank / TransformBlank / compute blanks) still work; word-cues,
  selector/satellite, and cycleable blanks are pruned. Raise the
  setting or set 0 to disable.
- **Word-cues dead while a lone `_` exists anywhere in the file** —
  the buffer-global blank scope filter (verified token-based:
  `_emphasis_` / `snake_case` do NOT trigger it; a standalone `_`
  word does).
- **Ctrl+Alt+arrows do multi-cursor, not navigation** — keybindings are
  scoped to `opencues.cueActive`; with no navigable cue the keys fall
  through to VS Code defaults. That's by design (Q1).
- **Nothing paints in the SCM commit box / chat input** — not
  `TextEditor`s; no decoration API. Out of v1 scope (PLAN.md D9).
- **OpenCues inert with 2+ cursors** — deliberate suspension (Q15).

## Debug paths

- `Output → OpenCues` panel + `/tmp/opencues.log` (lines prefixed
  `[vscode]`).
- `debug-mode: on` in `~/.cues/OPENCUES.md` for runtime debug lines.
- `opencues doctor` — VS Code section checks staged runtime, bundle,
  and extensions-dir links.
- Status bar shows `$(warning) OpenCues failed` on activation errors
  (tooltip carries the message) — a dead boot is never silent (Q18).

## Manual test pass (run after any change here)

Open a markdown file in a patched window, then:

1. Type `the attorny filed a motion` → spelling cue dims `attorny`;
   Ctrl+Alt+←/→ navigates; Ctrl+Alt+↑ cycles; Escape dismisses.
2. `weather london _` → blank fills; status bar shows the tip.
3. `volume 40 _` (WSL/Linux) → script blank fires; Ctrl+Alt+↑ steps.
4. `fix typos _` after a typo'd sentence → TransformBlank rewrites;
   ONE Ctrl+Z restores the prior text (single undo entry).
5. Cycle a word, then undo → highlight cleared, no stale span
   (reset-on-undo).
6. Open a second markdown file, switch back and forth mid-cycle → no
   cross-document paint or stale cycling.
7. Split the same document into two editors → cycling works in both,
   no reset churn on switching between them.
8. Add a 3rd cursor (Alt+Click) → OpenCues suspends; back to one
   cursor → resumes.
9. Format-on-save (or a large paste) → no stale dims; cues re-resolve.
10. `COMMIT_EDITMSG` (git commit from a terminal with `core.editor`
    pointing at VS Code) → full profile works.

## Gotchas for contributors

- `package.json` is BOTH a workspace package and the extension
  manifest. VS Code forbids scoped extension names, so the package is
  `opencues-vscode` (publisher `opencues`) — the one integration not
  named `@opencues/<host>`.
- `@opencues/{core,runtime}` are staged by `patches/setup.sh`, not
  declared as workspace deps (shell's model — avoids pnpm↔npm
  resolution drift). A stale `packages/*/dist` silently ships old
  code; setup.sh always rebuilds first.
- Keep `src/pure.ts` free of `vscode` imports — it's the unit-testable
  half (vitest can't load the `vscode` module).
- Every write path must run through `applyTextEdit` (reclassifier mark
  + single-range edit + serialization). A naked `editor.edit` call
  reintroduces the echo-misclassification runaway loop (REPAIR.md #1).
