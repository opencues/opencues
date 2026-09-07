---
last_updated: 2026-09-07
status: shipped (spec 0.12) — `tips-mode: semantic` is the default and the whole of the tips system
---

# Semantic tips

A tip that finds you by the **situation** you are in, not by a word you
typed.

## What you see

You are writing a prompt in Claude Code:

```
ok this is a mess, lets start over on the auth stuff
  ↳ 💡 Starting over? /clear wipes the conversation, CLAUDE.md stays    (underscore to apply)
```

Nothing in the sentence is a command. The pack knows `/clear` is what a
fresh start is, and says so. Press `_` and the whole prompt becomes `/clear`;
the note reads `💡 was: ok this is a mess…` with `(underscore to revert)`.
Press `_` again and your sentence is back.

A prose tip rewrites the flagged clause instead of the whole prompt. A tip
with nothing to change into is an advisory: `_` mutes it for half an hour,
twice within three seconds forgets it (`opencues dismissals` lists them).

A word from a pack is never special on its own. `undo`, `plan`, `fix` and
`/clear` stay plain text: no gray, no arrow stop, no definition, nothing to
cycle. Only what the matcher flags paints.

## Settings

| `tips-mode` | |
|---|---|
| `semantic` (default) | one fast-model call after the draft settles, about half a second on cerebras, through the cues bucket |
| `off` | no tips |

`on` and `definitions` are older spellings and read as `semantic`;
`opencues seed-configs` rewrites them. `tips-shard-size` (default `50`) is
the number of situations per call; a larger catalogue, for instance a
project pack on top of a shipped one, is cut into parallel calls of that
size. Both are in the settings menu.

## What a pack entry is

```json
"/clear": {
  "tip":  "Fresh start - clears context but keeps CLAUDE.md",
  "when": "wants to start over, begin an unrelated task, or says the model keeps circling",
  "say":  "Starting over? /clear wipes the conversation, CLAUDE.md stays",
  "emoji": "💡"
}
```

`when:` is the situation, in your words. `say:` is what the note says: advice
addressed to the situation, naming the command. `tip` is the definition, used
when there is no `say:`. `emoji:` is optional; one glyph leads the note and
the runtime adds none. Packs hot-reload. The shipped packs: Claude Code 44
situations, OpenCode 37, Gemini CLI 41, shell 15.

## What keeps it honest

- The model may only cite an entry that exists, and only for a clause that
  is verbatim in your draft.
- The command `_` swaps in is the pack's: the entry's name when that is a
  slash command, else the command its `say:` line names. A model rewrite
  that does not start with it collapses to the bare command. A launch flag
  such as `--worktree` is never a solution, since it cannot be applied inside
  the session; that note is advice.
- A prose rewrite must keep your words and must not be the pack's own text,
  or the note stays advisory.
- The note text is the pack's line. The model's reasoning never paints.
- A contradiction cue on the same clause wins over a tip.

## Where it stands (2026-09-07)

Each pack has a case set in `tests/benchmarks/tips/semantic-tips-bench.mjs`
(`--pack <host>`): recall phrasings that never use the entry's name,
topic-adjacent traps, and the command `_` must swap in. The gate is zero
false alarms, at least ninety percent cited right, and every command case
landing its command.

| pack (recall / traps) | gpt-oss-120b | qwen-3.8-27b |
|---|---|---|
| claude-code (20 / 10) | 20 of 20, 15 of 15 commands | 18 of 20, 13 of 13 cited |
| opencode (14 / 6) | 14 of 14, 9 of 9 | 14 of 14, 9 of 9 |
| gemini-cli (14 / 6) | 13 of 14, 10 of 10 | 14 of 14, 10 of 10 |
| shell (10 / 5) | 10 of 10 | 9 of 10 |
| false alarms, all packs | 0 | 0 |
| gate | met on all four | met on all four |

**The model is the ceiling on terse phrasings.** The bench phrasings are
sentences; a bare verb with little around it goes silent on the small model
and fires on the large one. Checked with `--probe "<phrase>" --model <m>`:

| phrase | qwen-3.8-27b | gpt-oss-120b |
|---|---|---|
| that broke everything, undo | silent | /rewind |
| that broke everything, undo it | silent | /rewind |
| undo that | /rewind | /rewind |
| that broke everything, go back to before the refactor | /rewind | /rewind |
| revert what you just did | silent | /rewind |
| put it back the way it was | silent | /rewind |

A silent case logs `SemanticTips: no tip`: the runtime asked and the model
declined. `cue ready` is a hit. The lever is the cues bucket's model
(`cues-llm-model:` in OPENCUES.md), not the pack.

**Scale.** With the Claude Code cases against a 122-situation stack of three
packs, qwen scored 15 of 20 in one call and 18 of 20 in three shards, at the
same latency; gpt-oss held 20 of 20 either way. Every shipped pack is one
call; shards begin once a project pack pushes a host past fifty.

Design and code pointers: `docs/architecture/semantic-tips.md`. Note grammar:
`docs/features/note-hints.md`.
