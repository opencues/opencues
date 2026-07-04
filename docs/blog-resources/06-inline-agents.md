# 06 — Inline Agents

For blog post #5: "Inline Agents".

OpenCues has TWO inline-agent surfaces, both invoked through `_`:

1. **Transform-blank** (one-shot) — type `hey can u send me that report
   when u get a sec make this formal _`, the system rewrites the surrounding
   text once.
2. **Agent-task** (continuous) — type `agentically correct spelling _`, the
   system arms a debounced loop that re-evaluates the whole document on
   every pause and applies edits inline.

Both share architectural DNA. Reading them together is the right move for
the blog post.

## Transform-blank: imperative `_`

From `docs/architecture/transform-blank.md`:

> OpenCues has had two `_` handlers: BlankSource (priority 95) for keyword-
> bound and FluidBlankSource (priority 92) for lookups. Both are
> *interrogative* — the user is asking a question, the system substitutes
> an answer. But people often want the opposite: *imperative* — they want
> to **edit** the text around `_` per an instruction.
>
> ```
> You type:   hey can u send me that report when u get a sec make this formal _
> You see:    Could you please send me that report at your earliest convenience?
> ```

`_` fires the moment you type it, so live typing can only ever produce
`<TARGET> <INSTRUCTION> _` — you type the body first, then realize you
want to transform it, and add the imperative at the end. (The parser
also accepts an inverted `<INSTRUCTION> _ <TARGET>` shape and a
sandwiched form, for pasted text or bench inputs that arrive as one
complete string — see `docs/architecture/transform-blank.md`.)

### The 3-pass pipeline

```
INPUT → EXTRACT → APPLY → VERIFY → SUBSTITUTE
        (P1)      (P2)     (P3)
        LLM       LLM(s)   LLM     code
        ~400ms    ~500ms   ~600ms  ~10ms
```

Total ~1.4-1.6s per blank.

- **P1 EXTRACT** — "Is this an imperative? If yes, what's the instruction
  and what's the target?" Output: `VERDICT: TRANSFORM | NONE`. If NONE,
  bail and let FluidBlank take the slot.
- **P2 APPLY** — "Execute the instruction on the target." Pure rewrite, no
  decisions about validity.
- **P3 VERIFY** — "Check the draft for AGREEMENT, COVERAGE, STRUCTURAL
  COMPLETENESS, and CONCEPT-SWAP PROPAGATION bugs." Either pass through
  (`OK`) or emit a corrected rewrite (`REPAIR`).

### Why three passes

The empirical data:

| Architecture | Accuracy | Per-case latency |
|---|---|---|
| Single-call (all in one prompt) | 19% | 0.5s |
| 1-pass rewrite | 46% | 0.6s |
| 2-pass extract → apply | 83% | 1.1s |
| **3-pass extract → apply → verify** | **86-90%** | **1.4-1.7s** |

Single-call is broken because the model can't juggle "is this a transform?"
+ "extract instruction + target" + "apply" + "check" simultaneously.

> **Narrow jobs are easier than wide jobs.** P1's only question is "is this
> an imperative? if so, what's the instruction and what's the target?" P2
> only does the rewrite — no decisions about validity. P3 only checks for
> consistency bugs — never re-litigates whether to fire.
>
> This recursive structure (split a pipeline into single-purpose phases)
> is the cornerstone pattern for OpenCues' LLM-orchestration code.

This is one of the most quotable lessons in the codebase.

### Sequential composition for "X and Y"

When the user writes "make past tense AND remove pronouns", EXTRACT pipe-
joins the instructions:

```
INSTRUCTION: make past tense | remove pronouns
```

The pipe means "run APPLY twice; output of N feeds target of N+1." Asking
ONE APPLY call to do both at once dropped accuracy to 47%; sequential
composition jumped it to 73%. **The model handles ONE transform at a time
much better than two** — same "narrow jobs" insight at one level deeper.

### The "default to OK" rule for VERIFY

VERIFY's biggest failure mode used to be **over-editing already-correct
drafts**. APPLY would produce a clean rewrite, VERIFY would decide it
could rephrase it more elegantly, and the "improved" rewrite was often
wrong.

Prompt fix in production:
> "DEFAULT TO OK. Only output REPAIR when you can name a SPECIFIC,
> IDENTIFIABLE defect. If the draft looks fine — even if you could rephrase
> it more elegantly — output OK and pass it through. Stylistic improvement
> is NOT your job. You are a defect catcher, not a writer."

The "defect catcher, not writer" framing is the most important sentence in
the VERIFY prompt.

## Agent-task: continuous `_`

From `docs/architecture/agent-task.md`:

> A **continuously-running agent loop** declared in plain English at `_`.
> The user types `agentically <task> _` to arm it; from then on, every
> time the user pauses typing (existing debounce), the agent re-evaluates
> the doc against the task and applies edits.

Closest analogue: a Google-Docs co-pilot that sits in the background,
makes corrections/improvements, surfaces them visually so the user can
revert. **Where transform-blank is one-shot, agent-task is persistent.**

### The trigger phrases

| Input shape | Verdict | Effect |
|---|---|---|
| `agentically <X> _` | `TASK_ARM` | Replace the current task with `X`. Generates new taskId, clears evaluation cache. |
| `add task <X> _` | `TASK_ADD` | Append: `prompt + " AND " + X`. Regenerates taskId, clears cache. |
| `stop task _` | `TASK_STOP` | Clear the task. Existing dimmed edits stay (user reverts any individually if they want). |
| `current task _` | `TASK_SHOW` | Substitute the current prompt at `_` so the user can see what's armed. |

The trigger phrases themselves are wiped from the buffer on substitute —
same WIPE pattern fluid-blank uses for `capital of france _` → `Paris`.

