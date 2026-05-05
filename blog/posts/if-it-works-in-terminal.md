# If it works in Terminal it works 'anywhere'

One of the cool observations I made since using Claude Code was that the 'base' simplicity of the interface afforded me the ability to be more flexible in my development setup and how I arrange my screens.

The minimum required screen space being minimal afforded me to finally have a palate single screen setup when on the go. I think this is one of the biggest wins of TUIs, they're naturally compact, simple with a minimal amount of elements to reflow.

I further confirmed this when I utilised the WhatsApp MCP in May 2025 to control my Claude Code instance remotely, this format was explored by many developers around the world and is now the basis for OpenClaw and other chat channel based agents.

The core simplicity of the terminal allowed for its functionality to be mirrored onto other platforms relatively easily and in quick order.

This simplicity is one of the key design decisions me and the team working on OpenCues are attempting to explore with Inline Prompting & Inline Agents.

What is the 'minimum' amount of UI needed to deliver an LLM experience and novel experiences could come to life as a result of us further removing the dependencies on UI?

---

## STAGING NOTES (not yet formatted)

### A. State the thesis cleanly

Terminal is the *lower bound* on host capability. Anything you build for it ports up. Anything you build for the richest substrate — browser, IDE, native app — has to be ported *down* to terminal, and usually does not survive the journey because it depends on capabilities the terminal does not have.

