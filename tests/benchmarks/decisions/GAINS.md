# Jev integration — gains ledger

One entry per shipped step: what moved off a chat call, what it cost before and after
(measured, same session, this WSL2 host at ~160 ms RTT), and the cumulative effect on the
events a user actually pays for (a pause, a `_`, a sentence). Numbers per call come from
`RESULTS.md`; per-event numbers come from the cost model in
`bench/system/cost/model.json` (scenario (a): a 1-hour coding session, 120 pauses, 15 `_`,
tips on, contradiction on, ask off). Update this file in the same PR as the step.

Prices: cerebras gpt-oss-120b $0.35/M in, $0.75/M out, cached tokens at the input rate;
TypeSafe jev-1.13.0 $0.042/M in, $0 out.

## Baseline — everything on cerebras (measured 2026-09-16, real sources through core)

| event | chat calls | $ per event | latency to decision |
|---|---|---|---|
| pause, ask off (tips ∥ contradiction) | 2 | 0.001757 | 590 ms |
| pause, ask on | 3 | 0.002480 | 988 ms |
| `_` (config classifier ∥ summon ∥ transform fused ∥ replace-detect ∥ fluid) | 5 | 0.006429 | 422 ms |
| sentence, sentence-cues on | 1 | 0.000434 | 462 ms |
| **1-hour coding session (a)** | **315** | **$0.3073** | pause 590 / `_` 422 |

## Step 1 — tips matching → Jev (PR #461, core 0.62.0)

**What moved:** the `SemanticTipsSource` matching call. The note, the command and the span
are assembled from the pack; the model returns an id and a probability.

Per call, gate-passing on every pack (shipped ship gate, both arms same session):

| pack | before (cerebras) | after (Jev) | latency | cost |
|---|---|---|---|---|
| claude-code | 573 ms · $0.00124 · 20/20 · 0/10 | 259 ms · $0.00008 · 20/20 · 0/10 | −55% | −94% |
| opencode | 397 ms · $0.00109 · 14/14 · 0/6 | 265 ms · $0.00006 · 14/14 · 0/6 | −33% | −94% |
| gemini-cli | 456 ms · $0.00116 · 24/24 · 0/12 | 272 ms · $0.00007 · 24/24 · 0/12 | −40% | −94% |
| shell | 618 ms · $0.00082 · 10/10 · 0/5 | 267 ms · $0.00004 · 10/10 · 0/5 | −57% | −95% |

Per event (the tips call is one of the two parallel calls on a pause; the pause's
latency is the slower of the two, which is now the contradiction call):

| event | before | after step 1 | Δ |
|---|---|---|---|
| pause, ask off | 2 chat · $0.001757 · 590 ms | 1 chat + 1 Jev · $0.000558 · 461 ms | −68% $, −22% ms |
| pause, ask on | 3 chat · $0.002480 · 988 ms | 2 chat + 1 Jev · $0.001280 · 859 ms | −48% $, −13% ms |
| **1-hour session (a)** | 315 chat · $0.3073 | 195 chat + 120 Jev · $0.1634 | **−46.8%** |
| 500 users × 4 h | $614.66 / day | $326.75 / day | −$288 / day |

What did not change: the contradiction and ask calls (steps 2–4), every `_` (step 5),
sentence rewrites (step 4). Accuracy: at parity on the shipped gate on all four packs;
the exploratory bench's one false alarm is removed by the typed-trigger pre-check.

## Step 2 — contradiction pre-gate → Jev (core 0.63.0)

**What moved:** nothing generative. A Choice over the watchlist's ids + `none` runs before the
contradiction chat call; a confident `none` (≥ 0.5) ends the pass. The chat call, its quote, tip
and reconciled rewrite are unchanged on every draft that reaches it.

Per draft (company-rules bench, 50 drafts, same session):

| draft | before (cerebras) | after (gate + chat only on a hit) | Δ |
|---|---|---|---|
| silent (22/22 skipped) | 395 ms · $0.000417 | ~270 ms · $0.000031 | −32% ms, −93% $ |
| violation (28/28 kept) | 395 ms · $0.000417 | ~730 ms · $0.000298 | +85% ms, −29% $ |
| bench overall (56% violations) | $0.0209 | $0.0150 | −29% $; 0 lost, 0 false alarms |

Per event, with the cost model's 10% not-none rate on realistic drafts (step 1 already banked):

