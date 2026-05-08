---
name: opencues-defaults
description: Default project-level auditor configuration
spec: opencues/0.1-alpha
disable: []
---

# AUDITORS.md — auditor-surface master

This file declares project-wide auditor configuration. The `disable:` list
in frontmatter SUBTRACTS named auditors from this layer's composition
without modifying the user's `~/.cues/auditors/` library.

To skip the user-level `grammar` auditor for this project:

```yaml
disable: [grammar]
```

Multiple auditors can be disabled:

```yaml
disable: [grammar, clarity]
```

Auditors live one folder per concern under `auditors/<name>/AUDITOR.md`.
The runtime concatenates all enabled auditors into ONE LLM call per
rewrite — never one call per auditor. See `spec/auditor-spec.md`.
