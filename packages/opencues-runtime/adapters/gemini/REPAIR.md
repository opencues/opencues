# Gemini CLI adapter — repair guide

Gemini CLI integration. Pin: **gemini-cli v0.41.2** (sha in `integrations/gemini-cli/pin.json`), served by the `gemini/v0.41/` adapter band. First React/Ink host — most quirks below are React-render-model specific and don't apply to CC or OC.

The runtime side is host-agnostic; the only band-specific code lives at:

- `packages/opencues-runtime/adapters/gemini/v0.41/adapter.ts`
- `packages/opencues-runtime/adapters/gemini/v0.41/boot.ts`
- `integrations/gemini-cli/patches/opencuesBootstrap.ts`
- `integrations/gemini-cli/patches/setup.sh`

Companion docs: `integrations/gemini-cli/CLAUDE.md` (architecture + quirks).

## Host quirks (Gemini CLI v0.41) — known fixes baked into the adapter

Five bugs surfaced during the May 2026 reintegration. All five are baked into the current adapter sources. If you see any of the **symptoms** below after a Gemini version bump, check the corresponding fix is still in place.

### LF-1. UI looks frozen — swap doesn't refresh until the user types or moves cursor

**Files:** `adapters/gemini/v0.41/boot.ts` (`wrappedSetText`/`wrappedSetCursorOffset`/`wrappedPushText`/`wrappedForceRender`).

**Symptom:** ctrl+alt+up swaps a word in the runtime's hlState, but the rendered text doesn't update until the user moves the cursor or types another character.

**Why:** React only re-renders when component state changes. The runtime's `setText` queues `pendingText` and calls `headlessTrigger` (null in interactive). Without something kicking React to re-render, the InputPrompt's pull-model `useEffect` (which calls `consumePendingRender` to drain pending) never fires.

**Fix:** Every wrapped setter ends with `host.forceRender?.()`. The host-side `forceRender` is `() => _renderKick?.()`, where `_renderKick` is a `useState` bumper registered by `useOpenCuesRenderTick()` in InputPrompt. Headless mode no-ops the kick (already drained synchronously), interactive mode kicks React.

Pinned by `boot.test.ts` "host.forceRender fires when runtime calls setText (React kick contract)".

### LF-2. Highlight flashes on then off when navigating

**File:** `integrations/gemini-cli/patches/opencuesBootstrap.ts` — `consumePendingOpenCues`.

**Symptom:** ctrl+alt+left activates the highlight visibly for one frame then deactivates. Same for ctrl+alt+right with multiple presses.

**Why:** Navigation moving without a text change calls `forceRender` only. `consumePendingRender` returns ZWS-toggled current text (different string, same visible content) so React's `useEffect([buffer.text])` fires. The InputPrompt useEffect calls `buffer.setText(zwsText)` **directly**, bypassing the wrapped `setText` that calls `markRuntimeWrite`. The next `notifyOpenCuesTextChange` then fires with `source='user'` — Navigation interprets that as user typing and deactivates.

**Fix:** `consumePendingOpenCues` calls `sourceReclassifier.markRuntimeWrite(pending.text)` before returning the ZWS-toggled text. The next text-change notification then reclassifies as `'runtime'`, Navigation leaves the highlight alone.

### LF-3. Blue background ▀/▄ block band around the input

**File:** `packages/opencues-cli/src/commands/run.cjs` — `runGemini`.

**Symptom:** Patched Gemini renders the input with a blue background band that the unpatched binary doesn't.

**Why:** The fork at `~/.opencues/forks/gemini-cli` ships its own `.gemini/settings.json` enabling `general.devtools: true` + many experimental flags. Earlier versions of `runGemini` launched gemini with `cwd: <fork>`, so Gemini picked up cwd-locally and overrode the user's `~/.gemini/settings.json`.

**Fix:** `runGemini` now launches without forcing cwd into the fork (drops the `{ cwd: fork }` option from `spawnSync`). The user's home settings.json governs.

