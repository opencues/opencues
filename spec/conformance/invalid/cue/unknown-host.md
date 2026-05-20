---
name: scoped-too-narrow
description: References a host the standard doesn't know
match: foo
priority: 50
on-host: [nethack-cli]
---

Body present. `on-host:` references `nethack-cli` which isn't a known host name per core.md § Host compatibility.
