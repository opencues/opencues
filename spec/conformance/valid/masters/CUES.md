---
name: example-project
description: Cue-surface master for a project
spec: opencues/0.1-alpha
tips-mode: on
word-cues-mode: on
ignore: [TODO, FIXME, XXX]
disable: [legal]
---

Optional Markdown body — human-readable project notes. Runtimes MUST ignore the body; only frontmatter contributes to configuration.

The `ignore:` list scopes to this surface: words listed here never produce cues, regardless of which source would have matched them. The `disable:` list subtracts named cue sources from this layer's composition without modifying the user-level library.
