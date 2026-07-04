---
last_updated: 2026-07-04
---

# Guides

Task-oriented how-tos — "how do I do X" rather than "how does X work" (that's [`docs/architecture/`](../architecture/README.md)) or "what does X mean" (that's [`docs/features/`](../features/README.md)).

## Getting started

| Guide | When you reach for it |
|---|---|
| [Quickstart](quickstart.md) | Installing OpenCues in Claude Code for the first time (~5 minutes). |
| [CLI Cheat Sheet](cli-cheatsheet.md) | Every `opencues` verb in one page, sorted by how often you'll reach for it. |
| [CLI Reference](cli-reference.md) | The full per-subcommand reference — usage, output, exit codes. |

## Authoring content

| Guide | When you reach for it |
|---|---|
| [Adding a Cue-Blank](adding-a-cue-blank.md) | Building a new `_`-gated blank that pulls external state (a script, an API, a runtime class). |
| [Adding an Auditor](adding-an-auditor.md) | Shipping a new inline-rewrite concern (grammar, clarity, tone, etc.). |
| [Response Parser Types](parser-types.md) | Which of the two real response-parser formats (`alternatives` / `raw`) to declare on a cue/blank source. |
| [LLM Providers](llm-providers.md) | Configuring per-bucket/per-feature LLM routing, adding a provider key, free-mode setup. |

## Extending OpenCues itself

| Guide | When you reach for it |
|---|---|
| [Adding a New Feature](adding-a-feature.md) | Adding a new `OPENCUES.md` scalar or toggle via the `FEATURES`/`MENU_TUNABLES` registry. |
| [Adding a New Integration](adding-an-integration.md) | Porting OpenCues to a host that doesn't have one yet — the process/checklist view. |
| [Porting OpenCues to a New Integration](porting-to-new-integration.md) | The same task from the behavioural-contract/pitfalls angle — read alongside "Adding a New Integration," not instead of it. |

## See also

- [`docs/overview.md`](../overview.md) — system architecture, core interfaces, API usage
- [`docs/glossary.md`](../glossary.md) — terminology (cues, blanks, sources, parsers, config files)
- [`docs/install.md`](../install.md) — deep per-host install reference
- [`docs/configuration.md`](../configuration.md) — every `OPENCUES.md` scalar + the surface master files
