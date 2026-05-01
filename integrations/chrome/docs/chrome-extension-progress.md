---
last_updated: 2026-04-22
---

# Chrome Extension — Testing Progress

Tracking what has been manually verified in the Chrome extension integration.

> **Current testing scope:** Chrome + OpenCode are the primary verification
> targets through the post-refactor test arc. Claude Code and Codex will be
> tested after both of these are fully green on every phase.

## Verified Working

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 1 | Build | ✅ | `npm run build` produces dist/ with content.js, background.js, popup |
| 2 | Load extension | ✅ | Load unpacked from dist/ folder, no errors |
| 3 | Popup config | ✅ | API key saves and persists across popup close/reopen |
| 4 | Target element | ✅ | Finds contenteditable elements |
| 5 | Visual cues (dimming) | ✅ | Words with alts dim gray after analysis |
| 6 | Navigation | ✅ | Ctrl+Alt+Left/Right moves highlight between navigable words |
| 7 | Cycling | ✅ | Ctrl+Alt+Up/Down cycles alternatives, multi-word spans grouped |
| 8 | Escape | ✅ | Clears highlight |
| 9 | Clear on typing | ✅ | Highlight clears when user types |
| 10 | Status bar | ✅ | Shows tip and alt index in bottom-right corner |
| 11 | TTS | ✅ | Speaks tip on navigation when enabled in popup |
| 12 | Instant tips | ✅ | Tips words dim immediately on input (synchronous lookup, no LLM wait) |
| 13 | Multi-word spans | ✅ | "deep thinking", "think harder" highlight as single unit during cycling |

## Not Yet Tested

| # | Feature | Notes |
|---|---------|-------|
| 14 | Blanks | ✅ | `2 + 2 = _` fills with `4` |
| 15 | Weather blank | ✅ | `london weather _` fills with temp + condition, keyword cleared, rAF render fix |
| 16 | Stocks blank | ✅ | `reddit stock _` fills with price, multi-word ticker map, closest-match proximity |
| 17 | Hackernews blank | ✅ | `hackernews _` fills first headline, cycle through 20, expansion (`hn`→`HackerNews`), span cleanup on cycle |
| 18 | Prompt improver | ✅ | `improve prompt write a poem _` → 3 improved versions, consume-all cycling, span-safe |
| 19 | Volume blank | ✅ | `volume _` fills with %, tab audio via Web Audio GainNode |
| 20 | Selector/satellite | ✅ | `opencues settings _` fills paired selector+satellite, multi-word spans, blankClearOnEdit collapses both on edit |
| 21 | Hot-reload | ✅ | Popup save → chrome.storage.onChanged → re-bootstrap. TTS checkbox syncs with voice-mode. Cycling persists back to storage. |
| 22 | Input swapping | N/A | Contenteditable only — textarea/input not supported (CSS Highlight API limitation). Dead swap code removed. |
| 23 | CORS fallback | ✅ | Finnhub, Open-Meteo via host_permissions; HN uses Firebase API (CORS-friendly) |

## Bugs Fixed During Testing

