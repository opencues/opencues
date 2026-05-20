---
title: Human Interaction
date: 2026-05-06
description: Human conversation is faux turn-based, with constant non-blocking cues. Current LLM chat is strictly turn-based, with none.
tags: [hci, communication, non-blocking, llm, foundational]
cross_links: [hci-human-to-computer-interface, inline-cues-continuous-onboarding, inline-prompting-blank, inline-agents, seamlessly-integration]
---

# Human Interaction

Humans don't really take turns. While one person speaks, the other steers via nods, expressions, micro-vocalisations, and glances at the door. The resulting conversation feels fluent because the listener never has to wait their turn to be heard.

Current LLM chat strips all of this away. The user types, submits, waits, reads, types, submits. As Head of HCI (Human to Computer Interface) at Command Stick, I find this gap fascinating, and pivotal to where AI HCI should go next.

---

### Faux turn-based: how humans actually communicate

Humans speak one at a time but communicate continuously. The non-verbal cues that flow during a single conversation:

- **Affirmative:** nodding, smiling, leaning in, sustained eye contact, raised eyebrows, "mhm" / "uh-huh" backchannel sounds.
- **Negative or pushback:** head shake, frown, furrowed brow, leaning back, breaking eye contact, the "I'm about to interject" intake of breath.
- **Confusion or slow-down request:** squinted eyes, head tilt, hand raised slightly, "wait, hmm" sound.
- **Wrap-up signals:** looking at the watch, glancing at the door, packing up belongings, the polite-but-firm "right ...".
- **Continuation prompts:** keeping eye contact through a pause, slight forward lean, the deliberate extra beat of silence.
- **Emotional colouring:** smile vs grimace, gasp vs sigh, eye-widening on surprise, a single laugh.

Each is sub-second, non-blocking, and on a different modality from the speaker's words. The speaker continues; the listener has communicated.

[Albert Mehrabian's research](https://en.wikipedia.org/wiki/Albert_Mehrabian) on emotional communication put numbers to the asymmetry: roughly 55% body language, 38% tone of voice, and 7% the words actually spoken. The original study was about communication of attitudes when channels conflict, and the figures don't generalise to all communication. Even with that caveat, the relative weights are striking. Words, the part current LLM chat captures, are the smallest channel. The other 93% is what the turn-based chat paradigm is throwing away.

### Non-blocking cues, digitised

Humans have already invented digital versions of this pattern. The reactions in WhatsApp let you respond to a message without producing a new message that shifts the chat window. Typing indicators ("Wilfred is typing...") signal that someone is composing without producing a chat message of their own. Read receipts mark acknowledgement without requiring a reply. Google Docs presence cursors show another user's caret moving in real time, on a separate visual layer, without disturbing the document.

The pattern extends into single-user software too. Spell-check red squiggles since the 1990s, Grammarly underlines, IDE inlay hints, Copilot ghost text, browser address-bar autocomplete, search-engine "did you mean...?" suggestions: each is a system → user cue that lives in a separate visual layer and is fully ignore-able. The user takes the suggestion or not, with no commitment cost on either side.

Each of these surfaces shares a structural property: the cue lives outside the user's primary input channel. It steers without blocking.

### What current LLM chat lost

LLM chat is not just turn-based. It is *stricter* than turn-based human conversation. In most chat interfaces:

- The model cannot steer the user as they construct a prompt; there is no channel for it to nudge, suggest, or signal understanding until the user submits.
- The model cannot signal "I am uncertain" or "you are leading me wrong" partway through generating; it commits to a full response and the user reads the whole thing.
- The user cannot interrupt mid-stream without losing context.

We have regressed from human conversation rather than matched it. Faux turn-based human dialogue has constant steering. Strict turn-based LLM chat has none.

### Why non-blocking cues work: the modality rule

Underneath the examples is one mechanism. Two people speaking at the same time produces chaos. Two people texting each other in real time produces interleaved confusion. But one person speaking and the other nodding produces *steered* communication, because nodding doesn't occupy the audio channel.

The same principle explains why the WhatsApp reaction works and why a "👍" sent as a message would not. The reaction lives in a separate visual layer attached to the original message. The same emoji sent as a message would shift the chat window and demand attention from the recipient as they composed their reply.

This should be a foundational rule when designing AI HCIs:

> To create an optimal experience, any cue between a user and an AI system should use a different modality than the user's primary input channel.

If the user is typing, the system's cue can be a visual mark, an underline, a status-line note. It cannot be a popup that takes focus. If the user is speaking, the system's cue can be visual or haptic. It cannot be audio that competes with the user's voice. The modality rule is what separates a cue that helps from a cue that interrupts.

### Looking forward

The hope is that we evolve out of strict turn-based AI chat the same way humans evolved out of strict turn-based speech: by inventing non-blocking signals that steer without interrupting.

---

See Also: [HCI](hci-human-to-computer-interface.md) · [Inline Cues](inline-cues-continuous-onboarding.md) · [Inline Prompting](inline-prompting-blank.md) · [Inline Agents](inline-agents.md) · [Seamless Integration](seamlessly-integration.md)
