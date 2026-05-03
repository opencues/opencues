# Agent Tasks

**Continuously-running agent loops** — declare a task in plain English at
`_`, and the runtime keeps editing your doc against that instruction
on every debounce. Edits appear as dimmed words you can navigate to and
revert with cycle Down.

```
You type:   agentically correct spelling _ I rite some text witth typos
You see:    I write some text with typos
            (with "write" and "with" dimmed — the agent's edits)

Type more:  ...and another sentance
After settle: ...and another sentence
                              ^^^^^^ also dimmed (agent caught it)

You type:   stop task _
            agent cleared. Existing dimmed edits stay.
```

Where **transform-blank** is one-shot ("change boy to girl _ ..." fires
once), agent-task is **persistent** — the instruction stays armed and
fires on every typing pause until you stop it.

---

## Enable it

Same setting as transform-blank in `~/.opencuesrc`:

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

```
On user text-change:
  Resolver runs as normal (existing behavior — fluid-blank, transform-blank,
  spelling source, etc).

  After 500ms debounce settle:
    Agent loop runs (only if a task is armed)
      1. Build candidates: words EXCLUDING:
         - blanks (`_`)
         - cursor-adjacent word (incomplete typing)
         - words owned by other DynDefs (other LLM sources' edits, blank fills, etc)
         - words already-evaluated under the CURRENT taskId (cache hit)
      2. If no candidates: no-op
      3. One LLM call: "given task prompt + doc + candidates, what edits?"
      4. Apply each edit as a DynDef with blankName='agent-task'
         → DimRender automatically dims it
         → Resolver skip filter automatically protects it
         → Cycling Down reverts to original
      5. Record evaluations under current taskId
```

**Per-task invalidation** — the cache is keyed by both word-text-hash
AND task-id. When you `add task X _`, the taskId regenerates and ALL
evaluations are invalidated. The agent re-reads the whole doc against
the new combined prompt.

---

## What kinds of tasks work

Tested categories (see `tests/benchmarks/agent-task/EXPERIMENTS.md`):

| Category | v1 pass | Example |
|---|---|---|
| spelling-task | 70% | `agentically correct spelling` |
| caps-task | 100% | `agentically capitalize cities and people names` |
| ownership-respect | 100% | (agent skips words other sources own) |
| cursor-adjacent | 100% | (agent never touches the word your cursor is on) |
| no-op-recall | 100% | (no LLM-noise when nothing to fix) |
| task-id-invalidation | 100% | (cache invalidates on prompt change) |

The 30% spelling-task failures are model variance (3rd typo missed in
a long list, hyphenated misspellings) — not pipeline issues.

---

## Latency

Per debounce cycle:
- Build candidates: <1ms
- LLM edit pass: ~300-700ms
- Apply DynDefs + setText: ~10-50ms
- **Total: ~500ms typical**

Same 500ms debounce as the resolver. The agent runs ON TOP of
resolver's results — no second clock.

---

## Debugging

With `debug-mode: on` the runtime emits to `/tmp/opencues.log`:

```
AgentTask: ARM (taskId=8a2f1b3c…, prompt="correct spelling")
AgentLoop: starting (textLen=42, candidates=8/9, taskId=8a2f1b3c…)
AgentLoop: edit-pass returned 2 edit(s)
AgentLoop: applied 2/2 edit(s) as DynDefs
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
- **Loop**: `packages/opencues-runtime/src/modules/agent-loop.ts`
- **EXTRACT extension**: `packages/opencues-core/src/sources/transform-blank-source.ts`
  (TASK_ARM / TASK_ADD / TASK_STOP / TASK_SHOW verdicts)
- **Resolver routing**: `packages/opencues-runtime/src/modules/resolver.ts`
  (search for `handleTaskCommand`)
- **Statusline**: `packages/opencues-runtime/src/modules/statusline.ts`
  (agentTask field in the payload)
- **Benchmark**: `tests/benchmarks/agent-task/` — 20 cases, 6 categories

---

## Known limits

- **Single task at a time.** `agentically X _` replaces any existing
  task. To run "spelling AND humour" simultaneously, use
  `add task humour _` after arming spelling.
- **Dies on host restart.** Task state lives in memory only.
- **Set-and-forget.** No conversational refinement ("no, leave that
  joke alone") in v1.
- **Single-word edits only.** The agent emits per-word swaps, not
  sentence rewrites. Multi-word transforms (rewrite a paragraph)
  belong in transform-blank's one-shot pipeline.
- **No streaming.** Edits arrive in a single batch per cycle.
- **No persistence.** Stop the agent, restart the host, agent forgets
  everything.
