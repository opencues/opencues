# Inline Cues (Continuous Onboarding)

Having moderated r/ClaudeAI over the past 10 months and developed learning resources for the Claude Code community (ClaudeLog.com) it has been interesting to see the evolution of the most modern HCI, a CLI based agentic tool. (I guess you could call it a Human to AI interface HAII)

Initially as the community grew to use the tool (Claude Code) there were not many mechanics for a user to learn as such it was easy to grok or catch up with the status quo/ best practices.

As time has passed (6-9 months), Claude Code has started to be used to build itself resulting in faster feature development and deprecation. This has made the amount of features needs to learn within the product ever growing and has now reached a point where even documenting all the changes would be a full-time job without the help of AI.

In the past years it was common for developers to read documentation, learn how a tool works and not have their 'working memory' of how the tool works or behaves be outdated for months. Modern agentic tools are subject to both model performance variance and harness variance. This results in a user needing to update multiple representations of how their work tools work.

The answer to this has been thus far to go to:

- Read the latest docs
- Read websites such as reddit etc to see how other people apply modern best practices
- Build evaluation frameworks for benchmarking performance and then dig deeper when issues are flagged.

I believe the future of product feature onboarding/discovery/deprecation is 'inline'.

By inline I mean like in the software sense where a function, class or … is defined inline not on some external source which:

- Can fall out of sync with the 'state' of the system it is supposed to be guiding a user to use.
- Requires a user to go to external sources
- Is not available at the very moment a user actually needs the specific information and thus can miss out on potential optimisations.
- Requires a user to remember the solutions, tips or best practices and recall to implement them at the exact best time.

Forever evolving AI systems should provide a user with continuously updated cues on how to utilise the tools to the fullest and these cues should be delivered contextually.

This is fundamentally a HCI problem as there many different kinds of cues which can be provided to a user as they are using a system such as: (reference HCI document parts)

Different cues need to be prioritised and the concepts cues themselves should not interfere with the base usage of a AI system or hinder a user's standard use.

[List lots of challenges)

These are the challenges me and the team at Command Stick initially set out on solving when attempting to improve the HCI of interface with an LLM system too.

The most major constraint we gave ourselves is one we call 'universality'; The solution should be applicable in all prompt sections without interrupting the UI or requiring shift in text rendering.

After iterating 6 months we landed on the concept of dimming the text to indicate that a cue is available. This was an anchor for HCI development direction as we knew in most prompt/ text boxes (excluding markdown ones) the colour of the text was underutilised as a means of inferring meaning to a user. Additionally markdown is often used by the LLM model to indicate important parts of text within its response so we utilise a similar mechanic for indicating mean to a user as they're constructing their prompt.

The next problem we needed to solve is how do you discover these cues. As we wanted to design a solution which is terminal friendly we opt-ed for a utilising a keyboard shortcut for moving the 'selected cue' indication. The selected cue indication being separate (opt-out) of the user's cursor position allows an individual to browse cues without moving their cursor and use that information to steer their prompt as they are constructing it.

Basic description of how cues work (ctrl+alt+left/right) = navigation, (ctrl+alt+up/down) = Cycling. A user is able to define the kind of cues they want a system to provide them such as:

Product owners can also engineer cues which can be updated in real-time and that can be displayed to a user as they construct their prompt. Utilising model specific context.

Cues are designed to be a means through which an LLM or deterministic system can seamless communicate aspects to you about a body of text you are constructing in real-time.

Additionally cues are paired with a secondary display/ display surface to provide additional information about the selected cue. (Expand on how the basic cue works based on the code)

Our main goal with the base cue mechanic are:

- Can be implemented 'anywhere'
- Does not reflow text
- Does not interrupt a user as the system is providing cues to them
- Does not overload prompt text rendering meanings

When designing cues we set out to attempt to explore solutions to:

- Product feature discovery
- A means of improving prompt
- A means of reducing token wastage
- A means of informating a user of product changes in real-time.

(Section on LLM writes the local cues which are then picked up by openCues, ask Wilfred)

These mechanics laid the foundation for several inventions which evolved into the OpenCues project.

---

## STAGING NOTES (not yet formatted)

### A. Fill `[List lots of challenges)`

The design challenges that gated every choice in OpenCues:

