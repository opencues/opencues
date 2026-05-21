---
type: blank
name: volume
description: System volume — get, set, and cycle in 6% steps
blankKeywords: volume
blankScript: ./volume-blank.sh
blankStep: 6
blankSuffix: "%"
blankFormat: integer
blankAutoPopulate: true
spec: opencues/0.1-alpha
---

Conformance note: this fixture's BLANK.md declares `blankScript:` but the suite intentionally does NOT ship the script file. Runtimes parsing this fixture in isolation should accept the frontmatter; the `blank-script-missing` rule fires only when the runtime also walks the script path. Suite consumers who want to exercise `blank-script-missing` should drop a sibling `volume-blank.sh` next to this fixture in their test fixture-prep, or rely on the matching invalid fixture under `invalid/blank/`.
