---
last_updated: 2026-09-07
status: shipped on `plan/remove-static-tips` (spec 0.12) — the whole of the tips system; user-facing summary in `docs/features/semantic-tips.md`
---

# Semantic tips — the packs as a watchlist of situations

A tip finds the person by the **situation** they are in, not by a word they
typed. The packs (`defaults/cues/tips-*/CUE.md`) are a catalogue of
situations; one fast-model call per pause matches the draft against it; the
result is a 💡 note whose `_` swaps the draft for the entry's command. There
is no static layer: a typed pack word is a plain word.

## The shape

Deliberately the same shape as the session-contradiction matcher and fluid
config: a stable watchlist in the system message, the draft in the user
message, the model's output validated against the watchlist so it can only
*choose*, never invent.

| Piece | Where | What it does |
|---|---|---|
| the catalogue | `packages/opencues-core/src/tips-catalog.ts` — `buildTipsCatalog(pack, { shardSize })` | One line per situation: dense id `t<N>`, the entry's name, its `when:`, its tip. Entries with no `when:` have nothing to match and are left out (a pack with none keeps every entry). Rendered under a char budget (32k), then cut into shards (below). |
| the source | `packages/opencues-core/src/sources/semantic-tips-source.ts` — `SemanticTipsSource` (priority 86) | One `dispatchChat` per shard, in parallel; flags parsed with the contradiction matcher's `parseFlags`; grounded; emitted as `sentence-cue:tip` results. |
| the rail | `packages/opencues-core/src/sources/session-cue-source.ts` | The tips leg of the fused session rail: contradiction → tips → ask, each its own call, first non-empty wins. Built by `build-sources.ts` when `enableSemanticTips`. |
| the loader | `packages/opencues-runtime/src/modules/config-loader.ts` | Builds `config.tipsCatalog` at every reload (a pack edit hot-reloads), reading `tips-shard-size`; `tipsMode` is `semantic | off`. `lookup(word)` serves blank tips only; `navigableWords` is blank keywords only. |
| the resolver | `packages/opencues-runtime/src/modules/resolver.ts` | Forwards the catalogue on `CueContext.tipsCatalog` when `tips-mode` is not `off`; registers the result as a passive sentence-cue DynDef (§ Registration). |
| the note | `packages/opencues-runtime/src/state/dyn-defs.ts` (`inlineNoteText`, `inlineNoteHint`, `splitNoteEmoji`), `dim-render.ts`, `cycling.ts` | The pack's `say:` line with one leading emoji; the hint is a verb; `_` cycles or dismisses (`docs/features/note-hints.md`). |
| the setting | `packages/opencues-core/src/feature-registry.ts` | `tips-mode: semantic | off` (FEATURES); `tips-shard-size: 50 | 35 | 20 | off` (MENU_TUNABLES). `on` and `definitions` are legacy spellings read as `semantic`; `seed-configs` rewrites them. |

## What a pack entry is

```json
"undo": {
  "tip":  "Use /rewind (Esc x2) to undo - rolls back context AND file changes",
  "when": "wants to undo or take back what the ASSISTANT just changed or did (not an undo inside their own code, database or app)",
  "say":  "Undo what it just did: /rewind restores code and conversation; git covers what bash changed",
  "emoji": "💡"
}
```

`when:` is what the matcher looks for, in the person's terms. `say:` is what
the note says: advice addressed to the situation, naming the command, so the
hint can stay a verb. `tip` is the definition, the note's fallback when there
is no `say:`. `emoji:` is optional. The entry's name is an id, not a match
token. There are no sibling lists (`alts` left with 0.12). One entry per
situation: two entries that overlap make the small model pick neither.

## Grounding — what the model may and may not decide

The prompt (`SEMANTIC_TIPS_MATCH_SYSTEM`) asks for at most two flags of
`{quote, tipId, why, apply}`, precision over recall, with an own-work rule (a
verb applied to the person's own code or data is their work, not a
situation) and a redundancy rule (a draft that already *is* the command needs
no tip). Every flag then passes four checks in the source:

1. **The id exists** in the catalogue, else dropped.
2. **The quote is a verbatim substring** of the live buffer, else dropped.
3. **The solution is the pack's.** `entryCommand(entry)` is the entry's name
   when that is a slash command, else the first slash command its `say:` (or
   tip) names; a path (`/mnt/c`) is not one and a launch flag (`--worktree`)
   is never one, since it cannot be applied inside the session. For a
   command tip the model's `apply` is kept only if it starts with that
   command (`/compact focus on the plan` survives), else it collapses to the
   bare command. For a prose tip (no command anywhere in the entry) the
   rewrite must keep at least half the quote's words, must not be the
   entry's own text, and must not add a launch flag or a keybind the quote
   did not have (`isGroundedRewrite`), else the tip is an advisory. The last
   rule exists because `<draft> --sandbox` and `Press Ctrl+R to search for
   <draft>` keep every word of the draft and are still advice to the person;
   `@path` and `!cmd` are allowed, a prompt can carry them.
4. **The note is the pack's line.** `cueTip` = `emoji` + `say` (or tip); the
   model's `why` goes to `metadata.tip.why` and the log.

So a model can mislabel a situation, but it cannot invent a command or paste
a definition into the prompt. Both failure shapes were seen live on
qwen-3.8-27b before the checks existed (the tip's sentence in the buffer
after `_`).

**Span.** A command tip spans the whole trimmed draft (`[0, text.trimEnd().length)`)
with `alternatives: [draft, command]`. A prose tip spans the quote with
`[quote, rewrite]`. An advisory is `[quote]` alone. Trailing whitespace is
not content: the caret typed after the text is still inside (end inclusive),
which is the normal span rule every cue follows.

## Registration — one def per cue

The resolver registers the result as a passive sentence-cue DynDef
(`blankName: 'sentence-cue:tip'`, `currentIndex: 0`, the buffer untouched).
Rules that matter:

- **The same cue re-resolved is a refresh, never a second def.** Same source,
  same solution, overlapping span → the existing def is kept; while passive
  it follows the content (typing more after the flag grows the span and
  updates the original). Two defs for one cue is how the first live test lost
  its revert.
- **Semantic outranks a word cue.** A sentence cue anchored on a word that
  already carries a word-cue def registers over it (the "already resolved"
  guard exempts sentence cues); the status line prefers a containing
  sentence-cue span over a plain def at the caret; an arrow inside the span
  cycles the span.
- **Priority resolves overlap** between sentence cues: a contradiction (87)
  evicts a passive tip (86) on the same span; a tip yields to any managed
  span (satellite, active blank, a cycled cue).
- **Dismissal** applies only to a pure advisory (`alternatives.length <= 1`):
  `_` mutes for 30 minutes, again within 3 seconds forgets it
  (`docs/architecture/cue-dismissal.md`).

## Sharding — the scale parameter

A single call to a small model abstains as the watchlist grows. Measured with
the Claude Code case set on cerebras:

| Claude Code catalogue | gpt-oss-120b | qwen-3.8-27b |
|---|---|---|
| 34 situations | 20 / 20 | 19 / 20 |
| 44 (shipped) | 20 / 20 | 18 / 20 |
| 55 | 20 / 20 | 16 / 20 |
| 122 (three packs stacked, one call) | 20 / 20 | 15 / 20 |
| 122 in 3 shards of 41 | 20 / 20 | 18 / 20 |
| 122 in 4 shards of 31 | 20 / 20, 1 false alarm | 19 / 20 |
| 122 in 7 shards of 18 | — | 18 / 20, latency 1.4 s |

`tips-shard-size` (default 50) is the ceiling per call. `shardCatalog` fixes
the shard count first (`ceil(N / size)`) and spreads the entries evenly, cut
on section boundaries so a family stays in one call; ids are assigned before
the cut. `SemanticTipsSource.match` runs `matchShard` once per shard in
parallel and concatenates the flags in shard order (project packs first, so
they win a same-span tie in the grounding loop). Each shard is a stable
system-message prefix, so N calls cost what one did in time-to-first-token;
the stacked 122-entry run went from 396 ms to 432 ms at three shards.

Why 50 and not smaller: every shipped pack stays one call. At shipped sizes a
single call beats two balanced halves on qwen (18 vs 17 of 20), and a lone
call sees every entry when it judges a trap, where isolated shards picked up
false alarms on gpt-oss. Past about five shards the parallel calls queue on
a rate-limited key. Sharding starts where the single call breaks down, i.e.
once a project pack stacks on a shipped one.

## The bench is the gate

`tests/benchmarks/tips/semantic-tips-bench.mjs --pack <host> [--model <m>]
[--shard <n>|off] [--stack a,b] [--probe "<phrase>"] [--pack-file <path>]`. Scoring is
deterministic: each recall case names the entry it must cite and the command
`_` must swap in; traps are topic-adjacent drafts that name a subject without
being in its situation. Gate: 0 false alarms, ≥ 90% cited right, every
command case lands its command. Current state (2026-09-08):