| Bug | Fix |
|-----|-----|
| Tips not loading — `DEFAULT_TIPS_JSON` never wired into config | Added `__DEFAULT_TIPS_JSON__` build-time define from tips.json, used in `DEFAULT_CONFIG` |
| Stored empty `tipsJson` overriding non-empty default | `loadConfig()` skips empty stored values when default is non-empty |
| Tips not instant — buried in async `analyze()` behind debounce | Added synchronous `lookupTipsSync()` called directly on input event |
| Re-analysis of already-rendered words | Tier 2 idle timer skipped when tier 1/3 already fired; tips skip words with existing defs |
| Multi-word spans not rendering as one unit | Renderer now accepts `engine.spans`, highlights full active span, dims non-origin span words |
| Manifest paths mismatched flat copy | Desktop copy uses `dist/` subfolder matching manifest `dist/` paths |
| Weather: "london" colored white after fill | `execCommand` DOM changes need rAF before CSS Highlight ranges stick; deferred render to `requestAnimationFrame` |
| Weather: location extraction returned wrong city | Scan from end of context (matching bash script), not start |
| Stocks: "Unknown: reddit" | Added multi-word entries (`"reddit stock"→RDDT`) to ticker map matching `tickers.json` |
| Stocks: same price for different tickers | Closest-match keyword proximity — pick nearest keyword to blank, not first in list |
| HN: CORS fetch error | Switched from hnrss.org RSS to official HN Firebase API (CORS-friendly) |
| HN: 20 headlines dumped into editor | Multi-line values treated as list alts — display first, cycle rest |
| HN: span breaks on space | `lookupTipsSync` now skips non-origin span positions |
| HN: stale span entries on cycle | Clean up old span entries beyond new span length when cycling to shorter headline |
| Prompt: span breaks on typing | Consume-all cleanup now word-level (only clears when span words change, not trailing spaces/appended words) — matches Claude Code |
| Prompt: not cycling | Consume-all WordDef had `blankName` → navigator routed to blank-invoke path (no-op). Added `consumeAll: true` metadata flag to bypass |
| Prompt: LLM/tips overwriting span words | Re-added `blankName` to consume-all WordDef for LLM protection; `consumeAll` flag routes cycling correctly |
| Consume-all: stale def clearing deleted span entry | Skip stale def clearing for consume-all fills (entire text replaced, no context word to clear) |
| Volume: not navigable | Blanks with `blankName` and `!blankReadOnly` now navigable |
| Volume: number not updating in text | Navigator blankInvoke path now replaces word in DOM with returned value |
| Volume: LLM giving word alts for "volume" | Cue-blank keywords skipped in tips + LLM analysis; minimal WordDef created for renderer dimming |
| Selector/satellite: not auto-populating | Implemented satellite branch in checkBlanks, paired WordDefs, span setup |
| Selector/satellite: not cycling | selectorWord/satelliteWord skip blank-dispatch path, fall through to cycleSelector/cycleSatellite |
| Selector/satellite: spans not updating on cycle | cycleSelector now clears old spans, shifts span keys, rebuilds for new word counts |
| Selector/satellite: blankClearOnEdit not firing | Added `invalidateWordsSync()` for immediate per-word invalidation (not 50ms timer) |
| Selector/satellite: executeClearOnEdit returning "" treated as falsy | Changed `if (cleaned)` to `if (cleaned !== null)` |
| Hot-reload: TTS checkbox disconnected from voice-mode | Popup syncs with voice-mode in opencues.md; cycling persists back to chrome.storage |

---

## Post-refactor verification (April 2026)

After the major April 2026 simplification + bug-fix arc (sync chrome
redesign, popup cleanup, storage cache removal, multi-word span fixes,
Resolver filter hardening, deterministic relocate, etc.), Chrome was
re-verified end-to-end via a phased test plan.

### 6-phase fresh-install verification plan

| # | Phase | What it verifies | Status |
|---|---|---|---|
| 0 | Clean slate | Remove the extension + Windows-side install dir | n/a (prep) |
| 1 | Fresh install | `pnpm exec opencues install chrome --wsl`, load unpacked, runtime boots | ✅ Verified — `[opencues][info] OpenCues runtime starting (Chrome v1)` shows in DevTools |
| 2 | Bake-time defaults + multi-source routing | No sync run; type a sentence with legal/medical/financial/grammar words, verify 4 parallel LLM calls and per-source alts | ✅ **Verified 2026-04-22** — see "Phase 2 verification" below |
| 3 | First sync (user-level only) | Add a tip to `~/.opencues/cues.md`, run `opencues sync chrome --wsl`, verify it overlays bake-time | ✅ **Verified 2026-04-22** — see "Phase 3 verification" below |
| 4 | Negative test: cwd doesn't leak | `cd ~/anywhere`, `sync chrome --dry-run`, verify only `source: user` (project-level not auto-included) | ✅ **Verified 2026-04-22** — see "Phase 4 verification" below |
| 5 | Explicit opt-in via `--include` | `sync chrome --include ~/some-project/.opencues --wsl`, verify project content lands in bundle | ✅ **Verified 2026-04-22** — see "Phase 5 verification" below |
| 6 | Watch-mode propagation | `sync chrome --wsl --watch`, edit a file, verify chrome picks up the change within ~2.5s | ✅ **Verified 2026-04-22** — see "Phase 6 verification" below |

