# Session-contradiction cues

Session-contradiction cues catch when your draft message **goes against a
decision you already made earlier in the same coding session** — you
agreed "runtime is Bun, not Node," then start typing "let's switch this to
node"; you scoped the work to the cache module, then reach for the auth code;
you said "no new dependencies," then ask to pull in a package.

They surface as a passive `⚠` cue tip on the offending sentence, exactly like
the other passive cues; the buffer is **never rewritten without your
keystroke**, and `Ctrl+Alt+↑` swaps in a reconciled rewrite if you want it.

**ON by default.** Works on any host with a session transcript — **Claude
Code, OpenCode, Gemini CLI, and the DeepSeek Harness** — and is completely
inert on hosts that have none (chrome, shell), where it costs nothing. Turn it
off with `session-contradiction-mode: off`.

## Company and project rules — `RULES.md`

The same watchlist can hold rules someone WROTE, not just decisions distilled
from your session. Put a `RULES.md` in your project's `.cues/` (or your user
`~/.cues/`); every `- ` bullet is one rule, and the rest of the file can be
ordinary prose:

```markdown
# Engineering policy
- No new third-party dependencies without platform-team approval.
- Secrets and API keys never go in code, config files, or logs.
- Customer data stays in EU regions — never replicate it elsewhere.
```

Type "let's just npm install lodash for this" and the ⚠ cue names the rule it
goes against, with a reconciled rewrite on `Ctrl+Alt+↑`. Benchmarked across
five kinds of company (engineering, comms/PR, support, healthcare, finance):
19/19 violations caught citing the right rule, zero false alarms on drafts
that mention a rule's topic while complying with it.

Nine defaults ship in your user-level file the first time `opencues
seed-configs` runs (each benched to a perfect score before earning its slot),
and **`opencues rules`** manages the whole set without opening an editor:

```
opencues rules                 # the merged list — project first, duplicates marked
opencues rules remove 3        # delete one (by index or unique substring)
opencues rules add "No deploys during the freeze."
opencues rules add "…" --project
```

Removal edits surgically — one bullet line goes, your prose stays — and an
edited file is never touched by re-seeding, so deleting a default is permanent
in practice (the opt-out for ALL of them is emptying the bullets, not deleting
the file, which would reseed on the next install).

Two honest boundaries: this **flags, it does not block** — it is a nudge at
typing time, not a gate (use CI for gates), and rules are dismissible like any
cue. And **keep the list curated** — the watchlist caps at 24 entries and
matcher precision degrades as it bloats; ten sharp rules beat a handbook.

## How it works — two stages

Unlike [contradiction cues](contradiction-cues.md) (which check your prose
against real-world facts your machine can compute), this checks your draft
against **your own session decisions** — so it needs to know what you decided.
It learns that in the background:

1. **Watchlist (slow, background).** As your session grows, a producer reads the
   session transcript and distils it into a short **commitments watchlist** —
   the stack choices, constraints, memory/compaction intents, and scope
   boundaries worth guarding. It refreshes within seconds of new activity
   (batched so it makes at most one call every ~8 s), and only ever sees your
   and Claude's prose (tool output, file contents, and thinking are stripped
   first).
2. **Match (fast, realtime).** As you type in the input box, a fast model checks
   your draft against that watchlist and flags a sentence that directly
   contradicts a listed decision.

The split is what keeps the realtime half snappy — the fast model isn't
reasoning from scratch, it's matching your draft against a ready-made list.

## What it's for

CC-developer-productivity contradictions — the kind that quietly waste your
time when you forget a decision mid-session:

| Category | You decided… | …and the draft that flags |
|---|---|---|
| **stack** | "Runtime is Bun, not Node" | "let's just switch this to node" |
| **constraint** | "No new npm dependencies" | "add the redis package for caching" |
| **memory** | "Keep the plan in CLAUDE.md so it survives /compact" | "we can just track it in this chat" |
| **scope** | "Only the cache module this session" | "while we're here, refactor the auth flow" |
| **architecture** | "Config lives in one shared ~/.cues" | "let's read it straight from the project dir" |

It errs toward silence — a false alarm on your draft is worse than a missed one
— and flags at most a few sentences.

## Privacy + safety

- **On by default, and it reads your session — so here is exactly what that
  means.** This is the one cue class that looks at more than the buffer you are
  typing in. Everything below is what bounds it; if you would rather no part of
  the session were read at all, `session-contradiction-mode: off` stops the
  producer entirely. On hosts with no session transcript (chrome, shell)
  nothing runs either way.
- **Data-minimized.** Only your and the assistant's prose feeds the watchlist
  producer; tool inputs/outputs, file contents, and thinking blocks are dropped
  before anything is sent. The watchlist itself is terse decisions, never code or
  secrets. It's scoped per project directory, so different repos keep separate
  watchlists.
- **A separate provider.** The distilled decisions go to your configured cues
  provider (the same one that already handles your prose cues), which is a
  different provider than the Claude model you're chatting with. If that matters
  for your project, leave this off.
- **Advisory only.** A cue is a tip you read, never an action — there's no
  side-effect channel, and nothing is rewritten without your keystroke.

## Setup

```
session-contradiction-mode: on   # in ~/.cues/OPENCUES.md
```

That's it — the watchlist producer is wired into the Claude Code statusline
automatically at install, so it starts distilling your session in the
background. Give it a turn or two of activity to build the first watchlist.

Design + internals: [docs/architecture/session-contradiction.md](../architecture/session-contradiction.md).