| pack (recall / traps) | gpt-oss-120b | qwen-3.8-27b |
|---|---|---|
| claude-code (20 / 10) | 20 / 20, 15 / 15 commands | 18 / 20, 13 / 13 cited |
| opencode (14 / 6) | 14 / 14, 9 / 9 | 13 / 14, 8 / 9 |
| gemini-cli (24 / 12) | 24 / 24, 19 / 19 commands | 24 / 24, 19 / 19 commands |
| shell (10 / 5) | 10 / 10 | 9 / 10 |
| false alarms | 0 (2 borderline traps report, see below) | 0 |

Three lessons the bench taught, all of which bit before it existed:

- **Score the swap, not the citation.** A right entry with the tip sentence
  as the stop scored as a pass until the solution column existed.
- **Bench on the user's model.** gpt-oss hides every gap qwen shows.
- **Terse phrasings are the small model's ceiling**, not the runtime's:
  `that broke everything, undo` is silent on qwen and fires on gpt-oss; four
  of six short undo variants (`--probe` table in the feature page). A
  `when:` rewrite chasing them regressed two other cases and was reverted.
  The lever is the cues bucket's model.

- **A `when:` edit is a whole-catalogue edit on gpt-oss.** The 2026-09-08
  Gemini review ran a 101-phrase probe set (two phrasings per entry, 35
  topic-adjacent traps) over nine pack variants. gpt-oss is stable within
  a run window (the master pack scored identically twice, minutes apart)
  and chaotic across catalogues: adding one `hooks` line moved verdicts on
  four unrelated phrasings, and a trap that a line's rewrite silenced in
  one variant fired again in the next with the line unchanged. A per-line
  probe delta of a few cases is cross-talk, not signal. qwen moved with the
  lines it was given. So: A/B the whole pack with `--pack-file`, keep every
  line terse (example lists in parentheses made gpt-oss keyword-happy across
  the board), and let the shipped gate on both models decide.
- **gpt-oss also drifts across hours with nothing changed.** The shipped
  Gemini pack passed its twelve traps three times in one hour, then fired
  `/restore` on `restore the backup from last night into staging` and
  `/tools` on `which tools are in the toolbar component` in every run of the
  next hour, byte-identical pack and prompt. Those two rows carry a
  `'borderline'` flag in the bench: reported as `ALARM (borderline)`, never
  gating. Add the flag only to a trap that no wording of its entry's line
  moved either way; a new false alarm on an unflagged trap is still a
  regression.

### End-to-end latency (2026-09-08, measured through the bridge)

Per phrase: `clear`, inject the draft, then the bridge's own timestamps for
`text.injected` → `resolver.started` → `resolver.completed`, plus the first
dump that shows the `sentence-cue:tip` def (100ms poll). Six shipped-bench
phrasings per host, cerebras, every other cue mode off:

| host | model | resolver starts | call done | tip visible (median) |
|---|---|---|---|---|
| opencode | qwen-3.8-27b | 498ms | 959ms | 1100ms |
| opencode | gpt-oss-120b | 499ms | 1016ms | 1100ms |
| gemini-cli | qwen-3.8-27b | 500ms | 970ms | 1100ms |
| claude-code | qwen-3.8-27b | 500ms | 936ms | 1083ms |

So roughly: the resolver's pause, then a 350 to 650ms model call, then the
def is on screen on the next render. Since runtime 0.41.2 the pause is chosen
from the SHAPE of the last keystroke (`Resolver.pickDelay`, never from the
words, so it holds in any script): a closed sentence (terminator or newline)
fires after `terminatorDebounceMs` (100), anything else keeps `debounceMs`
(500, per band `host.llmDebounceMs ?? 500`); a `.` after a digit is not a
terminator; a whitespace-only append schedules nothing at all, so the space
after `party!` neither re-fires nor supersedes the fast fire. An "inside a
word, wait longer" rule was tried and removed: most prompts end after a
plain word, so it held the person's FINAL pause (resolver.started 500 → 800ms
on every bench phrase) while saving nothing mid-draft (every wasted fire on
the typing model sat after a SPACE). The rule's value is the half-second it
takes off every sentence end; the word-boundary waste is the judge's job. Under a full config with
`session-contradiction-mode: on` the fused session rail used to run the
contradiction leg first and await it, so the tip landed about 400ms later
(opencode, qwen: median 1505ms); since core 0.60.4 the two legs run in
parallel (contradiction still wins when it fires), so a tip lands at
max(contradiction, tips) rather than their sum. And since runtime 0.41.2 the rail
no longer waits for its siblings either: core `resolve` reports each source
as it settles (`onSourceResult`), and on a `_`-free pass the runtime paints
the rail's result at once through the same apply path (a `resolver.early`
event), the full pass re-applying it later as a refresh. The remaining
sources still land together when the slowest returns. The bench's per-call latency is the middle
column; what the person feels is the last one.

