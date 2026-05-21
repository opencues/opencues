---
title: <Short title — what the proposal adds, changes, or removes>
status: draft   # draft | accepted | withdrawn | rejected
author: <Your name + GitHub handle>
date: YYYY-MM-DD
targets: [cue-spec, blank-spec, auditor-spec, core]   # which spec files this touches
---

# <Title>

## Motivation

Why this change matters. What problem in the standard does it solve? Who's affected?

Be concrete: cite a real authoring pain, a real implementer pain, or a real interop gap. "It would be nice if..." proposals tend not to land.

## Background

Brief recap of how the standard handles the relevant area today. Link to the specific spec sections (`spec/cue-spec.md` §X, line numbers if helpful). One paragraph is usually enough.

## Proposed change

The concrete BEFORE and AFTER. For a frontmatter field, show what a valid `CUE.md` / `BLANK.md` / `AUDITOR.md` looks like today versus what it looks like under this proposal:

```yaml
# BEFORE — current shape
---
name: example
match: foo
priority: 50
---

# AFTER — with this proposal
---
name: example
match: foo
priority: 50
new-field: <value>   # the proposed addition
---
```

For a behaviour change, describe the runtime contract delta in MUST / SHOULD / MAY terms.

## Conformance impact

What conformance fixtures need to land in `spec/conformance/`? List them:

- `valid/<surface>/<name>.md` — a valid example that exercises the new field/behaviour. MUST be accepted by conformant runtimes.
- `invalid/<surface>/<name>.md` — an invalid example that exercises the rejection rule (if this proposal adds a new linter rule). MUST be rejected with the named rule code.
- `wire/<name>.json` — if this proposal changes the LLM wire format.
- `routing/<name>.yaml` — if this proposal changes routing.

If this proposal doesn't extend the conformance suite, explain why (e.g. clarification that doesn't change behaviour).

## Alternatives considered

What other shapes did you consider? Why is this one preferable? Include shapes you explicitly rejected, even if briefly — future readers benefit from knowing the design space was explored.

## Backwards compatibility

Does this break files that are valid under the current spec?

- **No (additive).** Existing files keep parsing under the new spec. Promotion path: this becomes part of the next minor.
- **Yes (breaking).** Existing files become invalid. Justify the break — what does it enable that's worth the cost? Promotion path: this becomes part of the next major (or rides the alpha tag).

If unsure, default to "additive" — the standard's `unknown-field: warn` rule (per [`core.md` § Consumer behavior — unknown content](../core.md#consumer-behavior--unknown-content)) makes most additions backwards-compatible by construction.

## Open questions

Things you'd like reviewers' input on. Mark each one with a `?`:

- **? Should `<field>` default to `<value>` or be required?**
- **? How does this interact with `<other-field>`?**

## Adoption signal

For runtime-to-standard promotions only: list the runtimes that already implement this behaviour. The promotion criterion is **independent adoption** (two or more runtimes ship it), per [`core.md` § Promotion path](../core.md#promotion-path--runtime-specific-to-standard).

## References

- Existing spec sections this proposal touches
- Related issues / discussions / prior proposals
- External references (other open standards, prior art, papers if applicable)