### Phase 2 verification (2026-04-22)

Test sentence:
```
the attorney filed a liability clause after the diagnosis caused the portfolio to decline quickly
```

**4 parallel LLM calls observed in DevTools:**

| Source | Prompt input | Response |
|---|---|---|
| **legal** | `0=liability 1=clause` | `0:obligation,responsibility,exposure \| 1:provision,stipulation,term` ✅ |
| **medical** | `0=diagnosis` | `0:assessment,evaluation,clinical-diagnosis` ✅ |
| **financial** | `0=portfolio` | `0:holdings,assets,investment-mix` ✅ |
| **grammar** (default) | `0=the 1=attorney 2=filed 3=a 4=after 5=the 6=caused 7=the 8=to 9=decline 10=quickly` | indices 1, 2, 6, 9, 10 returned (function words 0/3/4/5/7/8 correctly skipped) ✅ |

**Confirms working end-to-end:**

- `RoutedWordSourceGroup` per-source dispatch — exactly one LLM call per source group, in parallel
- Bake-time defaults loaded from `defaults/cues/*` (no sync needed)
- Auto-append `INDEX:alt` format spec — every response in correct shape
- Function-word skipping in grammar prompt
- DimRender + Navigation working with multi-word static-alt spans
- No alt-track drift after cycling (Resolver skip-cycled-alts filter active)
- Deterministic relocate handles prefix/middle edits without dropping cycle progress

### Phase 3 verification (2026-04-22)

Default-source isolation + bundle precedence over bake-time.

**CLI side:**
- `pnpm exec opencues sync chrome --dry-run` → exactly one source listed:
  `source: user /home/wilfred/.opencues`. No `project`, no `include` —
  cwd-leak structurally absent.
- `pnpm exec opencues sync chrome --wsl` → 16 files synced, mirrored to
  `C:\Users\wilfred\AppData\Local\opencues-chrome\dist\configs` (Windows
  path display, not `/mnt/c/...`).
- `.version` file present + matches CLI output hash.
- `index.json` valid + lists every bundled file.

**Browser side (after extension reload):**
- `[opencues] bundled configs loaded: N files from dist/configs/` —
  was 0 before sync, > 0 after.
- All shipped configs flip from `← bake-time` to `← bundle`:
  - `cues.md`, `blanks.md`
  - `cues/{financial,grammar,legal,medical}/cue.md`
  - All 9 blanks
- `opencues.md` correctly stays `← storage` (writable file — voice-mode /
  debug-mode persist there).
- `cues/sync-demo/cue.md ← bundle (494 chars)` — this folder doesn't exist
  in `defaults/`; it lives only in `~/.opencues/cues/sync-demo/`. Its
  presence in chrome proves user content overlays bake-time successfully.
- `ConfigLoader: loaded 138 cue entries` — same count as bake-time
  baseline; no entries lost in translation.

**Confirms working:**
- Default sync source = user-level only (no cwd / project leak)
- Sync writes both repo dist AND mirrors to Windows install path
- Chrome extension reads bundle (when present) in preference to bake-time
- User-only content (`sync-demo/`) actually reaches the runtime
- Display paths under `--wsl` show as `C:\…` (not `/mnt/c/…`)
- Hot-version `.version` polling will pick up future syncs

### Phase 4 verification (2026-04-22)

Negative test — explicit-opt-in property holds.

**Test 1** — `sync chrome --dry-run` from inside `/home/wilfred/opencues`
(a directory that contains its own `.opencues/`):
- Output: exactly one source line — `source: user /home/wilfred/.opencues`
- NO `source: project ...` line
- 16 files, all from `~/.opencues/...`

**Test 2** — same command from `/tmp` (no `.opencues/` in cwd):
- Identical output, identical 16 files, same `source: user` line.

