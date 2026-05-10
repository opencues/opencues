# 01 — Project Structure

The repo layout, the package split, and what each layer is responsible for.

## The metaphor (use this)

From `CLAUDE.md`:

> `@opencues/core` is the **brain**, `@opencues/runtime` is the **nervous
> system**, and each integration is a **spinal-cord-shaped bridge** between the
> host and the runtime.

This is the dominant metaphor in the codebase. The brain *thinks* (decides what
alternatives exist). The nervous system *acts* (handles keystrokes, dimming,
cycling, blank fill). The spinal cord *connects* (carries signals between a
specific host's quirks and the shared nervous system).

## The three-layer split

```
┌──────────────────────────────────────────────────────────┐
│  HOST  (Claude Code, OpenCode, Chrome)                   │
│  Per-editor patches / extensions — the "spinal cord"     │
└──────────────────────────────────────────────────────────┘
                         │ (single API)
                         ▼
┌──────────────────────────────────────────────────────────┐
│  @opencues/runtime  — host-agnostic — the nervous system │
│  Navigation · Cycling · BlankFill · DimRender ·          │
│  ConfigLoader · SpanFillState · TS-implemented blanks    │
└──────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────┐
│  @opencues/core  — pure TypeScript — the brain           │
│  CueResolver · RoutedWordSourceGroup · BlankSource ·     │
│  FluidBlankSource · ConfigSource · parsers               │
└──────────────────────────────────────────────────────────┘
                         │
                         ▼
                  LLM provider (Groq/OpenAI)
                  + External APIs/scripts
```

### `@opencues/core` — the brain

- **What it does:** "What alternatives exist for this word?"
- **Pure TypeScript.** No I/O, no platform dependencies, no DOM, no filesystem.
- **Inputs:** parsed `.md` config + the text the user typed.
- **Outputs:** a list of `CueResult`s (per-word alternatives, tips, blank
  attribution).
- **Doesn't know about:** editors, key events, rendering, dimming, cursors.

### `@opencues/runtime` — the nervous system

- **What it does:** "How does the user interact with those alternatives?"
- **Host-agnostic.** Will work in any host that implements the `HostAdapter`
  contract.
- **Owns:** Navigation, Cycling, BlankFill, DimRender, ConfigLoader, render-
  directive ANSI, state classes, per-host adapter "bands" (CC v2.1, OC v1.4,
  Chrome v1).
- **Doesn't know about:** LLMs, prompts, what alternatives mean.
- **Depends on `@opencues/core`** from the BlankFill phase onward — modules
  receive a `Resolver` instance.

### Integrations — the spinal cords

- **`integrations/claude-code/`** — `tweakcc` patches inject a thin bootstrap
  into Claude Code's `cli.js`; the bootstrap calls `@opencues/runtime`'s
  `boot()` entry point.
- **`integrations/opencode/`** — patches a forked OpenCode source tree at a
  pinned SHA; runtime loaded inline.
- **`integrations/chrome/`** — Manifest V3 extension; uses CSS Custom Highlight
  API for in-page rendering (no DOM mutation).

Each integration is **a few hundred lines of bridge code**, not thousands. That's
the structural payoff of pushing complexity into the runtime.

## Repo layout (top level)

```
opencues/
├── concept.md                # The two-idea core
├── openstandard-notes.md     # The brand-vs-standard spec
├── damon.md                  # System overview with diagrams
├── README.md                 # Public pitch
├── CLAUDE.md                 # Repo overview for Claude sessions
├── CONTRIBUTING.md           # Three contribution tiers
├── defaults/                 # Shipped seed configs (CUES.md + cues/ + blanks/)
├── packages/
│   ├── opencues-core/        # @opencues/core — brain
│   └── opencues-runtime/     # @opencues/runtime — nervous system
├── integrations/             # Per-host bridges
│   ├── claude-code/
│   ├── opencode/
│   └── chrome/
├── docs/
│   ├── overview.md           # Dual-layer architecture
│   ├── glossary.md           # All terminology
│   ├── features/             # 21+ feature docs
│   ├── architecture/         # Spans/cycling, agent-task, transform-blank
│   └── guides/               # How-to: adding features, integrations, etc.
└── tests/
    └── benchmarks/           # LLM accuracy benchmarks (transform-blank, agent-task, …)
```

## What `defaults/` contains

The shipped seed configs — copied to `~/.cues/` by `opencues seed-configs`,
also baked into the Chrome extension at build time.

```
defaults/
├── CUES.md                # Master config: settings frontmatter + ignore list
├── cues/                  # 38+ shipped tip-group folders
│   ├── extended-thinking/cue.md
│   ├── legal/cue.md       # Legal terminology word-cues (LLM)
│   ├── medical/cue.md
│   └── financial/cue.md
└── blanks/
    ├── volume/            # Folder when scripts are colocated
    │   ├── cue.md
    │   └── volume-blank.sh
    ├── stocks/cue.md      # impl: @opencues/runtime StocksBlank
    ├── weather/cue.md
    ├── affirmations/cue.md
    └── ... (~15 shipped blanks)
```

## The `opencues` CLI — single front-door

A single CLI normalizes "install / update / debug" across three hosts with very
different install models:

```
opencues install <host>     # claude-code | opencode | chrome | --all
opencues seed-configs       # copy defaults to ~/.cues/
opencues sync chrome        # bundle .cues/ into Chrome extension
opencues validate           # lint configs across search paths
opencues list               # every defined cue / blank with source path
opencues doctor             # cross-host diagnostics
```

The CLI is the same whether you have one host installed or four —
`opencues install --all` then `opencues update` keeps everything fresh in
one command.

## Where this material lives

- `CLAUDE.md` — the brain/nervous-system metaphor + repo layout
- `damon.md` — the diagram + four-host overview
- `docs/architecture/repo-structure.md` — stage tracker for the structural refactor
- `README.md` — public framing
- `CONTRIBUTING.md` — three contribution tiers

## Quotable lines

- "`@opencues/core` is the brain, `@opencues/runtime` is the nervous system,
  and each integration is a spinal-cord-shaped bridge."
- "Same runtime, four host adapters."
- "Each integration is a few hundred lines of bridge code, not thousands."
