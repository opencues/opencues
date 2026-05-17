---
last_updated: 2026-05-17
---

# Blank Trigger Mode

Controls *when* a `_` actually fires its blank — the moment you
type it (`immediate`, the v0.1 default) vs only after a confirming
space follows (`spaced`).

The motivation is markdown italic. Without this setting, typing
`_italic_` to format prose in markdown surfaces (Reddit comments,
GitHub issues, anywhere `_` means emphasis) fires the blank on the
first `_` before the user can type the closing one. `spaced` mode
defers the trigger until a space, so the first `_` is just a
character — letting `_italic_` complete unmolested.

---

## Values

| `blank-trigger-mode` | Behaviour |
|---|---|
| `immediate` (default) | `_` triggers the blank the instant it lands at end-of-buffer. Snappy; preserves v0.1 behaviour. |
| `spaced` | `_` only triggers when a confirming space follows (i.e. buffer ends with `_<whitespace>`). Lets markdown `_italic_` complete without substitution; costs one keystroke (the space) when you actually want a blank. |

`immediate` is the default to avoid surprising existing users.
Markdown-heavy users (anyone using OpenCues in Reddit, GitHub,
Discord, or any contenteditable that interprets `_`) should opt
into `spaced`.

---

## How It Works

Two trigger sites both gated by the scalar:

1. **`Resolver.onTextChange` debounce-bypass** — the path that
   resolves immediately when `_` lands at end-of-buffer (skipping
   the 500ms debounce). In `spaced` mode the bypass condition
   tightens from "buffer ends with `_`" to "buffer ends with
   `_<whitespace>`".

2. **`Resolver.onTextChange` scheduled fall-through** — the
   regular 500ms debounce. In `spaced` mode, when the buffer
   ends with a bare unconfirmed `_`, the schedule is also
   skipped. So pausing after typing `_` doesn't get caught by
   the debounce window.

3. **`BlankFill.onUnderscoreKey` keyboard intercept** — fires
   synchronously on `_` press for stepValues-style blanks
   (`volume`, `brightness`). In `spaced` mode this returns false
   so the host's default insert happens normally; the resolver
   path picks up the trigger once the space arrives.

The semantics: bare `_` is inert; `_<space>` confirms intent
and fires.

---

## Configuration

In `~/.cues/OPENCUES.md` frontmatter:

```yaml
blank-trigger-mode: spaced   # or 'immediate' (default)
```

The setting is also cycleable via the selector-satellite menu —
type `opencues settings _` (or `config _`), navigate to
`blank-trigger-mode`, and cycle. The menu's tip and value
descriptions come from `@opencues/core`'s `FEATURES` registry.

Hot-reload picks up the change within ~2s — no host restart
needed.

---

## When NOT To Use Spaced

- Editors where `_` is rarely punctuation but often a blank
  trigger (terminals, plain text fields, IDE prompts).
- Any workflow where the extra space keystroke is annoying.
- The default `immediate` mode is fine for these.

---

## Edge Cases

- **Sentinel before whitespace** — `weather _ ` (trailing space)
  fires. `weather _\n` (trailing newline) also fires; any
  whitespace counts.
- **Mid-buffer `_`** — `hello _ world` doesn't fire either mode
  (the existing word-boundary check refuses any `_` that isn't
  at end-of-buffer).
- **`_italic_`** — the markdown case. The first `_` doesn't fire
  in `spaced` mode (no following space yet). The second `_` makes
  the buffer end with `_` (not `_<space>`), so still no fire.
  Buffer is preserved as `_italic_` — markdown intact.
- **`_italic_ ` (with trailing space)** — would technically
  qualify in `spaced` mode (`_` followed by space at end of
  buffer). The word-boundary check in `findUnderscoreAtChar`
  refuses anyway because `_italic_` isn't a lone `_` word. Safe.

---

## Implementation

- Scalar parsed by `ConfigLoader._parseOpencuesMd` into
  `OpenCuesState.blankTriggerMode: 'immediate' | 'spaced'`
- Trigger gates in `resolver.ts` (debounce bypass + scheduled
  fall-through) and `blank-fill.ts` (`onUnderscoreKey` early-return)
- Registered in `@opencues/core/src/feature-registry.ts` as a
  cyclable feature with two `ValueSpec` entries

## Tests

- `packages/opencues-runtime/src/modules/resolver.test.ts` —
  4 gate-semantics tests (immediate fires; spaced doesn't;
  spaced + space fires; `_italic_` typing never fires)
- `packages/opencues-runtime/src/blanks/registry-persistence.drift.test.ts` —
  ensures cycling the scalar persists to OPENCUES.md (closes the
  May 17 silent-snap-back bug class)

---

## See Also

- `docs/architecture/feature-registry.md` — how scalars like this
  are wired through the FEATURES registry
- `docs/features/selector-satellite.md` — the cycling UI
- `docs/features/hot-reload-config.md` — how changes propagate
  without restart
