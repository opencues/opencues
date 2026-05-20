# Principles of HCI

A working list of the dimensions a human-computer interface should be evaluated against. These aren't a ranked checklist — they trade off against each other, and any real HCI picks which to prioritise. The goal is to be *aware* of each axis when designing.

## Footprint

- **Screen space** — does the UI claim dedicated space that the user's task could otherwise use? Cost grows with vocabulary size and shrinks-screen contexts (mobile, smartwatch).
- **Persistence of unused elements** — do dormant controls (unused keys, hidden buttons) keep occupying space?
- **Separation from the work** — is the input far from the user's region of interest, forcing gaze excursions or refocusing?
- **Occlusion** — does the user's hand or finger cover the element they're operating?

## Attention

- **Statefulness** — must the user look at the UI just to know what mode it's in (caps lock, current menu, dial position)? Stateless interfaces are cheaper to use.
- **Layout stability** — do items stay in the same place, or do "recently used" lists, redesigns, and dynamic menus move them?
- **Non-visual feedback** — does the UI confirm actions through sound or haptics, or must the user look to verify?
- **Sight-only differentiation** — can controls be told apart only by looking at them?

## Speed

- **Input length** — how many strokes, taps, or gestures per command?
- **Excursion size** — how far does the hand/finger/cursor have to travel?
- **Latency under pressure** — can a command be issued quickly in response to an event, or does it need a deliberate menu walk?

## Cognitive load

- The mental effort of operating the UI competes with the user's actual task. A good HCI leaves higher-order cognition free.
- **Memory-type fit** — procedural memory wants a single repeated movement; auditory/phonological memory wants sound; episodic memory wants context. UIs that don't match their lexicon to a memory type are harder to internalise.

## Expressiveness

- **Vocabulary size** — how many distinct commands can the UI express?
- **Scaling cost** — does adding the Nth command require adding more space, more keys, or more screen real-estate?

## Ergonomics

- **One-handed operation** — can it be used with a single hand?
- **Natural motion** — does it use motions the human hand evolved for (grasping, fine-motor rotation), or coarse / unnatural ones (long flat keypresses, large swipes)?
- **Comfortable range** — does it stay within the natural excursion of a finger/hand without over- or under-reaching?

## Errors

- **Precision required** — how easy is it to hit the wrong target?
- **Error checking** — is there a moment where the user can confirm a command before it fires, or do actions execute immediately?
- **Cancellability** — once an input has started, can the user back out without committing?
- **Diagnosability** — when something goes wrong, can the user *see* what they did and understand the deviation?

## Learnability

