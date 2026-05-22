# Claude CLI provider — benchmark findings

May 22 2026 measurement on Claude Code CLI v2.1.111 (Haiku 4.5, Sonnet 4.6,
Opus 4.7). Five probe scripts in this directory, each isolating a different
question about routing opencues through `claude -p` vs the direct Anthropic
API:

| script                          | question answered                          |
|---------------------------------|--------------------------------------------|
| `claude-ttft.ts`                | Direct-API TTFT across thinking budgets   |
| `claude-cues-ttft.ts`           | Direct-API TTFT for the word-cue prompt   |
| `claude-cli-bench.ts`           | Per-call subprocess latency (no daemon)    |
| `claude-cli-daemon-probe.ts`    | Persistent-daemon latency (baseline)       |
| `claude-cli-daemon-tuned.ts`    | Persistent-daemon latency (best flags)     |

## TL;DR

`claude -p` as a per-call subprocess is ~3-5s/call. Running it as a
persistent daemon drops that to **840ms p50 / 874ms p95 for Haiku** —
~140ms above the direct-API floor.

We can't get any closer without bypassing Claude Code entirely (which
would require OAuth-token extraction, explicitly forbidden by Anthropic's
Feb 2026 ToS and server-side blocked since).

## Per-model latency floor (after full tuning)

| model  | mean   | p50    | p95    | optimal config |
|--------|--------|--------|--------|----------------|
| Haiku  | 818ms  | **840ms**  | **874ms**  | base + env `CLAUDE_CODE_DISABLE_THINKING=1` + `MAX_THINKING_TOKENS=0`, NO `--effort` flag |
| Sonnet | 1340ms | **1338ms** | **1445ms** | base + env `CLAUDE_CODE_DISABLE_THINKING=1` ONLY (NOT `MAX_THINKING_TOKENS=0` — interferes on Sonnet) + `--effort low` |
| Opus   | 1892ms | **1982ms** | **2900ms** | base + env `CLAUDE_CODE_DISABLE_THINKING=1` + `MAX_THINKING_TOKENS=0`, NO `--effort` flag |

Base flags (same for every model):

```
claude --bare -p
  --no-session-persistence
  --input-format stream-json --output-format stream-json --verbose
  --exclude-dynamic-system-prompt-sections
  --disable-slash-commands
  --append-system-prompt <task-specific-prompt>
```

These flags + the per-model env are baked into the daemon's `MODEL_FLAGS`
table at `packages/opencues-core/src/providers/claude-cli-daemon.ts`.
Users never touch them; pick a model and the daemon applies the right
combo.

**Model-name handling.** The daemon accepts BOTH short aliases
(`haiku` / `sonnet` / `opus`) AND full version-pinned names
(`claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, etc.) — same shapes
`claude --model` itself accepts. Flag-table lookup keys on the
resolved FAMILY (substring match in `resolveModelFamily`), so a future
version within the same family inherits the tuning unchanged. If you're
re-running these benches to validate a new model generation, both forms
will hit the same code path; pick whichever your config uses.

## What we tried that DIDN'T help

| lever                                    | result                                          |
|------------------------------------------|-------------------------------------------------|
| `--tools ""` (disable all tools)         | Drops cache_read to 0 — slower, not faster      |
| `--permission-mode bypassPermissions`    | Slight regression                               |
| `--effort low` (alone) on Haiku          | Slower (~6s for "1+1" vs ~3s default)           |
| `MAX_THINKING_TOKENS=0` on Sonnet        | Interferes with `--effort low` — slower         |
| Streaming for cue-style short outputs    | TTFT savings cancelled by SSE framing overhead  |
| OAuth-token extraction → direct API     | ToS-blocked + server-side rejected (401)        |
| Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | Requires `ANTHROPIC_API_KEY` — no subscription support |

## Streaming TTFT for cues (deep-dive)

For long outputs streaming wins: TTFT-text << total. For the typical
word-cue output (~12 tokens of `INDEX:correct` lines), Haiku generates
the whole response in ~700-800ms — SSE framing overhead (~100-200ms) eats
most of the TTFT benefit.

Per-case (8 cases, `claude-cues-ttft.ts`):

| metric                | buffer | stream TTFT |
|-----------------------|--------|-------------|
| mean                  | 807ms  | 1395ms      |
| p50                   | 822ms  | 701ms       |
| p95                   | 916ms  | 5711ms      |
| outputs match buffer? | yes    | yes         |

5/8 cases: streaming TTFT beat buffer total by 15-37%. 3/8: streaming was
slower. The variance is real and the median is only marginally better.
Streaming is the right call for prose-heavy surfaces (agent-rewrite,
transform-blank — paragraph-length output); not worth it for cues.

## How to re-run

When `claude` CLI versions bump or the bench data starts showing drift:

```bash
# Per-model tuned daemon (validates the MODEL_FLAGS table):
MODEL=haiku  npx tsx tests/benchmarks/thinking-budget/claude-cli-daemon-tuned.ts
MODEL=sonnet npx tsx tests/benchmarks/thinking-budget/claude-cli-daemon-tuned.ts
MODEL=opus   npx tsx tests/benchmarks/thinking-budget/claude-cli-daemon-tuned.ts

# Per-call subprocess (validates the "don't use this without a daemon" claim):
npx tsx tests/benchmarks/thinking-budget/claude-cli-bench.ts

# Direct-API streaming vs buffered for cue outputs:
npx tsx tests/benchmarks/thinking-budget/claude-cues-ttft.ts
```

All scripts read `ANTHROPIC_API_KEY` for the direct-API arms. The CLI
arms use whatever `claude` is on `$PATH` and its existing auth.

Variance is the biggest issue with these benchmarks — each run has at
least one 5-9s outlier per 6-call sweep, attributable to network jitter
or Anthropic-side scheduler effects. Re-run 2-3 times to confirm the p50
trend before declaring a config "best".

## Confirmation: this floor is real

Tested with three different fresh hosts and consistent results within
±100ms on p50. The 140ms gap vs direct-API persists across all variants —
turning off thinking, disabling skills, dropping plugins, replacing the
system prompt, all of them shave at most 50ms before hitting the floor.
The remainder is structural Claude Code per-turn init that no CLI flag
exposes.

## Decisions baked from these numbers

1. **Per-model flag tables in `MODEL_FLAGS`** — Haiku, Sonnet, Opus each
   get different flag combos because no single config wins across all
   three models.
2. **`--append-system-prompt` over `--system-prompt`** — replacing CC's
   default system prompt loses cache; appending keeps the ~5k-token
   default cached and just adds our task prompt.
3. **`CLAUDE_CONFIG_DIR` is NOT forced** — users keep their real config;
   we don't shadow it. The daemon spawns under the user's normal env.
   (Earlier experiments forced `CLAUDE_CONFIG_DIR=/tmp/empty-claude` to
   drop user plugins; net gain was <50ms and the user's plugins are
   sometimes load-bearing.)
4. **Word-cues excluded** — too slow for the ≤500ms target. Documented
   in the pipeline-viability matrix.
5. **No `PROVIDER_AUTO_ORDER` membership** — claude-cli is deliberate
   opt-in per feature, never auto-picked.

## See also

- `docs/architecture/claude-cli-provider.md` — full architecture deep-dive.
- `docs/features/claude-cli-provider.md` — user-facing summary.
- `packages/opencues-core/src/providers/claude-cli-daemon.ts:MODEL_FLAGS`
  — the production flag table. Update in lockstep with these findings.
