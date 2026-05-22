# claude-cli provider — subscription-backed transport

OpenCues integrates with Anthropic via two distinct transports:

1. **`anthropic`** — direct Anthropic Messages API. Pay-per-token via an
   `ANTHROPIC_API_KEY`. Fastest (~700ms p50 for Haiku), HTTP-shaped.
2. **`claude-cli`** — Anthropic via the user's locally-installed `claude`
   CLI. Counts against Pro/Max subscription quota. No API key. Subprocess-
   backed (a persistent `claude -p` daemon).

This doc covers `claude-cli` end to end: why it exists, why the OAuth-token
shortcut is off the table, the per-model latency floor we measured, the
daemon lifecycle, and the structural guarantees in the codebase.

The user-facing summary lives in [`docs/features/claude-cli-provider.md`](../features/claude-cli-provider.md).
Bench findings live in [`tests/benchmarks/thinking-budget/CLAUDE-CLI-FINDINGS.md`](../../tests/benchmarks/thinking-budget/CLAUDE-CLI-FINDINGS.md).

## Why ship it

Many opencues users already pay for Claude Pro or Max ($20–$200/mo) and have
the `claude` CLI installed and authenticated. Asking them to ALSO maintain
an `ANTHROPIC_API_KEY` (with separate billing) is duplicative. A
subscription-backed provider lets them flip one OPENCUES.md scalar and reuse
the auth they already have.

## Why not extract the OAuth token directly

Claude Code stores its OAuth bearer token at:

- macOS: keychain service `Claude Code-credentials`
- Linux/Windows: `~/.claude/.credentials.json` (mode 0600)

