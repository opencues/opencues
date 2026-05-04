# 09 — If It Works in Terminal, It Works Anywhere

For blog post #9: "If it works in Terminal it works 'anywhere'".

This is closely related to [`07-seamless-integration.md`](07-seamless-integration.md)
but the angle is different. The seamless-integration angle is "look how
many hosts we support." The terminal-first angle is "*because* it had to
work in a terminal first, the rest got cheaper."

## The thesis

Building for a terminal is the most-constrained text input you can target:
- No DOM. Just a stream of characters.
- ANSI escape codes for visuals. No CSS, no layout.
- Single-buffer. No tabs, no panels, no overlays without escape-code
  shenanigans.
- Direct stdin keystrokes. No event objects, no synthetic events.
- No subprocess sandboxing. Scripts can run, but they're explicit.

Anything you can build for a terminal, you can build elsewhere — because
elsewhere has *more* primitives, not fewer. The terminal is a lower bound on
host capability.

## What this looks like in OpenCues

The first integration was Claude Code (a terminal CLI). Every primitive that
landed there had to work with:
- A TTY for output
- Stdin for input
- ANSI for visuals
- Filesystem for config

When the runtime was extended to OpenCode (also terminal), nothing changed.
When it was extended to Chrome (browser, full DOM), the abstractions
*didn't have to bend* to accommodate richer rendering — Chrome simply
implemented `setText` / `getCursorOffset` / etc. with browser primitives.

> Same runtime, three host adapters. *— `damon.md`*

## What had to work in terminal first

### Visual: dimming via ANSI

Highlighting a word as "has alternatives" requires zero pixel-level rendering.
The terminal version uses an ANSI dim escape sequence. The Chrome version
uses CSS Custom Highlight API. Two completely different rendering approaches;
the same `WordDef` data structure feeds both of them.

### Input: keystroke handlers

`Ctrl+Alt+Right`, `Up`, `Down` — chosen because every host has them, and
they don't conflict with the host's existing keymap (in CC's case, after
careful patch design). Browser and terminal both expose the same
keystrokes through their respective input layers.

### Output: text-only substitution

`alternatives[0]` is the original word; `alternatives[1..]` are
alternatives. Cycling Up replaces the substring in the buffer. That's it.
No animation, no transition, no "diff view." Just text.

That works in a terminal because terminals are text. It also works in
Chrome because `value = newText` works on `<textarea>`.

### Status line: secondary display

From `docs/glossary.md`:
> **Secondary Display** — Where additional information (cue-tips) is shown.
> It is not in the text input box. The integration decides what this is —
> a status bar, tooltip, hover panel, sidebar, etc.

Generic name, deliberately. In CC it's the bash status line script. In
Chrome it's a popup. The runtime emits "show this tip"; the host decides
where.

### Configuration: files

`.md` files in `~/.cues/`. Every host can read them (or, for Chrome,
bundle them at build time + sync). No registry, no plist, no IndexedDB
required. Files are the universal terminal-friendly config format.

## What did NOT work in a terminal (and got accommodated)

### Tooltips on hover

Terminal has no hover. Mitigation: keystroke navigation reveals tips in the
status line. That works in every host (Chrome could *also* offer hover, but
doesn't have to).

### Inline images / rich media

Cue-tips are text-only. If a tip wanted a diagram, it'd have to be ASCII
art. The constraint forces good prose.

### Custom widgets

No comboboxes. No dropdowns. No floating panels. Cycling is in-place — Up
to next, Down to previous. That's because terminal can't draw a dropdown
elegantly.

This *forced* the in-place cycling pattern. Which turns out to be the
*better* HCI choice across all hosts because it never breaks the typing
flow.

## What the terminal-first constraint produced

1. **In-place editing as the default interaction.** No popup picker. No
   selection menu. Just substitution. (Compare to GitHub Copilot's grey
   inline ghost text: also terminal-shaped, also widely loved.)

2. **Keystroke-only navigation.** Mouse-free. Hand never leaves the typing
   position.

3. **A "secondary display" abstraction that maps trivially to any host.**
   Status line, tooltip, panel — all the same to the runtime.

4. **Text as the universal medium.** No images, no video, no rich
   metadata. The cue is text alternatives + a text tip. Period.

5. **File-based configuration.** Editable in any text editor. Works on
   every OS. Diffs cleanly in git.

6. **Subprocess as the escape hatch.** When you need OS-bound state (volume,
   brightness), spawn a script. Universal across native hosts. Chrome
   doesn't have it — and that exclusion was visible from the start, leading
   to the TS-class hoist.

## The HCI angle (for blog #9)

1. **Constraint is a tool.** Building for a terminal *forced* the design
   toward primitives that work everywhere. Without that constraint, the
   project might have leaned on Chrome-specific affordances (rich tooltips,
   floating selectors, hover) that wouldn't port.

2. **The "lowest common denominator" usually loses, but here it wins.** LCD
   often produces blandness ("we couldn't have rich UI because terminals
   don't"). Terminal-first here produced *concentration*: every primitive
   is sharp because it had to do everything.

3. **Text is the most portable medium.** The runtime's data structures are
   string-shaped. The configs are markdown-shaped. The interactions are
   keystroke-shaped. Each layer ports cleanly to any text-input host.

4. **Working in a terminal proves the architecture.** If a tool only works
   in IDEs with rich language servers, it's IDE-shaped, not portable. If
   it works in a terminal, it's keyboard-shaped, and that ports.

## Pitfalls and trade-offs

- **You miss richer UX where you could have it.** Chrome could show
  tooltips on hover; in OpenCues, navigation has to be keystroke. The
  trade-off is intentional but real.
- **Some tasks are intrinsically not terminal-friendly.** Volume / brightness
  shell scripts work on Linux but require `osascript` on macOS,
  `pwsh.exe` on Windows. The cross-OS work doesn't go away just because
  the architecture is terminal-shaped.
- **The terminal-first constraint can feel arbitrary in retrospect.** Once
  the runtime is mature, "but we *could* add a popup picker for Chrome"
  becomes tempting. The discipline of not doing it is what keeps the four
  hosts in sync.

## Where this material lives

- `damon.md` — system overview showing same-runtime-four-hosts
- `docs/glossary.md` — "Secondary Display" entry (deliberately generic)
- `docs/architecture/spans-and-cycling.md` — in-place cycling design
- `integrations/claude-code/docs/architecture.md` — terminal-specific patches
- `integrations/chrome/docs/rendering.md` — how the same primitives become
  CSS Custom Highlight
- `README.md` — "Real-time guidance as you type" / "any text input"

## Quotable lines

- "Same runtime, four host adapters."
- "Real-time guidance as you type."
- "Works on top of any text input: LLM prompts, word processors, mobile
  keyboards, and more."
- "The host decides what the secondary display is — a status bar, tooltip,
  hover panel, sidebar, etc."
- "Cycling is in-place. The hand never leaves the typing position."
