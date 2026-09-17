# Decision-layer compare bench — results log

One row per arm per leg, from `node tests/benchmarks/decisions/compare.mjs <leg>`, pasted
verbatim with the date and the pinned model. Same host, same session for both arms.
Accuracy is the shipped bench's own metric for the leg; $/call comes from core's price
table via the usage meter (Cerebras cached tokens at the full input rate).

## smoke — step 0 (seam only)

2026-09-16 · jev-1.13.0 · WSL2 host, ~160 ms RTT · n = 20 per arm, keep-alive

```
typesafe               accuracy 20/20
typesafe               n=20  p50 220 ms  p90 248 ms  $0.000017/call  401 in / 79 out
chat-fallback/cerebras accuracy 20/20
chat-fallback/cerebras n=20  p50 413 ms  p90 743 ms  $0.000412/call  298 in / 410 out
```

Reading: three questions (noul + choice-3 + score-3) on a one-line state. The Jev row is
the floor for a warm connection from this host (server ~95 ms + one RTT). The fallback's
410 output tokens are gpt-oss-120b's hidden reasoning at `reasoning_effort: low`; that is
what makes it 24× the price and twice the latency for the same three answers, and why the
fallback is the emergency path, not a peer.

## tips — step 1 (the matching leg on Jev)

2026-09-16 · jev-1.13.0 · `semantic-tips-bench.mjs --provider typesafe --pack <pack>` (the REAL
`SemanticTipsSource` with a `TypeSafeDecisionProvider`; one Choice over the pack + none, T = 0.5,
typed-trigger pre-check) vs the shipped chat arm on cerebras gpt-oss-120b, same session.
Accuracy = the shipped ship gate (0 false alarms, ≥ 90% cited right, every command case lands
its command).

| pack | arm | right entry | commands | false alarms | mean ms | tokens / call | $ / call | gate |
|---|---|---|---|---|---|---|---|---|
| claude-code | typesafe | 20/20 | 15/15 | 0/10 | 259 | 1796 in / 413 out | 0.00008 | PASS |
| claude-code | cerebras gpt-oss-120b | 20/20 | 15/15 | 0/10 | 573 | 2981 in (89% cached) / 258 out | 0.00124 | PASS |
| opencode † | typesafe | 14/14 | 9/9 | 0/6 | 265 | 1422 / 350 | 0.00006 | PASS |
| opencode † | cerebras gpt-oss-120b | 14/14 | 9/9 | 0/6 | 397 | 2588 (74% cached) / 252 | 0.00109 | PASS |
| opencode † | cerebras qwen-3.8-27b | 14/14 | 9/9 | 0/6 | 538 | — | — | PASS |
| gemini-cli | typesafe | 24/24 | 19/19 | 0/12 | 272 | 1588 / 386 | 0.00007 | PASS |
| gemini-cli | cerebras gpt-oss-120b | 24/24 | 19/19 | 0/12 (+1 borderline) | 456 | 2769 (93% cached) / 249 | 0.00116 | PASS |
| shell | typesafe | 10/10 | — | 0/5 | 267 | 855 / 152 | 0.00004 | PASS |
| shell | cerebras gpt-oss-120b | 10/10 | — | 0/5 | 618 | 1724 (87% cached) / 294 | 0.00082 | PASS |

† after a two-line pack edit in this PR: the opencode `/models` and `AGENTS.md` `when:` lines did
not cover "wants a cheaper model" / "forgets a rule every session" (12/14 on Jev before the edit:
none 0.45 vs /models 0.30; none 0.81 vs AGENTS.md 0.10). Both lines now mirror the claude-code
pack's phrasing; a `when:` edit is a whole-catalogue edit on gpt-oss, so both cerebras models were
re-run on the pack and stay at 14/14 · 0/6.

Reading: the decision arm matches the chat arm on every pack's gate, at roughly half the latency
and one fifteenth of the cost, with the cerebras rows already assuming 74–93% prefix-cache hits
(which cost nothing on cerebras but do not reduce the bill). The one design-A alarm from the
exploratory bench (`run /compact before we continue`) is gone: the typed-trigger pre-check leaves
an entry out of the options when the draft already carries its command.

