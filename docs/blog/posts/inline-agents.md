---
title: Inline Agents
date: 2026-05-24
description: An LLM that edits the user's draft continuously, in place, on every pause-in-typing. The continuous extension of Inline Prompting.
tags: [hci, agents, blanks, mechanic, continuous-editing]
cross_links: [hci-human-to-computer-interface, human-interaction, inline-prompting-blank, inline-cues-continuous-onboarding, seamlessly-integration]
---

# Inline Agents

Inline Agents run an LLM continuously over the user's draft, editing in place on every pause in typing. The user starts the agent with one phrase, keeps writing, and the agent's edits appear as dimmed words in the same text.

The starting gesture is `agentically <task> _`. From that point on, every pause sends the surrounding text to the LLM with that task as the prompt. Any edits the LLM makes are applied directly to the text and dimmed so the change is visible. To revert an edit, the user navigates to the dimmed word with `Ctrl+Alt+Left/Right` and cycles back to the original with `Ctrl+Alt+Down`.

[Inline Prompting](inline-prompting-blank.md) gave the user a way to summon one LLM response per `_`. Inline Agents keep the LLM running continuously, re-checking the user's text on every pause in typing.

---

### Prior to Inline Agents

Existing agentic tools live on a separate surface. A chat panel. A side window. A modal review pane. The user types in their document, switches to the panel, describes the task, waits, reads the agent's response, copies the output, switches back, pastes, edits. Every round trip costs the user two context switches: one out of the work, one back into it.

The cost is paid even when the agent's contribution is small. Fixing one typo by routing through a chat panel costs more than retyping the word by hand. Most users skip the round trip and accept the typos. The example is trivial; the friction it exposes is not.

The deeper issue is that the agent's edits live somewhere else. The user has to leave the work, look at a diff, accept or reject items in a review surface, and return. There is no way for the agent and the user to work in the same text at the same time.

### With Inline Agents

The user starts a task in the text they are already in (`agentically correct spelling _`) and continues typing. The agent runs in the background after a brief pause. When it decides on an edit, it applies the edit immediately and dims the new word so the change is visible. There is no accept gesture; ignoring the dim is acceptance. To revert an edit, the user navigates the cue-selection indicator to the dimmed word with `Ctrl+Alt+Left/Right` and cycles back to the original with `Ctrl+Alt+Down`. The user never left the document; the agent never asked them to.

The trigger phrase itself is wiped from the text when the agent starts, the same way [Inline Prompting](inline-prompting-blank.md) wipes its summon words. What remains is the user's draft, plus a `[task: correct spelling]` line in the status display.

---

### The four trigger phrases

The entire user-facing surface of Inline Agents is four phrases. There is no special syntax, no flags, no configuration.

| Gesture | What it does |
|---|---|
| `agentically <X> _` | Start the agent on task `<X>`. Wipe the trigger phrase. Status display lights up `[task: <X>]`. |
| `add task <X> _` | Append `<X>` to the active task. Prompt becomes `<old> AND <X>`. The whole document is re-evaluated against the new prompt. |
| `stop task _` | Stop the agent. Status display clears. Existing dimmed edits remain in the text; the user reverts any individually if they want. |
| `current task _` | Print the active task at `_` so the user can see what is running. |

Task composition is by accumulation, not by parallel agents. `agentically correct spelling _` followed by `add task fix grammar _` becomes one prompt: `correct spelling AND fix grammar`. Every run sends the full accumulated prompt. The LLM applies all sub-tasks in one pass. This avoids the *task A and task B edit the same word differently* coordination problem that parallel tasks would create.

### The cursor-adjacency rule

One of the key UX details. The agent never edits the word the user is currently typing.

```
I have somm con|
  → agent fixes "somm" to "some"; skips "con" (still being typed)

I have somm concerns|
  → agent evaluates "concerns" normally; no fix needed
```

Without this rule, the agent fights the user's typing. It autocorrects partial words mid-keystroke, creating a tug-of-war between the user's intention and the agent's interpretation. This exclusion is small and specific, but it is the rule that makes the agent feel cooperative instead of adversarial.

### Track changes without the review pane

Existing AI-edit features imitate Word's review pane: a separate surface where the user sits down to triage agent suggestions. Inline Agents do the same job without the surface.

- Edits are dimmed inline. The user sees them in the flow of their text.
- Reverting an edit is two keys: navigate to the dim with `Ctrl+Alt+Left/Right`, then cycle back with `Ctrl+Alt+Down`. No *right-click → reject suggestion*. No popup confirming the rejection.
- There is no *approve all* or *reject all* modal. Each edit lands automatically; reverting is the only per-word gesture the user needs. The whole draft is committed when the user submits it, however the host handles submission (`Enter` in a chat input, Send in an email client, posting a form).
- Triage happens as the user composes; there is no separate review session.

Google Docs Suggestions established the per-edit grain and the live-update flow; Inline Agents extend the same model into every text field, with an LLM as the proposer rather than another human.

### The agent never presses Enter: the safety boundary

The agent edits in place in the user's draft. The user is the one who finally commits the action by pressing `Enter`, by sending the message, by submitting the form. Until then, every change the agent has made lives only in the user's unsent draft.

This is meaningfully different from standard agentic-tool design.

- **Standard agents** can run terminal commands, send messages, modify files, commit code, call external APIs. The blast radius is whatever the agent's tools allow.
- **Inline Agents** edit text in a draft the user has not yet submitted. The blast radius is the user's draft, which they have not sent yet.

The safety boundary is not *limiting the agent's tools*; it is *never letting the agent cross the surface where the user's draft becomes a committed action*.

### Remembering what has been checked

