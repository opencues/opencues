---
name: unreachable
description: Declares neither match: nor keywords: — unreachable
priority: 50
---

Body present but no trigger declared. The source would never claim any word; validators MUST reject as unreachable.

(A source with no trigger AND no priority IS the DEFAULT/catch-all per core.md routing, but ONLY when the runtime is reading the master file — folder-based per-source files MUST always declare a trigger.)