The blue rendering itself comes from `ui.useBackgroundColor: true` (Gemini's default; `HalfLinePaddedBox`). User keeps `~/.gemini/settings.json` with `useBackgroundColor: false`.

### LF-4. Per-segment color lost on dimmed/highlighted lines

**File:** `integrations/gemini-cli/patches/setup.sh` — `patch_input_prompt` (the `decorateLine` swap).

**Symptom:** When OpenCues has a directive (dim or highlight) intersecting a visual line, the per-segment syntax-highlighting colors (`theme.text.accent` for command/file/paste segments) are flat-colored.

**Why (intentional trade-off):** The patch accumulates each segment's `display` into `__ocAnsiLine`, runs it through `decorateLine` (`applyDirectives`, ANSI-aware), and replaces the per-segment `<Text>` array with one `<Text>{decorated}</Text>` only when the result differs from the input. This mirrors CC's `applyRender(rendered, text, cursor)` pattern. Per-segment colors aren't baked into `display` (only the cursor inverse char is), so they're lost on the swap.

**Don't "fix" by switching to per-segment Ink-prop application** (`dimColor`/`inverse`). The CC-style string-wrap is intentional and consistent across host bands. Dim/highlight beats colored unhighlighted text.

### LF-5. Status file read/write at the wrong path

**File:** `integrations/gemini-cli/patches/opencuesBootstrap.ts` — `statusFilePath`.

**Symptom:** Agentic harness scenarios with `source: 'status'` always see `value=undefined`.

**Why:** Earlier versions used `/tmp/opencues-gemini-status-<pid>.json`. The harness's `oc-state` reads `/tmp/opencues-status-<pid>.json` (the convention shared with CC + OC).

**Fix:** `statusFilePath: \`/tmp/opencues-status-${process.pid}.json\``. Aligns with CC + OC.

## Test pass after touching the adapter

```bash
bash integrations/gemini-cli/patches/setup.sh
opencues run gemini-cli
```

Manual checklist (mirrored in `integrations/gemini-cli/CLAUDE.md`):

| What | Type | Expect |
|---|---|---|
| `this has a mispelled word` then ctrl+alt+left | Cycling (LLM) | Highlight on `mispelled` (spelling cue), up/down rotates corrections |
| `volume _` | Cue-blank script | `_` auto-populates to e.g. `25%`; up/down on it adjusts system volume |
| `weather _` | Cue-blank HTTP | `_` auto-populates with current temp |
| `atomic number of oxygen _` | Fluid blank | LLM substitutes `8` |
| `fix typos _ this is bad righting` | Transform blank | Rewrites to `this is bad writing` |
| `opencues settings _` | Selector blank | Shows e.g. `voice-mode active`; up/down toggles |
| Any active cycle | Footer | Shows `attorney (2/5) - …` while cycling |

Also: `pnpm --filter @opencues/runtime test` — the contract pins
in `boot.test.ts` catch render-kick / pull-model regressions that
the agentic harness can't see (because headless bypasses the
React render path).

## Bumping the Gemini CLI pin

1. Update `integrations/gemini-cli/pin.json` (version + sha).
2. `rm -rf ~/.opencues/forks/gemini-cli` (full clean-clone since pin changed).
3. `bash integrations/gemini-cli/patches/setup.sh` — patches will run; if any anchor string from upstream has moved, the script logs `WARN: ... anchor not found` and skips that injection.
4. Verify all four anchors landed:
   ```bash
   grep -n "startOpenCues\|publishPromptAccess\|useOpenCuesTip\|useOpenCuesRenderTick" \
     ~/.opencues/forks/gemini-cli/packages/cli/src/ui/AppContainer.tsx \
     ~/.opencues/forks/gemini-cli/packages/cli/src/ui/components/InputPrompt.tsx \
     ~/.opencues/forks/gemini-cli/packages/cli/src/ui/components/Footer.tsx
   ```
5. If anchors moved, edit `patch_app_container` / `patch_input_prompt` / `patch_footer` in `setup.sh` to use the new anchor strings — they're plain `str.replace`, not regex.
6. Run the manual test pass above.

## Cross-major version bumps

If gemini-cli ships a major rewrite (different React component layout, different KeypressContext API, different TextBuffer surface), create a new band: `adapters/gemini/v<NEW>/`. Copy the v0.41 sources, retarget the imports + anchor strings, leave the old band intact. The runtime stays.
