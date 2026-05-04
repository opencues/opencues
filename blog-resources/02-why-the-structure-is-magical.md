# 02 — Why the Structure is Magical

The user's words were "why the structure is magical." This file unpacks what the
brain / nervous-system / spinal-cord split *buys* you — the things that fall out
for free once the boundaries are right.

Read [`01-project-structure.md`](01-project-structure.md) first for the layout
itself.

## What "magical" means here

A boundary is "magical" when it makes things *automatic* that would otherwise
require explicit code. OpenCues' boundaries do this in several places:

1. New host integrations are cheap.
2. New features land in every host at once.
3. The two-direction split means cycling, dimming, ownership, and re-entrancy
   all reuse the same primitives.
4. Bad inputs to one cue source can't poison others.

Each of these is a *consequence* of the structure, not a separately-built feature.

## 1. New hosts cost a few hundred lines

Because `@opencues/runtime` owns Navigation, Cycling, BlankFill, DimRender,
ConfigLoader, and the per-host adapter contract, an integration only has to
implement the **HostAdapter contract** for its specific editor. Everything else
is shared.

From `damon.md`:
> Same runtime, four host adapters. The architecture deliberately keeps the host
> glue thin so adding new editors is mostly a few hundred lines of bridge code.

The four current hosts (Claude Code, OpenCode, Chrome, Codex) all read the same
`.md` config standard and use the same runtime modules. Chrome's bridge looks
*different* from Claude Code's bridge (one renders via CSS Custom Highlight API,
the other via ANSI escape codes), but both call the same `boot()`.

## 2. Features land everywhere at once

When a new feature ships in `@opencues/runtime` (say, `transform-blank` or
`agent-task`), every host adapter inherits it. The host doesn't need to know
the feature exists.

Concrete example — TS-class blanks. `cue-blanks.md` documents this directly:

> Several blanks were hoisted from per-host shell scripts into TypeScript classes
> living in `packages/opencues-runtime/src/blanks/` … Why hoist them: chrome
> can't spawn subprocesses, so the shell-script model excluded chrome from these
> blanks entirely. A TS class lives in the runtime that ships with every host —
> same code, every host.

`HackerNewsBlank`, `StocksBlank`, `WeatherBlank`, `OpenCuesSettingsBlank`,
`PromptImproverBlank`, `AnswerBlank` — all written once, work in CC + OC +
Chrome + Codex without any host-specific adaptation.

## 3. The two-direction model collapses N features into 2 primitives

Because every interaction is either "Cue" (LLM → user, plain text) or "Blank"
(user → system, `_`-gated), every interaction reuses the same machinery:

- **Visibility** — both surface as dim-rendered word spans
- **Cycling** — Up/Down rotates through alternatives in either case
- **Ownership** — `metadata.blankName` locks a position against
  re-resolution; same lock for fluid-blanks, transform-blanks, and agent-task
  edits
- **Re-entrancy** — re-evaluation on every edit; same debounce, same skip-filter
- **Reversion** — cycling Down to `alternatives[0]` always restores the original

This is the "free features" payoff. From `docs/architecture/agent-task.md`:

> The agent's edits are **indistinguishable from any other LLM source's results**
> at the data-structure level. They live as `WordDef` entries in `DynDefs`, get
> dimmed by `DimRender`, get skipped by the Resolver's 4-condition filter, get
> reverted via cycling. **Zero new ownership machinery required** — just plug
> into existing primitives.

The agent-task feature added a continuously-running LLM loop without writing any
new dim-render code, any new cycling code, or any new ownership code. Because
those primitives already exist for the other surfaces, agent-task gets them for
free.

## 4. Per-word routing isolates bad sources

`RoutedWordSourceGroup` dispatches each word to ONE source (highest-priority
domain match wins; default catches the rest; words destined for the same source
batch into one parallel LLM call). The old "merge all sources into one giant
prompt" model is gone.

From `CLAUDE.md`:

> **Isolation:** a hijacking prompt in one source can no longer poison every
> word. Sync-demo's "always output bundled, deployed, shipped" used to swap
> `happy → bundled`. With routing, that prompt only affects words its source
> is called for.

Architecturally: a single bad config can't break the whole system. The blast
radius is bounded by the source's match/keyword scope.

## 5. The standard is replaceable; the brand is too

The brand-vs-standard split (see [`03-open-standard.md`](03-open-standard.md))
means a second implementation (FastCues, AnotherCues) could read the same
`~/.cues/` library and `cues.md` manifests and run an entirely different
runtime. Users' cue libraries *port* between implementations.

From `openstandard-notes.md`:
> A second OpenStandard implementation (FastCues, AnotherCues, …) would ship
> its own `~/.fastcuesrc` etc., but read the same `~/.cues/` library and the
> same `<project>/cues.md` manifests. The brand is replaceable; the standard
> isn't.

## 6. Folder-based discovery means zero-registration extensibility

Drop a `cues/<name>/cue.md` (or `blanks/<name>/cue.md`) into the right
directory and the runtime picks it up on next hot-reload. No registration,
no code changes, no rebuild. From `CONTRIBUTING.md`:

> **Good first contribution:** add a word source under `cues/{name}/cue.md`
> (folder-based, auto-discovered, no code changes).

This works for static cues, LLM cues, scripted blanks, runtime-class blanks
(with `impl: @opencues/runtime <ClassName>`) — all the same.

## The HCI angle

This is the part to lean on for HCI/design blogs:

**Boundaries that hold the right shape make affordances multiply.** When the
runtime's primitives (DimRender, Cycling, DynDefs, ConfigLoader) are *generic
over* the source of edits, every new source — fluid blank, transform blank,
agent task, future ones we haven't thought of — automatically inherits the
visual + interaction grammar.

You don't *add* a new way to dim words for the agent feature. The agent
feature *uses* the existing way. That's the magic.

## Pitfalls and trade-offs

- **The per-word routing rule is a constraint, not a feature.** Authors used to
  combining cue sources into one prompt have to learn the new model. The
  validator surfaces zero-default-source warnings + multi-default priority ties.
- **No catch-all sources** means a config without `match:` or `keywords:` is
  silently dropped. Convenient for safety, surprising for newcomers.
- **Folder-based discovery has a cost.** ConfigLoader has to walk every search
  path on every keystroke (with a debounce). For deep `.cues/` trees this can
  add up; in practice the polling cost is dominated by other latencies.

## Where this material lives

- `CLAUDE.md` § "Word-alt routing" — the routing rationale
- `docs/architecture/agent-task.md` § "Why this fits OpenCues' architecture"
- `docs/features/cue-blanks.md` § "Blanks Architecture" — TS classes vs shell scripts
- `openstandard-notes.md` § 2 — Brand vs standard
- `CONTRIBUTING.md` — three contribution tiers, extension model

## Quotable lines

- "Zero new ownership machinery required — just plug into existing primitives."
- "Same runtime, four host adapters."
- "The brand is replaceable; the standard isn't."
- "Same code, every host."
- A hijacking prompt in one source "can no longer poison every word."
