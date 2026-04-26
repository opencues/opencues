# Template demos

Real-world demos scaffolded by `opencues new <kind> <name>` against the
canonical templates (`packages/opencues-cli/src/templates/new/`). Used
to validate that each template, when filled in plausibly, produces a
config the runtime accepts and the parser populates correctly.

This directory is **opt-in** — it's not seeded by `opencues seed-configs`,
not loaded at runtime by any host. To actually use one, copy it into
your `~/.opencues/`:

```bash
cp -r tests/template-demos/.opencues/cues/science ~/.opencues/cues/
# or all of them:
cp -r tests/template-demos/.opencues/* ~/.opencues/
```

## What each demo demonstrates

| Path | Template SHAPE | Concept |
|---|---|---|
| `cues/science/cue.md` | cue with `match:` + `classify:` (domain source) | Scientific terminology — alternatives that preserve technical precision (chemistry / biology / physics). `match:` regex restricts firing to ~25 known terms; `classify:` frames the LLM. |
| `blanks/currency/cue.md` | `parser: answer` blank with `match:` + `keywords:` | Currency conversion. Type `$100 in EUR is _` → `92 EUR`. Demonstrates the `answer` parser pattern shipped configs use for `### factual`. |
| `controls/mood/cue.md` | SHAPE 4 (list, no script) | Cycle through emotional states for journaling. Pure runtime — no shell, no LLM. `stepValues` array + `blankDismissible: true` lets you cycle to nothing. |
| `controls/display/cue.md` | SHAPE 6 (selector + satellite) | Cycle display settings inline (`theme dark` ↔ `font-size 14` ↔ `line-spacing 1.5`). Mirrors the OpenCues-settings pattern but for editor presentation. Includes a colocated `display-blank.sh` stub backed by a JSON state file. |

## Validate

```bash
node packages/opencues-cli/bin/cli.cjs validate \
  --project --user 2>&1 | tail
# (run from inside tests/template-demos/ for --project to hit this dir)
```

## How they were generated

```bash
cd tests/template-demos
opencues new cue science --project
opencues new blank currency --project
opencues new control mood --project
opencues new control display --project
# Then customized each per the template's SHAPE comments.
```

The point: someone reading `opencues new --help` and the resulting
template should be able to produce these in 10-15 minutes per demo.
If they can't, the template needs work.
