---
name: pii-redact
description: Redact PII inline (emails, phones, postal addresses) with [REDACTED] markers
priority: 90
enabled: true
expected-changes: [redaction-marker]
on-host: [chrome, claude-code, gemini-cli, opencode]
spec: opencues/0.1-alpha
---

Identify PII in the buffer (email addresses, phone numbers, postal addresses, government IDs). Replace each PII span with the literal token `[REDACTED]`. Preserve all other text exactly. If the buffer contains no PII, return it unchanged.

Do NOT redact PII that appears inside quoted examples (text in backticks or fenced code) — those are illustrative, not real user data.
