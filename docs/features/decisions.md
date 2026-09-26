---
last_updated: 2026-09-19
---

# The decision layer

`decisions-provider: typesafe` (off by default) puts a **calibrated decision
model** under every place OpenCues used to spend a chat call on a
*decision* rather than on text. A decision model answers typed questions
("which of these?", "is this true?", "how far along this scale?") with a
probability for each option and never generates a word. It is fast, costs
a few hundredths of a cent, and cannot hallucinate an answer that is not
one of the options it was given.

The rule the whole layer follows: **the model picks; code computes; text
is only ever generated when text is what you asked for.** A date is
resolved by code, a sum is done by code, a table is read by code, a rule's
own words are the note. When a generated answer is genuinely needed (a
lookup, a rewrite, a translation), the chat model is still called — but
only then, and only the one that was needed.

One scalar. No visual change: every cue and every `_` looks exactly as it
did; what changes is how many calls it took, how much it cost, and how
often it was wrong.

## What you'll notice

| you do | before (chat models) | now (a decision, then code) |
|---|---|---|
| pause after typing `i keep having to approve every git command` | one chat call reads the whole tips pack and writes a suggestion | one decision names the tip; the note is the pack's own line (💡) |
| pause on a draft that goes against a rule in `RULES.md` | a chat call per pause, the flag written by the model | one decision names the rule and the sentence; the note is the rule's own words (⚠); the rewrite is fetched only if you land on it |
| type `see you Friday 24 October` | a chat call parses the claim into JSON | the grammar reads the date, code checks the weekday, ⚠ `the 24th is a Saturday, not Friday`, `_` corrects it — no request at all |
| type `dinner was $120 between four of us so $25 each` | same | one decision says "a bill split", code does the division: ⚠ `$120 ÷ 4 = $30 each, not $25` |
| type `I'm free at 3pm today` with a calendar feed | a chat call reads your calendar's busy intervals | one decision says "an availability claim"; code reads the calendar locally: ⚠ `heads up: Dentist today, 3:00–3:45pm`. **Nothing about the calendar leaves the machine.** |
| type `what's the postgres port _` | a chat call answers (and may be wrong) | one decision names the table; code answers `postgres: 5432` |
| type `days between 3 march and 19 september _` | same | the `days-between` calculator: `200 days (28.6 weeks)` |
| type `less console noise _` | a chat classifier + a chat call to find where the command starts | one decision: `debug-mode off`; a second names where the command begins in an unpunctuated draft |
| type `use anthropic for cues _` | the chat classifier | the same decision routes the bucket: `cues → anthropic` |
| type `annuler les trois derniers _` | the chat classifier | the same decision: `undo ×3` (the count read by grammar) |
| type `make it louder _` | three chat calls fan out | one decision names the `volume` blank and the direction; the shape path runs it |
| type `capital of france _` | three chat calls fan out (settings? rewrite? lookup?) | one decision routes to the lookup; only that call is made |
| type `teh` | a spelling chat call on every pause | the pause decision flags the typo; one small request picks the fix (✍️) |
| write in a subreddit with posted rules (chrome) | a chat judge per sentence | one decision per pass names the rule the sentence breaks; the note is the cached rule's own name |
| a word cue with a broad `match:` on plain prose | a chat call per pause | one decision says none of the words deserve an alternative; no call |

## The demos, one line each

Every row is real behaviour with `decisions-provider: typesafe` and the
feature's own scalar on. Type the left column; the right column is what
appears. The note vocabulary is the product's (`⚠` a fact, `💡` a tip, `✍️`
a spelling fix, a card for a `_`).

**Facts** (`contradiction-cues-mode: on`)

| type | see |
|---|---|
| `see you Friday 24 October` | `⚠ the 24th is a Saturday, not Friday` · `_` → `Saturday 24 October` |
| `dinner was $120 between four of us so $25 each` | `⚠ $120 ÷ 4 = $30 each, not $25` · `_` → `$30 each` |
| `with tax it is 100 * 1.08 = 110` | `⚠ 100*1.08 = 108, not 110` |
| `back in the office on the 25th of December` | `⚠ Friday the 25th is a bank holiday (Christmas Day)` |
| `lunch on the patio Saturday` (rain forecast) | `⚠ Saturday's forecast is rain (80% chance)` |
| `I'll take the Victoria line` (disruption) | `⚠ the Victoria line has severe delays right now` |
| `it's a 5 minute walk from King's Cross to Camden` | `⚠ that's about a 30-minute walk, not 5` |
| `thanks for the update, I'll review it this week` | nothing, and no request was made |

**Calendar** (`calendar-context-mode: on` + a feed)

