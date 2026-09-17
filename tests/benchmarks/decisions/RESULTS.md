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
