# Tutorials

**Experimental (prototype — OpenCode + Shell hosts today).**

Guided, in-editor scenarios that walk you through a workflow step by
step — "enter plan mode, ask for a plan, switch model, commit to git" —
with a live AI coach in the status line telling you the next
micro-action, correcting you when you drift, and detecting your
progress automatically from what you type and press. You never announce
completion; you just do the thing.

```
you type:  start tutorial 1 _
statusline: ⛳ 1/4 · Step 1 — enter plan mode · Esc ×3 exits

you press Shift+Tab twice
statusline: ✓ — Step 2/4: Step 2 — ask for a plan

you type:  add a --verbose flag right now
statusline: ✗ Ask Claude to write a plan first — add "don't implement yet"
```

Tutorial mode is **modal**: while a tutorial runs, normal OpenCues LLM
behaviour (word-cues, fluid/transform blanks, config-intent,
sentence-cues) is suppressed so nothing races the lesson. Local
features that a tutorial might teach — navigation, cycling,
keyword-bound blanks like `capital of france _` — keep working.
Stopping restores everything instantly; nothing is written to your
settings.

## Starting, stopping, advancing

| You type | Effect |
|---|---|
| `start tutorial 1 _` | start by id (also by name: `start tutorial git-basics _`) |
| `start tutorial _` | start the first installed tutorial |
| `stop tutorial _` | exit — always works, no model involved |
| `next _` / `done _` | manually advance past the current step |
| `skip _` | force-skip a step you're stuck on |

An unknown id shows the installed catalogue in the status line
(`No tutorial "9" — available → 1: claude-code-basics · 2: …`).

**You rarely need the advance phrases.** Progress is detected from your
typed text, your submits (the buffer clearing after Enter), and salient
key presses (Tab/Shift+Tab, Escape, arrows, Enter on an empty input) —
so steps that happen outside the input box (mode toggles, pickers)
complete on their own. You can also just *tell* the coach: "please stop
this tutorial" (any language) ends it; "done" / "I did it" on a step it
can't observe is trusted.

## Escaping — guaranteed

The escape ladder, weakest assumption first:

