# CLAUDE.md — OpenCues CLI (`opencues`)

Design + conventions for the `opencues` command-line tool. Read this before
adding a command or touching the look of the output / interactive menus.

## Two libraries — output vs input

| Lib | Role | Used for |
|---|---|---|
| `src/lib/style.cjs` | **Output chrome.** Colour + glyph auto-detection, `bold/dim/green/yellow/red/brightWhite`, `tag()`, `banner()`, `tree()`, `gutter()`, `rule()`, `fileLink()`, the `G` glyph set. Zero-dep. | Every line the CLI prints. |
| `src/lib/prompt.cjs` | **Interactive input** — the counterpart to style.cjs. Thin wrapper over `enquirer`. Exposes `select / confirm / input / secret` + `isInteractive`. | Any prompt the CLI shows. |

**Commands depend on the in-house `prompt` API, never on `enquirer` directly.**
The library is swappable in one file and *all* interactive styling lives there.

## Scripting contract (hard rules — never break)

1. **TTY-gated.** `isInteractive()` is false in CI / pipes / `--no-interactive`
   / `OPENCUES_NO_INTERACTIVE`. Interactive prompts **throw** in a non-TTY.
2. **Flags always win.** Go interactive only when positional args were omitted.
   Every explicit subcommand stays one-shot + scriptable. The dispatch shape:
   ```js
   if (!sub && prompt.isInteractive()) return interactive(ctx);
   // …explicit subcommands below stay one-shot
   ```
3. A non-TTY caller must always have a flag path to the same outcome.

## Interactive menu — the house look

All of this is owned by `prompt.cjs` so every menu matches automatically.

- **No `?` prefix. No enquirer pointer.** We own the gutter.
- **2-col selection gutter** = the cursor: a white `❯` on the focused row, two
  spaces otherwise. "You are here."
- **On/off status = a ring** `●`: **green (on) / gray (off)**, drawn by the lib
  from a choice's `ring: true|false`. **Same glyph for both states, colour
  only** — `●`/`○` (filled/hollow) are East-Asian *ambiguous* width and render
  at different cell widths on some fonts, shifting every column after them.
- **The selected row's text turns bright-white; the ring keeps its on/off
  colour.** Each row is composed in `choiceMessage` from three independent
  parts — gutter, ring, text — so the two states never fight in ANSI (wrapping
  a colour-reset-bearing label in another colour breaks at the first `\x1b[39m`).
- **`dim:true` rows** (e.g. a `Done` row) are gray when idle, bright-white when
  focused — "gray until selected".
- **`spacer: true`** = a blank, non-selectable line (NOT enquirer's `─────`
  rule).
