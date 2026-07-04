---
last_updated: 2026-07-04
---

# Linked Words

> ⚠️ **Not implemented in the current runtime.** This page describes a
> feature that existed in the pre-refactor Claude Code patch (the
> `globalThis`-based `_cycleAlt`/`_dynDefs` system) and has NOT been
> carried over to `@opencues/runtime`'s modular `Cycling`/`DynDefs`
> system. Read this as a design record / possible-future-work
> reference, not as current behavior.

Linked words are words that must change together when any one of them cycles. When the user cycles "boy" to "girl", the pronoun "his" would simultaneously become "her". The idea was for an LLM prompt to detect these semantic relationships and return them as index arrays on each word definition.

---

## Current status

- **`CueResult.linked?: number[]`** still exists on the type (`packages/opencues-core/src/types.ts:28`), and the resolver still merges `linked` arrays across sources when present (`resolver.ts:323-333`) — this plumbing was never removed.
- **Nothing produces real `linked` data today.** A `prompts/linked.txt` reference file still sits in `packages/opencues-core/prompts/`, but no source class loads or dispatches it — grepping for `linked.txt`/`LINKED_PROMPT` across `opencues-core/src/` returns zero hits. `LocalCueSource` always sets `linked: null` on its own entries; it only merges the field through if some other source populates it, which none currently do.
- **Nothing consumes `linked` in the runtime.** `packages/opencues-runtime/src/modules/cycling.ts` has zero references to `linked` — cycling a word today never propagates to any other word, co-dependent or not.

So the field is a vestige: real in the type system, inert everywhere else. If you're implementing a new integration, you can safely ignore `linked` — nothing sets it and nothing reads it.

---

## If this gets reimplemented

The original design, for reference:

1. An LLM prompt would analyze the input and return `linked` index arrays on each `CueResult` — e.g., word 0 ("boy") gets `linked: [3]` and word 3 ("his") gets `linked: [0]`. Relationship types envisioned: gender agreement, number agreement, verb agreement, possession.
2. The relationship is symmetric — if word A lists B, word B lists A.
3. When cycling a word with a non-empty `linked` array, every linked word's `currentAltIndex` would update to match, with all text replacements committed as a single atomic buffer update (never partially visible).

Any reimplementation would need to fit into the CURRENT architecture: DynDefs-keyed state, the `Cycling.step()` priority chain (see [Word Cycling](cycling.md)), and the shared `HostAdapter.setText` commit path — not the retired globalThis mechanism described in older revisions of this doc.

---

## Portability

### Standard (opencues-core)

- `CueResult.linked` is part of the standard's data shape and the resolver merge logic honors it if populated — but no shipped source populates it today
- The standard does not mandate a specific detection prompt or mechanism; `linked` is meant to accept relationships from ANY source (LLM-detected or otherwise)

### Integration responsibilities

- None today — no integration needs to implement linked-word propagation, since no source emits `linked` data to propagate
- If you build a source that DOES populate `linked`, your integration is responsible for the propagation behavior described above (it isn't provided by the shared `@opencues/runtime` `Cycling` module)
