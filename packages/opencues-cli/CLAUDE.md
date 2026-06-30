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
- **Command owns:** the columnar label text, the section headers (printed at
  col 0 via `console.log`), and the choice list
  (`{ label, value, ring?, dim?, disabled?, spacer? }`).

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
sections → settings → value-picker browser). Copy its shape.

## Files

- `bin/cli.cjs` — the `COMMANDS` dispatch map.
- `src/lib/style.cjs` — output chrome (see its header for colour/glyph rules).
- `src/lib/prompt.cjs` — interactive toolkit (all menu styling).
- `src/lib/prompt.test.cjs` — scripting-contract tests (the TTY gate is the
  thing that must never regress; interactive rendering is validated by hand).
- `src/commands/config.cjs` — reference interactive command (two-level browser).

## Dependencies

- `enquirer` (the only interactive dep). A hand-rolled `node:readline` version
  was tried first and failed cross-terminal raw-input on WSL; `prompts` worked
  but couldn't drop the `?` or recolour the pointer. `enquirer` is themeable
  enough once the gotchas above are handled.
