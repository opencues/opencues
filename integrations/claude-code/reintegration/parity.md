# v1 → v2 parity tracker

Audit of every step from `steps.md` against what we've actually shipped in
the v2 plug-and-play runtime. The goal is **clean parity** with v1, not
just architecture.

**Status keys:**
- `✓` — fully shipped, parity with v1
- `◐` — partial (basic case works, edge cases missing)
- `○` — not started
- `—` — explicitly skipped (REMOVED in v1, or design-intentionally omitted)

**Last synced:** Phase 5 (commit `d52bc32`).

---

## Step-by-step audit

| # | Title | v2 status | Where / notes |
|---|---|---|---|
| 0 | tweakcc setup | ✓ | `~/.tweakcc/cli.js.backup` exists; setup works. |
| 1 | `cursorStateExport` | ○ | v2 doesn't write `/tmp/claude-cursor-state.json`. No consumer in v2 uses it yet but the harness (`opencues-auto`) does. |
| 2 | `wordHighlight` (full nav + highlight) | ◐ | Phase 1 (Navigation) + Phase 2 (DimRender) ship the *core*. Missing: cue filtering (skipped, see Step 4); inverse highlight only (no configurable colour); no ZWS-stripping in display value (the InputZone keeps its ZWS noise). |
| 3 | bare-number dim | — | REMOVED in v1 itself (reverted Step 21). Not porting. |
| 4 | nav filter narrows to cue-control words | ○ | Navigation hits every whitespace token. Phase 1 explicitly punted. **Big UX gap** — typing "raise volume now" + Ctrl+Alt+Left should highlight only "volume", not "now". |
| 5 | load cues-core, tip-having words = cue-controls | ◐ | ConfigLoader loads `claude-code-tips.json` only. v1 also primes `_localCueMap` and uses tip-presence as a navigability signal. |
| 6 | parse cwd `controls.md` | ○ | Not loaded. |
| 7 | parse cwd `cues.md` | ○ | Not loaded. |
| 8 | folder-config discovery for `controls/` | ○ | No folder walk. Needs `readDir` primitive on HostAdapter or a manifest-walk workaround. |
| 9 | `_stepPatterns` + dim renderer extension | ○ | DimRender only paints highlight. v1 dimmed all step-pattern matches (numbers etc.). |
| 10 | `_cycleAlt` for script-backed cue-controls | ○ | Cycling only handles static-alt cycling. Script-backed controls (volume.sh up/down) not wired. |
| 11 | `_isCueControl` recognises `_stepPatterns` | ○ | Depends on Step 9. |
| 12 | step-control cycling (arithmetic in-place) | ○ | e.g. `0.5f` + Ctrl+Alt+Up → `1.0f`. Not implemented. |
| 13 | tip text in statusline | ✓ | Phase 4.6 (commit `65393f8`). cueTip + altCueTips populated from cue map. |
| 14 | TTS speak on tip highlight | ✓ | Phase 5 (commit `d52bc32`). spawn-process capability + `~/.claude/actions/speak.sh`. |
| 15 | parse `opencues.md` → `_openCuesCurrent` | ○ | No opencues.md state. Voice-mode opt-out not implemented. |
| 16 | gate tip / TTS on `tips-mode: off` | ○ | Depends on Step 15. |
| 17 | NodeHttpAdapter | ○ | No HTTP wiring. |
| 18 | CueResolver | ○ | No resolver. Cycling uses static alts only. |
| 19 | auto-submit debounce → `resolve()` → `_dynDefs` | ○ | No debounce trigger; no LLM-driven DynDefs population. |
| 20 | tip-word cycling end-to-end (JIT) | ◐ | Cycling works for static cues. JIT injection from LLM not wired. Stale invalidation also missing. |
| 21 | visual dim consistency + Step 3 revert | ○ | Depends on Step 9 + 4. |
| 22 | debug logging gated on `opencues.md` `debug-mode` | ◐ | DEBUG_OPENCUES env var works (file-based). No opencues.md gate. |
| 23 | blank-fill: detect `_` + match `blankKeywords` | ○ | No blank-fill at all. |
| 24 | blank-fill: auto-populate with `stepValues[0]` | ○ | |
| 25 | blank-fill: `blankScript get` async populate | ○ | |
| 26 | blank-fill: context words + env vars + `~` path | ○ | |
| 27 | blank-fill: `blankClearKeywords` strips on fill | ○ | |
| 28 | blank-fill: `blankKeywordExpansions` display | ○ | |
| 29 | blank-fill: `blankConsumeContext` widens range | ○ | |
| 30 | blank-fill: `blankConsumeAll` (prompt improver) | ○ | |
| 31 | consume-all cycling (prompt improver Ctrl+Alt+Up/Down) | ○ | |
| 32 | dim the consume-all range | ○ | |
| 33 | general span infrastructure + stepValues cycling + blankDismissible + statusline tip parity | ○ | The big one — `_dynSpans` data model + everything that depends on it. |
| 34 | factor `_hlExport.cueTip` writes (one projection, one apply) | — | v2's Statusline already centralises the projection — Step 34 was a v1-specific cleanup, not needed in v2. |
| 35 | selector/satellite (multi-sub-step) | ○ | opencues.md-state-driven cycling. Big. |
| 36 | resolver-driven blank-fill (rip inline IIFE) | ○ | Depends on Steps 18 + 23-30. |
| 37 | post-reintegration polish (extHighlights cleanup, anchor-count assertions, doc hygiene) | ◐ | Anchor-count assertion analogue: v2's `assertAllFound` (commit `3ea17ae`). v1's extHighlights cleanup is N/A in v2. |

