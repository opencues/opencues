# Session-contradiction cues — architecture

Canonical reference for the `session-contradiction-mode` feature — the
Claude-Code-only "you're contradicting a decision you made earlier in this
session" cue. Read this before touching
`packages/opencues-core/src/session-commitments.ts`,
`packages/opencues-core/src/contradiction/session-contradiction-source.ts`,
the `extract-commitments` CLI, or the statusline kick. User-facing summary:
`docs/features/session-contradiction.md`.

## Two engines, one word

There are two unrelated "contradiction" features. Don't conflate them:

| | `contradiction-cues-mode` (`contradiction/checks.ts` + `contradiction-llm-source.ts`) | `session-contradiction-mode` (this doc) |
|---|---|---|
| Mechanism | model **routes** a sentence to a verifier; runtime **computes** the correction from data | slow producer builds a **watchlist**; fast matcher **authors** the contradiction against it |
| Correction | DATA (real weekday, arithmetic, weather) — can't hallucinate | LLM-generated (grounded, but authored) |
| Domain | real-world facts (dates, journeys, weather) | CC-developer decisions (stack, memory/compaction, scope) |
| Context needed | just the buffer + clock | the session transcript |
| Hosts | every host | Claude Code only (needs the transcript) |

They share the passive sentence-cue **render rail** (priority 87/88) and nothing
else.

## The two-stage shape: produce (slow) → match (fast)

The realtime half is cheap because the matcher isn't reasoning from scratch —
it checks the draft against a pre-built list.

### Stage A — the producer (slow, background)

`opencues extract-commitments <transcript_path>`
(`packages/opencues-cli/src/commands/extract-commitments.cjs`) distils the CC
session transcript into a terse **commitments watchlist**:

1. **Read** the transcript tail (last 256 KB) and parse it to plain user +
   assistant TEXT turns (`extractTranscriptTurns` in
   `session-commitments.ts`). tool_use / tool_result / thinking / image blocks
   are dropped — that's the data-minimization boundary (secrets and large
   payloads live there, decisions don't).
2. **Extract** with one cues-bucket LLM call
   (`SESSION_COMMITMENTS_EXTRACT_SYSTEM`) → a JSON array of
   `{category, statement}` — decisions/constraints across
   `stack | architecture | constraint | memory | scope | decision`. Precision
   over recall; secrets/code forbidden by the prompt.
3. **Write** `~/.cues/session-commitments.json`
   (`buildSessionCommitmentsSnapshot` normalizes + caps at `MAX_COMMITMENTS`,
   assigns stable `c<N>` ids).

Trigger: the CC statusline (`highlight-statusline.sh`) receives CC's
`{transcript_path, …}` JSON on stdin every turn. When the feature is on and a
short bash-level 5 s spawn-gate has elapsed, it fire-and-forgets the producer.
The producer *also* self-gates (mode off → exit) and self-debounces (a marker
records the transcript mtime + last-run time) with an 8 s batch floor, so a
burst of turns yields at most one LLM call per ~8 s. A lock file guards
concurrent kicks.

**Cadence tuning (measured).** Three intervals compose: the statusline
spawn-gate (5 s), the producer batch floor (8 s — the effective watchlist
cadence, kept *longer* than the spawn-gate so the two don't "beat"), and the
ingest poll (4 s). Net end-to-end, measured on cerebras/gpt-oss-120b: a fresh
session's first watchlist is active **~4–5 s** after activity (the first kick
has no stamp, so it fires immediately; producer ~0.8 s; ingest ≤4 s), and a
**mid-session** new decision becomes guardable in **~11–12 s**. The matcher
itself adds ~0.4–0.6 s once the watchlist is warm.