| type | see |
|---|---|
| `I'm free at 3pm today` | `⚠ heads up: Dentist today, 3:00–3:45pm` |
| `I'm free this afternoon` | `⚠ heads up: Dentist today, 3:00–3:45pm; Team standup today, 4:00–4:30pm` |
| `sure, the 22nd works` | `⚠ heads up: Conference Wed Jul 22, all day` |
| `Sarah is busy Monday morning` | nothing (someone else's schedule) |
| `the invoice is dated the 22nd` | nothing (a date, not a claim) |

**Settings, providers, undo** (`fluid-config-mode: on`, `undo-mode: on`)

| type | see |
|---|---|
| `shush, no voice _` | `voice-mode inactive` |
| `the console is too chatty, quiet it _` | `debug-mode off` |
| `hii world voice mode off _` | `hii world voice-mode inactive` (the greeting stays) |
| `use anthropic for cues _` | `cues-llm-provider anthropic` |
| `blanks on gpt-oss-120b _` | `blanks-llm-provider cerebras:gpt-oss-120b` |
| `undo the last two changes _` | the last two changes revert |
| `3回元に戻して _` | the last three changes revert |
| `undo my last commit _` | nothing — that's a task, not an OpenCues undo |

**Tables & calculators** (`table-lookups-mode: on`) — the full list with
worked examples is [tables.md](tables.md).

| type | see |
|---|---|
| `what's the postgres port _` | `postgres: 5432` |
| `how old is someone born 14 march 1990 _` | `36 years (since 14 Mar 1990)` |
| `what time is it in tokyo _` | `20:30 Sat 19 Sept (GMT+9, UTC+09:00)` |
| `what's 120 ex vat _` | `100 (20% VAT: 20)` |
| `which side of the road do they drive on in japan _` | `Japan drives on the left` |

**Devices** (`device-policy`)

| type | see |
|---|---|
| `make it louder _` | the volume blank steps up |
| `dim the screen a bit _` | the brightness blank steps down |

**Tips, contradictions, questions, spelling** — on every pause, one request

| type | see |
|---|---|
| `i keep having to approve every single git command` | `💡 Tired of approving? /permissions …` · `_` → `/permissions` |
| a draft that goes against a `RULES.md` line | `⚠ <the rule, verbatim>` on the sentence; `Ctrl+Alt+↑` for the reconciled rewrite |
| `can you fix it` (ask-cues on) | `❓ which file, which failure?` |
| `the recieve function` | `✍️ receive` |

## What it costs

| | chat | decision |
|---|---|---|
| a pause (tips + contradiction + ask + spelling) | 2–3 calls, ~$0.0016 | 1 request, ~$0.0002, p50 ~250 ms |
| a `_` (settings? rewrite? lookup?) | 3.4 calls on average | 1 request + the one call that was needed |
| a checkable claim | 1 call per sentence | 1 request per pass (sentences with nothing groundable are never sent) |
| a calendar clash | 1 call per sentence, calendar on the wire | 1 request per pass, calendar local |
| a table lookup | 1 call | 0 calls |

## What still uses a chat model

Everything that **generates text**: a fluid lookup's answer, a rewrite, a
translation, a sentence cue's rewrite (its gate is a decision), a session
contradiction's reconciled rewrite (fetched only on landing), word-cue
alternatives (their gate is a decision), the auditors, the kata coach's
line, and the background distillation of a session into its watchlist.
The architecture page keeps the [inventory of remaining chat
calls](../architecture/decisions.md#what-still-makes-a-chat-call) with the
shape each would take if it moved.

## Privacy

A decision request carries the text it is asked about — the same text the
chat call carried — through the same outbound PII floor
(identity-context `safe` dehydrates catalog values first). What it does
**not** carry: your calendar (times or titles), the answer to a lookup,
any value the model would have written. The provider is a separate seam
from the chat providers (`decisions-provider`, never in the LLM buckets)
and every request is one log line: `[decision][<leg>]`.

## Turn it on

```
decisions-provider: typesafe
```

in `~/.cues/OPENCUES.md`, with `TYPESAFE_API_KEY` in the environment.
Without a key or a package every feature keeps its chat path, and one log
line says so at boot. `opencues doctor` shows which legs the installed
package provides.

## See also

- [Architecture: the decision seam](../architecture/decisions.md) — the
  legs, the chokepoint, the rules for adding one, the inventory of what is
  still on chat.
- [Tables & calculators](tables.md) · [Contradiction cues](contradiction-cues.md)
  · [Calendar context](calendar-context.md) · [Semantic tips](semantic-tips.md)
  · [Session contradiction](session-contradiction.md) · [Fluid config](fluid-config.md)
