# Decision provider — Jev, the primitives, and the integration plan

⚠️ Canonical reference for the decision layer: `packages/opencues-core/src/decisions/`,
the `decisions-provider` scalar, and every leg that moves a *decision* off a chat
call onto a calibrated decision model. Read this before writing a question, adding a
leg, or touching the dispatch chokepoint.

A **decision provider** answers typed questions about a state and returns
probabilities. It never generates text. That makes it a different thing from an LLM
provider: it has its own seam (`DecisionProvider`), its own scalar, its own dispatch
chokepoint (`dispatchDecision`), and it is never selectable in the three LLM buckets.
Today there is one implementation that matters, TypeSafe's **Jev** (`jev-1.13.0`,
pinned), and one fallback that exists so the standard never depends on one vendor
(`ChatFallbackDecisionProvider`, a constrained chat call with self-reported confidence).

Every number below is from the 2026-09-16 benchmark runs (5,300 requests) recorded in
the session scratchpad under `ts/bench/system/*/REPORT.md`; the per-leg gates that
matter for shipping live in `tests/benchmarks/decisions/`.

## The three primitives

| Primitive | Asks | Returns | Cost per question | Use it for | Do not use it for |
|---|---|---|---|---|---|
| `noul` | is this true? | `noul` 0–1, no separate confidence (use `|p − 0.5| × 2`) | ~22 input tokens, 18.5 output | gates ("spend the rewrite call?"), one-per-unit fan-outs (per word / rule / sentence), an `exists` check beside a Choice | ranking a catalogue (isolated nouls light up unrelated entries; a Choice's relative framing is what calibrates); arithmetic, dates, elapsed time |
| `choice` | which of these? | `choice`, full `probabilities`, `confidence` | ~22 input per plain option (~66 structured), ~10.5 output per option; ≤ 255 options | catalogue matching, routing, candidate selection (spans, corrections, clauses, sentence ids) — always with a concretely described `none` | two near-synonym options (first-listed bias: 10/20 flips on swap); rule-shaped rejections ("a comparative is not a preset") which a nearest-option chooser cannot express |
| `score` | where on this rubric? | `score` (probability-weighted position), `probabilities`, `confidence` | ~6 input per level, 17 output flat; 2–10 levels | one-dimensional ordinal judgements (formality, frustration, how stuck); monotone and unimodal in practice (Spearman 0.99 on a hand-ranked set) | anything multi-dimensional — a non-adjacent split means the rubric measures two things |

## The five mechanics

| Mechanic | Measured | What it unlocks |
|---|---|---|
| **Per-pause fan-out.** Every decision one pause could need, in one request; the draft is tokenised once; questions are isolated from each other. | 9 questions: 300 ms, $0.000112. 256 nouls: +200 ms wall, +60 ms server. Marginal question ~22 tokens ≈ $0.0000009. Isolation: ≤ 0.08 Δp with 30 siblings, 0 flips. | tips + rules + route + gates + "how stuck" in one call per pause; a speculative question is free enough to ask and ignore. |
| **Candidate selection over big lists.** Code generates candidates, Jev picks; the model never emits a string it was not offered. | 255-option Choice: 6.2k input tokens, 2.7k output (free), 435 ms. 200 plausible distractors: 100% accuracy, mass on ~1.7 options. | spelling corrections from a dictionary, replace-detect spans from n-grams, the offending clause, sentence ids, catalogue entries. Grounding becomes structural. |
| **Per-unit fan-outs.** One question per word / sentence / rule / event in one request. | 307 per-word nouls: 1.34 s, 37.5k input tokens, $0.0016, 0 false alarms on 292 clean words. Ceiling 2,838 questions per request. | whole-draft passes at a sixth of a cent; per-rule verdicts; per-sentence "does this cue apply". |
| **Probabilities as the product.** A distribution and a confidence for the price of the input; output is not billed. | Noise ±0.03, concentrated below confidence ~0.65. Every wrong answer in the behaviour run sat at ≤ 0.62. | a second axis for every cue (act / hold / drop), per-entry thresholds, "why did that fire" from the top-3 mass. Carried as data on `CueResult.confidence`; rendering is parked. |
| **Whole-document passes.** Big state, many questions, one call. | 20k-token document, 100 decisions: $0.0013, ~870 ms. Needle found at 0.99 at any position in 1k–20k tokens. 32k-token request ~1.1 s. | a document-level pass per pause (open questions answered elsewhere, contradictions across the buffer) instead of per-sentence calls. |

## Latency and limits, measured

- **A small request is ~255 ms p50 from this host, ~95 ms of it server time.** The rest is one ~160 ms round trip. Headers and body arrive together (gap 0.5 ms): there is nothing to stream, TTFT = total.
- **Input: 23 ms per 1k tokens end-to-end, 4.5 ms per 1k on the server.** The difference is upload. Cerebras' slope on the same link: 49 (qwen-3.8-27b) to 60 (gpt-oss-120b) ms per 1k.
- **Questions are nearly free**: p50 = 281 + 0.86 × N ms for nouls; the marginal server cost is under 1 ms.
- **Two ceilings**: state ≤ ~32.9k tokens (~172k chars), total input ≤ ~65.8k. Both are HTTP **400** `{"detail":{"error_type":"max_tokens_exceeded"}}` (the docs say 422). 256 options and 11 levels are 400s with a `detail` string.
- **No prefix cache, no response cache.** Same state + different question is not faster after the first call; identical requests return ±0.03-different probabilities. A stable 20k rubric costs ~700 ms of prefill on every call, which is why the fused 20k chat prompts stay on Cerebras (its cache is a latency win — cached tokens bill at the full input rate).
- **No rate limiting observed** up to ~100 req/s; no rate-limit headers exist; one 529 in 700 requests, no `Retry-After`. Per-request latency is flat from 1 to 32 in flight.
- **Cold connection +344 ms** (DNS ~10, TCP ~160, TLS ~173). Keep-alive is worth more than any prompt trimming. `NodeHttpAdapter` keeps connections alive; the adapter uses it.
- **Aliases**: `jev-latest` and `jev-preview` both resolved to `jev-1.13.0`; `jev-1.12` already returns *Unknown model*. Pin, bench on bump.
- **Tokens**: ~5.3 chars per token on English prose plus a fixed ~282-token overhead per request.

## Authoring rules, from the evidence

1. Put the whole question in `instructions`; the id is a code key (measured: the id is not read).
2. Key structured state by name and reference `` `rules.r4` ``; never `` `rules[3]` `` (read one-off: 11 of 27 flags cited the neighbouring rule). `validateDecisionRequest` rejects index paths.
3. Batch everything about one draft into one request; never N requests for N questions.
4. Describe `none` concretely ("a status update, reminder or general question, not a request"); expect it to lose against on-topic neighbours (5/9 with 10 on-topic intents, 8/9 against off-topic distractors). A "does the draft make a request at all?" noul is the safer gate.
5. Never ship a two-option Choice whose options are near-synonyms; merge them or add a `not_for`, and threshold on confidence rather than reading `choice`.
6. Plain-string criteria by default; structured `{what, not_for, examples}` where a taxonomy has known boundary confusions (+0.08 p(gold), 2× tokens).
7. Do not use a negated question as a consistency check on borderline inputs (off by 0.12–0.20 there).
8. Do not ask it to verify arithmetic, elapsed time or weekdays (pattern-matched: a 25-minute elapsed-time error scored 0.95 "correct"); compute in code, ask it only to extract operands.
9. Thresholds are per job: ~0.7 for gates, 0.5 for tips and spelling, 0.3 for `exists` checks. Anything within ±0.05 of a threshold is undecided. Action floor for this model: confidence ≥ 0.65.
10. Frame `_`: an "is the sentence unfinished" noul flagged every `_` draft until the instruction said a trailing `_` is a deliberate marker.

## The seam (`packages/opencues-core/src/decisions/`)

| File | What |
|---|---|
| `types.ts` | `DecisionProvider { ask(req, ctx) }`, the three question/answer shapes, `DecisionError` with a typed `kind` (`auth / budget / shape / overloaded / transport / malformed`), `DECISION_LIMITS`. |
| `typesafe.ts` | The adapter. Pinned model, bearer key from `TYPESAFE_API_KEY`, one retry on overloaded. `HttpAdapter.post` carries no status line, so errors are classified from TypeSafe's `{detail}` body (`parseTypeSafeBody`). |
| `chat-fallback.ts` | Same contract on a chat call. Self-reported confidence spread evenly over the other options; ordinal at best. The standard's "implementable without TypeSafe" claim; benched in step 8. |
| `dispatch.ts` | The chokepoint every leg calls: validate → dehydration floor over every string in the state → `ask` → `reportUsage` under `providerId: typesafe` → one `[decision][leg]` log line. Never swallows a failure. |

Scalar: `decisions-provider: off | typesafe` (feature registry; `off` default). Usage: `opencues usage` prices the `typesafe` row at $0.042 / $0. Doctor: a `TYPESAFE_API_KEY` row. PII: row 11 of the coverage table in `hydration-dehydration.md`.

## The cue side, case by case (reviewed 2026-09-17, after step 3)

What the session rail does for every combination, with a decision provider configured.
"Chat" = the pre-decision behaviour, byte-identical.

| situation | behaviour |
|---|---|
| tips on, watchlist present, ask off (the default) | one fused request: `tip0` (+ `tip1`… over 240 entries) + `gate`; contradiction chat call only on a gate hit; tip assembled from the pack |
| + ask on | + `ask` noul in the same request; the ask chat call only at ≥ 0.7 and only when neither leg flagged |
| no watchlist (no transcript yet, chrome) | the fused request carries only the tips Choice(s) (+ ask); state has no `decisions` |
| `tips-mode: off` | only `gate` (+ `ask`) |
| `decisions-fanout: off` | one decision request per leg (steps 1–2 shape); the ask gate still runs as its own small request |
| draft already contains an entry's command (`run /compact …`) | that entry is left out of the options (typed-trigger pre-check); the static path owns it |
| the cursor is mid-buffer | a prose tip's span is the sentence containing `context.cursor` (`sentenceAt`), the last sentence when the cursor is unknown; command tips span the whole buffer regardless |
| a tip scores within ±0.05 of 0.5 | hysteresis (`TIPS_HYSTERESIS`): once an entry has fired on a draft it keeps firing while it stays the top non-none option at ≥ 0.4 on a continuation of that draft (typed forward, backspaced, or the same cursor sentence) for 60 s; a new draft, a different top entry or a fall below 0.4 releases it. Lives in the source because sub-threshold candidates are only visible there; fresh fires still need 0.5 |
| the fused request fails (overloaded after its retry, transport, budget, malformed) | the same pause falls back to the CHAT path for every leg with no further decision call, and the breaker holds the provider down for 30 s (`DECISIONS_BREAKER_MS`); an outage costs one failed request per window, not one per leg per pause |
| the key is wrong (auth) | breaker for 10 min + one log line; `opencues doctor` shows the row |
| the fused request is aborted by a newer keystroke | empty result, no fallback, no breaker (the next pause asks again) |
| the gate says a decision id but the chat call finds nothing | empty (the chat call's grounding is authoritative); the gate only ever decides whether to spend the call |
| the gate says `none` below 0.5 | the chat call runs (a low-confidence none is not a skip) |
| a commitment statement contains a catalogue value | the state's copy (`decisions.cN`) is dehydrated by the floor; the Choice criteria copy is scanned and warned on, not rewritten (same policy as the chat path's SYSTEM message) |
| chrome / dsh (a page) | `buildDecisionProvider` refuses on a non-Node host; every leg stays on chat until the host bridges carry it |
| no `TYPESAFE_API_KEY` | one boot log line, every leg on chat; doctor warns |
| `decisions-provider: off` | nothing above runs; the code paths are the pre-step-0 ones |

Not on the decision layer yet (deliberately): `SentenceCueSource` rewrites (step 4's
needs-rewrite gate), `ContradictionLlmSource`'s per-sentence claim parse
(`contradiction-cues-mode`, off by default; a "does this sentence make a checkable
claim" noul is the obvious gate, not scheduled), word-cues (generation), AgentRewrite /
auditors (an "anything to change?" gate, after step 4).

## Integration plan (simplest first, each behind its gate)

No visual change at any step; confidence is carried as data and left unrendered.

| Step | Ships | Replaces | Gate |
|---|---|---|---|
| 0 ✅ | this seam, the compare bench | — | smoke |
| 1 ✅ | tips matching as one Choice over the pack + none (`SemanticTipsSource.matchDecision`, core 0.62.0) | tips chat call ($0.00127, 590 ms → $0.00007, 259 ms) | `semantic-tips-bench.mjs --provider typesafe` passes the ship gate on all four packs — done 2026-09-16, rows in RESULTS.md |
| 2 ✅ | contradiction pre-gate (`contradictionGateRequest`: Choice over the watchlist ids + none; chat call only when the gate does not skip; core 0.63.0) | contradiction call on every pause | `company-rules-bench.mjs --gate typesafe`: 22/22 silent drafts skipped, 0/28 violations lost, 0 false alarms — done 2026-09-16 |
| 3 ✅ | one Jev request per pause in `SessionCueSource.getCuesFused` (tips Choice + contradiction gate + ask noul; `decisions-fanout`; core 0.64.0) | 2–3 chat calls per pause | `pause-bench.mjs`: 0.23 chat calls per pause instead of 2, $0.000200 vs $0.001570, p50 238 vs 418 ms, accuracy at parity — done 2026-09-17 |
| 4 | ask-cues and needs-rewrite gates in front of their generation calls | ask call every pause; rewrite call every sentence | precision unchanged; gated-call count drops |
| 5 | the `_` router (design ruled separately: serial vs parallel-and-cancel) | 5 chat calls per `_` | router bench ≥ 95% on acted cases; agentic 08/09/102 |
| 6 | contradiction detection in full (clause Choice for the span; reconcile generated lazily) | the remaining contradiction call | same benches; span exactness |
| 7 | candidate-selection legs (replace-detect span, spelling via dictionary) | replace-detect call; part of word-cues | literal suite reproduced by code; a spelling bench |
| 8 | spec: `questions:` block, chat-fallback semantics, `confidence` on a cue result | — | spec bump checklist |

Every shipped step also updates **`tests/benchmarks/decisions/GAINS.md`**, the running
ledger: what moved, per-call before/after, per-event before/after (pause, `_`, sentence),
and the cumulative table. A step PR without its ledger entry is incomplete.

The benchmark row every step reports, from `tests/benchmarks/decisions/compare.mjs <leg>`:
the shipped bench's own accuracy metric · p50 / p90 ms · $ per call · tokens per call ·
calls per event, for the Cerebras leg and the Jev leg in the same session. A step ships
only at accuracy parity on the shipped gate with the cost or latency column lower.