**Why the statusline is the trigger:** an OpenCues source in CC sees only the
input buffer — no transcript handle, no session id. The statusline is the one
CC hook that's handed `transcript_path`, so it's the natural producer trigger.
The CLI path is baked into the statusline by `setup.sh` (the fork's statusline
runs in the user's shell env, so `opencues` may not be on PATH).

### Stage B — the matcher (fast, per-keystroke)

`SessionContradictionSource`
(`packages/opencues-core/src/contradiction/session-contradiction-source.ts`)
runs one debounced LLM call over the WHOLE draft buffer against the watchlist
(`SESSION_CONTRADICTION_MATCH_SYSTEM` + `renderSessionCommitmentsCatalog`). It
flags any sentence that DIRECTLY contradicts a listed commitment. Whole-buffer
single call (not per-sentence): a contradiction is one judgement across the
draft — a coherent task, not N independent extractions.

The watchlist rides in the SYSTEM message (stable within a session → cerebras
prefix-caches it); the draft is the USER message.

## Ingest — live holder, re-read without restart

The CC boot band (`adapters/cc/v2.1/boot.ts`) calls
`buildSessionCommitmentsIngest` (`boot-common.ts`) — an mtime-gated 4 s
re-read of `session-commitments.json` into a live holder passed to the
`Resolver` as `options.sessionCommitments`. The resolver forwards it (gated by
`session-contradiction-mode`) onto every `CueContext` as `sessionCommitments`,
so a re-ingest applies without a host restart. Missing file → empty holder →
the source stays silent (the documented inert mode).

## Rendering — a passive sentence-cue at priority 88

A flag is emitted as a passive `sentence-cue:session-contradiction` result:
`alternatives: [offendingSentence, reconciledRewrite]`, a char-range span,
priority **88** (a sibling of the deterministic contradiction cue at 87; its
passive cue evicts `more-formal` at 85 on overlap). The resolver registers a
passive DynDef at `currentIndex: 0` — the buffer keeps the user's draft; the
`⚠` tip surfaces (inline or secondary, per `inline-cues-mode`) and
`Ctrl+Alt+↑` swaps in the reconciled rewrite. **Never auto-splices.**

## Grounding + safety invariants

This engine lets the model AUTHOR the contradiction (unlike the deterministic
one), so it's fenced:

- **Two grounding checks** (`getCues`): a flag survives only if its `quote` is
  an exact substring of the live buffer AND its `commitmentId` is one actually
  on the watchlist. The model can neither invent a span nor cite a
  non-existent commitment.
- **Passive, advisory-only.** Same safety class as sentence-cues: the buffer is
  never modified without an explicit keystroke, and there is no side-effect
  channel — worst-case injection is manipulated tip TEXT the user reads before
  acting.
- **Data minimization.** Only user/assistant prose reaches the producer; tool
  I/O and thinking are dropped before the LLM sees the transcript. The
  distilled watchlist is terse decisions, not raw transcript.
- **Egress note.** The watchlist (distilled session decisions) crosses to the
  cues-bucket provider — a different provider than the CC model the user is
  already talking to. This is the same trust class as sentence-cues (which
  already send the user's prose to the cues bucket). Off by default; enabling
  it is the consent. The watchlist is NOT PII-dehydrated in v1 (these are
  project decisions, not personal data); revisit before broadening the
  extraction to personal or credential-bearing content.

## Where to touch

- `session-commitments.ts` — types, transcript parser, extraction prompt,
  catalog render, snapshot builder. All pure + unit-tested
  (`session-commitments.test.ts`).
- `session-contradiction-source.ts` — the matcher + its prompt + grounding
  (`session-contradiction-source.test.ts`).
- `extract-commitments.cjs` — the producer (gate → debounce → lock → parse →
  wire call → write).
- `highlight-statusline.sh` `_oc_kick_commitments` + `setup.sh` bake step — the
  trigger.
- `boot-common.ts:buildSessionCommitmentsIngest` + `adapters/cc/v2.1/boot.ts` —
  the ingest.
- `resolver.ts` (`sessionCommitments` option + `CueContext` forward),
  `build-sources.ts` (`enableSessionContradiction` construction),
  `feature-registry.ts` + `config-loader.ts` (the scalar).

## Known v1 limitations

- **CC only.** Other hosts have no producer, so the holder stays empty and the
  source is inert. A future host with transcript access wires the same ingest.
- **Precision-tuned.** The matcher flags at most 3 sentences and errs toward
  silence; a subtle contradiction can be missed. That's deliberate — a false
  alarm on a developer's draft is worse than a miss.
- **No dehydration** of the watchlist (see egress note above).
- **Deliberate-revision ambiguity.** "actually, switch to X" is a real change,
  not a contradiction; the prompt tries to distinguish it but can't always.
  Passive rendering makes a false flag cheap to ignore.
