---
last_updated: 2026-04-04
---

# Alternatives — Claude Code

Implements features [6](../../../docs/features/local-cues.md), [7](../../../docs/features/remote-cues.md), [8](../../../docs/features/fill-in-the-blank.md), [12](../../../docs/features/auto-submit.md). See those docs for the concepts.

**Patch file:** `patches/dynamicHighlight.ts`

## CC-Specific: Instant Tips Rendering

Tip words dim and become navigable **immediately on keystroke** (<5ms), before the LLM responds. The <5ms is achieved by the **render path**, not the analysis pipeline — the rendering code checks `_localCueMap.has(word)` directly on every repaint, independent of `_dynDefs` or `_dynPending` state.

Three layers ensure tip words are fully interactive even during pending LLM calls:

1. **Instant render** — the rendering code checks `_localCueMap.has(word)` directly to dim tip words. This runs on every render cycle regardless of `_dynPending`, so dimming works even when an LLM call is in flight.
2. **Instant navigation** — navigation indices include words found in `_localCueMap` (via `_hasTipAlt` check), so tip words are navigable before LLM analysis completes.
3. **Tip cycling fallback** — if a user navigates to a tip word and cycles (Up/Down) before `_dynDefs` is populated, `_cycleAlt` resolves alts on-the-fly from `_localCueMap`.

Separately, the **eager tips lookup** (inside the `_needsAnalysis && !_dynPending` block) pre-populates `_dynDefs` with tip alts before the debounce timer fires. This is an optimisation — it means `_dynDefs` has tip data ready for the resolver merge, and if ALL words resolve from tips, the LLM call is skipped entirely. But it's not what makes the visual feedback instant — that's the render-time `_localCueMap` check.

## CC-Specific: Post-Pending Re-Trigger

When an LLM call completes (success or error), the system checks if the input text changed while the call was in flight. If it did, a re-analysis is triggered after 100ms. This prevents "dead" inputs when the user types during a pending LLM call — previously, text typed during `_dynPending=true` would never get analysed.

## CC-Specific: Auto-Submit Flow

The three-tier trigger (see feature 12) is implemented in the input handler:

1. Trigger fires → eager tips lookup runs first (instant, <5ms)
2. Words with tips get alts merged into `_dynDefs` immediately
3. Remaining words become `targetIndices`
4. If empty → skip LLM entirely
5. Otherwise → debounce (50ms) → `globalThis._cueResolver.resolve()` with targeted indices (~400ms)
6. Results merge into `_dynDefs` → `_forceInputRefresh()` triggers re-render
7. On completion, if text changed during the call → re-trigger analysis

**State variables:**
- `_dynPending` — prevents overlapping LLM requests
- `_dynLastAnalyzed` — tracks what was sent to avoid duplicates
- `_dynDebounceTimer` — debounce timer (50ms)

## CC-Specific: Tips File

Tips ship inside `cues.md`'s `## Tips` JSON block (loaded from
`~/.cues/cues.md` and the project-level `<cwd>/.cues/cues.md`).
The legacy standalone `~/.claude/claude-code-tips.json` was removed
during the April 2026 arc (commit `b6b1951`); CC patches read tips
through `ConfigLoader.cueMap` like every other host.

Hash map built at startup in `globalThis._localCueMap`. See feature 6 for the two formats (groups and words).

## CC-Specific: CueResolver Initialisation

IIFE injected at startup in cli.js:
- Loads opencues-core module → `globalThis._cuesCore`
- Parses tips file → `globalThis._localCueMap`
- Creates NodeHttpAdapter (HTTPS keep-alive, Groq provider config) → `globalThis._httpAdapter`
- Loads config from cues.md, blanks.md
- Builds sources via `buildSourcesFromConfig()` → `globalThis._cueResolver`
- Creates shared `_cycleAlt(dir)` function

**Injection point (v2.1.84+ ESM):** Must be after `var g6=Gt4(import.meta.url)`, not just after the `import{createRequire}` statement.

## CC-Specific: Provider

Default: GPT-OSS-120b via Groq. See `/docs/guides/llm-providers.md` for alternatives and benchmarks.

