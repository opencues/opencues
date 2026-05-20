---
name: future
description: Declares a spec version newer than 0.1-alpha
match: foo
priority: 50
spec: opencues/99.0
---

Body present. Runtimes targeting `0.1-alpha` MUST reject any file declaring a higher `spec:` value.
