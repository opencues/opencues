---
title: Inline Prompting (Blanks)
date: 2026-05-06
description: Inline Prompting allows the user to request LLM assistance by placing a `_` in any text input. The user→LLM cue of the OpenCues two-direction model.
tags: [hci, blanks, prompting, universal-handle, mechanic]
cross_links: [hci-human-to-computer-interface, human-interaction, inline-cues-continuous-onboarding, inline-agents, seamlessly-integration]
---

# Inline Prompting (Blanks)

Inline Prompting allows the user to request the assistance of an LLM system by placing a `_` in text. The system reads the surrounding context, infers what is being asked, and responds in place.

The summoning character is `_` (underscore). Place it where assistance is wanted: `4 * 12 _` resolves to `48`; `NVDA _` resolves to the current stock price; `improve prompt _` re-renders a prompt the user has written.

[HCI](hci-human-to-computer-interface.md), [Human Interaction](human-interaction.md), and [Inline Cues](inline-cues-continuous-onboarding.md) developed the LLM→user cue. Inline Prompting is the user→LLM cue of the same model.

---

### Prior to Inline Prompting

Until now, cues have been one-directional. The system surfaces useful information directly in the user's text; the user navigates through the dimmed words and finds what is offered. But the user could not provide cues to indicate that they needed assistance or additional data whilst constructing their prompt.

A good prompt steers the model. Iterating on the prompt before submission saves tokens that would otherwise be spent on back-and-forth with an expensive model. Tools to improve a prompt do exist, but using one means leaving the prompt, running the draft through the tool, and copying the result back. The friction is high enough that most users skip the improvement step and submit the raw prompt, accepting the token cost as the cheaper-feeling option.

The bigger issue is the contexts where no AI is available at all. A text field on a website. A note app. A messaging client. A form. If the user needs the assistance of AI while writing in any of these, the logical path is to navigate to a separate AI app, ask the question, copy the answer, and paste it back into the original context. The result: most writing tasks that would benefit from AI assistance never get it.

### With Inline Prompting

The user types `_` to turn plain text into an Inline Prompt. The system reads the surrounding text, infers what the user needs, and provides it in place. The user has not had to learn anything beyond placing `_` where assistance is wanted.

What used to require leaving the work now happens within it.

---

### How blanks resolve

Three resolution paths handle the space. The user does not pick which one fires; the surrounding text decides.

- **Lookup blanks.** The most common case. An LLM segments the surrounding text into the question and writes the answer back, preserving any template the user wrote. `4 * 12 = _` → `4 * 12 = 48`. `capital of france _` → `Paris`. `capital of france is _` → `capital of france is Paris`. `5 miles in km _` → `8.05`. The model handles whatever shape the question takes. Latency typically sub-second on fast providers.
- **Keyword-bound blanks.** For known fast paths. `NVDA _` triggers a stock-price API; `volume _` reads OS audio level (and cycling changes it); `weather london _` returns current conditions. Each registered keyword calls a script or live data source. Fast (no LLM in the loop), deterministic, and writable where the source allows.
- **Transform blanks.** When `_` is paired with an instruction. `<text> make this formal _` rewrites the text in a more formal tone. `<text> pluralize _` makes everything plural. The system detects the instruction, applies it to the preceding text, and clears the trigger phrase.

Dispatch is by priority: registered keywords first (`volume _`, `NVDA _`), then blanks paired with an instruction (`<text> pluralize _`, `<text> make this formal _`), then plain lookups as the default (`4 * 12 = _`, `capital of france _`).

### Why `_` is the right primitive

`_` is on every keyboard. Shift-hyphen on QWERTY, present on every smartphone keyboard, every text input on every platform. No special command, no menu, no plugin. The interaction primitive is *typeable*, and that universality is what lets it port from terminal to browser to mobile.

The character also has a second property: it flips the autocomplete model.

Traditional autocomplete pops up suggestions while the user types; the user accepts or dismisses. The system is choosing the moment, the position, and the shape of the suggestion. The user is the responder.

Blanks invert this. The user types `_` exactly where the response should land. The system has no choice about position; the system only has to figure out what to put there.

Three further properties make the primitive composable:

- **Ownership lock.** Once a `_` is resolved, only the user can clear the result. No LLM cue can overwrite it. Editing the word releases the lock.
- **Visible failure.** If the system cannot resolve `_`, the `_` stays. There is no silent *system tried, gave up* state. The user sees the gap and knows.
- **Multiple `_` per input.** A single text input can carry many `_`s, each dispatched independently to its own source.

### Lineage: fill in the blank

The shape is older than software. Math homework. Language-learning exercises. Trivia quizzes. Schoolchildren have filled in `___` for generations. The primitive is so pre-loaded into the average reader that no instruction is needed; anyone who has done a fill-in-the-blank quiz already knows what `_` invites them to do.

Inline Prompting plugs into that pre-loaded mental model. The user does not have to learn what the symbol means; the user only has to learn that the system can resolve it. That is a much smaller delta than introducing a new symbol from scratch.

### HCI 3-Axis Analysis

Scoring Inline Prompting against the HCI (Human to Computer Interface) 3-Axis Analysis:

- **Start-up frames:** one keystroke (`_`), placeable inline at any time. No separate AI app to switch to, no separate prompt box to focus, no new UI to learn. The prompt is constructed in the text the user is already writing.
- **Active window duration:** sub-second to several seconds, depending on which blank fired and the complexity of the task. The user can keep typing while the blank resolves.
- **End-lag:** zero. The user never left their work to get the response. No return navigation, no context restoration, no re-focusing.

### Looking forward

[Inline Cues](inline-cues-continuous-onboarding.md) is the LLM→user cue. Inline Prompting is the user→LLM cue. Together they complete the two-direction model the series has been building. [Inline Agents](inline-agents.md) extends the same primitive: instead of one user-summoned response, the system runs an agentic editing pass continuously.

---

See Also: [HCI](hci-human-to-computer-interface.md) · [Human Interaction](human-interaction.md) · [Inline Cues](inline-cues-continuous-onboarding.md) · [Inline Agents](inline-agents.md) · [Seamless Integration](seamlessly-integration.md)