- **Sections**: a **bold title + dim `· description`** (mirrors `style.cjs`'s
  `tree()` and the command's own static `list()`), then items at a 2-col gutter
  (`const IND = '  '`). Headers print at **col 0**; every selectable row, note,
  and the `Done` row line up under the gutter at **col 2**.
- **Columns are the command's job.** The lib never reflows. The command supplies
  plain, already-columnar text (`name.padEnd(nameW)` + `on/off`.padEnd + an
  aligned note column). Notes (e.g. `unreachable`) go in their own fixed column.
- **Confirm is a Yes/No arrow-select**, not a typed `y/N` — same gutter +
  white-focus UX; the cursor starts on the **safe default** (`No` unless
  `opts.default` is true).
- **No warning symbols in the interactive flow.** Use plain **bold/dim** text.
  (⚠ glyphs via `tag('warn')` are fine in the *static / scriptable* `list`
  output — a different surface.)
- **Minimal states — don't invent any.** A toggle row has exactly two:
  on/off (ring + word) and selected (white + arrow). No hover / active /
  extra-disabled variants.

### Division of labour

- **Lib owns:** the gutter + cursor, ring colour, focus styling, separators /
  spacers, and suppressing every enquirer echo (see gotchas).
- **Command owns:** the columnar label text and the choice list. Choice shape:
  `{ label, value, ring?: bool, dim?: bool, disabled?: bool, spacer?: true, heading?: styledStr }`.
  `heading` = a non-selectable bold section title (rendered inside the list, no
  gutter). `select(msg, choices, opts)` opts: `initial` (focus index),
  `cancelValue` (Esc/Ctrl-C → this). `input(msg, { default, allowEmpty })` —
  `allowEmpty:true` returns `''` when the pre-fill is cleared (vs the default).

## The `●` ring is the universal status glyph

One glyph carries status everywhere — interactive menus AND static output —
coloured by meaning. `G.ringOn` = `●` (ASCII `(*)`). **Never a tick / cross /
dot / `⚠` for status** — always a coloured `●`, so the whole CLI reads the same.

| Context | green ● | yellow ● | red ● | gray ● |
|---|---|---|---|---|
| on/off toggle (config, ai-callable, debug) | on / trusted | — | — | off / untrusted |
| API keys (help grid, check-keys, set-key) | key set / works | — | key failed | key unset |
| path existence (which, doctor) | present | — | — | absent |
| severity (review, doctor fixes, context modes) | ok / active | warning | error | info / off |

- **Colour carries the state; the glyph never changes** (`●`/`○` filled-vs-hollow
  are East-Asian *ambiguous* width and misalign on some fonts — so we recolour a
  single `●`, never swap glyphs).
- **Leading, not trailing.** Status rings go at the **start** of a row (a 2-col
  gutter), never a tick at the end. `which`/`doctor` replaced their tree branches
  + `✓`/`-` end markers with a leading `●`.
- The interactive menu's on/off ring (drawn by the lib from `ring: true|false`)
  is the same convention — green on / gray off.

## Static (non-interactive) output

The same house style applies when the command just prints (no prompt):

- **No markdown headings.** `bold('Section')` + optional `dim('· description')` —
  never `## Section` (it leaks raw markdown into the terminal). `doctor`/`review`
  were cleaned of `##`.
- **Aligned columns.** Multi-field data is a table: `label.padEnd(w)` columns
  with a `dim` header row. Pad the RAW string, then colour (padding a string that
  already contains ANSI counts the escape bytes and breaks alignment). See
  `identity list` (field/token/value), `review` (key/value manifest), `context`
  (token/description).
- **Use `style.cjs`, never inline `\x1b[...]`.** Every command imports the
  colour/glyph helpers; no hand-rolled `const dim = s => COLOR ? ...`. `tree()`
  for connected key→value listings; `fileLink()` for clickable paths;
  `banner()` for the header.
- **`opencues` (no args) grid.** The status dashboard (`help.cjs` `configRows`)
  builds an adaptive, terminal-width-aware grid (columns sized to `$COLUMNS`),
  never a fixed split that soft-wraps into a jumble.

## enquirer gotchas already neutralised (do not reintroduce)

`enquirer` is convenient but leaks internals; `prompt.cjs` already fixes these:

| Symptom | Cause | Fix in `prompt.cjs` |
|---|---|---|
| `?` before the message | falsy `prefix:` option is ignored | override `prefix()` → `''` |
| cyan **underline** on the focused row | default `styles.em` = `primary.underline` | `styles.em` set to identity; focus styling done in `choiceMessage` |
| stray `c0` printed on submit | `Select.format()` echoes `selected.name` (our synthetic id) | override `format()` → `''` |
| a choice prints `c3` | enquirer falls back to choice **name** when `message` is empty | spacer uses `message: ' '` |
| `(disabled)` tag on disabled rows | enquirer injects it when `hint == null` | pass `hint: ''` |
| `‣ false` on confirm | boolean prompt's live value echo + `‣` separator | confirm is a Yes/No `select`, not enquirer's boolean |
| stray leading space before the header | `[prefix, message, …].join(' ')` | empty `message` → `promptLine:false`; print headers yourself |
| cyan text on the field you're editing | `input` styles the value with cyan `placeholder`/`primary` | `OcInput` sets `styles.placeholder` → bright-white (value text); keep `primary` = ansi-colors `white` so the block cursor is white-bg/black-text, not cyan |
| arrow keys **wrap** (Down on last → top) | enquirer default `scroll` wraps | `up()`/`down()` overridden to **clamp** at the first/last selectable row |
| **flicker** on arrow navigation (WSL/remote) | enquirer clears then writes in separate stdout writes | each frame wrapped in a **DEC 2026** synchronized-output block (`\x1b[?2026h/l`) so the terminal paints erase+redraw atomically |
| long list renders past the terminal | enquirer's only scroll mode rotates + wraps the array | don't scroll — keep screens short (two-level browse: sections → items → value) |

## Building a new interactive command

1. **Dispatch:** `if (!sub && prompt.isInteractive()) return interactive(ctx);`
2. **Print the banner + section headers yourself** (col 0; bold title + dim
   description).
3. **Build choices** as plain, columnar `{ label, value, ring?, dim?, … }`.
4. **`await prompt.select('', choices)`** — empty message (you printed the
   header). Returns the chosen `value`, or `opts.cancelValue ?? null` on
   Esc/Ctrl-C.
5. **Confirm destructive actions** with `prompt.confirm(msg, { default:false })`.
6. **Keep every explicit subcommand one-shot** so scripting still works.

The reference implementation is **`src/commands/config.cjs`** (a two-level
sections → settings → value browser). Copy its shape.

## Interaction patterns (pick the one that fits)

- **Enum picker** — one `select` over a fixed set, run when the positional arg
  is omitted. `set-key` (provider → masked `secret`), `install`/`uninstall`/`run`
  (host, via the shared `lib/pick-host.cjs`), `new` (kind → `input` name).
- **On/off toggle** — a 2-row `select` (`ring` on the current value, cursor via
  `initial`). `debug`. Keep the scriptable `on|off` path.
- **Two-level browse** — list → detail → Back loop, so each screen stays short
  (no scrolling). `config` (sections → settings → value), `show` (list → detail).
- **Formatted detail view** — parse + render an entity as a `tree()` of aligned
  fields + a dimmed body, reused by both the scriptable and interactive paths.
  `show`'s `renderMatch`.
- **Embedded manager** — a manager that's a `lib/` module, not a command, invoked
  from another command's menu. `lib/ai-callable.cjs` (`manage()` + a count),
  embedded as a section in `config`.
- **Registry-driven** — derive menu structure from `@opencues/core`'s registry,
  not a CLI-local map. `config`'s sections come from each scalar's `group:`
  (see the `SETTINGS_GROUP_ORDER` refactor); a drift test pins coverage.

Configuration is centred on three "control panel" commands — `config` (settings),
`set-key` (credentials), and the AI-callable trust manager inside `config` — each
owning one file it writes.

## Files

- `bin/cli.cjs` — the `COMMANDS` dispatch map.
- `src/lib/style.cjs` — output chrome (see its header for colour/glyph rules).
- `src/lib/prompt.cjs` — interactive toolkit (all menu styling).
- `src/lib/prompt.test.cjs` — scripting-contract tests (the TTY gate must never
  regress) + fake-TTY driven tests (select/confirm/input return values).
- `src/lib/opencues-md.cjs` — read/write a single scalar in OPENCUES.md
  frontmatter (shared by every settings-writing command).
- `src/lib/pick-host.cjs` — shared host `select` for install/uninstall/run.
- `src/commands/config.cjs` — reference interactive command (the settings browser).
- `src/lib/ai-callable.cjs` — the AI-callable trust manager, a module embedded
  by `config` (not a standalone command; `manage()` + `trustedCount()`).
- `src/commands/{show,debug}.cjs` — reference for the formatted-detail explorer
  and the on/off toggle patterns.
- `src/commands/launcher.cjs` — the no-arg `opencues` interactive menu (routes
  into each command; non-TTY falls back to `help`). Registered in `cli.cjs` as
  the `argv.length === 0` default.

## Dependencies

- `enquirer` (the only interactive dep). A hand-rolled `node:readline` version
  was tried first and failed cross-terminal raw-input on WSL; `prompts` worked
  but couldn't drop the `?` or recolour the pointer. `enquirer` is themeable
  enough once the gotchas above are handled.
