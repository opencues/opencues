---
name: missing-script
description: blankScript references a path that does not exist
blankKeywords: foo
blankScript: ./does-not-exist.sh
---

Frontmatter is well-formed but the script at `./does-not-exist.sh` is missing on disk. Runtime MUST refuse to register the blank. (Suite consumers exercising this rule should ensure no `does-not-exist.sh` is dropped next to the fixture.)