Shape: `{ claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes } }`.
Open-source projects like
[`griffinmartin/opencode-claude-auth`](https://github.com/griffinmartin/opencode-claude-auth)
read this file and POST directly to `api.anthropic.com` with
`Authorization: Bearer <token>` plus a specific beta-header stack
(`claude-code-20250219,oauth-2025-04-20,…`). That would give us API-direct
speed (~700ms) while counting against subscription quota.

We can't ship it. Anthropic's **20 Feb 2026 ToS update** explicitly forbids
the practice:

> "The use of OAuth tokens obtained via Claude Free, Pro, or Max accounts
> in any other product, tool, or service is not permitted."

Server-side enforcement followed shortly after — many third-party tokens
now return `401 "OAuth authentication is currently not supported"`
([openclaw#19938](https://github.com/openclaw/openclaw/issues/19938)).
There's an open feature request asking for a sanctioned partner OAuth flow
([anthropics/claude-code#37205](https://github.com/anthropics/claude-code/issues/37205));
until that lands, `claude -p` is the only authorised subscription transport.

## The latency floor

A persistent `claude -p` daemon adds ~140ms per turn on top of the direct
Anthropic API call. That overhead is structural — every turn loads tools /
agents / system prompt registry inside Claude Code before the API call
fires, and no flag fully eliminates it.

Per-model p50 / p95 (from
[`tests/benchmarks/thinking-budget/claude-cli-daemon-tuned.ts`](../../tests/benchmarks/thinking-budget/claude-cli-daemon-tuned.ts)):

| model  | p50    | p95    | optimal config |
|--------|--------|--------|----------------|
| Haiku  | **840ms**  | **874ms**  | `--exclude-dynamic-system-prompt-sections --disable-slash-commands --append-system-prompt` + env `CLAUDE_CODE_DISABLE_THINKING=1`, `MAX_THINKING_TOKENS=0` |
| Sonnet | **1338ms** | **1445ms** | same flags + `--effort low` + env `CLAUDE_CODE_DISABLE_THINKING=1` ONLY (the other env var interferes on Sonnet) |
| Opus   | **1982ms** | **2900ms** | same as Haiku (no `--effort`); thinking still helps Opus structurally but the flag combination causes regressions |

The per-model flag table is baked into `MODEL_FLAGS` in
`packages/opencues-core/src/providers/claude-cli-daemon.ts`. Re-run the
bench when bumping `claude` CLI versions; values are pinned to the May 22
2026 measurement on CC 2.1.111.

## Pipeline viability

| pipeline        | target p50 | claude-cli viable? |
|-----------------|-----------|--------------------|
| word-cue        | ≤500ms    | ✗ — even Haiku p50 840ms is over |
| transform-blank | ≤1000ms   | ✓ Haiku (borderline) |
| fluid-blank     | ≤1500ms   | ✓ Haiku, ✓ Sonnet |
| agent-rewrite   | 1–3s      | ✓ Haiku, ✓ Sonnet, ✓ Opus |
| prompt-improver | 5–10s ok  | ✓ all |

Users opt in per feature in OPENCUES.md (see "How to use" below). Mixing is
expected: most users will leave word-cues on a fast OSS provider
(Cerebras gpt-oss-120b) and route only agent-rewrite + prompt-improver to
`claude-cli` for higher-quality prose.

## Daemon lifecycle

`ClaudeCliDaemon` (in `packages/opencues-core/src/providers/claude-cli-daemon.ts`)
manages one `claude -p` subprocess per `(model, systemPrompt)` pair.
`ClaudeCliDaemonPool` is the get-or-create indirection — sources never
construct daemons themselves; they call `dispatchChat` → `invokeCli` →
`pool.get(model, systemPrompt).invoke(userPrompt)`.

Lifecycle invariants:

- **Lazy spawn.** The first `invoke()` call spawns the subprocess; nothing
  runs at construction time. A daemon never created is a daemon never
  spawned — important because the pool may hold many daemons that only
  fire for specific surfaces.
- **Serial queue per daemon.** `claude -p --input-format stream-json`
  processes one turn at a time; concurrent `invoke()` calls on the same
  daemon enqueue and execute in order.
- **Response correlation via `result` event.** Each turn ends with a
  single `{"type":"result","subtype":"success", "result": "..."}` line in
  the stream-json output. The daemon resolves the in-flight promise with
  that text and pumps the next queued request.
- **Idle reap at 5 min.** Matches Anthropic's ephemeral prompt-cache TTL.
  Past that the cache is cold anyway, so keeping the subprocess alive is
  wasted memory. Next `invoke()` lazily respawns.
- **Crash restart.** If the subprocess exits unexpectedly mid-queue,
  every pending request rejects with a clear error and the next call
  lazily spawns a fresh subprocess. No automatic retry — opencues callers
  treat LLM failures as silent no-op (the same shape as
  `withFallback`-wrapped HTTP errors).

## Per-model system prompts get their own daemon

`--append-system-prompt` is a launch-time flag on `claude -p`. Different
prompts can't share a process without losing prompt-cache hit ratio. The
pool keys daemons by `(model, FNV-1a-hash(systemPrompt))` to ensure each
source's system prompt gets its own cache-hot daemon.

In production this means each pipeline that opts into `claude-cli` gets
its own daemon: e.g. `agent-rewrite-provider: claude-cli` →
agent-rewrite's system prompt is the cache prefix for that daemon. Adding
`fluid-blank-provider: claude-cli` spawns a second daemon with the
fluid-blank prompt. The two pipelines never share a process — that's by
design, not an oversight.

## The transport-tag contract

`ProviderAdapter` gained a `transport?: 'http' | 'cli'` field. CLI
providers leave `buildRequest` / `parseResponse` as stubs that throw if
called (defensive) and supply `invokeCli(req, ctx)` instead. The single
`dispatchChat` helper in `llm-provider.ts` routes on the tag:

```ts
export async function dispatchChat(provider, httpAdapter, req, ctx) {
  if (provider.transport === 'cli') {
    if (!provider.invokeCli) throw new Error(`provider ${provider.id} declared transport='cli' but has no invokeCli`);
    return provider.invokeCli(req, ctx);
  }
  // HTTP path — byte-for-byte identical to pre-May-2026 inline dispatch
  const built = provider.buildRequest(req, ctx);
  const raw = await httpAdapter.post(built.url, built.body, built.headers);
  return provider.parseResponse(raw);
}
```

Every CueSource (`ConfigSource`, `FluidBlankSource`, `TransformBlankSource`,
`SentenceCueSource`, `ConfigIntentSource`) calls `dispatchChat`. They are
transport-agnostic — adding a third transport (e.g. WebSocket, or a future
sanctioned OAuth flow) requires touching `dispatchChat` only, not every
source.

## How to use

```yaml
# ~/.cues/OPENCUES.md
---
# Per-feature opt-in. Defaults stay on whatever provider you had set.
agent-rewrite-provider: claude-cli
agent-rewrite-model: haiku       # haiku | sonnet | opus

fluid-blank-provider: claude-cli
fluid-blank-model: sonnet
---
```

Requirements:

1. `claude` CLI installed (`opencues doctor` checks `which claude`).
2. `claude auth status` returns OK (`opencues doctor` does NOT probe this;
   would spawn a subprocess every run).

When the daemon dies (auth expired, network gone, host process killed),
the failure surfaces as the same silent no-op every other opencues LLM
failure does. Re-run `claude auth` and the next call lazily respawns.

## Tests

- `packages/opencues-core/src/dispatch.test.ts` — pins the
  `dispatchChat` transport-tag contract: HTTP path identical pre- and
  post-refactor, CLI path routes to `invokeCli`, never touches httpAdapter.
- `packages/opencues-core/src/providers/claude-cli-daemon.test.ts` —
  14 tests with injected fake spawn (no actual claude binary needed for
  CI): lazy spawn, per-model flag application, serial queueing,
  crash-mid-flight rejection, non-success result rejection, shutdown,
  line-delimited parser handles split chunks, idle reap, post-reap
  respawn, pool identity, pool shutdownAll.
- `packages/opencues-core/src/llm-provider.test.ts` — three new tests
  pin claude-cli's resolveLLM behavior: resolves without API key, no
  warning, no fallback peer; per-feature override works; NOT auto-picked.

## Tradeoffs we accepted

- **~140ms structural overhead vs direct API.** That's the cost of
  routing through Claude Code; no flag removes it. Word-cues are out of
  reach as a result.
- **One subprocess per (model, systemPrompt).** Could be N×M daemons if
  every pipeline opts in across every model — practical bound is more
  like 2–3 in real use. ~10MB memory per daemon when alive; idle reap
  bounds total even if the user toggles between many configs.
- **No automatic fallback peer.** Unlike groq↔cerebras, CLI providers
  have no HTTP peer to fall back to. If `claude` auth dies mid-session,
  the surfaces using `claude-cli` go inert until the user runs
  `claude auth` again.
- **No `PROVIDER_AUTO_ORDER` membership.** `claude-cli` is deliberate
  opt-in; pickAutoProvider never returns it just because the user has
  a `claude` install. Users explicitly choose subscription-mode per
  feature.

## When to revisit

- **If Anthropic ships a sanctioned partner OAuth flow.** That removes
  the ~140ms structural overhead and unlocks word-cues for subscription
  users. Watch [anthropics/claude-code#37205](https://github.com/anthropics/claude-code/issues/37205).
- **If `claude -p` startup improves substantially.** Bench script at
  `tests/benchmarks/thinking-budget/claude-cli-bench.ts` re-runs the
  per-call subprocess case in <1 minute.
- **If a CC version bump changes flag semantics.** Re-run
  `claude-cli-daemon-tuned.ts` to re-validate the per-model flag table.

## See also

- [`docs/features/claude-cli-provider.md`](../features/claude-cli-provider.md)
  — user-facing summary.
- [`tests/benchmarks/thinking-budget/CLAUDE-CLI-FINDINGS.md`](../../tests/benchmarks/thinking-budget/CLAUDE-CLI-FINDINGS.md)
  — raw bench data + re-run instructions.
- `packages/opencues-core/src/providers/claude-cli-daemon.ts` — the
  daemon class.
- `packages/opencues-core/src/llm-provider.ts` — `dispatchChat`,
  `CLAUDE_CLI` adapter, transport tag.