| event | after step 1 | after step 2 | Δ vs step 1 |
|---|---|---|---|
| pause, ask off | 1 chat + 1 Jev · $0.000558 · 461 ms | 0.1 chat + 2 Jev · $0.000166 · ~320 ms (a positive pause ~730) | −70% $, −31% ms |
| **1-hour session (a)** | $0.1634 | ≈ $0.088 (per-draft rows measured; per-event modelled until step 3's fused request is measured end to end) | −46% |

## Step 3 — one decision request per pause (core 0.64.0)

**What moved:** the two per-leg decision calls from steps 1–2 become one request carrying the
tips Choice, the contradiction gate and the ask gate (`SessionCueSource.getCuesFused`). The
generation calls that remain (a contradiction hit's quote/tip/reconcile, an ask hit's question)
run as before. `decisions-fanout: off` keeps one call per leg.

Per pause, MEASURED end to end on the real rail (`pause-bench.mjs`, 26 pauses, same session):

| pause | before (chat, today) | after step 3 (fused) | Δ |
|---|---|---|---|
| ask off | 2.00 chat · $0.001570 · p50 418 / mean 544 ms | 0.23 chat + 1 Jev · $0.000200 · p50 238 / mean 345 ms | **−87% $, −43% p50** |
| ask on | 2.50 chat · $0.001927 · p50 550 / mean 656 ms | 0.50 chat + 1 Jev · $0.000417 · p50 489 / mean 483 ms | −78% $, −11% p50, −26% mean |

Accuracy at parity on both arms (tips 8/8, contradiction 5/5, traps 0/13 ask-off; the ask cue's
two alarms are identical under both arms). One borderline tip draft reported, not gated.

Per hour of coding (scenario (a): 120 pauses, ask off), now with a measured per-pause row:

| | chat calls | Jev calls | $ pauses | $ `_` (15, unchanged) | $ / hour | vs baseline |
|---|---|---|---|---|---|---|
| baseline | 240 + 75 | 0 | 0.211 | 0.096 | 0.307 | — |
| after step 3 | 28 + 75 | 120 | 0.024 | 0.096 | **0.120** | **−61%** |

The remaining $0.096/hour is the `_` side (5 chat calls per underscore), which step 5 addresses.

## Step 4 — the rewrite call behind a gate (core 0.65.0)

**What moved:** nothing generative. `more-formal/CUE.md` carries a `gate:` noul; one decision
request per pass asks it (plus a prose check) for every sentence, and the rewrite call is spent only
at ≥ 0.5. The ask-cues gate landed in step 3. The calendar cue has no gate and is untouched.

Per sentence (sentence-cues suite, 34 sentences, same session):

| | before (every sentence sent) | after (gated) | Δ |
|---|---|---|---|
| rewrite calls | 31 | 22 | −29% |
| $ per sentence | 0.000385 | 0.000299 | −22% |
| wanted rewrites emitted | 21/23 | 20/23 | −1 (the fuzziest sentence) |
| unwanted rewrites emitted | 1 | 0 | −1 |
| latency per buffer, mean | 575 ms | 486 ms | −15% |
| latency per buffer, p50 | 314 ms | 505 ms | +61% on buffers that still need a rewrite (serial gate) |

Per hour of heavy writing (scenario (d): 60 sentence rewrites on top of (a)): 60 → ~43 rewrite
calls, ≈ −$0.007/hour. Small in dollars; the pattern (a cue file gates its own generation call) is
what AgentRewrite / auditors reuse. The p50 regression on rewritten sentences is the cost of a
serial gate in a separate source; folding sentence gates into the per-pass request is the
follow-up.

## Step 5 — the `_` router (core 0.66.0, runtime 0.41.8; design A ruled 2026-09-17)

**What moved:** which chat blank sources a `_` dispatches. One stacked decision request (a 5-way
choice + one agreement noul per chat route) runs first; at choice ≥ 0.5 with its noul ≥ 0.5 the
pass dispatches only the routed source (settings → config-intent, transform → transform-blank,
lookup → fluid-blank). Below that, `device` / `other`, a keyword-bound `_`, or a failed request →
the full fan-out as today. A routed source that cedes is followed by the fan-out over the rest.
The non-`_` sources (session rail, sentence cues, word cues) are never filtered.

Per `_` (171 labelled underscores, real sources, same session):

| | before (fan-out) | after (routed) | Δ |
|---|---|---|---|
| chat calls per `_` | 3.42 | 2.51 (+1 Jev) | −27% chat |
| $ per `_` | 0.004227 | 0.003212 | −24% |
| answers lost | — | 0 | |
| winner agrees with today | — | 157/171 | 13 of the 14 are today's misroutes corrected (lookups transform-blank had won) |
| latency p50 | 448 ms | 687 ms | +239 ms (serial router; accepted) |
| latency mean | 539 ms | 804 ms | +265 ms |

Per hour of scenario (a) (15 underscores): $0.063 → $0.048 on the `_` side. Small in dollars
against the pause side; the router is also the request steps 6–7 stack their candidate questions
on (replace-detect spans, spelling), which is why it is a serial request and not a cancel.

## Step 6 — contradiction detection in full (core 0.67.0, runtime 0.41.9)

**What moved:** the last chat call on the pause side. The fused request now carries a sentence-level
unit Choice next to the verdict; on a hit the cue is built from the two answers (note = the rule
statement verbatim, span = the runtime-cut sentence) with no chat call. The reconciled rewrite is
generated only when the person goes to the cue (caret lands on the span), one small call.

Per pause (`pause-bench.mjs`, 26 pauses, same session):

| | before (step 3) | after (step 6) | Δ |
|---|---|---|---|
| chat calls per pause | 0.20 | **0.00** (+1 Jev) | the last one |
| $ per pause | 0.000109 | 0.000100 | −8% (the hits were rare) |
| latency p50 / mean | 238 / 345 ms | 250 / 269 ms | a flagged pause no longer waits for a chat call (~730 → ~270 ms) |
| tips / contradiction / false alarms | 8/8 · 5/5 · 0/13 | 8/8 · 5/5 · 0/13 | parity |

Per hour of scenario (a): the pause side is 120 Jev requests and zero chat calls, ≈ $0.012/h against
the $0.307/h baseline. The remaining chat spend is the `_` side (step 5) and the on-demand calls (a
rewrite when the person goes to a cue, an ask question above its gate).

## Step 7A — replace-detect as candidate selection (core 0.68.0)

**What moved:** the replace detector's chat call, on every transform-routed `_`. One decision
request in its place (kind / target / command over candidates the runtime cut), in parallel with the
fused call as before; the value comes from the fused rewrite's diff at the chosen target.

| | before (chat detector) | after (decision detector) | Δ |
|---|---|---|---|
| detector cost per transform `_` | $0.000587 | $0.000080 | −86% |
| detector latency (parallel to fused, not on the critical path) | 363 ms | 266 ms | |
| false diverts on the suite | 1 | 0 | |
| single-piece edits that get the exact splice | 28/28 | 21/28 | the rest merge, as every non-detected edit does |

Per hour of scenario (a) the `_` side goes ≈ $0.048 → ≈ $0.043 (only the transform-routed share
carries a detector). Small in dollars; the leg is about grounding: the target and the command are
candidates, the value is read off a rewrite that had to reproduce the buffer.

## Cumulative

| after step | chat calls / hour | $ / hour | saving vs baseline | pause ms | `_` ms |
|---|---|---|---|---|---|
| baseline | 315 | 0.3073 | — | 590 | 422 |
| 1 (tips) | 195 | 0.1634 | 46.8% | 461 | 422 |
| 2 (contradiction pre-gate) | ~87 chat + 240 Jev | ≈0.111 | ≈64% (per-draft measured; per-event at the 10% not-none assumption; `_` side included) | ≈320 | 422 |
| 3 (one request per pause) | 103 chat + 120 Jev | 0.120 (measured per-pause) | 61% | 238 p50 / 345 mean (measured) | 422 |
| 4 (sentence gate) | (a) unchanged; (d) 60 → ~43 rewrite calls | (d) 0.146 → ≈0.139 | (d) ≈ −58% vs its baseline 0.333 | — | 422 |
| 5 (`_` router) | (a) 15 `_` × 3.42 → 2.51 chat + 15 Jev | (a) `_` side 0.063 → 0.048 (measured per-`_`) | (a) total ≈ 0.105/h, ≈ −66% | — | 687 p50 / 804 mean (measured; was 448 / 539) |
| 6 (contradiction in full) | (a) 38 chat (all `_`) + 135 Jev | ≈ 0.060/h (pause 0.012 + `_` 0.048) | ≈ −80% | 250 p50 / 269 mean (measured) | 687 / 804 |
| 7A (replace detector) | (a) ≈ 33 chat + ≈ 140 Jev | ≈ 0.055/h (pause 0.012 + `_` 0.043) | ≈ −82% | 250 / 269 | 687 / 804 |

Modelled rows are from the cost model before the step ships and are replaced with measured
rows when it does.