- **Affordance** — does the UI suggest what to do without instruction (e.g. a slider invites dragging; a swipe gesture doesn't)?
- **Apparency** — are all available commands visible, or are some hidden behind shortcuts/combos the user must already know?
- **Intuitive mapping** — do commands resemble real-world gestures or familiar paradigms?
- **Path from novice to expert** — does the UI shed instruction as the user becomes proficient, instead of cluttering the screen forever?
- **Instruction paradox** — a new user needs the most guidance at the moment the UI most needs to look attractive and uncluttered. Resolving this tension is itself a design problem.

## Generality

- **Cross-application transfer** — do skills learned in one app work in another, or does every app reinvent its menus?
- **Cross-platform transfer** — does the UI behave the same on desktop, mobile, tablet, and watch, or must the user re-learn it on each?
- **Scale-independence** — does the UI work the same at different sizes and zoom levels?
- **Hardware variance** — does the user's proficiency carry across different mice, trackpads, keyboards, etc., or is it tied to one device's sensitivity?

## Targeting

- **Recipient clarity** — when the user issues a command, is it obvious *what* receives it (which control, which device, which window has focus)?
- **Dedicated input region** — is there an unambiguous area where the input "belongs," so a gesture can't be confused with something else (scroll vs. status-bar pull)?
- **Preview / focus indication** — does the UI show which element will be affected before the command commits?

## Aesthetics

- Beauty isn't decorative — UIs that are pleasant to perform (typing, signing, calligraphy) get used more and practised more, which compounds proficiency. Continuous motion, symmetry, and minimalism contribute. Ugly UIs are abandoned even when functional.

## Secondary tensions

Whenever an HCI solves one of the issues above, the solution itself tends to introduce new ones. A few recurring ones:

- **Speed vs. safety** — making every command fast also makes destructive commands easy to fire by accident.
- **Discoverability vs. clutter** — exposing all options helps new users but overwhelms experts.
- **Universality vs. context-fit** — a command that works "everywhere" may not be supported in every host app, leading to dead options.
- **Power vs. memorability** — a large vocabulary requires more to learn; a small one constrains expression.
- **Stateless vs. compact** — adding modes/state lets the same input do more, but forces the user to track where they are.

Designing an HCI is largely about deciding which of these trade-offs to make explicit, and which to hide.

---

## STAGING NOTES (not yet formatted)

### A. Apply each section to OpenCues

A walk-through scoring OpenCues' two-direction model (cues + blanks) against each axis. Demonstrates the principles in operation rather than in the abstract.

**Footprint**
- *Screen space* — zero dedicated screen space. The dim renders on existing words; the status line is a single line below the input; no new panels, popups, or icons.
- *Persistence of unused elements* — none. There are no controls to lie dormant; every cue exists only when its word is on screen.
- *Separation from the work* — zero. The dim is *on the words the user just typed*. Their region of interest contains the cue.
- *Occlusion* — none. The user is not hovering anything; their hand is on the keyboard, not in the way of the indication.

**Attention**
- *Statefulness* — minimal. Cycling has a per-word state (which alternative is active), but it is rendered in the text — the user does not have to consult a separate UI to know "where they are."
- *Layout stability* — guaranteed. Deterministic Relocate keeps cycle progress attached to the words even when surrounding text shifts; words do not move under cycling.
- *Non-visual feedback* — partial. The substitution itself is the feedback; ANSI dim is visual, but TTS (`speak: true`) and host audio cues are available where set.
- *Sight-only differentiation* — partial. Cues differ by *position in the text* (each word) rather than by sight-discriminating between visually-similar UI elements.

**Speed**
- *Input length* — 0 keystrokes for cues (automatic), 1 for blanks (`_`), 1 chord for cycling (Up/Down).
- *Excursion size* — minimal. Hands stay on the home row. No pointer movement required.
- *Latency under pressure* — high responsiveness on the surfaces where it matters. Local cues 0ms, blanks sub-second to ~1.5s, no waiting on cues (background advisory).

**Cognitive load**
- *Memory-type fit* — explicitly procedural. Up/Down cycling is the same chord regardless of which word is selected. Cycle direction does not change with mode. The fingers learn one move and apply it everywhere.
- The prompt grammar (`agentically <X> _`, `add task <X> _`, `stop task _`, `current task _`) uses ordinary English so it doesn't compete with the user's task-language.

**Expressiveness**
- *Vocabulary size* — effectively unlimited. Each blank and cue source is a separate "command"; folder-based discovery means new commands are dropped in without code changes.
- *Scaling cost* — sub-linear. Adding the Nth cue source adds zero screen space (no new UI elements) and zero new keystrokes; it only adds latent vocabulary the user can summon by context.

**Ergonomics**
- *One-handed operation* — possible for cycling (Up/Down/Ctrl+Alt+Arrow can be pressed one-handed on a standard keyboard). Typing the prompt itself requires whatever the host typically requires.
- *Natural motion* — uses the typing motion the user is already performing. No mouse, no swipe, no chord that breaks the typing posture.
- *Comfortable range* — yes. The user's hands stay on the keyboard.

**Errors**
- *Precision required* — low. Cycling does not require pointing accuracy; it operates on the highlighted word. Blank fills happen at the `_` location, not at a pixel.
- *Error checking* — yes. Every cycled value is reversible by cycling back. Every blank fill can be cleared by editing the position.
- *Cancellability* — yes. The user can always edit the value or cycle Down to revert. No commit point until the user submits the input.
- *Diagnosability* — partial. Debug logs (`debug-mode: on`) surface every pipeline step; without debug mode, failures are silent (the dim doesn't appear, or the `_` stays unfilled). Visible failure for blanks; invisible failure for cues — by design.

**Learnability**
- *Affordance* — partial. The dim signals "something is available" but doesn't reveal what. Cue-tips on navigation reveal it.
- *Apparency* — partial. The set of *all* cues is hidden (use `opencues list` to see them). The set *currently applicable* surfaces as dim words on the user's text.
- *Intuitive mapping* — `_` for "fill in the blank" is genuinely intuitive (school-exercise vocabulary). Cycling with Up/Down is intuitive (every list-cycling UI works this way).
- *Path from novice to expert* — the system never gets cluttered as the user becomes proficient. The only "instruction" is the cue-tip on navigation, which is opt-in (the user has to navigate to see it).
- *Instruction paradox* — solved by continuous onboarding (post #3). The teaching surface is *the system itself in use*. There is no docs-vs-clean-UI tension because the docs are the dim words.

**Generality**
- *Cross-application transfer* — high. Same primitives in CC, OC, Chrome. Author once, run everywhere.
- *Cross-platform transfer* — high (within the supported hosts). Limitations: shell-script blanks don't run in Chrome (filtered by `host-compat`); the user is told this rather than experiencing silent failure.
- *Scale-independence* — high. Works in any text-input substrate that can render dim and accept keystrokes.
- *Hardware variance* — high. Keyboard chords work the same regardless of keyboard model. No mouse sensitivity issues.

**Targeting**
- *Recipient clarity* — high. The cue applies to the highlighted word; the blank fills the `_` at its position. No ambiguity about which element is being addressed.
- *Dedicated input region* — the entire text input is the input region; no out-of-band areas.
- *Preview / focus indication* — the highlighted word is the focus indication; the dim is the preview that "this word has alternatives."

**Aesthetics**
- The system is aesthetically minimal by design. Plain text + a dim layer + a status line. No icons, no gradients, no chrome. Aesthetic minimalism falls out of terminal-first design (post #9).

The system was not designed item-by-item against this list. It scores well because the upstream design principles (the 3-axis framework, "no side-effects", terminal-first, the two-direction model) push the design toward seamlessness as a structural consequence.

### B. Apply each section to a generic AI chat box (the dominant HAII pattern)

The diagnostic mirror. Worth doing because the chat box is the default HAII today and most readers will be evaluating it implicitly when they read this post.

**Footprint**
- *Screen space* — high cost. The chat panel claims dedicated space, often half the screen on desktop, dominant on mobile. Every other element on screen has to share what is left.
- *Persistence of unused elements* — high. The chat history takes up space whether you're using it or not; old messages, the input box, the model selector, the "thinking" indicator all persist.
- *Separation from the work* — high. The chat is in a *separate panel* from the artifact (file, document, prompt) the user is producing. The user has to switch focus between the two.
- *Occlusion* — generally not a problem on desktop; can be on mobile when the keyboard rises.

**Attention**
- *Statefulness* — high. Each message references prior context the user must remember (or scroll to find).
- *Layout stability* — generally good (chat is linear) but new messages reflow the visible area, especially when long.
- *Non-visual feedback* — minimal. The user reads to verify; "typing…" indicators are visual.
- *Sight-only differentiation* — high. Different commands and tools are differentiated by reading their output, not by other senses.

**Speed**
- *Input length* — long. Often a paragraph or more, even for simple operations, because the system has no in-line context.
- *Excursion size* — depends on host but typically requires switching focus to the chat panel before typing.
- *Latency under pressure* — universally bad. Even simple queries take seconds; complex ones take minutes. There is no fast path.

**Cognitive load**
- High. The user is composing a prompt (writing in natural language), holding the conversation context (where are we, what did I ask before), evaluating the response (is this right?), and integrating the answer back into their task. Four parallel cognitive demands.
- *Memory-type fit* — declarative. The user has to recall what they asked, recall what was answered, recall where the answer fits in the work. Declarative memory is the expensive kind; chat boxes load it heavily.

**Expressiveness**
- *Vocabulary size* — effectively unlimited (you can ask for anything in natural language).
- *Scaling cost* — every new "tool" requires a new prompt-engineering convention or a new mode. The vocabulary grows but the user must learn how to ask for each new capability.

**Ergonomics**
- *One-handed operation* — chat is technically possible one-handed (typing) but the cognitive load makes it impractical.
- *Natural motion* — typing, which is fine, but typing *long natural-language prompts* is more effortful than the symbolic shortcuts other UIs use.
- *Comfortable range* — fine.

**Errors**
- *Precision required* — high in a different sense: prompt phrasing matters enormously, and the user has limited tooling for knowing if their phrasing was right until after the model has answered.
- *Error checking* — minimal. Some products allow editing the last message; few allow rolling back state across messages.
- *Cancellability* — partial. Most chat UIs allow stopping a generation; few allow reverting actions the model has already taken (file edits, tool calls).
- *Diagnosability* — poor. When the model goes wrong, the user often cannot tell *why*. Was it the phrasing? The model's training? A confused tool call? Most chat UIs surface no introspection.

**Learnability**
- *Affordance* — moderate. The chat box invites typing, but does not suggest what *kinds* of prompts will succeed.
- *Apparency* — poor. The set of available tools and capabilities is hidden behind the model's behaviour. Users discover features by trial.
- *Intuitive mapping* — high. Chat-with-a-person is the most intuitive metaphor humans have.
- *Path from novice to expert* — slow. The expert prompt-engineer learns through practice that they can rarely articulate. Skill transfer between users is poor.
- *Instruction paradox* — present and unresolved. New users need extensive prompt-engineering guidance, but the chat box never provides it in-line.

**Generality**
- *Cross-application transfer* — high (chat is chat) but trivially so — the skill transfers because the format is identical, but the underlying capabilities vary wildly between products.
- *Cross-platform transfer* — high.
- *Scale-independence* — high (chat scales).
- *Hardware variance* — high (typing is typing).

**Targeting**
- *Recipient clarity* — poor. The chat goes to "the model" but which model, with which system prompt, with which tools? Often opaque.
- *Dedicated input region* — present (the chat box) but disconnected from the artifact the user is producing.
- *Preview / focus indication* — none. The user submits and waits to see what happens.

**Aesthetics**
- Most chat UIs are visually pleasant but compete with the user's primary task for attention. The aesthetic is "consume my attention," which is the opposite of what an HCI for *accomplishing work* should be.

The point of this exercise: the chat box is *not bad* — it is the right HCI for some interactions (open-ended creative dialogue, long-form Q&A) — but it scores poorly on most of the principles. Defaulting every AI feature to chat is an HAII pattern that takes a UI optimised for one thing and applies it everywhere, dragging its trade-offs across all use cases.

This is also the structural argument for inline primitives (cues, blanks, transforms, agents): they pick *different* trade-offs that score better on most of the principles for the use cases where chat is overkill.

### I. Each section gets a prototypical violator

Famous UIs that fail each axis well. Naming them makes the principles diagnostic by example.

**Footprint** — *Mobile dropdown menus*. A category that occupies enormous screen real-estate to display a handful of options. The list is often longer than the visible area, requiring scroll.

**Attention** — *Caps Lock*. A purely stateful key. The user must look at an indicator (or test by typing) to know which mode they are in. The classical case of "you can't use the UI without consulting it."

**Speed** — *Nested menu navigation* (e.g., File → Recent Documents → submenu → submenu → file). Each command requires multiple deliberate gestures. No fast path exists for a known operation; the user must walk every level.

**Cognitive load** — *Modal dialogs that block other interaction*. The user has to drop their current task, read the dialog, decide how to respond, dismiss it, and re-load the original task into working memory.

**Expressiveness** — *Function keys (F1–F12)*. Twelve commands, no scaling path. To add a 13th you need a modifier key, which doubles the learnability cost.

**Ergonomics** — *On-screen keyboards on tablets*. Typing on glass with no haptic feedback, no key travel, often a layout that doesn't match the user's procedural memory from physical keyboards.

**Errors** — *`rm -rf`* (or any destructive command without confirmation). Once entered, no undo. No preview. No cancellation point. One typo is fatal.

**Learnability** — *Vim's modal editing*. Exceptionally powerful for experts; exceptionally hostile to new users because nothing on screen tells you which mode you are in or how to leave it.

**Generality** — *Right-click menus*. Universal in concept; the contents differ wildly between applications. The skill of "right-click to discover options" transfers; the specific options never do.

**Targeting** — *Touchscreen swipe gestures*. A swipe down on a phone could be "scroll the document," "pull the status bar," "dismiss the keyboard," "navigate back" — all depending on where on screen the swipe started and what state the app is in. Recipient ambiguity at its purest.

**Aesthetics** — *Default Windows dialog boxes from the XP era*. Functionally complete, visually leaden. Users abandon them as soon as a prettier alternative ships, even when the prettier alternative is functionally equivalent or worse.

**Secondary tensions** — *Photoshop's keyboard shortcuts*. Power users love them (speed maxed). New users fail (apparency minimal). The same UI is adored and hated by the same population at different proficiency levels.

These examples are useful because they let readers test their grasp of each principle against something concrete. If a reader cannot articulate *why* Caps Lock fails the Statefulness axis, they have not yet internalised the axis.
