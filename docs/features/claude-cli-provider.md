# claude-cli — use your Claude subscription instead of an API key

If you already pay for Claude Pro or Max ($20–$200/mo) and have the
`claude` CLI installed, you can route opencues' agent surfaces through
your subscription instead of paying separately for an `ANTHROPIC_API_KEY`.

It's per-feature opt-in: word-cues stay on a fast OSS provider, while
prose-heavy surfaces like agent-rewrite use Claude via your subscription.

## Setup

1. Confirm `claude` is installed and authenticated:

   ```bash
   claude auth status     # should print "Logged in as ..."
   claude -p "ping"       # should print a one-line reply
   ```

   `opencues doctor` also surfaces the binary check.

2. Edit `~/.cues/OPENCUES.md`:

   ```yaml
   ---
   agent-rewrite-provider: claude-cli
   agent-rewrite-model: haiku        # see "Model names" below
   ---
   ```

   That's it. The next time you trigger an agent rewrite, opencues spawns
   a `claude -p` daemon in the background and routes the call through it.
   Subsequent calls reuse the same daemon (Anthropic prompt cache stays
   hot — fast).

### Model names

Both short aliases and full version-pinned names work — same as the
`claude --model` flag:

```yaml
agent-rewrite-model: haiku                          # latest Haiku (auto-tracks releases)
agent-rewrite-model: claude-haiku-4-5-20251001      # pinned to one version
agent-rewrite-model: claude-sonnet-4-6              # pinned Sonnet
agent-rewrite-model: claude-opus-4-7                # pinned Opus
agent-rewrite-model: claude-fable-5                 # pinned Fable
```

Use an **alias** (`haiku` / `sonnet` / `opus` / `fable`) when you want
the latest release of a family automatically. Use a **full name** when
you want reproducibility (your config keeps the same model even when
Anthropic ships a new generation — useful if you're benchmarking or
want to lock in a tested setup).

Either form picks the right latency-tuning automatically. The daemon
maps both `haiku` and `claude-haiku-*-*` to the same flag set internally.

## Pick the right model per pipeline

We measured the per-model wall-clock latency through `claude -p`:

| model  | p50    | p95    | recommended pipelines |
|--------|--------|--------|----------------------|
| haiku  | 840ms  | 874ms  | transform-blank, fluid-blank, agent-rewrite |
| sonnet | 1338ms | 1445ms | fluid-blank (borderline), agent-rewrite |
| opus   | 1982ms | 2900ms | agent-rewrite (when quality matters), transform-blank |
| fable  | *(not yet benched)* | *(not yet benched)* | pre-bench tuning mirrors opus |

**Word-cues are not supported** via `claude-cli` — they need sub-500ms
response and even Haiku via the CLI is over budget. Leave word-cues on
your existing fast OSS provider (Cerebras gpt-oss-120b recommended).

## What if I have both an API key and a subscription?

You can mix. Set the global LLM to a fast OSS provider for word-cues and
opt in to `claude-cli` only for the surfaces where it matters:

```yaml
---
# Fast default for everything LLM-driven
llm-provider: cerebras
llm-model: gpt-oss-120b

# Use my Claude Pro subscription for the prose-heavy stuff
agent-provider: claude-cli
agent-model: sonnet

transform-blank-provider: claude-cli
transform-blank-model: opus
---
```

## Why is `claude-cli` slower than `anthropic`?

Direct `anthropic` (HTTP API) is ~700ms for Haiku. `claude-cli` adds
~140ms of Claude Code overhead per turn (system prompt setup, tool
registry loading) — we measured this and confirmed it's structural; no
flag fully eliminates it. That's the cost of routing through CC instead
of hitting api.anthropic.com directly.

We accept the tradeoff because the alternative (extracting your OAuth
token and calling the API directly) is explicitly forbidden by Anthropic's
Feb 2026 ToS and is server-side blocked. `claude -p` is the only
sanctioned subscription transport today.

If Anthropic ships a sanctioned partner OAuth flow, we'll add it — track
[anthropics/claude-code#37205](https://github.com/anthropics/claude-code/issues/37205).

## When the daemon dies

If `claude` auth expires mid-session (8h access-token TTL), or you kill the
opencues host, the LLM-driven surfaces that use `claude-cli` go silently
inert until the daemon respawns. Recover via:

```bash
claude auth      # re-authenticate
```

The next agent-rewrite call automatically spawns a fresh daemon.

## Common questions

- **Will this hit my Claude usage limits?** Yes — calls count against
  your Pro/Max subscription quota same as any other `claude -p` call.
- **Does opencues see my conversations?** No. Each daemon turn is
  independent (no chat history). The system prompt is opencues' own
  (agent-rewrite prompt, etc.); the user-message is just the text being
  rewritten or analysed.
- **Can I use `claude-cli` in the Chrome extension?** No — Chrome can't
  spawn subprocesses. Chrome continues to use API providers
  (`ANTHROPIC_API_KEY` etc.). Subscription mode is a native-host
  feature (Claude Code, OpenCode, Gemini CLI).
- **What if I don't have `claude` installed?** `opencues doctor` warns
  you. Install from [claude.com/code](https://claude.com/code).

## See also

- [`docs/architecture/claude-cli-provider.md`](../architecture/claude-cli-provider.md)
  — full architecture deep-dive, ToS context, daemon design.
- `OPENCUES.md` reference: every `*-provider` scalar accepts `claude-cli`.
