# 03 — The Open Standard

The user explicitly asked for "stuff about the openstandard (undefined)" — this
file is the dedicated extract. Source: `openstandard-notes.md` (a "living spec"
that already exists in the repo).

## The core split: Cues vs OpenCues

Two namespaces. Keeping them separate makes implementations interchangeable.

| Term | What it is | Where it appears |
|---|---|---|
| **Cues** (the standard) | The OpenStandard for cueing text. Defines data shapes, file layout, scopes, parsers. | `.cues/`, `CUES.md`, scope names (`words`, `blanks`), data shapes |
| **OpenCues** (the brand) | Anthropic's reference implementation: the runtime, the CLI, the integrations. | `opencues` CLI, `@opencues/*` packages, `.opencuesrc`, repo name |

**Rule of thumb (worth quoting):**
> Anything universal across implementations uses the standard's vocabulary.
> Anything that's runtime-specific or tool-specific uses the brand's vocabulary.

## Brand-owned vs standard-owned

| Brand-owned | Standard-owned |
|---|---|
| `~/.opencuesrc` (user runtime config) | `~/.cues/` (user cue library) |
| `opencues install <host>` | `CUES.md` (project manifest) |
| `@opencues/core`, `@opencues/runtime` (npm packages) | The data format inside cue.md / CUES.md / source files |
| Settings schema (voice-mode, debug-mode, etc. — runtime-defined) | Source schema (match, keywords, scope, parser — standard-defined) |

A second OpenStandard implementation (FastCues, AnotherCues, …) would ship its
own `~/.fastcuesrc` etc., but read the same `~/.cues/` library and the same
`<project>/CUES.md` manifests. **The brand is replaceable; the standard isn't.**

## File layout (the spec)

### User level (`$HOME`)

```
~/.opencuesrc            # user runtime config — OpenCues tool's prefs (brand)
~/.cues/                 # user cue library — the standard's data
├── words/               # word-scope cues
│   ├── tips.md          # static cue source (body JSON)
│   ├── legal.md         # LLM cue source (frontmatter match: + prompt body)
│   ├── medical.md
│   └── financial.md
└── blanks/              # blank-scope cues
    ├── volume/          # folder when scripts are colocated
    │   ├── cue.md
    │   └── volume-blank.sh
    ├── stocks.md        # flat file when no script needed (runtime class)
    ├── weather.md
    └── ...
```

### Project level (a repo)

```
<project>/
├── CUES.md              # project manifest — visible, marketing surface
└── .cues/               # project-specific cues (optional)
    ├── words/
    │   └── project-jargon.md
    └── blanks/
        └── project-blank/
            ├── cue.md
            └── project-blank.sh
```

Project layout mirrors user layout under `.cues/`. The visible `CUES.md` at
project root is the manifest.

## Why the names are what they are

### `.opencuesrc` — user runtime config
- YAML, no markdown framing. Pure config, no prose body.
- `rc`-suffix dotfile is the conventional Unix pattern (`.bashrc`, `.npmrc`,
  `.gitconfig`).
- Brand-name prefix says "this is OpenCues' rc file." Honest naming.

### `CUES.md` — project manifest
- Markdown with YAML frontmatter. Body is human-readable description.
- **Matches** `package.json`, `Cargo.toml`, `.editorconfig` — visible, generic,
  brand-neutral.
- "Drops at the root of a repo and signals 'this project speaks Cues' to any
  reader."

### `~/.cues/` and `<project>/.cues/` — cue library directory
- Standard-named (`cues`), no brand. Both implementations and projects use this
  layout.
- Both **dotted** (`.cues/`) — user-level per Unix convention; project-level so
  it doesn't clutter `ls` at a project root. Visibility comes from `CUES.md` at
  the project root, not the cues directory.

