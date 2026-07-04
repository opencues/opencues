---
last_updated: 2026-07-04
---

# Documentation map

OpenCues' docs are split into six places. This page exists so you don't have to guess reading order — pick the row that matches what you're trying to do.

| I want to... | Start here |
|---|---|
| Install and use OpenCues | [`../README.md`](../README.md) (quickstart) → [`install.md`](install.md) (deep per-host reference) → [`configuration.md`](configuration.md) (every scalar) |
| Understand the terminology (Cues / Blanks / Auditors / sources / parsers) | [`glossary.md`](glossary.md) |
| Understand the system architecture (packages, layers, interfaces) | [`overview.md`](overview.md) |
| Look up what a specific feature does (behavior, not implementation) | [`features/README.md`](features/README.md) — 42 feature concepts, numbered by stable ID |
| Understand *why* a mechanism is built the way it is (implementation rationale, invariants, "read before touching X" guards) | [`architecture/README.md`](architecture/README.md) — 28 canonical implementation references |
| Do a task (add a cue-blank, add an auditor, add a feature toggle, port to a new host, configure an LLM provider) | [`guides/README.md`](guides/README.md) |
| Author a `CUE.md` / `BLANK.md` / `AUDITOR.md` file, or build a second runtime implementation | [`../spec/README.md`](../spec/README.md) — the open standard, independent of this reference implementation |
| Read prompt-engineering lessons learned across every LLM-backed source | [`prompt-design-learnings.md`](prompt-design-learnings.md) |

## The distinction that trips people up: `features/` vs `architecture/`

Both describe running behavior, but at different altitudes:

- **`features/`** answers "what does this do, from a user's or integrator's perspective." Platform-agnostic, numbered (stable IDs — code and other docs reference them by number), short.
- **`architecture/`** answers "why is it built this way, and what breaks if I change it." Reference-implementation-specific, deep, cites real file/function names, and many are marked ⚠️ **canonical reference — read before touching `<file>`** in root `CLAUDE.md`.

A feature doc and an architecture doc often exist for the same mechanism (e.g. [Transform Blanks](features/transform-blank.md) + [`architecture/transform-blank.md`](architecture/transform-blank.md)) — read the feature doc first, the architecture doc when you're about to change the code.

## Where the six live

```
docs/
├── README.md                 # this file
├── overview.md                # architecture: packages, layers, interfaces, API usage
├── glossary.md                # terminology
├── install.md                 # deep per-host install reference (the top-level README has the quickstart)
├── configuration.md           # every OPENCUES.md scalar + the CUES.md/BLANKS.md/AUDITORS.md masters
├── prompt-design-learnings.md # cross-cutting prompt-engineering lessons
├── install/                   # install-process deep-dives (walkthrough, tmux prebuilt publishing)
├── guides/                    # task-oriented how-tos — see guides/README.md
├── architecture/              # implementation reference docs — see architecture/README.md
└── features/                  # feature concept reference — see features/README.md

spec/                          # the open standard (cue-spec.md, blank-spec.md, auditor-spec.md, core.md) —
                                # independent of this repo's reference implementation; see spec/README.md
```

## Also worth knowing about

- Root [`CLAUDE.md`](../CLAUDE.md) — project-wide context for anyone (human or agent) working in this repo: build commands, versioning policy, pre-merge checklist, and the running list of "canonical reference, read before touching X" pointers into `architecture/`.
- Per-integration docs (`integrations/<host>/README.md` + `CLAUDE.md`) — host-specific detail (patch mechanics, install flow, known quirks) for Claude Code, OpenCode, Chrome, Gemini CLI, and Shell. Host-agnostic feature behavior lives in `docs/features/`, not here.
- `packages/opencues-runtime/SPEC.md` — reference-runtime-specific settings and behaviors that are deliberately **not** part of the open standard (explains what's runtime-only vs. spec-mandated).

## Keeping this map honest

This page, `architecture/README.md`, `features/README.md`, and `guides/README.md` are indices — each one is only useful if it stays in sync with the directory it indexes. If you add a new doc file, add it to the relevant index in the same PR. If you notice a doc these indices point at no longer exists (or a real doc exists that no index mentions), that's a bug in the index — fix it rather than working around it.