- **Must not reflow text.** Any solution that moves words around as the user is typing breaks flow and breaks procedural memory of where things are. This rules out inline insertions, expanding popovers, and most autocomplete-style overlays.
- **Must not interrupt typing.** No popups, no modals, no taking focus. The user keeps typing while the system thinks.
- **Must not overload existing rendering meanings.** Bold and italic and underline and colour are already used by markdown to indicate meaning *within* the prompt. The cue indicator must not collide with those.
- **Must work in a plain terminal.** No DOM, no CSS, no rich tooltips. Anything that requires browser-only primitives fails the universality test.
- **Must compose with the user's typing rhythm.** A cue that arrives 30ms after the user has moved on is noise. A cue that arrives 5 seconds later is irrelevant. The latency budget is felt.
- **Must be ignorable.** A cue that the user does not engage with should cost zero — no dismiss action, no follow-up modal, no "did you see this?" follow-through.
- **Must not poison across domains.** A cue source for legal terminology must not contaminate a cue source for medical terminology. One bad config should not break the whole system.
- **Sub-second where the user is waiting.** Cues are advisory and can take seconds to arrive. Blanks (`_`) are demanded and cannot — the user can see the gap they put there and is waiting.
- **Discoverable without docs.** The user must be able to learn what cues exist *while using the tool*, not by reading a manual.
- **Must not bind to cursor position.** The user's cursor is for typing. The cue-selection indicator must be separate so the user can browse cues without losing their place.
- **Must work in any text input.** Prompt boxes, document editors, mobile text fields, in-browser textareas — the same primitive should port.

### B. Reference HCI document parts (link back to posts #1 and #2)

The cue mechanic is an application of the framework laid out in earlier posts:

- **Post #1 (HCI)** — the 3-axis evaluation. Cues score zero on start-up frames (no summoning), zero on active window (the user keeps typing during analysis), zero on cool-down (cycling stays in place, no dismiss action).
- **Post #2 (Human Interaction)** — the different-modality rule. The dim works *because* it occupies a different modality from the text the user is typing. If the cue were itself text in the prompt, it would interrupt; because it is a colour-channel signal layered on top of the existing text, it does not.

The cue mechanic is the productisation of those two principles applied to LLM-grade alternatives.

### C. Expand "Basic description of how cues work"

The current one-liner says `ctrl+alt+left/right = navigation, ctrl+alt+up/down = Cycling`. The expanded version:

- **Dimming** signals "this word has alternatives available." The user does not have to act on the signal.
- **Navigation** (Ctrl+Alt+Right / Ctrl+Alt+Left) moves the *cue-selection indicator* between dimmed words. The cursor does not move. The user can browse alternatives without leaving the position they were typing at.
- **Cycling** (Up / Down on the selected cue) rotates through the alternatives, replacing the word in place. No popup, no menu — the substitution happens in the text.
- **Status line / secondary display** shows the cue-tip when a word is highlighted — the in-context teaching surface.
- **`cursor-navigate` setting** (opt-in) fuses cursor and cue-selection. Some users prefer this; the default is independent because the post's "user can browse without moving cursor" property is the more radical choice.
- **Editing a word** clears its cue and starts fresh. Other words in the input keep their state.
- **Cycle progress survives edits** elsewhere in the input — typing "Yesterday " in front of a sentence with cycled words does not reset the cycle.

### D. The kinds of cues a user can define

Filling the dangling list at "kind of cues they want a system to provide them such as:":

- **Local cues** — static dictionaries of word → tip + alternatives. Loaded into RAM at boot, looked up in ~0ms. Used for product-feature tips ("ultrathink", "/compact"), shipped defaults, and curated synonym groups.
- **Remote (LLM) cues** — domain prompts that fire on words matching a regex or keyword list. Used for legal / medical / financial terminology, style variants, formal vs informal alternatives. Latency ~200–500ms.
- **Cue-blanks (keyword-bound `_`)** — `volume _`, `nvda _`, `weather london _` — the user types a registered keyword next to `_` and the system auto-populates with live external state. Cycling Up/Down changes that state.
- **Fluid blanks** — any unbound `_` becomes a free-form lookup. `capital of france _` → `Paris`. No per-blank config required.
- **Selector / satellite blanks** — `opencues settings _` cycles through the system's own settings, writing back to disk on cycle.
- **Per-domain stacks** — multiple domain cue sources can coexist; each word is dispatched to exactly one source via per-word routing.

The user defines cues by dropping a `cue.md` file into `~/.cues/cues/<name>/` (for word cues) or `~/.cues/blanks/<name>/` (for blanks). Folder-based discovery; no registration; hot-reload picks up changes.

