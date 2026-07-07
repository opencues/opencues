---
"../etc/passwd": some-value
---

# IDENTITY.md with a path-traversal key. The key `../etc/passwd` does
# not match the required shape [A-Za-z][A-Za-z0-9_-]* and MUST be
# rejected at write time (error: invalid-key). Shell-meta keys
# (`foo;rm`), leading digits, and unicode tricks fail the same gate.
