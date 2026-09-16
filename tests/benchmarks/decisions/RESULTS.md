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
