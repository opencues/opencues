---
name: plain
description: Plain-language alternatives with synonym support
match: \b(utiliz|facilitat|endeavor|ascertain)\w+\b
keywords: verbose, wordy, formal
priority: 75
parser: alternatives
provider: anthropic
model: claude-haiku-4-5
enabled: true
classify: Verbose vocabulary, plain-language rewriting
on-host: [chrome, claude-code, gemini-cli, opencode]
spec: opencues/0.1-alpha
---

Propose two plain-language alternatives per matched term.

Format: INDEX:alt1,alt2