## contradiction pre-gate — step 2

2026-09-16 · jev-1.13.0 · `company-rules-bench.mjs --gate typesafe` (six domains, 28 violations +
22 compliant traps = 50 drafts). GATED = the source's exact gate request
(`contradictionGateRequest`: one Choice over the watchlist's ids + none, skip on a confident
`none` ≥ 0.5) on TypeSafe, then the SOURCE chat call only when the gate did not skip. Same
session; cost from the meter's price table.

```
SOURCE  recall 28/28 · right-rule 28/28 · restraint 22/22  (0 false alarms) · mean 395ms
GATED   recall 28/28 · right-rule 28/28 · restraint 22/22  (0 false alarms) · chat calls skipped 22/50 · violations lost to the gate 0 · mean 528ms
SOURCE  cerebras/gpt-oss-120b: 50 calls · 621 in / 267 out per call · $0.0209 total, $0.000417 per draft
GATED   typesafe/jev-1.13.0:   50 calls · 739 in /  70 out per call · $0.0016 total, $0.000031 per draft
GATED   cerebras/gpt-oss-120b: 28 calls · 620 in / 347 out per call · $0.0134 total, $0.000267 per draft
```

Per draft: a silent draft costs the gate alone ($0.000031, ~270 ms) instead of the chat call
($0.000417, ~395 ms); a flagged draft costs both ($0.000298, ~730 ms, the gate being serial).
On this bench (56% violations) that is −29% $ overall; on realistic drafts, where ~90% of pauses
contradict nothing, the per-pause cost falls to ~$0.00007 (−83%) and the mean latency to ~320 ms.
The gate skipped every compliant trap and lost no violation; accuracy is the SOURCE's own, since
the chat call is unchanged on every draft that reaches it. Not run: real-transcript watchlists
(near-duplicate-prone); the gate's fall-through design (a low-confidence `none` still runs the
chat call; a gate error runs it too) bounds the risk to a saved call, never a lost cue.

## pause — step 3 (one decision request per pause)

2026-09-17 · jev-1.13.0 · `pause-bench.mjs`: the REAL `SessionCueSource` (claude-code tips pack,
44 entries + a 5-rule engineering watchlist) on 26 pauses — 8 tips recall, 5 rule violations,
13 traps/neutral (1 borderline) — CHAT path vs FUSED path, same session, cost from the meter.

```
CHAT (today)  (26 pauses, ask off)
  tips right 8/8 · contradiction recall 5/5 · false alarms 0/13
  latency p50 418 ms · p90 938 ms · mean 544 ms
  calls per pause: chat 2.00 · jev 0.00 · $ per pause 0.001570
FUSED (one decision request per pause)  (26 pauses, ask off)
  tips right 8/8 · contradiction recall 5/5 · false alarms 0/13 (+1 borderline, reported not gated)
  latency p50 238 ms · p90 667 ms · mean 345 ms
  calls per pause: chat 0.23 · jev 1.00 · $ per pause 0.000200
    typesafe/jev-1.13.0: 26 calls · 2215 in / 474 out
    cerebras/gpt-oss-120b: 6 calls · 603 in / 337 out      ← the 5 contradiction hits + 1 gate pass-through

CHAT (today)  (26 pauses, ask on)
  tips right 8/8 · contradiction recall 5/5 · false alarms 2/13
  latency p50 550 ms · p90 1168 ms · mean 656 ms
  calls per pause: chat 2.50 · jev 0.00 · $ per pause 0.001927
FUSED (one decision request per pause)  (26 pauses, ask on)
  tips right 8/8 · contradiction recall 5/5 · false alarms 2/13 (+1 borderline)
  latency p50 489 ms · p90 839 ms · mean 483 ms
  calls per pause: chat 0.50 · jev 1.00 · $ per pause 0.000417
```