This is why "if it works in terminal it works anywhere" is a structural property, not a slogan. The terminal sits at the bottom of the capability stack. Every other host (browser, TUI in another language, mobile keyboard, in-game chat, future HCIs we haven't met yet) has *more* primitives than a terminal, not fewer. So a primitive that works in a terminal is a primitive that works in all of them.

### B. The OpenCues runtime is the proof

Same runtime today in:

- **Claude Code** — Node.js CLI, ANSI escape sequences in a TTY, patched via `tweakcc`.
- **OpenCode** — Bun-based TUI, patched fork at a pinned SHA.
- **Chrome** — Manifest V3 extension, CSS Custom Highlight API in `<textarea>` / `contenteditable`.

Same `.md` config files. Same keystrokes. Same cues. Same blanks. Two terminals and one browser — about as different as host environments get, especially the rendering layers (ANSI vs CSS Custom Highlight). And yet the same primitives work in all of them.

The reason is that the primitives were chosen to fit the terminal's constraints first. Everything else inherits.

### C. What terminal forces you to give up — and what falls out as a result

Each missing capability in the terminal forced OpenCues toward a simpler primitive that ended up being better:

| Terminal lacks | Forced design choice | Why it ports |
|---|---|---|
| DOM | In-place cycling (Up/Down on a dimmed word) instead of popup pickers | Every host can substitute text in a buffer |
| Hover | Keystroke navigation reveals tips in the status line | Every host has keystrokes; only some have hover |
| Floating panels | Status line as the single "secondary display" surface | Every host has *some* secondary surface (status bar, footer, tooltip) |
| Mouse | Keyboard-only navigation by default | Every host has a keyboard; not every host has a mouse |
| CSS layout | Text reflow doesn't break the system | The system never depended on layout in the first place |
| Rich widgets | A single character (`_`) as the universal interaction handle | A character is typeable everywhere |
| Animations | State transitions are instantaneous | Nothing to animate, nothing to break |

Read the right column twice. The pattern: every "missing capability" forced a simpler primitive, and that simpler primitive turned out to be the *better* choice for HCI quality, not just the portability-friendly choice.

### D. The "secondary display" abstraction

A deliberately generic name from the glossary, deserving of a callout:

> **Secondary Display** — Where additional information (cue-tips) is shown. It is not in the text input box. The integration decides what this is — a status bar, tooltip, hover panel, sidebar, etc.

Concrete renderings per host:

- **Claude Code** — bash status line below the input.
- **OpenCode** — footer area in the home view.
- **Chrome** — popup or floating panel attached to the input.

The runtime emits "show this tip when this word is highlighted." The host decides where. The runtime does not know — and does not need to know — what shape the secondary display takes in any given host. This is what an abstraction *should* look like: name the role, leave the rendering to whoever controls the surface.

### E. The WhatsApp MCP / OpenClaw lineage expanded

The post mentions this in passing. Worth grounding because it is the empirical proof of the thesis:

- **WhatsApp MCP (May 2025)** — controlling a Claude Code instance by sending messages via WhatsApp. The whole UX — typing a prompt, getting a reply, asking a follow-up — runs through SMS-shaped text. Why this works: Claude Code's interface is *already* text-in / text-out. Adding a different transport (WhatsApp instead of stdin) does not require redesigning the experience.
- **OpenClaw** — chat-channel-based agents that adopted the same pattern at scale. Discord, Slack, Telegram, custom messaging surfaces — all variants of "deliver text, receive text, repeat."
- **The abstraction these inherit from** — if Claude Code had required a rich GUI to use, none of these projects would have happened. The text-shaped interface is what made the chat-channel ports cheap. Terminal-first → text-first → portable to any text channel.

The lesson: the cheapest way to make your tool portable to surfaces that don't exist yet is to keep the substrate text. Everything that can render text becomes a candidate host.

### F. Constraint as a design tool

The meta-point worth elevating into its own paragraph:

> Pick your tightest constraint as the design floor, not your richest substrate as the design ceiling.

Designing for the richest available substrate is the default tendency — you build for the browser because it has the most primitives, then port to mobile (lose hover, lose precise pointer), then port to terminal (lose almost everything). Each port costs work and breaks features.

Designing for the tightest constraint inverts this. You build for the terminal because it has the fewest primitives, then port to browser (gain hover, gain CSS, gain panels — but you don't *need* any of them to ship), then port to mobile (still works). Each port is a *bonus*, not a degradation.

This is the same principle that makes good APIs portable across languages: design for the lowest-common-denominator type system, gain elaboration in richer environments. It is the same principle that makes good fonts work at every size: design for the smallest readable rendering, the rest scales up.

OpenCues did not arrive at this principle by deduction. It arrived because the first integration target was a CLI, and the CLI's constraints set the design floor. The portability turned out to be the consequence.

### G. The closing question expanded — what is the minimum UI for an LLM experience?

The post asks the question. OpenCues' answer to date:

- **A text input the user is already typing in.** Not a dedicated chat box. The artifact they were already editing.
- **A dim signal on words.** A visual layer separate from the text content (so it does not interrupt or reflow).
- **A status line** (one line below or beside the input) for tips and task indicators.
- **Five keystrokes total:** Up, Down, Ctrl+Alt+Right, Ctrl+Alt+Left, and any character that goes in the input.
- **One special character** (`_`) as the universal interaction handle for "user-initiated prompt."

That is the entire UI surface. No menus. No buttons. No popups. No chat panel. No model picker. No system prompt editor. No conversation history viewer. No settings dialog. No review pane. No accept/reject modal. No icon tray.

Whether this is *the* minimum or *a* minimum is a fair question. But it is meaningfully smaller than the surface every commercial AI tool ships today, and it covers cues, blanks, transforms, and continuously-running agents — the full feature set — with zero additions.

### H. The portability stack

Three layers, each text-shaped, each portable for the same reason:

```
   Data   ─── alternatives, tips, blank values ──── all strings
   Input  ─── keystrokes, _ character, words ──── all keystrokes
   Config ─── cues.md, .opencuesrc, .cues/ ─── all files
```

Every layer is text. Strings travel between hosts via the renderer; keystrokes travel via the host's input system; files travel via the filesystem (or, for Chrome, a synced bundle that imitates one). No layer has a dependency on a primitive that does not exist in every host.

This is what makes the "if it works in terminal" claim *structurally* true. The portability is not a happy accident; it is the consequence of every layer being text-shaped from the beginning.

### I. Concrete portability gains in practice

What this enables, end-to-end:

- The same `cue.md` file in `~/.cues/cues/legal/CUE.md` works in Claude Code and OpenCode without modification. No host-specific tags, no per-host config blocks.
- The same `blanks/volume/BLANK.md` (with its colocated `.sh` script) works on every native host that can spawn a subprocess. Chrome filters the script out via the `host-compat` declaration.
- Hot-reload works in every host: native hosts poll file mtimes, Chrome polls a `.version` hash. Different mechanisms, identical user-visible behaviour.
- A user authoring a new cue or blank does it once. The runtime distributes it to every installed host on the next keystroke.

The author's mental model is "I am writing a cue." They do not have to think about which host the cue runs in. The portability is invisible — which is the right shape for portability to take.

### J. Terminal as a renaissance

The post's premise rests on a thing that was non-obvious five years ago: terminal tooling is currently more vibrant than at any point since the early 90s.

- Claude Code, OpenCode, Aider, Goose — modern AI coding assistants ship as TUIs.
- lazygit, gitui — git porcelain by terminal UI, displacing GUI git clients for many users.
- fzf, ripgrep, fd, sd — the modern "Unix-shaped" toolkit, faster and more ergonomic than their classical predecessors.
- btop, htop, glances — system monitors as TUIs.
- helix, neovim, micro — terminal-native editors with modern feature sets.
- zellij, tmux — terminal multiplexers as the new "window manager" for many developers.

The "terminal is dead, GUIs replaced it" prediction from the late 90s and early 2000s simply turned out to be wrong. Terminal interfaces are *back*, in part because they fit the modern developer's screen-real-estate constraints, in part because keyboard-driven UX has aged better than mouse-driven UX for repetitive work, in part because the AI substrate happens to be text-shaped and the terminal renders text natively.

This grounds the post's premise. The thesis is not "terminal is the floor because terminal is dying anyway" — it is "terminal is the floor because terminal is *thriving* and the surface area to design within is meaningfully larger than the GUI tradition assumed."

### K. Specific terminal-shaped wins, listed

A concrete inventory of OpenCues primitives that came directly from the terminal constraint:

- **Dim via ANSI escape** (`\e[2m`) — no CSS, no Material Design colour system, no theming engine.
- **ASCII text alternatives** — `attorney → lawyer → counsellor`. No rich text, no images, no formatting markers.
- **Status line as the single secondary surface** — one line of text, hot-replaceable via stdout. Universal across hosts.
- **Single-buffer cycling** — alternatives replace the word in place. No overlay, no detached menu, no "options panel."
- **Subprocess for OS state** — `bash volume-blank.sh get` is universal across every native shell. Works on macOS, Linux, WSL.
- **File-based config** — `.md` files in `~/.cues/`. Edit in any text editor. Diff cleanly in git. Sync via any file-sync tool.
- **Keystroke vocabulary** — five keys total, none of which conflict with standard editor keymaps in any host I have tested.

Each of these is one decision the terminal constraint made for me. Each one ported to Chrome and OpenCode without effort. The terminal did not just constrain the design; it *clarified* it.

### L. The lower-bound argument applied to AI tooling specifically

Most AI tools today build for the richest substrate first and try to port down:

- Built for browser → ported to mobile → never quite right on mobile.
- Built for VSCode → ported to other IDEs → broken on each new IDE.
- Built for proprietary chat UI → no port path exists.

The result is that "AI tool portability" usually means "we shipped on Mac and Windows" rather than "we shipped on every text input the user uses."

OpenCues' bet is that inverting the substrate ordering is the path to actual portability. Terminal first, then OpenCode, then Chrome, then anything-text-shaped (including hosts that don't exist yet). The terminal is not a downgrade target — it is the design floor that makes every other target free.

If the future of LLM HCIs includes interfaces we haven't met yet — voice transcription editors, AR text input, in-game chat copilots, glasses-based dictation — the terminal-first design floor is what gets the runtime there without a rewrite.