This is the mechanism that makes the agent feel coherent across edits and prompt changes.

The agent compares the current document to the last one it processed. If the text, the task, and the cursor position are all unchanged, the agent skips the run entirely. If any of them differ, the agent checks a small cache of recent rewrites for an exact match before calling the LLM. Things that force a re-run:

1. **Document text changed** → recompute.
2. **Task changed** (via `agentically` or `add task`) → recompute.
3. **Cursor moved** to a different sentence → recompute. The same word can need different edits depending on the sentence it sits in.

The auditor list and the window-size setting also invalidate the cache when they change, though they rarely do.

Practical consequence: when the user runs `correct spelling` for a while, then types `add task fix humour _`, the task no longer matches and the agent re-reads the entire document on the next run. The user gets the right behaviour without thinking about it.

### Lightweight: the latency budget

What "lightweight" means in practice:

- **Cadence:** the agent runs after a 1000ms pause in typing by default (configurable via `agent-debounce-ms`).
- **Per-run latency:** typically a few hundred milliseconds on Cerebras (`gpt-oss-120b`), depending on document size.
- **Apply-side validation:** the runtime diffs the LLM's rewrite against the buffer it sent, then drops any edit hunk that overlaps text the user typed while the LLM was generating. Rewrites that come back identical, empty, or suspiciously truncated are rejected outright.
- **Soft-fail:** if the LLM returns nothing or hits a rate limit, the run produces no edits. The next pause is the implicit retry. There is no retry loop inside the run, since that would compound rate-limit failures.

### Stop semantics: no auto-revert

`stop task _` clears the active task and stops the agent. The `[task: ...]` line in the status display disappears. **Existing dimmed edits remain in the text.** The user can revert any individual edit by navigating to the dimmed word with `Ctrl+Alt+Left/Right` and pressing `Ctrl+Alt+Down` to cycle it back to the original.

The principle: don't auto-revert. While the task ran, the user could revert any individual edit; not doing so is implicit consent. Rolling back on stop would erase those consents.

---

### The mechanism

The user-facing surface isn't the only interesting part of Inline Agents. The runtime is too.

The agent's edits are indistinguishable from any other LLM source's results at the data-structure level. They use the same data structure as every other cue. They get dimmed by the same render pipeline that dims [Inline Cues](inline-cues-continuous-onboarding.md). They get skipped by the same ownership filter that protects resolved `_` results. They get reverted via the same cycling primitive the user already knows from word cues.

Adding the Inline Agents feature did not require new visual code, new cycling code, new ownership code, or new state-management code. The runtime's primitives were already generic enough. The agent added a small piece of state (the active task and a small rewrite cache), a routine that listens for text changes, and three new routes that send task-starting phrases to the agent. Everything else was already there.

> A two-direction framework that holds the right shape makes new affordances multiply without proportional code growth.

### Lineage: Google Docs Suggestions

Google Docs Suggestions is the closest existing analogue. A proposer marks alternatives in a separate visual layer; the accepter reviews per-item; the proposer's marks are non-blocking so the accepter keeps writing while marks accumulate; accepting or rejecting a single suggestion is one click.

Inline Agents extend the same pattern with three changes:

| Google Docs Suggestions | Inline Agents |
|---|---|
| Proposer is another human | Proposer is an LLM |
| Visual layer is strike-through + colour | Visual layer is the dim |
| Default state is the original (suggestion pending) | Default state is the edit applied (original cyclable back) |
| Acceptance is an explicit click | Acceptance is doing nothing; only reverting is an action |
| Trigger is *"I'll suggest this"* | Trigger is `agentically <X> _` |
| Lives in Google Docs | Lives in any text input across any host |

The lineage matters because the per-edit grain and the live-update flow are already familiar to anyone who has used Suggestions mode. Two things are new: the inverted default (edits are live, only reverting is an action) and the in-line starting gesture (`agentically <X> _`).

### HCI 3-Axis Analysis

Scoring Inline Agents against the HCI (Human to Computer Interface) 3-Axis Analysis:

- **Start-up frames:** one phrase to start (`agentically <X> _`). The user does not leave the document to issue the command. No chat panel to switch to, no agent dashboard, no settings page.
- **Active window duration:** once started, the agent runs in the background after a brief pause in typing. The user keeps typing. They are not prevented from doing other things while the agent thinks. Edits arrive in the dim layer, not in the typing flow.
- **End-lag:** edits appear in the document the user is already in. Reverting an edit is two keys: navigate to the dim, then cycle back. Stopping the agent (`stop task _`) is one phrase in-line. There is no agent-dismiss UI, no return-to-region navigation, no separate surface to close.

Standard chat-panel agents incur heavy frames on all three axes: the user switches to another surface to start, waits while the agent runs, and switches back when it finishes. Inline Agents collapse all three because they never leave the text the user is already writing in.

### Looking forward

Inline Agents are the continuous extension of Inline Prompting. Same primitive, same routing surface, same `_` summon, held active across keystrokes rather than running once per `_`.

What I want to see next is local-model integration. The LLM call goes through a generic provider interface, so adding a local provider is a configuration change, not a runtime change. Consumer hardware running quantised 3B-8B models is within striking distance of the sub-second TTFT (Time to First Token) the agent needs to feel snappy. The agent following the user across hosts is already real; the agent running entirely on the user's machine is the next step.

I am excited to work with the community to extend `Google Doc-ifying` to every input box.

---

See Also: [HCI](hci-human-to-computer-interface.md) · [Human Interaction](human-interaction.md) · [Inline Prompting](inline-prompting-blank.md) · [Inline Cues](inline-cues-continuous-onboarding.md) · [Seamless Integration](seamlessly-integration.md)
