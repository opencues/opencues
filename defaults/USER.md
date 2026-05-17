---
# Uncomment + fill the fields you want OpenCues to use.
# Then set `user-context-mode: safe` in OPENCUES.md to activate.
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

# USER.md — your personal data for OpenCues

The frontmatter above is the catalog. Each key auto-derives a
sentinel token: `firstName` → `[FIRST NAME]`, `workCity` →
`[WORK CITY]`, `github` → `[GITHUB]`.

When `_` is typed in a labelled form field, OpenCues sends the
catalog to the LLM as sentinel tokens. In `safe` mode (recommended)
the LLM only sees token names; a post-processor substitutes the
real values locally — your PII never reaches the LLM provider.

Spec: `docs/architecture/user-context.md`.
