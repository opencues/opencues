---
name: project-auditors
domain: project
version: 1
disable: []
---

# AUDITORS.md
#
# Auditors: a continuous, whole-buffer variant of a Cue. Each auditor
# declares ONE concern (grammar, clarity, tone, ...) and applies it as
# an ongoing, revertable rewrite of the buffer — not a per-word cycle.
#
# This master file is OPTIONAL. A project with no AUDITORS.md simply uses
# every auditor under `auditors/` (composed with the user-level auditors
# in ~/.cues/auditors/ per the composition rules below).
#
# ─────────────────────────────────────────────────────────────────────
# THIS FILE — surface-wide configuration only
# ─────────────────────────────────────────────────────────────────────
#
# The frontmatter above is the whole contract; this body is documentation.
# The one field that does anything is `disable:`.
#
# `disable:` is a SUBTRACT. It removes named auditors from THIS project's
# composition without touching the user's ~/.cues/auditors/ library. cd
# out of the project and the auditor fires again. cd-ing into a project
# should EXTEND what the user has, never silently remove it — so there is
# no project-level "enable"; only opt-in subtraction.
#
#   To skip the user-level `grammar` auditor for this project:
#
#     disable: [grammar]
#
#   Multiple:
#
#     disable: [grammar, clarity]
#
# ─────────────────────────────────────────────────────────────────────
# DEFINING AN AUDITOR
# ─────────────────────────────────────────────────────────────────────
#
# Auditors live one folder per concern:
#
#   .cues/auditors/<name>/
#     AUDITOR.md        — the concern's frontmatter + prompt body
#
# AUDITOR.md frontmatter:
#
#   ---
#   name: grammar
#   type: auditor
#   priority: 50          # merge order when multiple auditors compose
#   ---
#   Fix grammar and spelling mistakes. Do not change meaning or tone.
#
# The prompt BODY itself decides whether the concern applies to a given
# buffer — auditors are not gated by `match:`/`keywords:`. Lower-priority
# auditors' edits are diff-merged over higher-priority ones.
#
# The runtime runs each auditor as its own parallel LLM call (isolated
# mode) and diff-merges the results by `priority:` order — one auditor's
# prompt never steers a sibling's call.
#
# Scaffold examples live at defaults/auditors/{grammar,clarity}/AUDITOR.md.
#
# For the full contract see docs/guides/adding-an-auditor.md and
# spec/auditor-spec.md.
