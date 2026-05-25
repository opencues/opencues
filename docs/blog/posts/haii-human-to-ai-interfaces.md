---
title: Human-to-AI Interfaces (HAII)
date: 2026-05-24
description: HAII is to AI what HCI is to computers. A sister discipline with its own constraints, affordances, and failure modes, and a manifesto for treating it that way.
tags: [hci, haii, manifesto, harness, discipline]
cross_links: [hci-human-to-computer-interface, human-interaction, inline-cues-continuous-onboarding, inline-prompting-blank, inline-agents, cross-domain-pollination]
---

# Human-to-AI Interfaces (HAII)

HAII (Human-to-AI Interface) is the design discipline concerned with how a human extracts value from an AI system. The interface, the harness, the prompt scaffolding, the output rendering, the error handling: everything that sits between the user and the model.

I coined the term to make the discipline investible. As a HCI (Human to Computer Interface) specialist of seven years at Command Stick, I have watched the AI industry default to "the chat box" because the field has no shared vocabulary for anything else. Naming the discipline is the first step to expanding it.

---

### Why HAII is its own discipline

HAII is technically a subset of HCI. AI systems are computer systems, so any interface to an AI is also an interface to a computer. But the everyday assumptions of HCI break in HAII territory:

| Property | Classical HCI | HAII |
|---|---|---|
| Output | Retrieved / deterministic | Generated / variable |
| Same input → same output? | Yes | No |
| Behaviour stable across sessions? | Yes | No (model upgrades, tuning) |
| Output length predictable? | Yes | No |
| System can be "wrong in plausible ways"? | Rarely | Routinely |
| Latency budget | ~100ms or it feels broken | 200ms–10s, often visible to user |
| Cost per interaction | Effectively zero | Non-trivial, varies by model |

Each row is an assumption HCI baked in over four decades that HAII has to consciously *unbake*. A HAII designer cannot reach for *"the system always responds the same way"* or *"latency is invisible if it's under 100ms"* or *"the system never says something untrue"*. The whole grammar has to be re-derived.

This is why HAII is its own thing rather than a chapter in the HCI textbook. It is operating on a substrate the textbook did not anticipate.

### Where value compounds

Much of what users feel as "AI got better" has come from harness work, not just from new model capability. Better prompts, narrower jobs, smarter caching, sequential composition instead of single-shot: these compound dramatically without retraining anything.

The ratio of effort spent on models versus harnesses is currently lopsided. A handful of organisations on the planet have the resources to push the model frontier. Many orders of magnitude more contributors can push the harness frontier. The press coverage goes to the first group; the experienced quality gains go to the second.

A few directional lessons from the OpenCues codebase that show what harness work actually achieves:

- **Narrow jobs beat wide jobs.** In the transform-blank benchmark on `gpt-oss-120b`, splitting a single LLM call into a multi-pass pipeline outperformed the single-call version substantially. The same lesson applies to instruction composition: asking one call to do "X and Y" performed worse than splitting into two sequential calls.
- **Output tokens dominate latency.** A long input prompt with short output is faster than a short input prompt with long output. Optimise for output efficiency, not input compression.

Every one of these is a harness-level decision that changed user-felt quality without touching the model.

### Local models as the opportunity

There is a swath of open-source models, many of which run on consumer hardware. gpt-oss, Llama 4, Qwen 3, Phi-4, Gemma 3, Mistral Small, Mixtral, DeepSeek R1. The gap is not that local models don't exist; the gap is that the harnesses on top of them have not been optimised for the smaller-model regime.

The narrow-jobs lesson matters more on local models, not less. A weaker model fed wide prompts hallucinates and bails. The same weaker model fed narrow single-purpose prompts in a multi-pass pipeline performs dramatically better, because each step is something it can do, even if the whole task is not.

### The status quo

What "the status quo" looks like, listed explicitly so it can be challenged item by item:

- **Chat as the default HCI.** Every new AI product ships a chat box because every previous AI product shipped a chat box.
- **Provider lock-in.** The model and the product are bundled. Switching the model is a re-purchase of the product.
- **Cloud-only.** Most products do not work without a network connection.
- **No inline editing.** Output appears in a separate panel; the user copies it back.
- **Latency exposed, not masked.** The user watches the spinner.
- **Single-modal, turn-based input.** Type, send, wait, read, type again. No interleaved cues, no in-flight steering.
- **No per-word revertibility.** Accept all or reject all; granular revert is rare.

Each of these is a design choice, not a constraint of LLMs. Each one is open territory for HAII work to challenge.

### Tools of today, building tools of tomorrow

OpenCues is built with what OpenCues offers. Claude Code edits the runtime; LLM-as-judge runs the benchmarks; the prompts are tuned with the model in the loop. The same primitives that help the end user help the developer iterate.

### A two-direction model on text

One concrete HAII primitive, demonstrated by the rest of this series:

> **Cues** (LLM → user): the system surfaces useful information directly in the user's text.
>
> **Blanks** (user → LLM): the user places `_` to request assistance, answered in place.

### Looking forward

I would like to challenge engineers and designers around the world not to settle for the status quo (however good or well-funded it is) and to ponder what the future could be. The status quo persists because alternatives are invisible. Make alternatives visible by shipping, benchmarking, naming, and sharing, and the status quo becomes negotiable.

> Bewilderment is the enemy of invention.

We should use the tools of today to build the tools of tomorrow.

---

See Also: [HCI](hci-human-to-computer-interface.md) · [Human Interaction](human-interaction.md) · [Inline Cues](inline-cues-continuous-onboarding.md) · [Inline Prompting](inline-prompting-blank.md) · [Inline Agents](inline-agents.md) · [Cross-domain Pollination](cross-domain-pollination.md)
