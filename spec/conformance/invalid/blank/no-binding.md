---
name: no-impl
description: Declares neither stepValues, blankScript, nor impl
blankKeywords: foo
---

Frontmatter has no binding profile. Implicit-impl-by-name would resolve to `NoImplBlank`, but if the runtime can't find that class, this is a load error.