### `words/` and `blanks/` — scope subdirs
- Matches the `SourceConfig.scope` field exactly. **The directory IS the scope.**
- Why not "cues" / "blanks" inside `.cues/`? The parent already says "cues".
  Repeating is redundant and creates the `.cues/cues/` collision. Using scope
  names (the runtime's existing terminology) avoids both problems.

## Ownership matrix

Who is allowed to write each piece, and at what scope.

| Path | Schema owner | Write scope | Hot-reload? |
|---|---|---|---|
| `~/.opencuesrc` | runtime (OpenCues) | user-level only | yes (next keystroke) |
| `~/.cues/words/<name>.md` | standard | user (own library) | yes |
| `~/.cues/blanks/<name>/...` | standard | user (own library) | yes |
| `<project>/CUES.md` | standard | project author | yes |
| `<project>/.cues/words/<name>.md` | standard | project author | yes |
| `<project>/.cues/blanks/<name>/...` | standard | project author | yes |

## What overrides what

Resolution order at runtime (highest priority first):

1. `$OPENCUES_HOME` (env override — for CI / containers / tests)
2. `<cwd>/.cues/` (project-level overrides)
3. `~/.cues/` (user-level baseline)

**Settings are user-level only** — projects do NOT override `~/.opencuesrc`.
Projects override **content** (cue sources, blank registrations, ignore list)
but never the runtime's behavior toggles.

> Reasoning: cd'ing into a project should not silently change whether TTS
> speaks, whether the spell-checker fires, etc. Those are user prefs.

A project's `CUES.md` ignore list **adds to** the user's ignore list. A
project's `disable: [<source>]` removes specific cue sources from this
project's resolution path without touching the user-level config.

## What's gone (deliberately removed from earlier designs)

- ❌ `OPENCUES.md` as a separate file at user level. Settings consolidated into
  `.opencuesrc`.
- ❌ `BLANKS.md` as a separate file. Folder-based blanks under `blanks/<name>/`.
- ❌ `## Tips`, `## Blanks`, `## Ignore` body sections in CUES.md. Frontmatter
  + folders only.
- ❌ `type: tips` / `type: prompt` discriminators. Parser infers from data
  shape.
- ❌ Catch-all "default" word-cue sources. Every cue source must declare
  `match:` or `keywords:`.
- ❌ `ClassifiedSourceGroup` (legacy classifier-routed blank modes). Fluid-
  blank covers the territory.

## Two formats, one parser

| Format | Used for | Rationale |
|---|---|---|
| **YAML (no fences)** | `~/.opencuesrc` | Pure config. No prose body. Pure rc convention. |
| **Markdown frontmatter + body** | `CUES.md`, all source files | Frontmatter for structured config; body for prose (descriptions, prompts) or JSON code blocks (static data). One parser, used everywhere data has both metadata and content. |

The `parseSingleCueMd` parser:
- Reads YAML frontmatter between `---` fences.
- Reads body for: prose (LLM prompts), JSON code blocks (static data),
  `## Ignore` legacy section (back-compat).
- Distinguishes static-vs-LLM cue sources by data shape: presence of body JSON
  ⇒ static; presence of `match:` / `keywords:` + prose body ⇒ LLM.

**There's no `type:` discriminator in frontmatter. Inference > declaration.**

## The HCI / naming angle (for blog #8)

This file is the primary source for the "Naming / AEO / Trademark" post.

The naming discipline here is unusually careful:
- **Generic root**, brand prefix only where the runtime has authority.
- The standard's directory is `.cues/` not `.opencues/` — leaves room for
  competing implementations.
- The settings file is `.opencuesrc` (brand-prefixed) because the *schema* of
  settings (voice-mode, debug-mode, …) is the runtime's choice; a different
  implementation would have a different settings schema and a different
  `.{brand}rc`.
- The project manifest is `CUES.md` (un-prefixed) because the schema there is
  the standard — every implementation reads the same fields.

The general principle: **brand the things you control; leave generic the things
you want others to extend.**

## Quotable lines

- "The brand is replaceable; the standard isn't."
- "The directory IS the scope."
- "Drops at the root of a repo and signals 'this project speaks Cues' to any
  reader."
- "Settings are user-level only — projects do not override `~/.opencuesrc`."
- "Inference > declaration."
- "Every cue source must declare `match:` or `keywords:`."

## Where this material lives

- `openstandard-notes.md` — the entire 200-line spec
- `CLAUDE.md` § "Config search paths" + § "Hoisted-blank writes vs ConfigLoader
  hot-reload"
- `docs/glossary.md` — entries for "Host", "Host Compat", "Chrome Sync",
  "Config Files"
