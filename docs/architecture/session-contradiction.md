# Session-contradiction cues — architecture

Canonical reference for the `session-contradiction-mode` feature — the
"you're contradicting a decision you made earlier in this session" cue, on any
host with a session transcript (Claude Code, OpenCode, Gemini CLI). Read this
before touching `packages/opencues-core/src/session-commitments.ts`,
`packages/opencues-core/src/contradiction/session-contradiction-source.ts`,
`packages/opencues-core/src/sources/session-cue-source.ts` (the fused wrapper),
the `extract-commitments` CLI, or the host kick triggers. User-facing summary:
`docs/features/session-contradiction.md`.

## Two engines, one word

There are two unrelated "contradiction" features. Don't conflate them:

| | `contradiction-cues-mode` (`contradiction/checks.ts` + `contradiction-llm-source.ts`) | `session-contradiction-mode` (this doc) |
|---|---|---|
| Mechanism | model **routes** a sentence to a verifier; runtime **computes** the correction from data | slow producer builds a **watchlist**; fast matcher **authors** the contradiction against it |
| Correction | DATA (real weekday, arithmetic, weather) — can't hallucinate | LLM-generated (grounded, but authored) |
| Domain | real-world facts (dates, journeys, weather) | CC-developer decisions (stack, memory/compaction, scope) |
| Context needed | just the buffer + clock | the session transcript |
| Hosts | every host | any host with a transcript (Claude Code, OpenCode, Gemini CLI) |

They share the passive sentence-cue **render rail** (priority 87/88) and nothing
else.

## The two-stage shape: produce (slow) → match (fast)

The realtime half is cheap because the matcher isn't reasoning from scratch —
it checks the draft against a pre-built list.

### Stage A — the producer (slow, background)

`opencues extract-commitments <transcript_path> [--format cc|gemini|opencode] [--cwd <dir>]`
(`packages/opencues-cli/src/commands/extract-commitments.cjs`) distils the host
session transcript into a terse **commitments watchlist**:

1. **Read** the transcript tail (last 256 KB) and parse it to plain user +
   assistant TEXT turns. Each host has its own parser, selected by `--format`:
   `extractTranscriptTurns` (CC JSONL), `extractGeminiTranscriptTurns` (Gemini
   JSONL / legacy single-object), and `readOpenCodeTurns` (OpenCode's SQLite
   store via `node:sqlite`, cwd-authoritative). All in `session-commitments.ts`
   / the producer. tool_use / tool_result / thinking / image blocks are dropped
   — that's the data-minimization boundary (secrets and large payloads live
   there, decisions don't).
2. **Extract** with one LLM call (`SESSION_COMMITMENTS_EXTRACT_SYSTEM`) → a
   `{summary, commitments:[{category, statement}]}` object — decisions/constraints
   across `stack | architecture | constraint | memory | scope | decision`, plus a
   one-line session `summary` (the latter grounds the sibling ask-cues source).
   Precision over recall; secrets/code forbidden by the prompt. Routes to
   **Claude Haiku** when `ANTHROPIC_API_KEY` is set (cheap large-context read;
   `OPENCUES_EXTRACT_PROVIDER`/`_MODEL` override), else the cues bucket.
3. **Merge — incremental distillation.** The tail read only ever sees the most
   RECENT turns, so in a long, tool-heavy coding session early decisions age out
   of every fresh distillation (the recall boundary the real-transcript bench
   surfaced — `tests/benchmarks/session-contradiction/RESULTS-real-transcripts.txt`).
   So the fresh tail decisions are MERGED into the watchlist already built THIS
   session rather than overwriting it. The merge is split by trust of judgement:
   - **Preservation + dedup + cap → deterministic** (`mergeSessionCommitments`):
     a prior decision survives unless it's explicitly superseded or a duplicate;
     accumulation can never *silently* lose a decision. An empty-tail tick
     preserves the whole watchlist (no wipe).
   - **Supersession → its own small LLM call** (`SESSION_COMMITMENTS_SUPERSEDE_SYSTEM`),
     NOT folded into the extraction prompt (overloading it regresses extraction —
     the SUMMON-in-classifier lesson). Given the prior + fresh lists it names only
     the prior statements a newer decision REPLACES ("actually switch to X"), so a
     revised decision doesn't leave a stale entry that would *false-alarm* the
     matcher — precision was the feature's best property (~100% on real
     transcripts) and this protects it. Only runs when there's fresh content.

   The watchlist is **per-session**: it accumulates within a session but RESETS on
   a new session (the snapshot's `sessionId` = the transcript basename; a mismatch
   starts fresh). If `@opencues/core` lacks the merge fn (older bundle), the
   producer degrades to the previous overwrite behaviour.
