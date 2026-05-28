# ConfigLoader hot-reload race vs hoisted-blank writes

Selector/satellite cycling (e.g. `opencues settings` flipping `voice-mode: active ↔ inactive`) goes through this sequence:

1. `Cycling.cycleSelectorSatellite` → `applyOpenCuesScalar(key, value)` — updates `opencuesState` in-memory **synchronously**.
2. `blankInvoke({action: 'set', args: [setting, value]})` — kicks off the host's **async** file/storage write. Chrome: `chrome.storage.local.set`. OpenCode: `fs.writeFile`.
3. `setText(newText)` fires the host's text-change pipeline → `ConfigLoader.maybeReload`.

**Race**: step 3's reload can fire *before* step 2's async write lands. The reload reads the still-stale file, parses the old `opencuesState`, and overwrites the in-memory update from step 1.

## Fix pattern (already wired in `config-loader.ts`)

`applyOpenCuesScalar` arms `_suppressReloadUntil = Date.now() + 2500`. `maybeReload` short-circuits while inside that window. 2.5s is plenty for either host's async write to complete; after that the normal hot-reload debounce takes over.

If you add a new code path that mutates a scalar *and* writes via `blankInvoke` (or any async write), reuse `applyOpenCuesScalar` so the suppression fires automatically.

Tests pinning the contract live in `config-loader.test.ts` — `applyOpenCuesScalar suppresses the next maybeReload (write-race guard)` and the resume-after-window companion.
