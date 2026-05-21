---
voice-mode: inactive
tips-mode: on
debug-mode: off
fluid-blank-mode: on
word-cues-mode: on
blank-trigger-mode: immediate
llm-provider: groq
agent-debounce-ms: 800
---

**Non-standard.** `OPENCUES.md` is the OpenCues runtime's settings file. Its schema lives in [`@opencues/runtime`'s `SPEC.md`](../../../../packages/opencues-runtime/SPEC.md), not in `core.md`. Other runtimes that park their config in a different file are conformant — this fixture is included so reference-implementation runners have a canonical example to parse.

Conformant runtimes that do NOT recognise the OpenCues-runtime keys MUST preserve the file (don't error, don't overwrite) and ignore the keys.
