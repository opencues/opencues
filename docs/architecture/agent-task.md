# Agent Task — Implementation Plan

> **Status: PLAN / NOT YET IMPLEMENTED.** This is the design doc. Once
> the feature ships, this will become the canonical implementation
> reference (same role as `transform-blank.md`).

---

## What this is

A **continuously-running agent loop** declared in plain English at `_`.
The user types `agentically <task> _` to arm it; from then on, every
time the user pauses typing (existing debounce), the agent re-evaluates
the doc against the task and applies edits.

The closest analogue is a Google-Docs co-pilot — sits in the background,
makes corrections/improvements, surfaces them visually so the user can
revert. Where transform-blank is **one-shot** (instruction fires once,
substitutes once), agent-task is **persistent** (instruction stays
armed, fires on every debounced text settle until stopped).

```
You type:   agentically correct spelling _ I rite some text witth typos
You see:    I write some text with typos
            (with "write" and "with" dimmed — the agent's edits)

Press ↓ on a dimmed word to revert it back to "rite" or "witth".

You type more:  ... and another sentance
After debounce: ... and another sentence
                                    ^^^^^^ also dimmed (agent caught it)

You type:   stop task _
            agent armed → cleared. Statusline clears. Existing dims stay
            (user's choice whether to revert any).
```

---

## Why this fits OpenCues' architecture

The agent's edits are **indistinguishable from any other LLM source's
results** at the data-structure level. They live as `WordDef` entries
in `DynDefs`, get dimmed by `DimRender`, get skipped by the Resolver's
4-condition filter, get reverted via cycling. **Zero new ownership
machinery required** — just plug into existing primitives.

The only new pieces:
1. A state singleton holding the task prompt + per-word evaluation cache
2. A loop module that subscribes to text-change and orchestrates
   classify-and-edit cycles
3. Three new EXTRACT verdicts so transform-blank routes task-arming
   inputs to the agent

Everything else (visibility, cycling, ownership, filtering) is free.

---

## User model

### Trigger phrases

EXTRACT learns three new verdicts on top of the existing ones
(`TRANSFORM | NONE | GENERATIVE`):

