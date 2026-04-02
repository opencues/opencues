---
last_updated: 2026-04-02
---

# Glossary

## Core Concept

**Cue** — An indication provided to a user *before* they press enter and submit a prompt. The idea behind cues is to steer users as they construct their prompt, surfacing alternatives, suggestions, and context while they're still writing.

---

## Types of Cues

**Visual Cue** — The indication within the body of text that additional information is available. For example, a word appearing dimmed signals that alternatives exist for it.

**Alternatives** — The information which is switched out when the user cycles. A word's alternatives are the set of values it can be replaced with (e.g., "happy" → "sad", "excited", "content").

**Cue-Tips** — The information displayed within the secondary area. When a word is highlighted, its cue-tip provides context about what the word means or why the alternative was suggested.

**Cue-Actions** — Cues that trigger external actions rather than modifying text. For example, "volume" triggers system volume control instead of cycling through alternatives.

**Blanks** — Underscores (`_`) which are automatically computed and re-evaluated based on surrounding context. Blanks can be automatically moved to their first option if a setting is enabled.

**Linked Words** — Words that must change together when any one of them cycles. For example, changing "boy" also changes "his" to "her" to maintain agreement.

**Multi-Word Group** — An alternative that consists of multiple words (e.g., "Sundar Pichai"). Tracked as a single unit that cycles together.

---

## Sources

**Local Cues** — Cues computed locally on your machine that return a result near-instantly (~0ms). Tips file lookups are local cues.

**Remote Cues** — Cues computed externally utilising an LLM or other system (~200-500ms). Grammar, math, and factual alternatives are remote cues.

---

## Display

**Secondary Display** — Where additional information (cue-tips) is shown. It is not in the text input box. The integration decides what this is — a status bar, tooltip, hover panel, sidebar, etc.
