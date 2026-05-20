---
name: medical
description: Clinical terminology with synonym support
match: \b(diagnos|prognos|sympt|patho)\w+\b
keywords: patient, clinical, diagnosis
priority: 75
parser: alternatives
provider: anthropic
model: claude-haiku-4-5
enabled: true
classify: Clinical vocabulary, patient-facing medical writing
on-host: [chrome, claude-code, gemini-cli, opencode]
spec: opencues/0.1-alpha
---

Propose two clinical-vocabulary alternatives per matched term.

Format: INDEX:alt1,alt2
