---
# Uncomment + fill the fields you want OpenCues to use.
# Then set `identity-context-mode: safe` in OPENCUES.md to activate.
# firstName:
# lastName:
# email:
# github:
# linkedin:
# website:
# workCity:
# company:
# jobTitle:
# phone:
---

# IDENTITY.md — your personal data for OpenCues

The frontmatter above is the catalog. Each key auto-derives a
identity-context token: `firstName` → `[FIRST NAME]`, `workCity` →
`[WORK CITY]`, `github` → `[GITHUB]`.

When `_` is typed in a labelled form field, OpenCues sends the
catalog to the LLM as identity-context tokens. In `safe` mode (recommended)
the LLM only sees token names; a post-processor substitutes the
real values locally — your PII never reaches the LLM provider.

Spec: `docs/architecture/identity-context.md`.