Re-run the bench on both models before editing `SEMANTIC_TIPS_MATCH_SYSTEM`,
any `when:` line, or the catalogue renderer. Prompt wording is fragile on
qwen: one added sentence cost four cases. Write a candidate pack to a file
and bench it with `--pack-file` before touching `defaults/`.

## The completeness judge (trial, `judge-mode: on`)

Step 3 of the Sep 2026 cost plan. One tiny call per pause
(`CompletenessJudge`, `packages/opencues-core/src/judge.ts`: qwen-3.8-27b,
~130 prompt tokens, one output token, reasoning off, cached on the trimmed
text, fails OPEN) answers "is this draft at a resting point?". Core
`resolve` takes a `gate`; sources it applies to wait for the verdict and are
skipped on NO. `judge-scope: fanout` (default) gates the per-sentence
sources only (sentence cues, contradiction parse, word-cues); `all` gates
every source on a `_`-free pass, tips and the rail included. Settings-map
only (`judge-mode`, `judge-model`, `judge-provider`, `judge-scope`), off by
default. Bench `tests/benchmarks/judge/judge-bench.mjs`: qwen 31/32 at
273ms, $0.00005 per call; gpt-oss-120b 31/32 at 529ms (it still emits
reasoning tokens); the prompt names no language and reads only the end of
the text.

Measured on the opencode fork (2026-09-11), the three-sentence post typed
at 70 wpm under shipped defaults + calendar, and the six one-liners under
the full config:

| pause · judge | post: pauses / model calls / cost | one-liner tip visible (median) |
|---|---|---|
| 500 · off (shipped) | 9 / 49 / $0.032 | 1.10s |
| 500 · fanout | 9 / 40 + 9 / $0.029 | 1.10s |
| 500 · all | 9 / 26 + 9 / $0.018 | 1.31s |
| 300 · fanout | 28 / 93 + 28 / $0.070 | **0.87s** |
| 300 · all | 28 / 25 + 27 / $0.019 | 1.14s |

The judge's verdicts were right by inspection (NO on `Had`, `…party! Prior`,
`…saw the`, `…me alon`; YES on each closed sentence). What the grid says:
after the sentence cache, the fan-out is no longer the cost — the two
whole-buffer calls (tips, the rail) are, at about $0.0012 per pause, and
they are the ones the judge does not gate under `fanout`. Gating them too
(`all`) makes a pause cheap enough that a 300ms pause costs the same as
today's 500 while cutting the bill 40%, but puts the judge's ~200ms in front
of the tip, so the tip is no faster. The only row that is faster, `300 ·
fanout`, pays for it with 2.2× the bill. Speed and money pull against each
other through the tips call; the lever that moves both is a cheaper tips
call (reasoning off, or a provider that bills cached prefix at a discount),
not the judge alone. Nothing here changes what any source answers.

## What it deliberately does not do

- No token matching, anywhere. The static layer (`ConfigLoader.cueMap`,
  `LocalCueSource`, gray + definition + sibling cycling on a typed pack word)
  was retired in spec 0.12 as noise: it fired on `plan`, `fix`, `large`,
  `git`, and cycling `undo` into `revert` swapped words the person meant.
- No composed prompt. The tips call is its own dispatch; folding it into the
  contradiction call repeated the catalogue and cost precision.
- No model-authored text in the buffer or the note beyond a grounded rewrite.
- No LLM without a key: with no cues-bucket model the source is not built and
  the packs are inert. A fresh install without a key gets no tips, which is
  the honest state and a `doctor` message.

## Open

- `when:` lines for the gemini-cli and shell packs are first drafts; the
  bench case sets for those hosts are small (14 and 10).
- Prompting-guidance tips (the research's "things people do wrong") as a
  pack versus as `RULES.md` bullets.
- A deterministic def source for the private end-to-end cycling scenarios,
  which drove cycling through static tip words.