### Why this fits OpenCues' architecture (the key insight)

> The agent's edits are **indistinguishable from any other LLM source's
> results** at the data-structure level. They live as `WordDef` entries in
> `DynDefs`, get dimmed by `DimRender`, get skipped by the Resolver's
> 4-condition filter, get reverted via cycling. **Zero new ownership
> machinery required** — just plug into existing primitives.

This is the killer line for the blog post. The agent didn't require new
visual code, new cycling code, or new ownership code. The runtime's
primitives were already generic enough.

### Per-task invalidation cache

```
A word is "already evaluated" if and only if:
  state.evaluations.has(i)
  AND state.evaluations.get(i).taskId === state.taskId
  AND state.evaluations.get(i).textHash === currentTextHash
```

Three ways the cache invalidates:

1. **Word text changed** → re-eval
2. **Task changed** (arm or appendToPrompt) → re-eval (whole doc)
3. **Task cleared** → loop doesn't run

Practical implication: when you type `add task fix humour _` after running
spelling-correction, the agent re-reads the WHOLE doc on the next pulse
because every word's cached `taskId` no longer matches.

### Cursor-adjacency guard

The agent never edits the word adjacent to the cursor. If you're mid-typing
"con" (about to become "concerns"), the agent skips it — correct
"con" → "concerns" / "context" / "conservatives" would be wrong half the
time.

### Stop semantics

`stop task _`:
- Clears the task state
- Statusline `[task: ...]` disappears
- **Existing dimmed edits stay** as DynDefs. The user can revert any
  individual edit via cycling Down. They can also leave them as-is.

> Don't auto-revert — that would be surprising.

### Empirical lessons (from agent-task benchmark)

From the "Implementation outcomes" section in `docs/architecture/agent-task.md`:

- **EDITS format beat DECISIONS format.** v1 used a DECISIONS format (one
  verdict per candidate). EDITS (only emit lines for actual edits) won on
  every dimension: 97-100% pass vs 93-97%, 30% lower latency, 5× faster on
  200-word docs at 100% recall vs 25%.
- **Apply-side defence in depth.** The model occasionally proposes edits
  OUTSIDE the candidate list. The apply loop re-checks
  `candidateSet.has(edit.wordIndex)` AND re-fetches live text to verify
  `liveWord.word === edit.originalWord`.
- **Defensive parse.** `JSON.parse(response)` wrapped in try/catch; empty
  bodies, missing `.choices`, rate-limit errors all return empty edits +
  log; next text-change debounce is the implicit retry.

### Generalization

The benchmark proved the loop generalises with no code changes to:
- spelling correction
- British English conversion
- inclusive language
- medical terminology
- legal precision
- LinkedIn polish
- Twitter concision
- English-to-Spanish day translation

> The runtime is genuinely task-agnostic; everything is in the prompt.

## The HCI angle (for blog #5)

1. **Imperative inline editing breaks the chat boundary.** You don't talk
   *to* an agent in a separate window. You declare an instruction *in your
   own text*, next to a `_`, and the agent edits *your text in place*. No
   context switch.

2. **Track-changes via cycling, not via review-and-accept UI.** Edits are
   dimmed inline. Press Down on any one to revert it. There's no "approve
   all / reject all" modal — the user picks edits at word granularity, by
   moving and pressing Down.

3. **The two-direction architecture absorbed inline agents almost for
   free.** Once you have visual highlighting, cycling, ownership, and
   re-evaluation as primitives, an inline agent is just "another source
   that produces alternatives." The structure was load-bearing in a way
   the original designers didn't have to plan for.

4. **Continuous editing without a chat window.** `agentically correct
   spelling _` is the entire UI. There's no agent panel. The agent's
   presence is the dim words and the `[task: ...]` line in the status bar.

5. **The user owns the prompt as text.** Want to know what the agent is
   doing? Type `current task _` and the prompt substitutes inline. Want to
   add a constraint? Type `add task X _`. The user's intent and the agent's
   instruction are the same surface.

## Pitfalls and trade-offs

- **Cursor-adjacency rule is essential.** Without it the agent fights the
  user's in-progress typing. The mock adapter test bug ("agent appears to
  miss the last item") was a benchmark-author mistake, not a real
  cursor-adjacency failure — but the symptom shows what the failure mode
  would look like.
- **VERIFY adds ~600ms.** Smart skip-VERIFY rules trade 0.5pp accuracy for
  −13% latency. Worth it.
- **Single growing prompt, not parallel tasks.** v1 ships ONE prompt that
  the user can grow with `add task`. Parallel tasks would create the "task
  A and task B edit the same word differently" problem.
- **No streaming.** The rewrite arrives all at once after ~1.4s. Future
  work; would cut perceived latency.
- **Subjective register shifts are at the model's edge.** "Make it more
  confident" / "make it sincere" — APPLY weakness, not pipeline design.

## Where this material lives

- `docs/architecture/transform-blank.md` — the canonical 800-line reference
- `docs/architecture/agent-task.md` — the canonical agent-task reference
- `docs/features/transform-blank.md` — user-facing
- `docs/features/agent-task.md` — user-facing
- `tests/benchmarks/transform-blank/EXPERIMENTS.md` — empirical justification
  for every design decision
- `tests/benchmarks/agent-task/EXPERIMENTS.md` — same for agent-task

## Quotable lines

- "Narrow jobs are easier than wide jobs."
- "Defect catcher, not writer."
- "Zero new ownership machinery required — just plug into existing
  primitives."
- "`_` makes ... a universal interaction handle rather than just a slot
  to fill."
- "The runtime is genuinely task-agnostic; everything is in the prompt."
- "Splitting a pipeline into single-purpose phases is the cornerstone
  pattern for OpenCues' LLM-orchestration code."
