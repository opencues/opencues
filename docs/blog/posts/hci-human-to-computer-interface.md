---
title: HCI (Human to Computer Interface)
date: 2026-05-06
description: HCI is any means through which we interface with a computer. The sharpest framework I know for evaluating one is borrowed from fighting games.
tags: [hci, framework, fighting-games, foundational]
cross_links: [human-interaction, inline-cues-continuous-onboarding, inline-prompting-blank, inline-agents, cross-domain-pollination, seamlessly-integration]
---

# HCI (Human to Computer Interface)

A human-to-computer interface is any means by which we interact with a computer system, not just hardware. Sliders, dials, buttons, widgets, touchscreens, keyboards, chat windows, dropdown menus, command palettes, swipe gestures, swipe-to-type: all are HCIs, all were invented by someone, all were chosen over alternatives.

I have spent seven years inventing and patenting HCIs at Command Stick, across desktop, mobile, tablet, and smartwatch platforms. The work taught me to evaluate HCIs more rigorously than my discipline typically does, and that rigour came from an unexpected place.

---

### Prior to the framework

HCI evaluation in design schools and product teams tends to lean on heuristic checklists: Nielsen's ten heuristics, Fitts's law, the speed-accuracy tradeoff. These are useful, but they answer a different question than the one I needed answered. They tell you whether a HCI is *usable*. They don't tell you whether using it makes a user feel *fluent*: in the zone, mid-task, doing the thing.

What I kept needing to say:

> It's usable, but within a workflow it's the slowest part.

> Each step works on its own; using them in sequence works, but it's missing something.

### With the framework

I borrowed three terms from fighting-game design. Players in those games have spent thirty-plus years refining language for exactly the property I needed to name: how committal is each move, and what does it cost the player who throws it?

The three terms map cleanly onto HCI evaluation as axes: **start-up frames**, **active window duration**, and **end-lag**. Once I had them, gaps in existing HCIs became obvious in ways they hadn't been before.

---

### Start-up frames

How long the user must wait, or how many pre-requisite actions they must take, before they can engage the HCI at all.

The naive read is "my button responds instantly so start-up frames are zero." That misses the actual cost. Start-up frames count *from where the user already is*, not from where the HCI sits. A button on a different screen has high start-up frames even if its click latency is zero, because the user must navigate, refocus, locate. A keyboard shortcut depends on hand position: near-zero start-up frames if the user is already typing; the switch from the mouse adds additional start-up frames.

Reducing start-up frames is the HCI design decision that makes a HCI feel "always accessible" at a moment's notice.

### Active window duration

How long the HCI's process actually takes to finish, from the moment the user initiates the action to the moment the result is returned.

A blocking modal is the canonical bad case: the user initiates the action and is prevented from doing anything else until it completes. Active window duration cannot be circumvented with background processes. If the user needs the result to proceed, they are still waiting for it to return. Allowing them to keep typing while the operation runs softens the perceived cost but does not shorten the actual duration. The operation's time-to-completion governs how soon the user can move onto the next task.

Reducing active window duration is the HCI design decision that lets the user move onto their next task sooner, and extends where the HCI can be applied (as does optimising start-up frames and end-lag).

### End-lag

How much effort the user must spend to return to their pre-HCI interaction state.

Modals that demand to be dismissed have end-lag. Tools that pop the user out of their current focus have end-lag. Anything that requires a "now I'll go back to what I was doing" navigation has end-lag. The ideal HCI has zero end-lag: the user finishes the action and is *already where they want to be next*.

Reducing end-lag is the HCI design decision that lets users chain actions without breaking flow.

---

### Why these three?

You could evaluate HCIs on dozens of parameters. I chose these three because they collectively measure *the user's freedom around the HCI*: before, during, after. Together they answer one question: how much of the user's time and attention does this HCI lay claim to? A HCI that scores low on all three feels fluent. A HCI that scores high on any single axis breaks flow.

> A great HCI takes nothing from the user that the work itself didn't already demand.

### Lineage: fighting games

This framework didn't come from within HCI design. It came from a domain (competitive fighting) where the language for *committal moves* had been refined for thirty-plus years by players who had to get it right under pressure. Borrowing that vocabulary didn't just hand me a label; it handed me a well-documented way of drawing parallels between the experiences I was having with a system and what the fighting-game community had spent decades analysing.

This is a strong example of [cross-domain pollination](cross-domain-pollination.md) as a design practice. The frameworks that sharpen design thinking often come from outside design.

### Beyond the three axes

The three axes are the first lens, not the only one. A second, partial lens looks like this:

- **Cognitive load:** how much working memory the HCI consumes. Procedural memory is cheap (the keyboard); declarative memory is expensive (remembering shortcuts).
- **Hand occlusion:** does the operating hand block the user's view of the input? (Touchscreens suffer.)
- **Ambiguous recipient:** can the user tell which on-screen element the input applies to? (Voice assistants suffer.)
- **Scale-independence:** does the HCI port across screen sizes without breaking procedural memory?
- **Discoverability:** can the user find the functionality without docs? (Gestures fail; menus pass.)
- **Cancellability:** can the user abort a partially-formed input?
- **Affordance:** does the HCI signal how to use it without instruction? (Door handle, yes. Swipe gesture, no.)

These get their own treatment later. For now they sit beside the three axes as honourable mentions.

---

> **Note:** HCIs that fall out of favour usually don't fail on usability. They fail because the *substrate* shifted. The stylus didn't become bad; the iPhone arrived and the substrate became the finger. Right-click as a discovery surface is collapsing on mobile. The HCIs that endure are the ones whose constraints generalise across substrates.

---

### What LLMs unlock?

We are entering an era where the substrate is shifting again. LLMs unlock a class of HCI that wasn't possible before: interfaces that respond to *intent* rather than to fixed gestures. The rest of this blog series is about that shift, the new HCIs it enables, and how the HCI 3-Axis Analysis predicts which of them will stick and which might fade away.

---

See Also: [Human Interaction](human-interaction.md) · [Inline Cues](inline-cues-continuous-onboarding.md) · [Inline Prompting](inline-prompting-blank.md) · [Inline Agents](inline-agents.md) · [Cross-domain Pollination](cross-domain-pollination.md) · [Seamless Integration](seamlessly-integration.md)
