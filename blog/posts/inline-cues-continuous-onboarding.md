---
title: Inline Cues (Continuous Onboarding)
date: 2026-05-06
description: Inline Cues are a system-to-user signal that teaches the tool in context, while the user uses it. The structural answer to AI-era feature churn outpacing documentation.
tags: [hci, cues, continuous-onboarding, llm, mechanic]
cross_links: [hci-human-to-computer-interface, human-interaction, inline-prompting-blank, inline-agents, seamlessly-integration]
---

# Inline Cues (Continuous Onboarding)

Inline Cues are system-to-user signals embedded in the text the user is already typing. They surface information about the tool in context, while the user is working, without requiring the user to leave the prompt.

Cues activate automatically as the user types in any prompt with cue sources installed. Cues surface as dimmed words; navigate between cues with `Ctrl+Alt+Right` / `Ctrl+Alt+Left`, and cycle through a cue's alternative words with `Ctrl+Alt+Up` / `Ctrl+Alt+Down`.

Claude Code is a new class of HCI (Human to Computer Interface): an agentic CLI tool, or what I call a Human-to-AI Interface (HAII). I have watched it emerge and evolve while moderating [r/ClaudeAI](https://www.reddit.com/r/ClaudeAI) and building Claude Code learning resources at [ClaudeLog.com](https://claudelog.com). That experience has shown me why continuous onboarding is necessary, and I believe Inline Cues are how to deliver it.

---

### Prior to Inline Cues

In the past, a developer could read a tool's documentation, internalise how it works, and trust that mental model would be valid for months. Modern agentic tools break that assumption. They are subject to two compounding sources of variance:

- **Model variance:** the model behind the tool may shift week-to-week as providers update system prompts, alignment, or pricing.
- **Harness variance:** the tool itself ships features faster than docs can describe them, partly because the tools are now used to build themselves.

The user's mental model goes stale faster than they can update it. The fix has been to keep three sources of truth in their head: the official docs, the [r/ClaudeAI](https://www.reddit.com/r/ClaudeAI) subreddit, and their own evaluation framework. Each is a separate place to visit, separately staffed by humans or AI, going out of date at its own rate.

### With Inline Cues

The teaching surface lives *inside the work*. The user types `ultrathink` in their prompt; the word dims; navigating to it surfaces the cue-tip in the status line; the user has now learnt what `ultrathink` does, *while using it*, without leaving the prompt. When the feature changes, the cue updates with it. When a new feature ships, a new cue ships alongside. When old behaviour is deprecated, the cue updates to point users at the current alternative.

There is no documentation to go stale, because there is no separate documentation.

> The docs are the cues, and the cues live in the prompt.

---

### The constraints we set ourselves

Six months of iteration was gated by a hard set of design constraints. None of them are negotiable:

- **No text reflow.** Solutions that move words around as the user types break flow and procedural memory of where things are.
- **No interrupting typing.** No popups, no modals, no taking focus. The user keeps typing while the system thinks.
- **No overloading rendering meanings.** Bold, italic, and underline are already used to indicate meaning. The cue indicator must not collide with those.
- **Universality.** The solution must work in any text input on any platform: terminal, browser, mobile, IDE.
- **Felt latency.** A cue that arrives 30ms after the user has moved on is noise; a cue that arrives 5 seconds later is irrelevant.
- **Ignorable.** A cue the user does not engage with should cost zero. No dismiss action, no follow-up modal.
- **Cross-domain isolation.** A cue source for legal terminology must not contaminate one for medical terminology. One bad config should not break the whole system.
- **Discoverable without docs.** The user must be able to learn what cues exist *while using the tool*, not by reading a manual.
- **Decoupled from cursor position.** The user's cursor is for typing. The cue-selection indicator must be separate so the user can browse cues without losing their place.

These constraints rule out most existing affordances for this purpose: autocomplete dropdowns, tooltips on hover, popovers, command palettes. We settled on a colour-channel signal layered on top of existing text. The dim.

### Dim, navigate, cycle

The dim is the entry point. Three primitives compose around it:

- **Dimming** signals that a word has alternatives available. The user does not have to act on the signal.
- **Navigation** (`Ctrl+Alt+Right` / `Ctrl+Alt+Left`) moves the cue-selection indicator between dimmed words. The cursor does not move; the indicator is decoupled from the cursor by default, so the user can browse alternatives without leaving their typing position. The status line is the in-context teaching surface, showing the cue-tip for whichever cue is selected. An opt-in `cursor-navigate` setting fuses cursor and indicator for users who prefer that simplification.
- **Cycling** (`Ctrl+Alt+Up` / `Ctrl+Alt+Down` on the selected cue) rotates through alternatives, replacing the word in place. No popup, no menu. The substitution happens in the text.

Editing a word clears its cue and starts fresh; other words in the input keep their state.

Two cue sources cover the space:

- **Local cues** are static dictionaries of word → tip + alternatives, loaded into RAM at boot and looked up in roughly zero milliseconds.
- **Remote (LLM) cues** are domain prompts that fire on words matching a regex or keyword list. Latency 200–500ms.

A user defines cues by dropping a `cue.md` file into `~/.cues/cues/<name>/`. The frontmatter declares `match:` (regex) or `keywords:` (list); the body is the prompt or a dictionary of words. Folder-based discovery, no registration, hot-reload picks up changes on the next keystroke.

### Why the dim works

The dim works because it occupies a different modality from the words the user is typing. The text is the user's primary input channel; the dim is a colour-channel signal layered on top. That different-modality property is the rule named in [Human Interaction](human-interaction.md).

### Continuous onboarding

The post opened on feature churn outpacing documentation. Inline Cues are the structural answer.

Inline Cues put the teaching surface inside the prompt. The user types a feature name; the dim signals "there is something to know"; navigation surfaces the tip. The user has learnt the feature in context. There is no documentation site to fall behind, because there is no separate documentation site. When the feature changes, a config file updates and every user picks it up on their next keystroke.

For product owners, this same mechanism gives a fast cycle. A `cue.md` file authored today, dropped into a user's `~/.cues/cues/` or shipped via a defaults bundle, becomes a live cue on the next keystroke. No build, no deploy, no restart.

Continuous onboarding generalises beyond the LLM era. It is the answer to *any* fast-moving substrate where the user's mental model is liable to go stale: product features, terminology, deprecations, community best practices.

> Anywhere the work is the surface, the teaching can live with the work.

### Looking forward

These mechanics are the foundation for the rest of OpenCues. Inline Cues are the LLM→user cue; the same primitives extend into Inline Prompting, the user→LLM cue.

---

See Also: [HCI](hci-human-to-computer-interface.md) · [Human Interaction](human-interaction.md) · [Inline Prompting](inline-prompting-blank.md) · [Inline Agents](inline-agents.md) · [Seamless Integration](seamlessly-integration.md)