**Tally:** 4 ✓, 5 ◐, 27 ○, 2 — out of 38 steps.

---

## Effort buckets

The not-started work clusters into bigger chunks. Some have hard dependencies
on others.

### A. Real ConfigLoader (foundation for almost everything)
Steps **6, 7, 8, 15** + hot-reload (currently load-once-at-boot).

What it unlocks: Steps 4, 9, 10–12, 16, 23–32, 35.

Effort: **~1 day**. cues-core already does the parsing; ConfigLoader needs
to call its `parseCuesMd` / `parseSingleCueMd` / `discoverFolderConfigs`
for the `cwd` files and merge results. Folder discovery may need a
`readDir` primitive on HostAdapter or a manifest read.

### B. Nav cue filtering
Step **4** (+ Step **11** if step-patterns are added at the same time).

What it unlocks: matches v1's "skip non-cue words" UX. Required for
control-word navigability.

Effort: **~half day**. Navigation currently runs `splitWords(text).map(w => w.index)`
unconditionally. Replace with: filter to words whose lowercased form is in
`configLoader.cueMap` OR matches a `_stepPatterns` regex (TBD when patterns
land). Preserve fall-back to all-words when no targets match (matches v1).

### C. Step-pattern dim + step controls
Steps **9, 10, 11, 12, 21**.

What it unlocks: `0.5f` cycling, number dimming, generic regex-pattern cues.

Effort: **~1-1.5 days**. Need `_stepPatterns` data model in DynDefs (or a
new state class), DimRender extension (return multiple `dimRanges`), Cycling
extension to do arithmetic on numeric matches and call control scripts for
non-numeric.

### D. LLM resolver path (the runtime side of cycling LLM alts)
Steps **17, 18, 19, 20**.

What it unlocks: cycling words that aren't in the static cue map; tip-word
JIT injection.

Effort: **~1 day**. cues-core already has `CueResolver`, `NodeHttpAdapter`,
`createResolver`. Wire them into a new `Resolver` runtime module that
debounces text changes and populates DynDefs from results. ConfigLoader (A)
should be done first so the resolver has merged sources to work with.

### E. Blank-fill (the entire feature)
Steps **23–32**.

What it unlocks: `_`-style blanks getting filled by scripts/LLM, prompt
improver, all the cue controls (volume/brightness/stocks/etc.).

Effort: **~3-4 days**. This is the biggest single chunk. 8 sub-steps in v1.
Has its own internal architecture (auto-populate vs consume-all vs
consume-context vs satellite), span tracking, dismissed-blanks state.

### F. Span infrastructure
Step **33**.

What it unlocks: every span-aware feature (stepValues cycling, dismissible
blanks, span-internal nav skip).

Effort: **~half day**. Mostly DynDefs/state changes plus Cycling/Navigation
filter integration.

### G. Selector/satellite
Step **35**.

Effort: **~1-1.5 days**. opencues.md state writeback + satellite blank
construction. Depends on A (ConfigLoader), E (blank-fill base), F (spans).

### H. Resolver-driven blank-fill (refactor)
Step **36**.

Effort: **~half day**. Refactor: move blank-fill from inline IIFE into
the Resolver module. Done after E + D.

### I. Polish
Steps **1, 22 (full), 37 (full)**.

Effort: **~half day total**. cursorStateExport (small), opencues.md
debug-mode gate, post-reintegration cleanup analogues.

---

## Suggested order

Dependency-respecting:

1. **A — ConfigLoader expansion** (~1 day). Unblocks everything else.
2. **B — Nav cue filtering** (~half day). Big UX win, small code.
3. **C — Step-pattern dim + step controls** (~1.5 days). Visible features.
4. **D — LLM resolver path** (~1 day). Restores LLM cycling.
5. **E — Blank-fill** (~3-4 days). Big chunk; tackle as 4-5 commits not one.
6. **F — Span infrastructure** (~half day). Slot before E if parallel work
   suggests it; otherwise after.
7. **G — Selector/satellite** (~1.5 days).
8. **H — Resolver-driven blank-fill refactor** (~half day).
9. **I — Polish** (~half day).

**Total estimate:** ~10-12 days of focused work to reach v1 parity.

---

## What's *better* in v2 than v1

Things v2 ships that v1 didn't (worth preserving as we add features):

- **Single `boot.js` entry point** — patch surface is minimal, runtime
  layout decoupled. (commit `4cbfbd8`)
- **REPAIR.md host-quirks documentation** — every non-obvious decision is
  captured for future contributors.
- **115-130 unit tests** — most modules are testable in isolation against
  MockAdapter. v1 had ~no unit tests.
- **Capability flags** — adapters declare what they support; runtime
  degrades gracefully.
- **S6 seam (event-driven statusline refresh)** — v1 also had this but
  via a hardcoded var; v2 has a clean predicate + fallback path.
- **Optional seams + fail-loud installer** — missing required seam = clean
  error message; missing optional seam = warning + degraded path.

---

## When to revisit this doc

- After every shipped phase: flip the relevant rows from `○` → `✓` or `◐`.
- When a new step or quirk is discovered, add a row at the bottom.
- Before declaring "v1 parity reached": every row should be `✓` or `—`.
