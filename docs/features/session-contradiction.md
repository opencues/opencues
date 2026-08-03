# Session-contradiction cues

Session-contradiction cues catch when your draft message **goes against a
decision you already made earlier in the same Claude Code session** — you
agreed "runtime is Bun, not Node," then start typing "let's switch this to
node"; you scoped the work to the cache module, then reach for the auth code;
you said "no new dependencies," then ask to pull in a package.

They surface as a passive `⚠` cue tip on the offending sentence, exactly like
the other passive cues; the buffer is **never rewritten without your
keystroke**, and `Ctrl+Alt+↑` swaps in a reconciled rewrite if you want it.

**OFF by default. Claude Code only.** Enable with
`session-contradiction-mode: on`.

## How it works — two stages

Unlike [contradiction cues](contradiction-cues.md) (which check your prose
against real-world facts your machine can compute), this checks your draft
against **your own session decisions** — so it needs to know what you decided.
It learns that in the background:

1. **Watchlist (slow, background).** As your session grows, a producer reads the
   session transcript and distils it into a short **commitments watchlist** —
   the stack choices, constraints, memory/compaction intents, and scope
   boundaries worth guarding. It runs at most once every ~45 s of activity, and
   only ever sees your and Claude's prose (tool output, file contents, and
   thinking are stripped first).
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

- **Off by default; enabling it is the consent.** Claude Code only (it needs the
  session transcript).
- **Data-minimized.** Only your and Claude's prose feeds the watchlist producer;
  tool inputs/outputs, file contents, and thinking blocks are dropped before
  anything is sent. The watchlist itself is terse decisions, never code or
  secrets.
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