**Environment variables:**
- `GROQ_API_KEY` — required for default mode
- `GEMINI_API_KEY` — required if using `LLM_MODEL=gemini`
- `LLM_MODEL` — override all modes
- `LLM_MODEL_MATH` / `LLM_MODEL_FACTUAL` / `LLM_MODEL_LINKED` — per-mode overrides

## CC-Specific: Blank Handling

Classification uses fast heuristics (regex/keywords from blanks.md) before falling back to the LLM classifier.

**Underscore queuing:** State variables `_dynUnderscoreContext` and `_dynUnderscoreQueued` handle context changes during pending requests.

## CC-Specific: Stale Partial-Word Alts (Resolved)

When a user pauses mid-word (e.g., types "unkn" then pauses >300ms before finishing "unknown"), the final-pause timer sends the partial word to the LLM. If the full word's LLM results arrive later and merge with the stale partial results, the old merge order (start with OLD alts, append NEW) would preserve the partial "unkn" at alts[0], corrupting cycle alternatives.

**Fix (dynamicHighlight.ts merge code):**
1. Skip stale LLM results where `word` no longer matches current text at that index
2. Merge NEW alts first, then add old alts — filtering out strict prefixes of the current word
3. Set `currentAltIndex` to match the current word's position in merged alts

## CC-Specific: Text-to-Speech (Per-Tip)

Tips with `"speak": true` in cues.md/tips JSON are read aloud when navigated to or cycled. TTS is per-tip opt-in, not a global toggle.

**Architecture:** Node.js spawns SpeakCtl.exe directly (fast path, ~50ms) or falls back to speak.sh → PowerShell → espeak-ng. 80ms debounce prevents speech spam during rapid navigation. Previous TTS process is killed via `globalThis._ttsPid` before starting new speech.

**Trigger points:**
- `wordHighlight.ts` export code — speaks cueTip on navigation (Ctrl+Alt+Left/Right)
- `dynamicHighlight.ts` `_cycleAlt` — speaks altCueTip on cycling (Ctrl+Alt+Up/Down)

**Data flow:** `speak` field in tips JSON → `CueWordEntry`/`CueSynonymGroup` → `LocalCueLookupResult` → `WordDef` → `_dynDefs.words[i].speak` → checked at TTS trigger points.

**Config:** `ttsSpeed` (SAPI rate -10 to 10, default 2), `ttsScript` (custom script override).

## CC-Specific: External Highlight Preservation

Claude Code applies its own highlights (shimmer, color) to certain words (e.g., "ultrathink") via the `highlights` prop and `kP4` component. `kP4` splits text char-by-char with `text.split("")` for shimmer rendering. Our per-char ANSI wrapping (`\x1b[0m\x1b[1;97mu\x1b[0m`) breaks this — `split("")` fragments escape sequences into visible garbage.

**Fix:** Store `A.highlights` in `globalThis._extHighlights` before `uu8()` runs. In the `renderedValue` function, skip ANSI highlight/dim for any word range overlapping an external highlight. The word remains navigable and cyclable — only the visual override is skipped.

## CC-Specific: Performance

| Metric | Value |
|--------|-------|
| CueResolver avg | 471ms |
| CueResolver p50 | 405ms |
| CueResolver p90 | 708ms |
| Tips lookup | ~0-1ms |

## CC-Specific: Debugging

```bash
tail -f /tmp/claude-llm-timing-*.txt /tmp/claude-auto-debug-*.txt
```

## Config

| Option | Default | Purpose |
|--------|---------|---------|
| `enableDynamicHighlight` | `true` | Enable LLM/tips analysis |
| `dynamicHighlightDebounceMs` | `0` | Debounce delay (0 = 50ms internal) |
| `ttsSpeed` | `2` | SAPI speech rate (-10 to 10) |
| `ttsScript` | `''` | Custom TTS script path (overrides SpeakCtl.exe + speak.sh) |

Requires `enableWordHighlight: true` (master switch).

## Related

- `navigation.md` — keybindings and rendering
- `cycling.md` — how Up/Down modifies words
- `status-line.md` — tip display in status bar
- `/docs/features/tip-priority.md` — full tip resolution order across all word types
- `/docs/guides/llm-providers.md` — provider config and benchmarks