| Input shape | New verdict | Effect |
|---|---|---|
| `agentically <X> _` | `TASK_ARM` | Replace the current task. Sets `prompt = X`, generates new `taskId`, clears evaluation cache. |
| `add task <X> _` | `TASK_ADD` | Append to the prompt: `prompt = prompt + " AND " + X`. Generates new `taskId`, clears cache. |
| `stop task _` | `TASK_STOP` | Clear the task entirely. Existing dimmed edits stay in the buffer (user's choice to revert any). |
| `current task _` | `TASK_SHOW` | Substitute the current prompt text at `_` so the user can see what's armed. |

The trigger phrases themselves are **wiped from the buffer** on
substitute (same WIPE pattern fluid-blank uses for "capital of france
_" → "Paris"). The `_` and surrounding trigger text disappear, leaving
the rest of the doc intact.

### Magic word

**`agentically`** is the unambiguous marker. `correct spelling _`
without the prefix is still a one-shot transform (existing behavior);
`agentically correct spelling _` arms a continuous task.

`add task` and `stop task` and `current task` are unambiguous on their
own (the word "task" makes the intent clear).

### Single growing prompt

Per the design discussion: ONE prompt that the user can grow. NOT
multiple parallel tasks.

```
agentically correct spelling _      → prompt = "correct spelling"
add task fix humour _               → prompt = "correct spelling AND fix humour"
add task improve clarity _          → prompt = "correct spelling AND fix humour AND improve clarity"
```

Every eval sends the FULL accumulated prompt to the LLM. The LLM
applies all sub-tasks in one pass. This avoids the "task A and task B
edit the same word differently" coordination problem.

### Statusline

When task is armed, statusline shows `[task: <truncated>]`. Truncation:
last ~40 chars of the prompt with `…` prefix if longer.

```
no task         (statusline silent)
short prompt    [task: correct spelling]
long prompt     [task: …rect spelling AND fix humour AND improve clarity]
```

Use `current task _` to see the full prompt at any time.

---

## Architecture

### State

```ts
// packages/opencues-runtime/src/state/agent-task.ts

export interface AgentTaskEntry {
  /** Hash of the word's text content as last evaluated. */
  readonly textHash: string;
  /** Which task this evaluation belongs to. Mismatch → re-evaluate. */
  readonly taskId: string;
}

export class AgentTaskState {
  private _taskId: string | null = null;        // null when no task armed
  private _prompt: string = '';
  private _evaluations = new Map<number, AgentTaskEntry>();
  private _armedAt: number = 0;

  // ── Read API ─────────────────────────────────────────────────────
  get armed(): boolean { return this._taskId !== null; }
  get taskId(): string | null { return this._taskId; }
  get prompt(): string { return this._prompt; }
  get armedAt(): number { return this._armedAt; }

  /** True if word at `i` has already been evaluated against the
   *  current taskId AND its text content (hash) is unchanged. */
  isEvaluated(i: number, currentTextHash: string): boolean {
    if (!this._taskId) return false;
    const entry = this._evaluations.get(i);
    if (!entry) return false;
    return entry.taskId === this._taskId && entry.textHash === currentTextHash;
  }

  // ── Mutation API ─────────────────────────────────────────────────
  arm(prompt: string): void {
    this._taskId = crypto.randomUUID();
    this._prompt = prompt;
    this._evaluations.clear();    // new task → all old evaluations invalid
    this._armedAt = Date.now();
  }

  appendToPrompt(addition: string): void {
    if (!this._taskId) return;
    this._taskId = crypto.randomUUID();   // new id for new prompt
    this._prompt = `${this._prompt} AND ${addition}`;
    this._evaluations.clear();    // prompt changed → all old evaluations invalid
  }

  stop(): void {
    this._taskId = null;
    this._prompt = '';
    this._evaluations.clear();
  }

  recordEvaluation(i: number, textHash: string): void {
    if (!this._taskId) return;
    this._evaluations.set(i, { textHash, taskId: this._taskId });
  }
}
```

**Key invariant from your spec:** evaluation entries are tagged with
`taskId`. When the task changes (arm or appendToPrompt), `taskId`
regenerates and all old `evaluations` entries become stale. We
implement this by clearing the Map on every change — equivalent
semantics, simpler than tagging-and-checking on every read.

### Loop module

```ts
// packages/opencues-runtime/src/modules/agent-loop.ts

export class AgentLoop {
  // Subscribes to adapter text-change events.
  // Reuses Resolver's existing 500ms debounce timer (don't create a
  // second one — keep the system to ONE clock).

  constructor(
    private adapter: OpenCuesAdapter,
    private state: AgentTaskState,
    private dynDefs: DynDefs,
    private spanFillState: SpanFillState | undefined,
    private highlightState: HighlightState,
    private resolverHook: () => Promise<void>,    // re-trigger Resolver after agent edits
    private llmClient: AgentLlmClient,
  ) {}

  /** Called from Resolver's onTextChange after the regular resolver
   *  finishes (or in parallel — TBD). */
  async maybeRun(text: string): Promise<void> {
    if (!this.state.armed) return;

    // 1. Build candidate words (everything NOT owned by another source,
    //    NOT cursor-adjacent, NOT already-evaluated under this taskId)
    const candidates = this.findCandidates(text);
    if (candidates.length === 0) return;   // nothing new to look at

    // 2. Run the edit LLM call — model returns a list of edits
    //    {wordIndex, originalWord, editedWord} or empty
    const edits = await this.llmClient.evaluateAndEdit(
      this.state.prompt,
      text,
      candidates,
    );

    // 3. Record evaluation regardless (we asked, we got an answer)
    for (const i of candidates) {
      this.state.recordEvaluation(i, hashWord(text, i));
    }

    // 4. Apply edits as DynDefs — ownership/dimming/cycling all free
    for (const edit of edits) {
      this.dynDefs.set(edit.wordIndex, {
        originalWord: edit.originalWord,
        alternatives: [edit.originalWord, edit.editedWord],
        currentIndex: 1,                    // showing edit
        spanStart: ..., spanEnd: ...,
        blankName: 'agent-task',            // locks against re-resolution
      });
    }

    if (edits.length > 0) {
      this.adapter.forceRender();           // surface the dim-render changes
    }
  }

  private findCandidates(text: string): number[] {
    const wordSpans = splitWords(text);
    const cursorPos = this.adapter.getCursorOffset();
    const cursorWordIdx = findWordIndexForCursor(wordSpans, cursorPos);

    const out: number[] = [];
    for (let i = 0; i < wordSpans.length; i++) {
      // Same exclusions as Resolver's skip filter, plus the cache
      if (wordSpans[i].word === '_') continue;
      if (i === cursorWordIdx) continue;                    // cursor-adjacent
      if (this.spanFillState?.current && /* in span */) continue;
      if (this.dynDefs.findSpanContaining(i)) continue;     // multi-word static
      const existing = this.dynDefs.get(i);
      if (existing) continue;                                // already owned
      const hash = hashWord(text, i);
      if (this.state.isEvaluated(i, hash)) continue;         // already-checked under this task
      out.push(i);
    }
    return out;
  }
}
```

### Integration with existing primitives

| Primitive | What we use it for |
|---|---|
| `DynDefs.set(i, def)` | Apply each agent edit as a per-word ownership claim |
| `WordDef.blankName = 'agent-task'` | Same lock fluid-blank/transform-blank use to prevent re-resolution |
| `DimRender` | Automatically dims any word with a DynDef — no new code needed |
| `Resolver` skip filter (4 conditions) | Automatically skips agent-edited words on the next normal resolve |
| `Cycling` | Cycle Down on a dimmed agent edit → reverts to `alternatives[0]` (the original word) |
| `SpanFillState` | Read-only — agent skips any word inside an active blank-fill |
| `Statusline` (existing) | Add a new line/section for `[task: …]` |

The agent NEVER touches words owned by other sources. The same
`isEvaluated()` cache prevents re-asking the LLM about words it just
saw under the current task.

---

## Per-task invalidation (the critical rule)

> "Note the invalidation of a word being seen is based on the 'task' id
> being the same too. If the task changes the word/text hasn't been
> seen by that task." — your spec

The cache is keyed by `(wordIndex)` and the entry stores
`(textHash, taskId)`. A word is "already evaluated" if and only if:

```
state.evaluations.has(i)
  AND state.evaluations.get(i).taskId === state.taskId
  AND state.evaluations.get(i).textHash === currentTextHash
```

Three ways the cache invalidates for a given word:

1. **Word text changed** → `currentTextHash !== entry.textHash` → re-eval
2. **Task changed** → `state.taskId !== entry.taskId` → re-eval
3. **Task cleared** → `state.taskId === null` → loop doesn't run at all

We implement (2) by clearing the Map on every `arm()`/`appendToPrompt()` —
equivalent semantics to tagging-and-checking, simpler.

This means: if the user runs `correct spelling` for a while, then types
`add task fix humour _`, the agent re-reads the WHOLE doc on the next
run because every word's cached `taskId` no longer matches.

---

## Loop cadence

Per your spec: **same debounce as the existing system** (500ms after
last keystroke). Reuses the Resolver's debounce timer — we don't create
a second clock.

After settle:
- Resolver runs as normal (existing behavior unchanged)
- Agent loop runs ON TOP of resolver's results — sees the post-Resolver
  DynDefs, so it correctly skips anything Resolver just claimed

No backoff after no-ops in v1 (we'll see in benchmarks if it's needed).

---

## Stop semantics

`stop task _`:
- Clears `AgentTaskState` (taskId, prompt, evaluations all reset)
- Statusline `[task: …]` disappears
- **Existing agent edits stay in the buffer** as DynDefs. The user can
  revert any individual edit via cycling Down. They can also leave
  them as-is. Don't auto-revert — that would be surprising.

---

## File plan

### New files

```
packages/opencues-runtime/src/state/agent-task.ts          ← state singleton
packages/opencues-runtime/src/modules/agent-loop.ts        ← debounce + classify + edit + apply
packages/opencues-runtime/src/modules/agent-loop.test.ts   ← unit + scenario tests
docs/features/agent-task.md                                 ← user-facing reference
tests/benchmarks/agent-task/                                ← benchmark harness
```

### Existing files to extend

```
packages/opencues-core/src/sources/transform-blank-source.ts
  - EXTRACT prompt: add TASK_ARM | TASK_ADD | TASK_STOP | TASK_SHOW verdicts
  - getCues: route TASK_* verdicts back to runtime via metadata, NOT
    through the regular APPLY/VERIFY path

packages/opencues-runtime/src/modules/resolver.ts
  - Substitute branch on r.source === 'transform-blank' AND
    r.metadata.taskAction → call agent-task state mutators

packages/opencues-runtime/src/modules/statusline.ts
  - Add a section for [task: <prompt>] when state.armed

packages/opencues-runtime/src/boot-common.ts
  - Wire AgentTaskState + AgentLoop into the runtime instantiation
  - Pass agent-task state to statusline
```

---

## Benchmarks

Following the transform-blank pattern. Suite at
`tests/benchmarks/agent-task/`. Each case is a SEQUENCE of user
actions (type, pause, type, pause, ...) and asserts on the agent's
edits at each pause point.

### Categories (10+ cases each)

| Category | Tests |
|---|---|
| `spelling-task` | Inject typos as user types; assert agent fixes them within 1-2 debounce cycles |
| `humour-task` | Subtle humour rewrites happen, no churn on neutral text |
| `layout-task` | Formatting fixes happen on multi-paragraph |
| `task-stop` | `stop task _` halts loop within 1 cycle; existing edits remain |
| `task-update` | `add task X _` invalidates evaluations, re-runs full doc |
| `task-show` | `current task _` substitutes correctly |
| `cursor-adjacent` | Cursor-adjacent word never gets edited |
| `ownership-respect` | Agent skips words claimed by transform-blank, fluid-blank, blank-fill |
| `no-op-recall` | If nothing changed, no LLM call (cache works) |
| `task-id-invalidation` | Modify task → all evaluations re-fired even though text unchanged |

### Open questions deferred to benchmark phase

These are explicitly DEFERRED — we'll discover via experiments after
the basic loop works. Mark with `// EXPERIMENT n` in code as we test.

1. **Classify-first vs always-edit** — does running a cheap "anything
   to do?" call BEFORE the expensive edit pass save tokens, or is the
   edit pass with "return empty if nothing" cheaper end-to-end?
2. **What does the agent SEE** — full doc text, or just the candidate
   words extracted, or doc text with `<owned>...</owned>` markers?
3. **Cadence backoff** — should consecutive no-ops slow the loop down
   (500ms → 1s → 2s)?
4. **Multi-edit batching** — when agent finds 5 edits in one pass,
   apply all at once (single DimRender pulse) or stagger them?
5. **Word-level vs region-level** — does the agent emit per-word edits
   or larger spans (sentence rewrites)? Spans require multi-word
   DynDef machinery.

---

## Examples — what each task should feel like

### Example 1: `agentically correct spelling _`

```
User types:    I think this is a goood plan but I have somm concerns
                                            ^cursor here, "concerns" not finished
After debounce, agent runs on text excluding cursor-adjacent word:
  - Candidate: "I", "think", "this", "is", "a", "goood", "plan", "but", "I", "have", "somm"
  - Edits returned: { 5: "good", 10: "some" }
  - "goood" → DynDef alternatives=["goood","good"], currentIndex=1, dimmed
  - "somm"  → DynDef alternatives=["somm","some"],  currentIndex=1, dimmed

User sees:     I think this is a good plan but I have some concerns
                                  ^^^^                ^^^^
                                  dimmed              dimmed
```

### Example 2: Adding to the task

```
User types:    add task fix grammar _
EXTRACT routes to TASK_ADD → state.appendToPrompt("fix grammar")
  task.prompt = "correct spelling AND fix grammar"
  task.taskId = <new uuid>     ← cache invalidated
  task.evaluations = (empty)

Statusline: [task: correct spelling AND fix grammar]

Next debounce pulse: agent re-evaluates the WHOLE doc against the
new prompt. Even words it already saw need re-evaluation under the
new task.
```

### Example 3: Cursor-adjacent guard

```
User types:    I have somm con
                                ^cursor here
                                cursor-adjacent word = "con"

Agent runs:    candidates excludes "con" entirely
  - May edit "somm" → "some"
  - Does NOT touch "con" (might become "concerns", "conservatives",
    "context", ...)

User keeps typing → "concerns"
Next debounce: candidates now includes "concerns" (cursor moved past it)
  - Agent reads "concerns" in context — no fix needed
  - records evaluation
  - skips on next pulse unless text changes
```

### Example 4: Stop

```
User types:    stop task _
EXTRACT routes to TASK_STOP → state.stop()
  task.taskId = null
  Statusline clears

Existing dimmed edits ("good", "some") stay in the buffer — they're
just DynDefs from the agent's earlier work. User can cycle Down on
each to revert if they want, or leave them.

No more debounced agent calls until the user re-arms.
```

---

## Future work (NOT v1)

- **Multiple parallel tasks** — run task A and task B independently with
  conflict resolution. v1 = single growing prompt.
- **Persistence across sessions** — task survives host restart. v1 =
  in-memory only.
- **Conversational refinement** — "no, leave that joke alone" feedback
  loop. v1 = set-and-forget.
- **Type-while-firing** — flag for shorter debounce + fires while user
  is mid-word. v1 = fires only on settled debounce + cursor-not-adjacent.
- **Track-changes UI** — pending suggestions instead of inline edits.
  v1 = silent inline (with cycle-to-revert).

---

## Implementation order

When we start building, the order should be:

1. `AgentTaskState` class + tests
2. EXTRACT prompt extension for TASK_* verdicts (test against the
   benchmark suite's task-show + task-stop cases)
3. Resolver substitute branch for taskAction metadata
4. `AgentLoop` module (the debounced re-eval loop)
5. Statusline integration
6. Benchmark harness + first 10 spelling-task cases
7. Iterate prompts/cadence/etc. via benchmark

---

## Open questions to revisit when implementing

- What's the right MAX prompt length before we cap appendToPrompt?
- Should `stop task _` also clear all existing agent edits? (Currently
  spec says no.)
- Does the agent skip the line that contains the cursor entirely, or
  just the word adjacent to the cursor? (Spec says word; line might be
  safer.)
- For the EXTRACT classifier — do we do TASK_ARM as a 5th verdict on
  the existing prompt, or split it into a separate "is this a task
  command?" pre-pass?

We'll resolve these during implementation, document the decisions.
