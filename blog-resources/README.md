# Blog Resources

Reference material extracted from the OpenCues codebase for an HCI-focused blog series.
Each file is **self-contained** so a separate Claude instance can read just the relevant
extracts without scanning the whole repo. All extracts cite their source `.md` files in
case the writing instance wants to dig deeper.

## How to use these files

1. Pick the blog post you're writing.
2. Open the extract files listed under that post below.
3. Each extract gives you: the **key idea**, the **concrete details to cite**, the
   **HCI angle** (why it matters from a human-computer-interface design lens), and any
   **pitfalls / trade-offs** worth surfacing.
4. Feel free to combine extracts across files — the topic boundaries are deliberate but
   not exclusive.

## Universal extracts (read for ANY post)

These three are the conceptual spine; nearly every post will draw from them.

- [`00-foundations-cues-and-blanks.md`](00-foundations-cues-and-blanks.md) — the two-direction model the whole system reduces to
- [`01-project-structure.md`](01-project-structure.md) — packages + integrations layout (brain / nervous system / spinal cord)
- [`02-why-the-structure-is-magical.md`](02-why-the-structure-is-magical.md) — what the split *buys* you (isolation, swappable hosts, free features)

## Blog post → extracts mapping

| # | Blog title | Primary extracts | Notes |
|---|---|---|---|
| 1 | HCI (Human to computer interface) | 00, 01, 02, 04, 05 | Frame: cues + blanks as a fresh HCI primitive pair |
| 2 | Human Interaction | 00, 04, 05, 11 | Focus on the *direction of intent* model — mirrors human conversational cues |
| 3 | Inline Cues (Continuous Onboarding) | [`04-inline-cues.md`](04-inline-cues.md), 11 | Tips/cue-tips as in-context teaching |
| 4 | Inline Prompting (Blank / `_`) | [`05-inline-prompting-blanks.md`](05-inline-prompting-blanks.md), 00 | `_` as "user-placed autocomplete" |
| 5 | Inline Agents | [`06-inline-agents.md`](06-inline-agents.md), 10 | agent-task + transform-blank pipelines |
| 6 | What is Invention | 02, 03, 12 | Invention via removal: the "non-extension points" framing |
| 7 | What is Design | 02, 12 | Design = boundary-setting; the brand/standard split |
| 8 | Naming / AEO / Trademark | [`03-open-standard.md`](03-open-standard.md) | Brand-vs-standard naming discipline (`OpenCues` vs `Cues`) |
| 9 | If it works in Terminal it works anywhere | [`09-terminal-anywhere.md`](09-terminal-anywhere.md), 07 | Four-host parity, host-adapter pattern |
| 10 | The Value of Design | 02, 12 | Same material as #7, different angle (ROI of getting boundaries right) |
| 11 | HAII (Human ↔ AI Interfaces) | 00, 04, 05, 06, 10 | Two-direction model is THE HAII insight; agents just extend it |
| 12 | Flow state | [`11-flow-state-mechanisms.md`](11-flow-state-mechanisms.md), 04 | Cursor preservation, deterministic relocate, debounce, in-place edits |
| 13 | Cross domain pollination & `_` shaped people | 03, 12 | Underscore as a literal "_-shaped" interface person; weak draft |
| 14 | Simplicity | 00, 02, 06, 12 | The whole system reduces to two ideas — simplicity as compression |
| 15 | In Ram | [`08-in-ram-local-first.md`](08-in-ram-local-first.md) | 0ms local cues, hot-reload, no server, ConfigLoader |
| 16 | Seamless integration | [`07-seamless-integration.md`](07-seamless-integration.md), 09 | Host-adapter pattern, single API, four hosts |
| 17 | The Value of Community | 03 | Open standard → community implementations; no source yet, mostly fresh |
| 18 | Principles of HCI | 00, 02, 11, 12 | Synthesis post — pull principles from across all extracts |

## Files in this directory

| File | What it covers |
|---|---|
| [`00-foundations-cues-and-blanks.md`](00-foundations-cues-and-blanks.md) | The two-direction model (Cues = LLM→user, Blanks = user→system) |
| [`01-project-structure.md`](01-project-structure.md) | Repo layout, the three-layer package split, integrations |
| [`02-why-the-structure-is-magical.md`](02-why-the-structure-is-magical.md) | Design rationale: isolation, swappability, what falls out for free |
| [`03-open-standard.md`](03-open-standard.md) | Brand vs Standard, file layout spec, ownership matrix |
| [`04-inline-cues.md`](04-inline-cues.md) | Word cues, tips, per-word routing, cycling |
| [`05-inline-prompting-blanks.md`](05-inline-prompting-blanks.md) | `_` as universal interaction handle, blank flavours |
| [`06-inline-agents.md`](06-inline-agents.md) | Transform-blank + agent-task: imperative & continuous LLM editing |
| [`07-seamless-integration.md`](07-seamless-integration.md) | Host-adapter pattern, four-host parity, single CLI |
| [`08-in-ram-local-first.md`](08-in-ram-local-first.md) | Local-first architecture, 0ms tips, hot-reload, no server |
| [`09-terminal-anywhere.md`](09-terminal-anywhere.md) | Terminal-first → why it ports cheaply |
| [`10-prompt-design-principles.md`](10-prompt-design-principles.md) | Prompt engineering lessons (narrow jobs, output dominates latency, etc.) |
| [`11-flow-state-mechanisms.md`](11-flow-state-mechanisms.md) | Mechanisms that protect uninterrupted typing |
| [`12-pitfalls-and-tradeoffs.md`](12-pitfalls-and-tradeoffs.md) | Cross-cutting design pitfalls and trade-offs from real bug arcs |

## Source files referenced

The primary `.md` sources used to build these extracts (paths from repo root):

- `concept.md` — the two-direction core concept
- `openstandard-notes.md` — the open standard / brand split
- `damon.md` — system overview, the spinal-cord metaphor
- `README.md` — public-facing pitch
- `CLAUDE.md` — repo overview for sessions
- `CONTRIBUTING.md` — contribution tiers + extension points
- `docs/overview.md` — dual-layer architecture
- `docs/glossary.md` — terminology
- `docs/prompt-design-learnings.md` — LLM optimization principles
- `docs/features/cue-blanks.md`, `transform-blank.md`, `agent-task.md`, `consume-all-blanks.md`, `word-cue-routing.md`, `host-compat.md`, `chrome-sync.md`
- `docs/architecture/agent-task.md`, `transform-blank.md`, `spans-and-cycling.md`, `repo-structure.md`
- `integrations/{claude-code,opencode,chrome}/docs/*.md`
