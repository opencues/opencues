---
last_updated: 2026-07-04
---

# Tip Priority

Every highlighted word can show a tip in the secondary display (status line). Tips come from multiple sources. When a word matches more than one source, a fixed priority order determines which tip wins. Implemented in `Statusline.snapshot()` (`packages/opencues-runtime/src/modules/statusline.ts`).

---

## Priority Table

Checked in this order — the first match wins:

| Priority | Word type | Tip shown |
|---|---|---|
| 1 | Selector (settings menu) | The setting's own `tip` from the `FEATURES`/`MENU_TUNABLES` registry definition |
| 1 | Satellite (settings menu) | The setting's per-value tip (`valueTips.get(currentValue)`) |
| 2 | Span-fill (any word inside an active consume-all or list-blank span) | The blank's `tip` (e.g. "Daily affirmations") |
| 3 | Blank-attributed value (e.g. `50%` after `volume`) | **None — suppressed on purpose.** The value is already visible in the buffer; a tip would be redundant ("system volume blank 50%"). |
| 4 | General word (including blank keywords like the word `volume` itself, and plain LLM/local cue words) | `configLoader.lookup(word).cueTip`, preferring `altCueTips[currentAlt]` when set |

**Important correction from earlier revisions of this doc**: a blank's *value* word never shows a live "current reading" tip via a `blankInvoke get` call — there is no such code path in the current statusline. A blank's *keyword* word (the trigger, e.g. "volume") gets whatever static/LLM tip its cue-lookup entry has, formatted with `cueBlank: true` (the consumer prints the tip alone, without a "(N/M)" alt-position suffix) — it does not invoke the blank's script live.

`tips-mode: off` suppresses the tip text at every priority level (word/alts data still gets exposed for the status line, just no tip string).

---

## How Priority Is Enforced

`Statusline.snapshot()` checks four branches in order, each an early return:

1. **Selector/satellite** — is the highlighted word index within the active `SelectorSatelliteState`'s selector or satellite range? If so, look up the tip from `configLoader.opencuesState.definitions.get(currentSetting)` (selector: `.tip`; satellite: `.valueTips.get(currentValue)`).
2. **Span-fill** — is the highlighted word index inside the active `SpanFillState`? If so, use the span's own `tip`.
3. **Blank-attributed DynDef** (`def?.blankName` set) — return with `cueTip: null` unconditionally. This is priority-3 in the table above.
4. **Everything else** — look up the word (using its *original* word, stable across cycling) via `configLoader.lookup()`; prefer `altCueTips[currentDisplayedWord]` over the primary `cueTip` if the lookup has per-alt tips. Whether this word is `cueBlank: true` (tip-alone display) is decided separately, by checking if the word is in `configLoader.blanksByWord` — independent of whether the lookup itself found a tip.

A word inside a multi-word blank/fluid/transform substitute span resolves to the ORIGINATING def (via `DynDefs.findSpanContaining`) before any of the above runs, so e.g. highlighting "email" inside an LLM-drafted email body doesn't surface an unrelated word-cue tip for "email" as a standalone word.

---

## The settings menu (registry-derived)

Settings, valid values, and tips are declared in `@opencues/core`'s `FEATURES` + `MENU_TUNABLES` registry (`packages/opencues-core/src/feature-registry.ts`), not in per-cue `CUE.md` files or a raw parsed `settings:` block held in module-level globals. `ConfigLoader` derives `opencuesState.definitions` (a `Map` from setting name to `{ tip, values, valueTips, ... }`) from the registry at boot and on every hot-reload; `Statusline` reads directly from that map. See [`docs/architecture/feature-registry.md`](../architecture/feature-registry.md) for the registry's full shape.

---

## Portability

### Standard (opencues-core)

- `CueResult.cueTip` carries the primary tip for any word
- `CueResult.altCueTips` maps each alternative to its own tip (for per-alt display during cycling)
- Cue-blanks use `tip` from the blank's config
- Selector/satellite tips are derived from `@opencues/core`'s `FEATURES` + `MENU_TUNABLES` registry, not from per-cue `CUE.md` files

### Integration responsibilities

- Implement the four-branch priority order: selector/satellite, then span-fill, then blank-value-suppression, then general word lookup
- Suppress the tip (not the whole status entry) for blank-attributed values — the value is already visible in the buffer
- For selector/satellite words, read tips from the registry-derived definitions and hot-reload them
- When no tip resolves for a word, suppress the secondary display entirely (don't show an empty tip)
