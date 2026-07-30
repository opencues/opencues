---
# ─────────────────────────────────────────────────────────────────
# example — minimal hello-world cue
#
# A deliberately tiny word-cue source you can copy-and-edit.
# Larger shipped cues (more-formal, spelling) carry more fields for
# many reasons; this one shows the minimum that fires.
#
# What it does: when you type `hi`, `hey`, or `hello`, the runtime
# claims that word and offers three formal-greeting alternatives.
# Navigate to the word with Ctrl+Alt+Right, cycle with Ctrl+Alt+Up.
#
# How the runtime picks it up: every file under defaults/cues/<name>/
# auto-discovers via the folder loader. After `opencues seed-configs`
# (or with the dev loop's hot-reload) this exact file lives at
# ~/.cues/cues/example/CUE.md and the runtime polls it on every
# keystroke. Editing the prompt body or match: regex below picks
# up within ~2.5s — no restart.
#
# To turn it off without deleting: add `enabled: false` to the
# frontmatter, or add `example` to ~/.cues/CUES.md's `disable:`
# array.
# ─────────────────────────────────────────────────────────────────

# Required — must match the folder name (the runtime keys on this).
name: example

# Shipped OFF — this pack is tutorial scaffolding to copy + edit,
# not a default-on cue. Remove the line (or set true) to enable it.
enabled: false

# Output shape: alternatives (the LLM emits INDEX:alt1,alt2,...).
# Other choices: raw (verbatim string), answer (single value).
parser: alternatives

# When this cue applies: per-word on plain text. Other scopes are
# `blanks` (only when `_` is in the buffer), `sentence` (whole-
# sentence rewrites — needs sentence-cues-mode: on), and `all`.
scope: words

# Higher priority wins when multiple sources match the same word.
# Shipped priorities: more-formal=85 (sentence), spelling=10 (catch-all).
# 65 sits above the spelling catch-all but below higher-priority cues,
# so the example claims its own words without shadowing anything else.
priority: 65

# Trigger: any word matching this regex routes to THIS source.
# RoutedWordSourceGroup dispatches each highlighted word to exactly
# one source — first match wins by priority. Words no source claims
# are not navigable as alternatives.
match: \b(hi|hey|hello)\b
---

Rewrite each input word as a more formal greeting. Output the
INDEX of the input word followed by 1-3 comma-separated
alternatives. One line per word.

Examples:
  hi    → 0:hello,greetings,good day
  hey   → 0:hello,greetings,good morning
  hello → 0:greetings,good day,good morning

Do NOT include the input word in the alternatives.
Do NOT add prose, explanations, or markdown — alternatives only.