**Confirms working:**
- `sync chrome` default source set is user-level only — independent of cwd
- No silent project leak from running inside a `.opencues/`-bearing dir
- Watcher started from any cwd will bind to the same stable source set
  (matches the documented model in CLAUDE.md § "`opencues sync chrome`
  source discovery")

### Phase 5 verification (2026-04-22)

Explicit opt-in via `--include` — project content overlays user.

Test project: `~/testing/.opencues/` (contains `cues.md`, `blanks.md`,
`blanks.md`). Distinguishing marker: `cues.md` frontmatter
`name: project-cues` (vs user-level `name: claude-code-cues`).

**Dry-run first** — `sync chrome --include ~/testing/.opencues --dry-run`:
- Source list now shows TWO entries:
  `source: user /home/wilfred/.opencues` + `source: include /home/wilfred/testing/.opencues`
- The 3 files where names collide (`cues.md`, `blanks.md`)
  flip to come from the include path; non-conflicting files still come
  from user.

**Real sync** — `sync chrome --include ~/testing/.opencues --wsl`:
- 16 files synced (same count — include overlays, doesn't add)
- New version hash `0b4a8a3b6d79795c`
- Both repo `dist/configs/cues.md` AND Windows-mirror
  `C:\Users\wilfred\AppData\Local\opencues-chrome\dist\configs\cues.md`
  show `name: project-cues` — confirms the swap landed everywhere.

**Confirms working:**
- `--include` opt-in actually mixes the named path into the source set
- Precedence: include > user (project-style override semantics)
- Mirror writes the swapped content to Windows side, not just repo dist
- `.version` hash changes, so chrome's `.version` poller will pick the
  new bundle up within ~2.5s without page refresh

### Phase 6 verification (2026-04-22)

End-to-end watch-mode propagation — file edit → re-sync → bundle update
→ chrome reload, all without manual intervention.

**Setup**: `pnpm exec opencues sync chrome --wsl --watch` running.

**Edit**: appended `[PHASE6]` marker to the `spantest` tip in
`~/.opencues/cues.md`.

**Within ~2 seconds:**
- `.version` flipped: `1ac5a116781d2757` → `0c47706bff306800`
- Marker present in repo `dist/configs/cues.md` AND Windows mirror
- Browser-side: `spantest` tip popup rendered with `[PHASE6]` text —
  no extension reload, no page refresh required

**Reverted** the edit; watcher re-synced again; `.version` returned to
the original `1ac5a116781d2757` (content-addressable round-trip).

**Confirms working:**
- Watcher fires re-sync within ~1s of file change
- Mirror to Windows path happens on every re-sync
- `.version` is content-addressable — reverting an edit returns to the
  same hash, so the polling client knows to re-load the original state
- `ConfigLoader` swaps the active config without restart
- The full feedback loop (edit a file in WSL, see it live in Chrome on
  Windows) is the daily-iteration workflow described in CLAUDE.md
  § "Chrome Extension — Dev Workflow"

### Cross-host runtime fixes verified

These runtime-level fixes from the April 2026 arc apply to all hosts but
have been confirmed in **Chrome AND OpenCode**:

| Fix | Chrome | OpenCode |
|---|---|---|
| Multi-word static-alt spans (DynDefs source of truth) | ✅ | ✅ |
| Span preservation across edits outside the span | ✅ | ✅ |
| Skip already-resolved + cycled words in Resolver | ✅ | ✅ |
| No dim-flash on keystroke | ✅ | ✅ |
| Two concurrent multi-word spans coexist | ✅ | ✅ |
| Multi-word splice at live char positions (no drift) | ✅ | ✅ |
| Shift downstream DynDefs on cycle (no flicker) | ✅ | ✅ |
| Deterministic relocate on prefix/middle edits | ✅ | ✅ |
| Resolver skips cycled alts (no track drift) | ✅ | ✅ |

Claude Code and Codex inherit the same runtime fixes via
`buildSharedRuntime` and will be re-verified after Chrome + OpenCode
phases 3-6 are complete.