4. **Write** the watchlist, **scoped per working directory** so two sessions in
   different repos (or two hosts) never clobber a shared file:
   `<cues>/session-commitments/<key>.json` where `key = sessionCommitmentsKey(cwd)`
   (slug of the cwd; `session-commitments.ts`). With no `--cwd`, it falls back to
   the legacy flat `<cues>/session-commitments.json` (hand runs, tests). The
   debounce marker + lock are scoped the same way. `buildSessionCommitmentsSnapshot`
   normalizes + caps at `MAX_COMMITMENTS` and assigns stable `c<N>` ids.

Trigger: **every host kicks the producer from its boot band** via
`startSessionCommitmentsKick` (`boot-common.ts`), a mode-gated poller that
watches the host's own transcript and fire-and-forgets the producer with the
right `--format` + `--cwd host.cwd` when it changes. Each host supplies a
locator: `locateNewestCCTranscript` (CC — newest `.jsonl` under
`~/.claude/projects/<cwd-slug>/`), `locateNewestGeminiChat` (Gemini's chat
JSONL), `locateOpenCodeDb` (OpenCode's SQLite, whose `-wal` mtime is the change
signal). This means the feature **does not depend on any opt-in UI** — it works
out of the box once the mode is on.
- **Claude Code additionally** kicks from the statusline
  (`highlight-statusline.sh`), which receives CC's `{transcript_path,
  workspace.current_dir, …}` JSON on stdin every turn — a belt-and-braces path
  for when the statusline is enabled. A double kick is harmless: the producer
  self-debounces + locks, so at most one runs. (Before the boot poller, the
  statusline was CC's *only* trigger, so session-contradiction was silently
  inert whenever the opt-in statusline was off — the default. The boot poller
  closed that gap by construction.)

The producer *also* self-gates (both modes off → exit) and self-debounces (a
scoped marker records the transcript mtime + last-run time) with an 8 s batch
floor, so a burst of turns yields at most one LLM call per ~8 s. A scoped lock
file guards concurrent kicks.

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

**The pre-gate (`decisions-provider`).** With a decision package installed
(docs/architecture/decisions.md) the source asks the `contradictionGate` leg
BEFORE the chat call with the draft, the watchlist as `{id, statement}` and the
draft's sentences cut by `segmentSentences` (`contradictionUnits`, keyed
`s1…`). A confident `none` (≥ 0.5, `contradictionGateSkips`) ends the pass with
no chat call; a gate error falls through to the chat call: the gate can save a
call, never lose a cue. The gate's confidence rides `CueResult.confidence` as
data when the chat call cited the same decision.

**Detection on the decision layer.** The same verdict may name a UNIT. On a
hit at ≥ `CONTRADICTION_FIRE_THRESHOLD` (0.5) with a unit, the cue is built from
data with no chat call: the span is the chosen sentence (a substring by
construction), the note is the decision's own statement (`⚠ <statement>`), and
the result carries `metadata.deferredRewrite = { commitmentId, statement, quote }`
with `alternatives: [sentence, sentence]`. The reconciled rewrite is fetched by
the runtime when the caret lands on the span (`reconcile`, one small call:
`SESSION_CONTRADICTION_RECONCILE_SYSTEM`) and applied on the press; a NONE /
echo / failure leaves the note in place and is never asked twice. A hit under
the fire floor, or with a `none` unit, runs the chat matcher: engineering
violations come back confidently, style rules ("do not hedge a commitment") sit
closer to `none`, and without the floor low-confidence hits painted cues on
clean drafts. The chat matcher below remains the path without a package, and
the fallback. **Style rules work through this leg unchanged** — see docs/features/session-contradiction.md
§ Rules about how you write.

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
  already send the user's prose to the cues bucket). **ON by default as of
  core 0.48.0**, so the opt-in consent gate no longer bounds this — the parse
  boundary does, and it is now the whole of the defence rather than a second
  layer behind a toggle. Weigh any change to what the producer reads against
  that. The watchlist is NOT PII-dehydrated in v1 (these are project decisions,
  not personal data); revisit before broadening the extraction to personal or
  credential-bearing content.

## Company / project rules — `RULES.md`

The matcher takes any watchlist, and benching it on org-policy statements
across five industries (`tests/benchmarks/session-contradiction/company-rules-bench.mjs`
— engineering, comms, support, healthcare, finance) scored **19/19 recall,
19/19 right-rule-cited, 0 false alarms** on topic-adjacent compliant traps, on
both gpt-oss and gemma, with the production prompt unchanged. So rules are a
LOADER, not an engine: static watchlist entries that come from a file instead
of a transcript, skipping Stage A entirely.

- **File**: `RULES.md` in the standard `.cues` search paths; project beats
  user; every `- ` bullet is one rule, everything else is ignored prose
  (`parseRulesMd` in core).
- **Merge**: at the ingest (`buildSessionCommitmentsIngest`), rules first with
  stable `r<N>` ids (stable order keeps the rendered catalog prefix-cacheable),
  then session commitments, DROPPING any that near-duplicate a rule
  (`commitmentDedupeKey`) — the producer can re-distil a rule the user restated,
  and a near-duplicate pair is the measured matcher-silencing failure. Total
  capped at `MAX_COMMITMENTS`, rules first; a rules file that fills the cap
  logs a warning instead of silently starving session decisions.
- **This is advisory, not enforcement**: a passive ⚠ cue, dismissible like any
  other. For hard gates use CI. It polices the PROSE/decision layer.
- **Hosts**: native bands (via the ingest) **and dsh** — its node half merges
  the same two scopes into the `/opencues/session-commitments` route using the
  same core parser + merge, with PROJECT scope keyed to the SESSION's workspace
  (`lastSessionCwd`), never the dsh server's own cwd. Chrome remains out: no
  filesystem, deliberately not bridged.
- **Threat note**: a project-level `RULES.md` means a cloned repo can put
  entries in the matcher's system prompt. Same class as the watchlist itself
  (security-audit #31): no side-effect channel exists, so worst-case injection
  is manipulated cue TEXT the user reads.

## Where to touch

- `session-commitments.ts` — types, per-host transcript parsers, extraction
  prompt, catalog render, snapshot builder, `sessionCommitmentsKey(cwd)` (the
  scoping slug), and the incremental-merge primitives (`mergeSessionCommitments`
  + `SESSION_COMMITMENTS_SUPERSEDE_SYSTEM` + `parseSupersededResult`). All pure +
  unit-tested (`session-commitments.test.ts`).
- `session-contradiction-source.ts` — the matcher + its prompt + grounding
  (`session-contradiction-source.test.ts`).
- `session-cue-source.ts` — the fused wrapper (contradiction ∥ tips, then ask-cues).
- `extract-commitments.cjs` — the producer (gate → scoped debounce → scoped lock
  → per-format parse → wire call → scoped write).
- `highlight-statusline.sh` `_oc_kick_commitments` + `setup.sh` bake step — the CC
  trigger (extracts `current_dir`/`cwd`, passes `--cwd`).
- `boot-common.ts` — `buildSessionCommitmentsIngest({cwd})` (scoped ingest) +
  `startSessionCommitmentsKick` (the producer poller, wired in ALL boot bands
  incl. CC) + the per-host locators `locateNewestCCTranscript` /
  `locateNewestGeminiChat` / `locateOpenCodeDb` (unit-tested in
  `boot-common.cc-transcript-locator.test.ts`).
- `resolver.ts` (`sessionCommitments` option + `CueContext` forward),
  `build-sources.ts` (`enableSessionContradiction`/`enableAskCues` → `SessionCueSource`),
  `feature-registry.ts` + `config-loader.ts` (the scalars).

## Known v1 limitations

- **Transcript hosts only.** Works on Claude Code, OpenCode, and Gemini CLI
  (each has a session transcript + a producer path). Shell and Chrome have no
  conversation transcript, so the contradiction holder stays empty and the
  source is inert there — the sibling ask-cues source still works on those hosts,
  grounded on page/field ambient instead of the session.
- **Precision-tuned.** The matcher flags at most 3 sentences and errs toward
  silence; a subtle contradiction can be missed. That's deliberate — a false
  alarm on a developer's draft is worse than a miss.
- **No dehydration** of the watchlist (see egress note above).
- **Deliberate-revision ambiguity.** "actually, switch to X" is a real change,
  not a contradiction. Two things handle it: the incremental supersession pass
  removes the replaced decision from the watchlist (so the matcher no longer
  guards the old choice), and passive rendering makes any residual false flag
  cheap to ignore. The supersession call is model-judged, so a subtle revision
  can still slip through — bounded by the passive render.
- **Tail-window recall (mitigated, not eliminated).** The producer reads only the
  last 256 KB of the transcript, and in a tool-heavy session that's just the most
  recent prose turns. Incremental distillation (Stage A step 3) preserves earlier
  decisions across ticks *once they've been seen*, so recall is no longer purely
  recency-biased — but a decision that scrolled out of the tail **before the
  feature was enabled**, or one that only ever appeared in a code diff / tool
  result (never in prose), is still never captured.