Reading: one Jev request (~2.2k tokens, the catalogue + the watchlist + the draft) replaces
both chat calls on a silent pause and all but the hit's chat call on a contradiction. Per pause,
ask off: −87% $, p50 −43%, mean −37%; 0.23 chat calls per pause instead of 2. With ask on the
gate lets 0.27 ask calls through per pause instead of 0.5, and the two ask alarms are the same
two under both arms (the ask cue's own 1-in-3 ceiling, not the gate). The borderline draft
("pushing the branch now" against the commit entry's "is about to commit") scores none
0.47–0.53 alone and fused, inside the ±0.05 band at the 0.5 threshold; flagged in the case
set, not tuned around. Three repeat runs of the fused arm: p50 238 / 239 / 260 ms, identical
accuracy.

## sentence gate — step 4 (more-formal's rewrite call behind a noul)

2026-09-17 · jev-1.13.0 · `sentence-gate-bench.mts`: the REAL `SentenceCueSource` built from the shipped
`more-formal/CUE.md` (its promptText and its `gate:` line), on the sentence-cues suite (30 buffers,
34 labelled sentences: 23 MORE_FORMAL, 11 SAME/CEDE). Scored on whether the source emitted a rewrite
per sentence; the rewrite call itself is unchanged (its quality stays with `sentence-cues/run.ts`).

```
CHAT (today, every sentence sent)
  rewrites wanted 23: emitted 21 (recall 0.91) · not wanted 11: emitted 1
  rewrite (chat) calls 31 · $ per sentence 0.000385 · latency per buffer p50 314 / mean 575 ms
  lost: "got a lot on my plate this week.", "cheers!"   noise: "The presentation went well." (SAME)
GATED, T = 0.5 (shipped)
  rewrites wanted 23: emitted 20 (recall 0.87) · not wanted 11: emitted 0
  rewrite (chat) calls 22 · decision calls 30 · $ per sentence 0.000299 · latency per buffer p50 505 / mean 486 ms
  lost: "got a lot on my plate this week.", "cheers!" (both lost by the chat arm too), "I'll wait for your reply."
GATED, T = 0.4: identical to 0.5.   GATED, T = 0.6: recall 0.83 (also loses "we need to talk about the proposal.").
```

Gate phrasing was chosen by probe (`gate-probe.mjs`, 8 sentences × 5 shapes): "Is this sentence
written in an informal or casual register that a more formal rewrite would improve?" separates
best (0.83–0.86 informal, 0.27 neutral, 0.11 formal); the statement shape first shipped scored
0.38 on a wanted sentence and the prose companion at 0.5 knocked out short imperatives ("ping me
when ready." 0.53, "cheers!" 0.42), so the prose floor is 0.3 (a URL scores 0.06).

Reading: the gate's own cost is one fuzzy sentence in 23 ("I'll wait for your reply."); it removes
the chat arm's one false rewrite and 29% of the rewrite calls, −22% $ per sentence. Latency is
the honest trade-off: a buffer whose sentences all cede returns in ~250 ms with no chat call
(mean 575 → 486), but a sentence that IS rewritten now waits for the serial gate first (p50 314 →
505 ms). The fix for that is not in this step: the sentence gates should ride the per-PASS
decision request with the session rail's questions, which needs the resolver to assemble one
request across sources (noted in decisions.md as the batching follow-up).

## `_` router — step 5 (design A, serial; ruled 2026-09-17)

2026-09-17 · jev-1.13.0 · `route-bench.mts`: the REAL three chat blank sources (config-intent,
transform-blank, fluid-blank, built by `buildSourcesFromConfig` on cerebras gpt-oss-120b) behind
the REAL core resolver, on the 171 labelled `_` cases the three pipelines' own suites provide
(84 fluid-config, 40 fluid-blank, 40 transform-blank + 7 transform negatives). Same session, both
arms. Scored on the runtime's own outcome per `_` — which source WON — so the arms are compared on
agreement and on answers the routed arm lost, plus calls / $ / latency per `_`.

```
CHAT (today, the fan-out)
  calls per _ 3.42 chat · $ per _ 0.004227 · latency p50 448 / p90 839 / mean 539 ms
  winners: config-intent 31 · transform-blank 67 · fluid-blank 52 · none 21
ROUTED (router first, cede fallback), T = 0.5, agreement ≥ 0.5
  routed 101/171 (59%) · routed-then-ceded 5 · router failed 0
  calls per _ 2.51 chat + 1.00 Jev · $ per _ 0.003212 (−24%) · latency p50 687 / p90 1205 / mean 804 ms
  winners: config-intent 31 · transform-blank 53 · fluid-blank 66 · none 21
  agreement: same winner 157/171 · lost answers 0 · gained 0 · different winner 14
```

The 14 different winners: 13 are lookup-labelled cases (`100 celsius in fahrenheit _`, `unicode for
em dash _`, `hex for tomato red _`, …) where today's fan-out lets transform-blank (priority 93) win
over fluid-blank; the router sends them to fluid, which is what the label wants. One is a real
mis-route (`recalculate _ 4 tickets at $9 each costs $30`, transform → fluid). No `_` that had an
answer lost it.

The router alone (`--arm probe`, the 171 labels, stacked request: choice + one agreement noul per
chat route, `route-probe-v2.mts` for the sweep): plain choice at conf ≥ 0.5 routes 68%, 93% right;
stacked choice ∧ noul ≥ 0.5 routes 59%, 95% right (the shipped rule); at 0.7 54% / 97%, at 0.9
44% / 99%. Of the 5 wrong at 0.5, 3 are out-of-scope settings requests (`switch the theme to dark
mode _`) the settings classifier rejects anyway → cede → fan-out. Stacking costs +148 input tokens
and no latency (223 vs 240 ms mean).

Why the fan-out is 3.42 calls and not 5: `supports()` cedes (config-intent on prose, transform on
inputs with no instruction shape), and the summon extraction / replace-detect are conditional. The
router's saving is therefore ~0.9 chat calls per `_`, concentrated on the transform fused call (the
largest prompt, cached but billed at the input rate on cerebras).

End to end on a live host (opencode, fresh fork from this branch, the three `_` scenarios that
pin dispatch counts, scalar off then on): 3/3 pass in both arms. With the router on, the fluid
scenario routed `lookup 1.00 / agree 0.93 → fluid-blank` (transform never started), the
config-intent scenario routed `settings 1.00 / agree 0.87 → config-intent` (neither chat sibling
started), and the transform scenario (`this is bad righting fix typos _`) chose `transform 0.96`
but its agreement noul scored 0.39, so it fell back to the fan-out (both started, as today). Route
latencies 237 / 576 / 3605 ms — the last an outlier on a fresh host, which is why the runtime now
gives the router a 1000 ms budget and fans out past it (no breaker trip).

Reading: −24% $ per `_`, 0 answers lost, 13 misroutes of today's fan-out corrected, one introduced;
+239 ms p50 on every `_` (the serial router in front of the first chat call, the trade ruled
acceptable). The ledger's `_` column moves from 422 (modelled) to the measured 448 → 687.

## contradiction detection in full — step 6 (verdict + sentence on one request, note = the rule, rewrite on demand)

2026-09-17 · jev-1.13.0 · rulings: note text = the rule statement verbatim ("just state the rule to keep it
cheap"), span = sentence-level unit Choice, rewrite fetched when the caret lands on the cue.

**Bench B — the span** (`contradiction-span-bench.mjs`; corpus `contradiction-corpus.mjs`: the company-rules
bench's six rulebooks, every violating sentence embedded between two of its domain's compliant / unrelated
sentences → 34 flagged pauses, ≥ 3 sentences each, reference span known by construction):

```
JEV/sentence   right rule 34/34 · unit = reference sentence 34/34 · outside 0 · none 0
               unit confidence mean 0.99 / min 0.84 · 286 ms · $0.000038 per pause · 894 in
JEV/clause     right rule 34/34 · unit = reference sentence 25/34 · inside it 9/34 · outside 0
               unit confidence mean 0.99 / min 0.92 · 267 ms · $0.000038 per pause
CHAT (today)   flagged 34/34 · right rule 34/34 · quote = reference 32/34 · inside 2/34 · 467 ms · $0.000579
```

Sentence-level is exact on every pause, on the same request as the verdict. Clause-level never leaves the
right sentence but sub-picks on 9/34, which buys nothing the sentence arm lacks. Shipped: sentences, cut
by `segmentSentences` (the sentence-cue segmenter), keyed `units.sN`.

**Bench A — the note** (`contradiction-note-bench.mjs`, same 34 pauses; blind pairwise, both orders,
two judges with thinking off):

```
                 chars mean / max   fits 80 cols   gpt-oss-120b   qwen-3.8-27b
CHAT (today)     54 / 85            31/34          32%            15%
RULE (verbatim)  69 / 102           27/34          85%            67%
QUOTED           125 / 158          0/34           33%            68%
```

Both judges prefer the rule statement to the chat-written tip by a wide margin; QUOTED (rule + "you
wrote: …") ties RULE on qwen and never fits the rail. RULE misses the 80 columns on 7/34 because some
shipped rules run to 102 chars — an authoring note for RULES.md (keep rules under ~75 chars), not a code
change. Shipped: `⚠ <rule statement>`.

**Per pause, the real rail** (`pause-bench.mjs`, 26 pauses, same session; the FUSED arm now carries the
unit Choice and a contradiction hit makes no chat call):

```
CHAT (today)   tips 8/8 · contradiction 5/5 · false alarms 0/13 · p50 418 / mean 513 ms · 2.00 chat per pause · $0.001600
FUSED          tips 8/8 · contradiction 5/5 · false alarms 0/13 · p50 250 / mean 269 ms · 0.00 chat + 1.00 Jev · $0.000100
```

Step 3's fused row was 0.20 chat calls per pause (the contradiction hits); step 6 takes the pause side to
zero chat calls. `company-rules-bench.mjs --gate typesafe` (which replays the gate then the chat matcher,
not the source) is unchanged: 28/28 recall, 22/22 restraint, 0 lost.

**The rewrite** (`SESSION_CONTRADICTION_RECONCILE_SYSTEM`): one small chat call (DECISION + SENTENCE →
the sentence rewritten, or NONE), fetched by the runtime when the caret lands on the cue's span
(`DynDefs.resolveDeferred`, deduplicated, a null remembered), applied on Ctrl+Alt+↑ / `_` — instantly if
it has landed, on arrival if not, never after an edit. Not benched for quality here: it is the same
rewrite the matcher used to emit, now asked for on its own.

## replace-detect as candidate selection — step 7A

2026-09-17 · jev-1.13.0 · `replace-bench.mts` on the fluid-blank-replace suite (66 cases: 28 replace,
22 fill, 16 none), same session as today's chat detector (`REPLACE_DETECT_SYSTEM_PROMPT` on cerebras).
The Jev request is core's `replaceDecisionRequest`: a `kind` Choice (fill / replace / none, with
examples that are not suite inputs), a `target` Choice over candidates the runtime cut (every word and
2-gram, ~15 per case) and a `command` Choice over the suffix phrases ending at the `_`.

```
CHAT (today)      class right replace 28/28 · fill 22/22 · none 14/16 · target right 27/28
                  would divert 28/28 · FALSE diverts (fill/none verified) 1 · $0.000587 · 363 ms
JEV               kind right  replace 28/28 · fill 21/22 · none 16/16 · target right 28/28
                  divert kind ≥ 0.5 ∧ target ≥ 0.5: 24–25/28 · ≥ 0.4: 26/28 · ≥ 0.3: 27/28 — 0 wrong targets, 0 FALSE diverts at every threshold
                  $0.000080 · 266 ms · 1908 in
```

The first phrasing (a bare `is_replace` noul + target) separated badly (replace noul mean 0.72, min 0.33;
fill max 0.81) and diverted 20/28. Two edits fixed it: examples per class on the `kind` Choice and a
focus line on what "it" / "that" refers to, and the deictic rule on the target question. The one fill the
choice still leans replace on (`8 in roman numerals _` → 8, 0.46) is the case that trips the chat
detector too.

End to end (`--arm e2e`: the REAL TransformBlankSource, fused on cerebras + the decision detector, value
read off the fused rewrite by `deriveReplaceValue`, then the shared `verifyReplaceDetect` gate):

```
replace: spliced 21/28 (75%) · spliced value matches the suite 21/21 · target right 21/21
fill/none: FALSE splices 0 · mean 505 ms per case
not spliced (fused merge instead): a command chosen too long (whole sentence, contains the target),
a low target confidence (402, 2.4.0, 12), two the fused rewrite changed beyond the target
```

Transform suites through `prod.ts --category literal,targeted --replace-parse chat|decisions`
(instruction-first inputs, judge-scored on the final text with the splice applied):
chat 55/57 (spliced 3) · decisions 56/57 (spliced 0 — the literal suite's targets recur inside the
command, which the shared verify rejects on both arms). Parity on the suites; the difference is jitter
on one targeted case.

Reading: the detector chat call goes (−86% on that leg, $0.00059 → $0.00008), no false splice on the
suite (the chat detector has one), every splice reproduces the suite's value; 1 in 4 single-piece
edits that used to get the exact splice take the fused merge instead. Three things must agree before a
splice — the kind choice, the target choice, the generative rewrite — and every string that reaches it
came from the buffer.

## spelling as a passenger on the pause request — step 7B

2026-09-17 · jev-1.13.0 · `misspelling-bench.mts` (44 drafts: 20 with one typo in context, 20 clean and
full of odd-but-correct words — names, packages, commands, identifiers, regional spellings — and 4
context errors reported apart), same session as the shipped spelling cue on cerebras gpt-oss-120b.
Ruled: spelling is not the selling point; it rides the pause request at whatever recall the passenger
gets, instead of a word-cues chat call on every pause.

```
CHAT (today's spelling cue)   typos caught 20/20 · clean drafts untouched 20/20 · their/there 1/4 · $0.0003 · 355 ms
JEV detect (Choice over the draft's words + none), flag at ≥ 0.8
                              typos caught 16–17/20 · wrong word 0 · clean untouched 20/20 · their/there 4/4 (not shipped as spelling)
                              $0.00003 · 264–289 ms · misses: safly, requst, mesages, accross — confident none (0.83–0.99)
JEV fix (Choice over the flagged word's edit-1 neighbourhood, ≤ 254 candidates ranked)
                              right 18/20 · wrong 1 (flashs → flash) · none 1 (identicle: two edits away) · 308 ms
E2E (real SessionCueSource, passenger only)
                              corrected right 14/20 · wrong word 0 · wrong fix 0 · nothing 6 · clean untouched 20/20
                              1.39 Jev requests per pause (the fix request only on a flag) · 407 ms
```

Recall probe (five shapes: words-only state, "read the letters" phrasing, two choices in one request,
one noul per word, letters spelled out): 14–16/20, the same four misses every time, per-word noul on
`safly` 0.06. A discriminative model judges what a token means, and to it `safly` is `safely`; the
generative cue reproduces the word and sees the letters. A primitive limit, not a phrasing one (one
phrasing reached 18/20 only with two suite words quoted as examples).

On the pause request (`pause-bench.mjs --spelling`, 26 typo-free pauses): $0.000100 → 0.000116 per
pause, p50 234 → 282 ms, no fix requests, tips and contradiction unchanged.

Reading: ~70% of typos corrected end to end with no false correction on the odd-but-correct set,
for +$0.000016 and ~+45 ms on the pause request and no word-cues chat call for spelling. Context
errors (their / there) are detected 4/4 but are not spelling and are not shipped here.