### E. Expand `(Expand on how the basic cue works based on the code)`

Implementation details that ground the description:

- **RoutedWordSourceGroup.** Every `cue.md` defining a `match:` regex or `keywords:` list becomes one cue source. The runtime wraps the whole set in a single `RoutedWordSourceGroup` that dispatches each word in the user's input to *exactly one* source. There is no "merge all the prompts into one giant LLM call" step — that older design was scrapped because a hijacking prompt in one source could poison every word.
- **Debounce.** A 500ms pause-in-typing fires the resolver. Words destined for the same source batch into one parallel LLM call. O(sources), not O(words).
- **Resolver skip filter.** Once the user has cycled `attorney → lawyer`, the LLM is *not* re-asked about "lawyer" on the next pulse. This saves tokens and prevents the "I cycled to it; the system silently un-cycled it" bug.
- **Deterministic relocate.** When the user edits a prefix and the word indices shift, cycle progress follows the words rather than getting orphaned. Only relocates when the match is unambiguous; ambiguous cases drop cleanly.
- **Ownership lock.** Once a blank value is filled (e.g., `volume 50%`), no LLM cue can overwrite it. Only the user can clear it — by editing the word.
- **Hot-reload.** ConfigLoader polls every search path on every keystroke (debounced). Edit a `cue.md`; next keystroke picks up the change.
- **Per-host adapters.** The same cue + the same code work in Claude Code, OpenCode, and Chrome. Host-specific glue is a few hundred lines per integration.

### F. *(LEAVE AS ASK — NOT YET BUILT — placeholder for "LLM writes the local cues which are then picked up by openCues")*

> Section on LLM writes the local cues which are then picked up by openCues, ask Wilfred.

**Status: design idea, not yet implemented.** This is a future feature, not something to describe as if it ships today. Drafting deferred until Wilfred decides on the shape. Possible shapes to discuss later:
- An LLM run (build-time, scheduled, or on-demand) authors `cue.md` files into `~/.cues/cues/<name>/`; the runtime's existing hot-reload picks them up.
- An in-product meta-cue (e.g., `give me cues for this domain _`) that writes new cue files in response to the user's request.
- A community contribution flow where LLM-generated cue libraries are shared and curated.

Will draft once the design is settled.

### G. Land the "Continuous Onboarding" framing the title promises

The title says "Continuous Onboarding" but the body trails off into mechanics. The pivot the post needs:

- **The deprecation problem stated up top** ("documenting all the changes would be a full-time job") was a *symptom*. The *cause* is that documentation lives in a separate place from the tool, and the user has to leave the work to consult it.
- **Cue-tips invert that.** The teaching surface lives *inside the work*. The user types `ultrathink`; the dim signals "there is something to know about this word"; navigating to it surfaces the tip in the status line. The user has now learnt what `ultrathink` does — *while using it, in context, without leaving the prompt*.
- **This is what continuous onboarding looks like.** No more "read the docs once and remember" → "feature deprecates" → "your mental model is stale" → "go re-read the docs". Instead, the system carries its own teaching with it. When the feature changes, the cue updates. When a new feature ships, a new cue ships with it.
- **Generalises beyond the LLM era.** Continuous onboarding is the answer to *any* fast-moving substrate, not just LLMs. The framing applies to product features, terminology, deprecations, even community best practices — anywhere the user's mental model is liable to go stale.

### K. Product-owner / real-time feature rollout angle

The post says "Product owners can also engineer cues which can be updated in real-time" but does not unpack it. The mechanism:

- A product owner authors a `cue.md` file. Frontmatter declares `match:` (regex) or `keywords:` (list); body is the prompt or a JSON dictionary of word → tip + alternatives.
- The file goes into `~/.cues/cues/<name>/cue.md` (or shipped via the project's `defaults/`, or pushed to the user via an update channel).
- The runtime's hot-reload picks it up on the next keystroke. No build. No deploy. No restart.
- The user sees the new cue *the next time they type a relevant word*.

The implication: a product owner can react to a model regression, a new directive, or a community-discovered best practice in *minutes*. The lag between "we noticed this matters" and "every user knows about it" collapses from a documentation cycle to a config push.

This is the structural answer to the post's intro — agentic-tool feature churn is faster than documentation can keep up with, but a *cue-based* teaching surface can keep up because it lives next to the work and updates by file.
