---
last_updated: 2026-05-14
---

# Blank Loading Animation

Visual feedback at a `_` slot while its source resolves (LLM call, HTTP fetch, sub-process). The slot's character animates through a short progression so the user can see "something is happening" — crucial for slow sources like `answer _`, `weather _`, `prompt _`.

The animator (`packages/opencues-runtime/src/modules/blank-loading.ts`) holds per-slot state and shares one `setInterval` across all active slots. The render handler in `boot-common.ts` emits per-frame `coloredRanges` into the existing `RenderDirectives` pipeline so colour rendering reuses the same path as dim / highlight / markdown styling.

## OPENCUES.md scalars

All five scalars live in `~/.cues/OPENCUES.md` frontmatter (user-level only — system settings aren't project-overridable). Hot-reload picks up edits within ~2s on the next keystroke.

| Scalar | Type | Default | Effect |
|---|---|---|---|
| `blank-loading-animation` | enum | `bounce` | Glyph progression: `bounce` / `braille-rotate` / `flipper` / `custom` / `off` |
| `blank-loading-frames` | csv | `·,•,●,•,·` | Custom-mode frames (up to 5). Each item is one frame glyph; only used when `blank-loading-animation: custom`. |
| `blank-loading-colors-rgb` | csv hex | `#ef4444,…,#3b82f6` | Per-frame palette for hosts with `render-rgb-color` capability (chrome + OC). Up to 5 `#rrggbb` values. |
| `blank-loading-colors-ansi` | csv names/indices | `red,…,blue` | Per-frame palette for terminal hosts (CC + gemini). Named (`red`, `bright_cyan`, `gray`) or 256-colour index (`0`-`255`). Up to 5 entries. |
| `blank-loading-interval-ms` | int | `150` | Per-frame duration. Clamped to `[30, 2000]`; invalid → 150. Selector preset values: `75` / `150` / `300`. |

## Capability-based RGB vs ANSI routing

The render handler picks ONE palette per host based on advertised capability:

```ts
const wantsRgb = adapter.capabilities.includes('render-rgb-color');
const ranges = blankLoading.getActiveColoredRanges(text, wantsRgb ? 'rgb' : 'ansi');
```

- **Chrome** (`render-rgb-color`): RGB → CSS Custom Highlight API (`runtime-renderer.ts`)
- **OpenCode** (`render-rgb-color`): RGB → OpenTUI extmark styles with `RGBA.fromHex(hex)` (`opencuesBootstrap.ts`)
- **CC** + **gemini** (no capability): ANSI → raw `\e[XXm` escape sequences via `applyDirectives` (`render-directives.ts`)

Both palette scalars can be set simultaneously — each host consults only the relevant one. To keep visuals consistent across hosts, populate both with corresponding values (e.g. `magenta` ↔ `#c000c0`).

## Hot-reload semantics — thunk re-read timing

Every animator option that depends on settings is **thunk-shaped** (`() => T`) so a hot OPENCUES.md edit takes effect without restarting the host. The re-read timing varies by option:

| Option | When re-read |
|---|---|
| `mode` | On each `start(wordIndex)` call (next slot activation) |
| `customFrames` | On each `start()` when `mode === 'custom'` |
| `rgbColors` / `ansiColors` | On every `getActiveColor` / `getActiveColoredRanges` call (each render tick) |
| `frameIntervalMs` | On each timer creation — i.e. when the FIRST slot becomes active. In-flight animations keep their captured interval until the timer is cleared and re-created. |

For `frameIntervalMs`, this means a hot edit from `150` to `300` while a blank is mid-load won't slow that animation — the next blank picks up the new speed. Acceptable trade-off: in-flight tweaks would require `clearInterval` + `setInterval` reschedule mid-animation, which adds complexity for a setting most users tune once and forget.

## Parsers — single source of truth

Each scalar has a dedicated exported parser in `blank-loading.ts`:

- `parseCustomFrames(raw)` → frame strings, capped at `CUSTOM_FRAMES_MAX` (5)
- `parseRgbColors(raw)` → `#rrggbb` / `#rgb` hex tokens, capped at 5
- `parseAnsiColors(raw)` → named tokens (with `gray`/`grey` → `bright_black` normalisation) or 256-indices `0-255`, capped at 5
- `parseFrameIntervalMs(raw)` → integer ms, clamped to `[FRAME_INTERVAL_MIN_MS, FRAME_INTERVAL_MAX_MS]`, default `FRAME_INTERVAL_DEFAULT_MS`

Centralising the parsers keeps three boot sites (CC's `boot.ts`, the shared `boot-common.ts`, and `BlankFill._loadingAnimator()`) on the same validation logic. When you tweak a parser, all hosts get the change automatically.

## When NOT to animate

The animator no-ops when:

- `mode === 'off'` — explicit disable
- `mode === 'custom'` AND `customFrames` is empty/invalid — silently falls back to `braille-rotate` (a misconfiguration should never produce a dead loading slot)
- The slot is already animating (idempotent `start()` — avoids double-claim races between BlankFill's dedup and a stale call)

`stop()` is similarly idempotent and best-effort: it restores `_` only if the slot's current char is one of our known frame characters (never overwrites real content the user typed over).

## Configuring via `opencues settings _`

The selector/satellite blank cycles through settings declared in OPENCUES.md's `settings:` block. The animation scalars are all declared there, so users can hot-flip without hand-editing:

```
opencues settings _
  → cycle to `blank-loading-animation`
  → up/down rotates: bounce ↔ braille-rotate ↔ flipper ↔ custom ↔ off
```

For settings that take free-text values (the colour scalars), the selector skips them — direct file edit is the path. For settings with declared `values:` (animation mode, interval-ms), the selector cycles among them.

## Surfaces touched

- `packages/opencues-runtime/src/modules/blank-loading.ts` — animator class + parsers
- `packages/opencues-runtime/src/boot-common.ts` — shared animator construction (OC + gemini + chrome go through this)
- `packages/opencues-runtime/adapters/cc/v2.1/boot.ts` — CC's animator construction (mirrors the shared one)
- `packages/opencues-runtime/src/modules/blank-fill.ts` — lazy animator for the BlankFill path (when no upstream animator is injected)
- `packages/opencues-runtime/src/render-directives.ts` — `applyDirectives` emits ANSI escapes around `coloredRanges.ansi`
- `integrations/chrome/src/runtime-renderer.ts` — registers a `Highlight` per unique hex
- `integrations/opencode/patches/opencuesBootstrap.ts` — lazy-registers `opencues-load-<rrggbb>` extmark styles
- `packages/opencues-runtime/adapters/gemini/v0.41/boot.ts` — `decorateLine` clips `coloredRanges` per visual line
- `defaults/OPENCUES.md` — shipped scalars + settings schema

## Adding a new preset value

To add e.g. a `1000` option to `blank-loading-interval-ms`:

1. Add the entry under `settings.blank-loading-interval-ms.values:` in both `defaults/OPENCUES.md` and `~/.cues/OPENCUES.md`.
2. No code change needed — `parseFrameIntervalMs` already accepts any integer in `[30, 2000]`.

To add a new mode (e.g. `pulse`):

1. Add the frame array constant + a `framesFor()` case in `blank-loading.ts`.
2. Add a literal-type branch in the `mode` thunk's switch (e.g. `if (raw === 'pulse') return raw;`).
3. Add the entry under `settings.blank-loading-animation.values:` in both OPENCUES.md files.
