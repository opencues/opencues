---
name: model
# Multi-line get() output is ONE answer (a card), not a list of
# cycleable alternatives - join the lines into the buffer (opencues #339).
blankMultilineIsAnswer: true
type: blank
tip: Which LLM you're routed to
# `model` → the effective provider · model (what dispatch actually
# uses); `models` → the provider/model catalog. One blank, the trigger
# keyword picks the output mode (same pattern as location's map).
blankKeywords: model, models
# Explicit shapes REPLACE the keyword-synthesized grammar (authored
# shapes win) — deliberately, because "model" is a common English word
# and this blank must ONLY claim question-shaped commands, never prose
# like "the model returned garbage _". Shape-gated blanks bypass the
# keyword window entirely. First match wins:
#   1. bucket-scoped     "model for cues _" / "whats my model for blanks _"
#   2. catalog           "list models _" / "models _" / "available models _"
#   3. current           "model _" / "whats my model _" / "what model am i using _" /
#                        "current model _" / "which model is this _"
# Every shape captures its FULL question (valueGroup) on purpose: a
# captured arg consumes the command span, so the answer replaces the
# question instead of trailing it ("whats my model cerebras · …" would
# read as prose corruption). Shape 1 captures only the bucket word —
# that IS the arg the blank reads — and consumes the span the same way.
blankShapes: [{"pattern":"^(?:what(?:'s|s| is) )?(?:my |the )?model for (cues|auditors|blanks)\\s*\\??\\s*_$","action":"get","valueGroup":1},{"pattern":"^((?:list |show |available |what )?models)\\s*\\??\\s*_$","action":"get","valueGroup":1},{"pattern":"^((?:what(?:'s|s| is) )?(?:my |the )?(?:current |active )?model(?: am i (?:using|on))?(?: in use)?)\\s*\\??\\s*_$","action":"get","valueGroup":1},{"pattern":"^(which model(?: (?:am i (?:using|on)|is (?:this|active|in use)))?)\\s*\\??\\s*_$","action":"get","valueGroup":1}]
blankAutoPopulate: true
blankFormat: string
# Clearing is SHAPE-DERIVED (the blankReplace dial was deleted, June 2026):
# a bare keyword get keeps its label — "whats my model _" fills the `_`
# and the lead-in stays.
blankClearOnEdit: true
blankDismissible: true
as-context: off
---

Implementation: built-in `ModelBlank` in `@opencues/runtime`
(`packages/opencues-runtime/src/blanks/model.ts`). Every host wires it
via `createDefaultBlanksRegistry` (needs the host's `opencuesMdIO` —
the blank reads the routing scalars from OPENCUES.md on every
invocation, so settings changes reflect on the next `_`).

The answer comes from `@opencues/core`'s `resolveEffectiveRouting` —
the SAME precedence walk dispatch runs (bucket scalar > global
`llm-provider` > auto-route over available keys > subscription-CLI
rung), so the blank can never report a model that differs from what a
real LLM call would use. Doctor's LLM-routing section and `opencues
models` sit on the same walk.

Output modes:

- **`whats my model _`** (and variants) → the blanks-bucket effective
  route: `cerebras · gpt-oss-120b`. When the three buckets differ the
  answer is tagged `(blanks bucket — buckets differ)`. On cycling
  hosts, Up surfaces two more alts: the per-bucket breakdown
  (`cues: … | auditors: … | blanks: …`) and the source attribution
  (`provider from llm-provider · model from provider default`).
- **`model for cues _`** / `auditors` / `blanks` → that bucket only,
  plus its source attribution as a cycling alt.
- **`list models _`** / `models _` → one line per provider:
  `cerebras (current): gpt-oss-120b*, zai-glm-4.7, gemma-4-31b, qwen-3.8-27b`, then
  key-set providers, then keyless ones. `*` marks the model currently
  in effect; the curated lists are each provider's `knownModels` (the
  same set the config menu and fluid-config classifier offer — models
  outside it remain hand-edit-only by design).

Degraded states are named, never silent: a configured provider whose
key is absent shows `(key missing)`; an unknown provider id shows
`(unknown provider — calls disabled)`; nothing configured at all →
`no LLM configured — add a key (opencues set-key) or set llm-provider:
in ~/.cues/OPENCUES.md`.

Switching stays with the existing paths: natural language via
fluid-config (`use qwen for blanks _`), cycling via
`opencues blanks-llm-model _`, or the `opencues config` menu.

Read-only: no cycling required, so the blank also runs on no-cycling
hosts (chrome's plain-input profile) — the extra alts simply don't
surface there.