1. **Esc ×3** — press Escape three times in a row. Deterministic:
   works with no API key, no network, no phrase knowledge, in any
   language. The first press shows a countdown ("Esc ×2 more to exit
   the tutorial"). Three presses (not two) so Claude Code's normal
   double-Esc clear-input can't exit a tutorial by accident.
2. `stop tutorial _` — deterministic phrase.
3. "please stop this tutorial" — the coach honours an explicit quit
   request in any language (requires a working model).
4. `skip _` — per-step relief without abandoning the tutorial.

## When there's no LLM

Tutorials stay fully usable without a working model — they degrade to a
labelled self-guided checklist. The status line says so explicitly:

```
Step 1/4: Step 1 — enter plan mode — coach offline (no LLM key); type next _ when done · Esc ×3 exits
```

Missing key → immediate; network failures → after 2 consecutive failed
coach calls (recovery resumes live coaching automatically). Everything
deterministic (start/stop/next/skip, step counter, Esc ×3, idle nudges
— which fall back to a static "Still there?" line) is unaffected.

## Idle nudges + lesson memory

Go quiet mid-step and the coach checks in on its own — a context-aware
nudge referencing your partial input and what you've already completed
("Finish typing “give me an overview…” and press Enter."). A second
idle window escalates once with the escape valve (`· stuck? skip _
skips this step`), then the coach goes QUIET — two nudges per stall,
never nagging. Any activity resets the cycle. Nudges are advisory:
they never advance steps (no new evidence) and never stop the
tutorial.

The coach also keeps a **lesson journal** — one line per completed
step recording how you completed it — in context for every check-in,
so guidance and nudges build on the whole lesson, not just your last
few keystrokes. (Known limit: explicit recap questions — "what have I
done so far?" — are answered with the next action rather than a
summary on cerebras gpt-oss; the journal is in context, the model is
just terse. Coach-quality bench will tune this.)

## Writing a tutorial

One folder, one file: `~/.cues/tutorials/<name>/TUTORIAL.md` (or
project-level `<project>/.cues/tutorials/`). Hot-loaded at `start` —
no restart, no rebuild.

```markdown
---
name: git-basics
id: 3
title: Git basics — status, branch, commit
---

## Step 1 — check the working tree
Run `git status` before anything else.
coach:
  - Nothing typed → suggest typing: git status
  - They typed it but haven't submitted → tell them to press Enter
  - They submitted "git status" → STEP_DONE

## Step 2 — create a branch
...
```

Everything under a step heading is a **script for the coach** — it
rides into the model verbatim, so fidelity is an authoring choice:
one loose line, or keystroke-by-keystroke choreography. Useful
patterns, all demonstrated by the shipped tutorials:

- **Strict order** — `STRICT ORDER — if they do X before Y, that is
  OFF_TRACK: remind them to …`. Enforces sequence: the same input can
  be off-track at step 1 and correct at step 2
  (`cc-custom-command` demonstrates with `/standup`).
- **Detection notes** — tie completion to observable evidence:
  `Trace shows "pressed: shift+tab (×2)" → STEP_DONE`.
- **Hint mode (discovery pedagogy)** — withhold the answer:
  `ANSWER (for you only, the user can't see this): the command is /init`
  + `do not reveal it; hint at what it does; after 3 or more wrong
  attempts, reveal the exact command`. The coach must be TOLD the
  answer — it hints toward what it knows, judges correct submissions,
  and reveals after the user has earned it. See `hint-demo` (id 8).
  Note: hint discipline is model judgement, not a hard gate.

Shipped tutorials (`defaults/tutorials/`): `claude-code-basics`,
`opencues-basics`, `git-basics`, `claude-code-power`,
`cc-first-session`, `cc-fix-a-bug`, `cc-custom-command`, `hint-demo`.
The Claude Code ones are verified against the official CC docs.

## Configuration

| Scalar (OPENCUES.md) | Default | Effect |
|---|---|---|
| `tutorials-mode` | on (absent) | `off` disables the feature entirely |
| `tutorial-debounce-ms` | 300 | pause length before a coach check-in |
| `tutorial-nudge-ms` | 30000 | idle window before a proactive nudge (`0` disables) |
| `tutorial-voice` | off | `on` speaks step advances, nudges, and completion via the host TTS (never per-tick) |

The coach call uses the **auditors** LLM bucket
(`auditors-llm-provider:` → global `llm-provider:` fallback) — it is a
background prose-reading concern, same trust class as agent-rewrite.
Coach ticks average ~300-550ms on cerebras.

## Progress, resume, and curriculum

Progress persists to `~/.cues/tutorial-progress.json` (written on every
step advance / stop / completion; never load-bearing — chrome simply
skips it). Restarting a tutorial you left mid-way resumes where you
stopped, lesson journal included: "Welcome back — resuming at step
2/3: …". A completed tutorial starts fresh next time.

Completion gets a celebration instead of a silent vanish — a 20s recap
notice built from the journal, plus the curriculum link when the
tutorial declares one (`next: cc-fix-a-bug` frontmatter):

```
🎉 Git basics — complete (3/3): check the working tree → create a
branch → stage and commit · next up: type `start tutorial cc-first-session _`
```

The next-up phrase is a command span (renders coloured) — one typed
line chains lessons into a curriculum. The shipped tutorials chain:
git-basics → cc-first-session → (claude-code-basics →
claude-code-power, cc-first-session → cc-fix-a-bug →
cc-custom-command).

## Status line

While a tutorial runs, the status JSON carries a `tutorial` block that
consumers render as the dominant content:

```json
{"tutorial": {"name": "git-basics", "title": "…", "step": 2,
  "stepCount": 3, "stepTitle": "Step 2 — create a branch",
  "coach": "Use -b to create a new branch, e.g. …", "offTrack": true}}
```

`offTrack: true` means the coach line is a correction (render with ✗ /
warning colour); `step: 0, stepCount: 0` marks a transient notice (the
not-found catalogue, the exit confirmation).

Commands vs prose: anything the user should literally type or press is
marked in the raw coach line with backticks (deterministic lines are
authored that way; the coach model is instructed to do the same) and
arrives pre-parsed as `coachSegments: [{text, command}]` alongside the
plain `coach` string. Rich consumers render command spans distinctly —
the OpenCode footer shows them in the theme's success colour + bold,
with the ⛳ step head flipping to the error colour while off-track.
Plain consumers just use `coach` (markup already stripped).

## Safety model (summary)

Coach output is display-only — it feeds the status line and a
bounds-clamped step counter (never backward, at most one step per
check-in), never your buffer, never a side-effect layer. The single
exception: the coach may STOP the tutorial on your explicit request,
which only *releases* the modal state. A malicious TUTORIAL.md can at
worst show wrong text and mis-advance its own step counter. Full
analysis: [docs/architecture/tutorials.md](../architecture/tutorials.md).
