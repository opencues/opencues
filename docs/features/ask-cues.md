# AskUserQuestion cues (tool-prompt cues)

AskUserQuestion cues turn the sentence under your cursor into an **inline
question with cyclable options** — "Substantiate the speed claim with data or
qualify it?" → cycle between *Add data* and *Qualify claim*. The question is
the cue tip; each option is a cycle alternative on the sentence; options that
carry a concrete rewrite edit the sentence when you land on them, and advisory
ones just inform.

**ON by default.** The prompt makes silence the default, so most sentences draw nothing. Turn it off with `ask-cues-mode: off`.

## The idea — borrow a well-known tool prompt to populate cues

This is a **generic primitive**, not a one-off. Tools like AskUserQuestion have
prompts models are heavily trained on, so they emit that tool's shape
(`{header, question, options}`) very reliably. OpenCues doesn't build the
tool's UI — it borrows the tool's **prompt** as a cue *generator* and maps the
output onto the cue system you already use:

| Tool output | OpenCues cue |
|---|---|
| `question` | the cue tip (`❓ …`) |
| `header` | a short category chip shown with the tip |
| each `option.label` | a cycle stop (Ctrl+Alt+↑/↓) |
| `option.apply` (optional) | the concrete rewrite spliced into the sentence when chosen |

No new UI — it's the same navigate + cycle + tip surface as every other cue.
AskUserQuestion is the first plugged-in tool prompt (`TOOL_PROMPTS.ask`);
others can be added as one registry entry, and session-contradiction is
expressible as another.

## Grounded in your context, not just the sentence

The question isn't reasoned from the bare sentence — it's grounded in **what
you're actually working on**, using whatever context the host has. On the coding
hosts (Claude Code, OpenCode, Gemini CLI) the same producer that feeds
session-contradiction distils your session into a one-line summary + your
decisions, and ask-cues reads that. In the browser (Chrome), where there's no
session, it grounds on the **page and field** you're typing into instead. Either
way it:

- **catches tensions with your decisions** — with "no new dependencies" on
  record, "we should add redis to speed up the cache" becomes *"Add Redis even
  though it's a new dependency? [Keep dependency-free / …]"*;
- **resolves ambiguity from context instead of asking** — if the session
  already settled the runtime, "use the library everyone's using" grounds to
  *"Use a Bun built-in?"* rather than a generic "which library?";
- **stays quiet** when the sentence is already consistent with the session.

Measured effect (independent Claude judge, `tests/benchmarks/ask-cues/`):
question quality **1.0/2 → 2.0/2** with context, and every grounded question
used it. Because the session feeds both features, the producer runs when
**either** `ask-cues-mode` **or** `session-contradiction-mode` is on.

## What it looks like

```
"The new API is way faster than the old one."
❓ Evidence: Substantiate the speed claim with data or qualify it?
  Add data       → "The new API is 2× faster…, 200 ms to 100 ms."
  Qualify claim  → "The new API is generally faster than the old one."
  Keep as is       (advisory — no edit)
```

Cycle to *Add data* and the sentence is rewritten to the concrete version;
*Keep as is* is advisory (nothing changes). Ignore it entirely and keep typing
— it's a passive cue, never a blocking prompt.

## Cost + cadence

Ambient: it fires on the sentence under your cursor. It **caches per sentence**
— one LLM call per *new* sentence, reused while your cursor sits in an
unchanged one — so moving around a paragraph doesn't re-call. It routes through
your cues-bucket provider. Being on-by-cursor, it makes more calls than an
explicit-summon cue would; keep it off unless you want the always-on behaviour.

Internals: `packages/opencues-core/src/sources/tool-prompt-source.ts`.
