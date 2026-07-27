# Agent Tasks

**Continuously-running agent loops** — declare a task in plain English at
`_`, and the runtime keeps editing your doc against that instruction
on every debounce. Edits appear as dimmed words you can navigate to and
revert with cycle Down.

```
You type:   I rite some text witth typos agentically correct spelling _
You see:    I write some text with typos
            (with "write" and "with" dimmed — the agent's edits)

Type more:  ...and another sentance
After settle: ...and another sentence
                              ^^^^^^ also dimmed (agent caught it)

You type:   stop task _
            agent cleared. Existing dimmed edits stay.
```

Where **transform-blank** is one-shot ("the boy ran change boy to girl _"
fires once), agent-task is **persistent** — the instruction stays armed
and fires on every typing pause until you stop it.

---

## Enable it

Same setting as transform-blank in `~/.cues/OPENCUES.md`:

```yaml
transform-blank-mode: on   # required (agent commands route via transform-blank's EXTRACT)
debug-mode: on             # see the loop's per-stage trace
```

Hot-reloads — no restart needed.

---

## Trigger phrases

| You type | What happens |
|---|---|
| `agentically <task> _` | **Arms** a fresh task. Replaces any existing prompt. |
| `add task <task> _` | **Appends** to the existing task. Joins with " AND ". |
| `stop task _` | **Clears** the task. Existing edits stay. |
| `current task _` | **Substitutes** the current task prompt at `_`. Lets you see what's armed. |

The trigger phrases get wiped from the buffer on substitute (same WIPE
pattern fluid-blank uses).

---

## Examples

### Spelling agent

```
agentically correct spelling _

then keep typing:
I rite stuff with somm typos
After ~500ms pause: I write stuff with some typos
                       ^^^^^               ^^^^
                       both dimmed — agent's edits
```

### Multi-task

```
agentically correct spelling _
add task fix grammar _
add task remove emojis _

Statusline: [task: …rect spelling AND fix grammar AND remove emojis]

Every text-change settle, the agent re-evaluates against the full
combined prompt.
```

### See what's armed

```
current task _
↓ substitutes:
correct spelling AND fix grammar AND remove emojis
```

### Stop

```
stop task _
↓ task cleared. Statusline drops the [task: ...] section.
   Existing dimmed edits stay in the buffer — cycle Down on each to
   revert if you want.
```

---

## How it works

`AgentRewrite` is the single agent module. While a task is armed,
each text-change event (re)schedules a tick. After a debounce window
(default **1000 ms**, user-tunable via `agent-debounce-ms` in
OPENCUES.md), the agent:

```
1. Snapshots the live buffer (A) and the current task prompt.
2. Makes ONE LLM call: "given DOC and TASK, return the rewritten DOC."
3. Three-way merges:
     - diff A → B  (the LLM's hunks)
     - diff A → C  (where C is the live buffer at apply time)
     - drops any LLM hunk that overlaps a user hunk in A's frame
     - splices surviving LLM hunks into C with cursor translation
4. Places a DynDef per applied hunk (Down-arrow reverts each).
```

Hot debounce: setting a different `agent-debounce-ms` (e.g. `500` for
aggressive, `2000` for relaxed) takes effect on the next text-change
event, no restart. Misparses or non-positive values fall back to 1000.

User typing during the LLM call is **never clobbered** — the merge
layer drops any LLM hunk that touches a region the user has been
editing. See `docs/architecture/agent-task.md` for the design and
the structural invariants the merge layer enforces.

Edits are user-visible (dimmed) and user-reversible (cycle Down).
`stop task _` clears the task; existing dimmed edits stay so the
user can decide whether to revert each.

### `current task _` is a span

Substitutes the current prompt at `_` and registers it as an atomic
DynDef span. Two consequences:
- **Cycling Down** on the inserted prompt reverts to empty (clean removal).
- **Editing any character** of the prompt (typing inside, backspacing
  into it) deletes the **whole** span as a unit — partial edits aren't
  allowed to leave a half-state in the buffer. Surrounding prose stays
  intact. Built-in behaviour, scoped to `task-*` spans only;
  fluid-blank and transform-blank substitutions stay editable in place.

### Trigger-keyword order matters

The classifier matches canonical orderings only: `agentically X _`,
`add task X _`, `stop task _`, `current task _`. Reversed-order typos
(`task stop _`, `task add X _`) don't classify as task commands.

A defensive guard in fluid-blank refuses to claim inputs containing
either order, so a typo doesn't get hallucinated as a lookup query
("task stop _" used to get substituted with the LLM's guess of
"yes" — that's fixed). The buffer stays literal; correct the order
and retry.

### Statusline indicator

While a task is armed, the statusline payload includes
`agentTask: <truncated prompt>`. Hosts render this as a stable badge:

```
[task: <prompt>]
```

Visible across word-highlight states (the agent runs across the whole
session, not per-word). No flicker — the badge doesn't toggle while
LLM calls are in flight, since a per-tick spinner jitters on every
keystroke pause. CC's `highlight-statusline.sh` and OpenCode's
`statusSnapshotHook` both render the same format.

---

## What kinds of tasks work

Tested categories (the legacy AgentLoop benchmark harness is gone;
these are the categories that worked then and continue to work under
AgentRewrite):

**Mechanical tasks** — single right answer per word:

| Category | Pass | Example |
|---|---|---|
| spelling-task | 100% | `agentically correct spelling` |
| caps-task | 100% | `agentically capitalize cities and people names` |
| british-english | 100% | `agentically use british english spelling` |
| translation | 100% | `agentically translate english days to spanish` |
| inclusive-language | 100% | `agentically use inclusive gender-neutral language` |
| linkedin-friendly | 100% | `agentically make wording linkedin friendly` |
| twitter-concise | 100% | `agentically shorten verbose words` |
| long-doc | 100% | (40–65 word docs, mixed tasks) |

**Stability primitives** — invariants the runtime guarantees:

| Category | Pass | What it pins |
|---|---|---|
| ownership-respect | 100% | agent skips words other sources own |
| cursor-adjacent | 100% | agent never edits the word your cursor is on |
| no-op-recall | 100% | no LLM noise when nothing to fix |
| task-id-invalidation | 100% | cache invalidates on prompt change |

**Stylistic tasks** — multiple defensible answers; lower ceiling:

| Category | Pass | Why lower |
|---|---|---|
| professionalism | ~50% | model has its own style opinions; over-edits clean prose |
| mixed-task | ~80% | composed prompts ("X AND Y") harder for the model |

Stylistic-task failures are model judgement, not pipeline bugs —
don't prompt-tune to suppress them; that hurts the mechanical tasks.
(The specific aggregate pass-rate and case count cited in older
revisions of this doc referenced `tests/benchmarks/agent-task/`, which
was deleted in the May 2026 AgentLoop→AgentRewrite retirement — see
`tests/benchmarks/agent-rewrite/CONTINUE.md`. The replacement suite's
case/category count changes as it grows; re-run it for a current
number rather than trusting a cited figure here.)

---

## Latency

Per debounce cycle (gpt-oss-120b @ Groq, EDITS format):
- Build candidates: <1ms
- LLM edit pass: ~300–500ms (most docs); 1.7s for a 200-word doc
- Apply DynDefs + setText: ~10–50ms

Same 500ms debounce as the resolver. The agent runs ON TOP of
resolver's results — no second clock. Cache hits skip the LLM
entirely (zero cost in steady state).

---

## Debugging

With `debug-mode: on` the runtime emits to `/tmp/opencues.log`:

```
AgentTask: ARM (taskId=8a2f1b3c…, prompt="correct spelling")
AgentRewrite: started (cadence=1500 ms)
AgentRewrite: round start (textLen=42, cursor=42, taskId=8a2f1b3c…)
AgentRewrite: merge result (applied=2, dropped=0, userHunks=0)
```

When the user adds:
```
AgentTask: ADD (taskId=ff14a8d2…, prompt="correct spelling AND fix grammar")
```

When the user stops:
```
AgentTask: STOP (was prompt="correct spelling AND fix grammar")
```

When `current task _`:
```
AgentTask: SHOW (prompt="correct spelling AND fix grammar")
```

---

## Architecture references

For the canonical implementation reference (state machine, loop logic,
DynDef integration, per-task invalidation deep-dive) see
**`docs/architecture/agent-task.md`**.

Quick locator:
- **State**: `packages/opencues-runtime/src/state/agent-task.ts`
- **Loop**: `packages/opencues-runtime/src/modules/agent-rewrite.ts`
- **EXTRACT extension**: `packages/opencues-core/src/sources/transform-blank-source.ts`
  (TASK_ARM / TASK_ADD / TASK_STOP / TASK_SHOW verdicts)
- **Resolver routing**: `packages/opencues-runtime/src/modules/resolver.ts`
  (search for `handleTaskCommand`)
- **Statusline**: `packages/opencues-runtime/src/modules/statusline.ts`
  (agentTask field in the payload)
- **Benchmarks** (`tests/benchmarks/agent-rewrite/` — replaced the
  deleted `tests/benchmarks/agent-task/` in the May 2026
  AgentLoop→AgentRewrite retirement; see that directory's
  `CONTINUE.md` for the migration history):
  - `cases.ts` — categorized cases (spelling, capitalisation,
    translation, grammar, paragraph-structure, idempotent, style,
    long-doc, …) — check the file directly for the current count,
    it's grown since the retirement
  - `run.ts` — main runner (`--parallel`, `--category`, `--case`, `--verbose`)
  - `live-typing.ts` — stress test simulating user typing during the
    LLM call, asserting user content always survives the merge
- **Implementation reference**: `docs/architecture/agent-task.md` — pipeline shape, prompt design rationale, response format choice, and the empirical lessons that justify each.
- **Cache reference**: `docs/architecture/agent-rewrite-cache.md` — two-tier skip-on-stable + LRU cache, key composition, determinism assumption, and extension points (size, persistence, approximate keys, negative caching, telemetry).

---

## Known limits

- **Single task at a time.** `agentically X _` replaces any existing
  task. To run "spelling AND humour" simultaneously, use
  `add task humour _` after arming spelling.
- **Dies on host restart.** Task state lives in memory only.
- **Set-and-forget.** No conversational refinement ("no, leave that
  joke alone") in v1.
- **Word-level edits.** The agent operates on words and contiguous
  word ranges (single swap / multi-word expand / range rewrite /
  delete). Sentence-level structural rewrites still belong in
  transform-blank's one-shot pipeline.
- **No streaming.** Edits arrive in a single batch per cycle.
- **No persistence.** Stop the agent, restart the host, agent forgets
  everything.
- **Subjective grammar choices**. Under prompts like "fix grammar"
  the LLM may pick equally-valid forms (`"you'll" ↔ "you will"`)
  differently from one round to the next. Each round is independent,
  so the buffer reflects the most-recent choice; cycling Down on the
  DynDef reverts to the user's original phrasing.
