# Inline Agents

Upon stumbling across the HCI needed to enable Inline prompting I wondered what is the natural final form of this technology.

Being an avid Claude Code user I wondered what would an "Inline Agent", what capabilities could it have and how could it help a user by creating a 'Google Docs' always available assistant.

My desire was to build off the UI-less foundation of Inline-prompting by having the experience purely defined inline thus maintaining the wide scope of areas it could be deployed.

One of my initial fears was as per usual with agents… this thing could go 'south'. How do you design an agent system which can be maximally ambitious whilst limiting it in some fundamental way.

My conclusion was to 'NEVER' allow the agent to press 'enter'. It does not solve every security issue but it does provide one fundamental limitation and scopes the security vulnerabilities somewhat…

The idea of an Inline Agent is an agent which exists within a body text and can be provided a 'task' to perform continuously as you are working on a document. E.g.

- (List example usecases of an inline agent)

I am excited to work with the community to expand the concept of Inline Agents into the 'Google Doc-ifying' of every input box.

We have a lot of work to do in terms of developing the harness, means of benchmarking but I believe this technology can become the ultimate 'co-pilot' and assistance which can follow you everywhere **without** being tied to any specific provider. In the future (or if someone sends a PR) I imagine Inline prompting and Inline Agents running off local agents assuming they're fast enough on TTFT (Time to first token).

(Explaination of the structure of Inline Agents)

I view Inline Agents as a paradigm shift in terms of how we view working with AI. It is working alongside us 'natively' within the same format and user interface we use to perform a task. The complexity is obfuscated behind a Blank. We are attempting to take the best aspects of Inline Prompting and turn it into an lightweight agentic process which can be used anywhere **cheaply**.
One of the great learnings I have from working within the terminal is the appreciation for the initial simplicity of the apps/ interfaces I was met with as adopting agentic tools. When multiple humans are interfacing via Google Docs, we do not 'need' advanced user interfaces, we 'can' leave inline comments and it is on the human's judgement to determine the task at hand and execute it. I aspire for Inline Agents to capture that natural human simplicity and naturally fit into our lives where appropriate.

Side note: Now is an awesome time to become an inventor, the communities on reddit, twitter etc are so eager to adopt new technologies and work together to build better tools for all. I have never been more excited to utilise my skills an inventor to contribute to the opensource.

---

## STAGING NOTES (not yet formatted)

### A. Example use-cases of an Inline Agent

A reasonably complete list of armed-task shapes the system handles today, each generalised from the same loop with no per-case code changes:

- `agentically correct spelling _` — typos get fixed on every pause-in-typing
- `agentically convert to british english _` — `colour`, `harbour`, `realise` propagated through the doc
- `agentically use inclusive language _` — pronoun and term substitutions
- `agentically polish for LinkedIn _` — register shift toward professional tone
- `agentically be more concise (twitter-style) _` — compression + word economy
- `agentically translate days to spanish _` — `Monday → lunes`, etc., everywhere they appear
- `agentically use medical terminology consistently _`
- `agentically use legal precision _`
- `agentically fix grammar _`
- `agentically maintain past tense _`

Composed tasks via accumulation:

```
agentically correct spelling _              →  prompt = "correct spelling"
add task fix grammar _                      →  prompt = "correct spelling AND fix grammar"
add task convert to british english _       →  prompt = "correct spelling AND fix grammar
                                                AND convert to british english"
```

Every pulse sends the *full accumulated prompt*. The LLM applies all sub-tasks in one pass. This avoids the "task A and task B edit the same word differently" coordination problem that parallel-tasks would cause.

The benchmark suite proved this generalises across all of the above with **no code changes**. Everything is in the prompt.

### B. The structure of Inline Agents

The four trigger phrases (the entire user-facing surface):

| You type | What it does |
|---|---|
| `agentically <X> _` | Replace the active task with `<X>`. Status line lights up `[task: <X>]`. The trigger phrase is wiped from the buffer (same WIPE pattern fluid blank uses). |
| `add task <X> _` | Append: prompt becomes `<old> AND <X>`. Cache invalidates so the whole doc is re-evaluated against the new prompt. |
| `stop task _` | Disarm. Status line clears. Existing dimmed edits stay in the buffer — the user reverts any individually if they want. |
| `current task _` | Substitute the current prompt at `_` so the user can see what is armed. |

What runs under the hood:

- A **debounced loop** subscribed to text-change. Reuses the resolver's existing 500ms debounce — there is one clock for the whole system, not multiple competing heartbeats.
- A **per-word evaluation cache** keyed by `(taskId, textHash)`. A word that was already evaluated under the current task and whose text has not changed is skipped.
- A **cursor-adjacency exclusion** — the word the user is currently typing is never sent to the LLM (see H below).
- An **ownership exclusion** — words owned by other sources (fluid blank, transform blank, keyword-bound blank, multi-word static cycling) are skipped. The agent never touches positions another source claims.
- The **edit pass** asks the LLM "given this prompt and these candidate words, return the edits." The LLM returns a list of `{wordIndex, originalWord, editedWord}` tuples (or empty).
- Each edit lands as a `WordDef` in the existing dim-render pipeline. Cycling Down on any edit reverts to `alternatives[0]` (the original word) — same primitive used everywhere else in OpenCues.

### C. Why the existing architecture absorbed Inline Agents almost for free

This is the strongest single architectural insight in the project. From the architecture reference:

> The agent's edits are *indistinguishable from any other LLM source's results* at the data-structure level. They live as `WordDef` entries in `DynDefs`, get dimmed by `DimRender`, get skipped by the Resolver's 4-condition filter, get reverted via cycling. **Zero new ownership machinery required** — just plug into existing primitives.

What this means concretely: the agent feature did not require any new visual code, any new cycling code, any new ownership code, any new state-management code. The runtime's primitives were already generic enough. The only new pieces:

- A state singleton holding the active task prompt and per-word evaluation cache.
- A loop module subscribing to text-change.
- Three new EXTRACT verdicts so transform-blank routes task-arming inputs to the agent.

Everything else — visibility, cycling, ownership, filtering — was already there for the cues, fluid blanks, transform blanks. It was doing structural work in a way the original designers did not have to plan for. **A two-direction framework that holds the right shape makes new affordances multiply** without proportional code growth.

### D. Sharpen "never press enter" — the irreducible safety primitive

The post mentions this in passing. It deserves to be elevated because it is the actual security boundary, not a pragmatic limit:

The agent edits *in place* in the user's text. The user is *always* the one who finally commits the action — by hitting Enter, by sending the message, by submitting the form. The agent's edits are *proposals the user has not yet committed*.

This is meaningfully different from the standard agentic-tool design:

- **Standard agents** can take terminal actions, send messages, modify files, commit code, hit external APIs. The blast radius is whatever the agent's tools allow.
- **Inline Agents** edit text in a buffer the user has not yet submitted. The blast radius is "the user's draft, which they have not sent yet."

The boundary is not "limit the agent's tools." It is **"the agent never crosses the surface where the user's draft becomes a committed action."**

This is also why the agent does not need separate per-feature permission prompts, sandbox escapes, or undo machinery. The user's draft is the undo. If they do not like an edit, they revert it (Down). If they do not like the whole batch, they do not press Enter.

### E. Track-changes via cycling, not via review-and-accept UI

Inline Agents productise "track changes" without the modal review step. From the post's "Google Doc-ifying" framing, this is the concrete UX move:

- Edits are dimmed inline. The user sees them in the flow of their text, not in a side panel.
- Reverting an edit is one keystroke (Down on a dimmed word). No "right-click → reject suggestion." No popup confirming the rejection.
- There is no "approve all" or "reject all" modal. The user makes per-word decisions by *moving the cursor*. Pressing Enter at the end is the only commit.
- There is no "review session" surface where the user sits down to triage agent suggestions. Triage happens *as the user is composing*.

This is a real shift. Most "AI track-changes" UIs imitate Word's review pane — a separate surface where the user sits down to triage. Inline Agents do triage in the typing flow itself.

### F. The 3-axis framework applied to Inline Agents

(Using the framing from post #1, the proper read of the three axes for Inline Agents.)

- **Start-up frames** — one phrase to arm: `agentically <task> _`. The user does not leave the document to issue the arming. They do not switch to a chat panel, an agent dashboard, or a settings page. The arming happens in the same buffer they were already typing in.
- **Active window** — once armed, the agent runs in the background on the debounce. The user keeps typing. They are not prevented from doing other things while the agent thinks. Edits arrive into the dim layer, not into the user's typing flow.
- **Cool-down (end-lag)** — edits land in the document the user is already in. Reverting an edit is one keystroke. Stopping the agent (`stop task _`) takes one phrase, in-line. There is no agent-dismiss UI, no return-to-region navigation, no separate surface to close. The user's region of interest *never changes*.

This is the strongest pass of the framework so far. Standard chat-panel agents fail all three axes (you switch surface to start, you wait while it runs, you switch back when it finishes). Inline Agents pass all three because they *never leave the buffer*.

### G. Google Docs Suggestions as the lineage

The post invokes "Google Docs always-available assistant" as the aspiration. The closest existing analogue is more specific: **Google Docs Suggestions mode**.

In Suggestions mode:
- A proposer marks alternatives in a separate visual layer (strike-through + inline new text + colour).
- The accepter reviews per-item, per-position.
- The proposer's marks are non-blocking — the accepter keeps writing while the marks accumulate.
- Accepting or rejecting a single suggestion is a single click.

Inline Agents extend the same pattern with three changes:

| Google Docs Suggestions | Inline Agents |
|---|---|
| Proposer is another human | Proposer is an LLM |
| Visual layer is strike-through + colour | Visual layer is the dim |
| Granularity is per-marked-edit | Granularity is per-word |
| Trigger is "I'll suggest this" | Trigger is `agentically <task> _` |
| Lives in Google Docs | Lives in any text input across any host |

Naming the lineage grounds the "Google Doc-ifying" framing as something already understood, not something aspirational.

### H. The cursor-adjacency rule

The single most important UX detail. The agent never edits the word the user is currently typing.

```
User types:    I have somm con
                                ^cursor here
                                cursor-adjacent word = "con"

Agent runs:    candidates excludes "con" entirely
  - May edit "somm" → "some"
  - Does NOT touch "con" (might become "concerns", "conservatives", "context", ...)

User keeps typing → "concerns"
Next debounce: candidates now include "concerns" (cursor moved past it)
  - Agent reads "concerns" in context — no fix needed
```

Without this rule, the agent fights the user's typing — autocorrecting partial words mid-keystroke, creating a tug-of-war between the user's intention and the agent's interpretation. The cursor-adjacency exclusion is small and specific but it is the rule that makes the agent feel cooperative instead of adversarial.

### I. Per-task invalidation cache

The mechanism that makes the agent feel coherent across edits and prompt changes:

```
A word is "already evaluated" if and only if:
  state.evaluations.has(i)
  AND state.evaluations.get(i).taskId === state.taskId
  AND state.evaluations.get(i).textHash === currentTextHash
```

Three ways the cache invalidates:

1. **Word text changed** → re-evaluate that word
2. **Task changed** (arm or appendToPrompt) → re-evaluate the whole doc
3. **Task cleared** → loop does not run at all

Practical consequence: when the user runs `correct spelling` for a while, then types `add task fix humour _`, the agent re-reads the *entire* document on the next pulse because every word's cached `taskId` no longer matches. The user gets the right behaviour without thinking about it.

### J. Single growing prompt, not parallel tasks

A deliberate simplification: there is *one* active task at a time. The user grows it with `add task`. There are not multiple parallel tasks running with their own scopes.

Why: parallel tasks would create the "task A says change X to Y, task B says change X to Z, the same word gets edited twice with conflicting outputs" coordination problem. Resolving it requires per-task ownership tracking, conflict resolution, priority decisions — a whole agent-orchestration layer.

The single-growing-prompt design avoids the entire problem class. Every pulse sends the full accumulated prompt. The LLM applies all sub-tasks in one pass and resolves conflicts internally.

This is the same "narrow jobs are easier than wide jobs" insight from the transform-blank pipeline carried into multi-task territory: ask one prompt to satisfy all constraints rather than running multiple competing prompts.

### K. Latency / debounce — grounding "lightweight"

The post claims this is a "lightweight agentic process." Concrete numbers:

- **Loop cadence** — 500ms debounce. Same clock as the main resolver. One pulse fires the agent's evaluation pass.
- **Per-pulse latency** — ~365ms median in the production EDITS prompt format on Groq.
- **EDITS vs DECISIONS empirical win** — the EDITS format (only emit lines for actual edits) beat the original DECISIONS format (one verdict per candidate, KEEP or edit) on every dimension: 97-100% pass rate vs 93-97%, 30% lower latency, 5× faster on 200-word docs at 100% recall vs 25%. Output tokens dominate latency; emitting only the edits saves tokens proportional to the size of the doc.
- **Apply-side defence in depth** — the loop re-validates every edit against the live text and the candidate set before applying. Defends against the model proposing edits to indices it was not asked about.
- **Soft-fail on rate-limit** — empty response or rate-limit error returns empty edits and logs. Next text-change debounce is the implicit retry. No retry loop inside `runOnce` — that would compound rate-limit failures.

This is what makes "lightweight" substantive instead of marketing. The user is paying ~365ms per debounce pulse for the agent presence, not seconds.

### L. No chat window — the negative-space UX claim

Extends the "no popup" rule from earlier posts. **Inline Agents have no chat panel.** No agent-talks-to-you surface. No conversation log. No assistant icon. No model dropdown. No system-prompt editor. No history viewer.

The agent's presence is exactly two things:

1. The dim words it has edited.
2. The `[task: ...]` line in the status line.

Everything else is the user's normal text input. The user does not "talk to" the agent. They arm it (`agentically <X> _`), they keep working, the agent edits in the dim layer, the user accepts or reverts by cycling, the user disarms it (`stop task _`).

This is a sharper UX claim than "ultimate co-pilot." Co-pilot typically implies a chat surface. Inline Agents are the co-pilot *minus the chat surface*. The only conversation is the user's own text and the agent's marks on it.

### M. What makes it "the ultimate co-pilot" — concretely

The post claims this. Worth grounding by listing what specifically distinguishes Inline Agents from existing co-pilots:

- **Continuous** — runs on every pause-in-typing, not just on explicit invocation.
- **In-place** — edits land in the user's draft, not in a side panel.
- **Ignorable** — the user can ignore every edit; nothing forces engagement.
- **Revertible** — every edit reverts in one keystroke (Down).
- **No chat window** — see L above.
- **Surface-portable** — runs in CC, OC, and Chrome with the same primitives. The co-pilot follows the user across hosts.
- **Substrate-agnostic** — provider is a config switch, not a build dependency (see N).
- **Plain-English task definition** — `agentically <task> _` is the entire armed-state syntax. No DSL, no flags, no parameters.
- **Composable tasks** — `add task <X> _` extends the same prompt rather than spawning a parallel agent.
- **No commit power** — never crosses the "user submits" boundary (see D).

### N. Substrate portability — not tied to any provider

The post says "without being tied to any specific provider." The mechanism:

- The runtime calls the LLM through a `LLMRequest` interface with `endpoint`, `model`, and `apiKey` as config inputs.
- Default: Groq (`GROQ_API_KEY`) on `openai/gpt-oss-120b`.
- Switchable: any OpenAI-compatible endpoint. `OPENAI_API_KEY` works. Anthropic-compatible endpoints with a thin adapter work.
- Future: local models via the same interface — see O below.

The implication: the user's choice of provider is a *config decision*, not an architectural one. If a better model ships, the user updates one line of config. If a provider's pricing changes, they switch. There is no vendor lock-in built into the architecture.

This is genuinely different from cloud-locked AI tools where the model and the product are the same thing.

### O. Local-model future — what "fast enough" means

The post mentions "if someone sends a PR" for local agents. The TTFT (time to first token) targets that would make this work:

- **Fluid blank** — ~200ms TTFT to feel responsive. The user is staring at a `_` waiting for it to fill.
- **Transform blank** — ~500ms TTFT acceptable. The whole pipeline is ~1.4s; some of that is reasoning.
- **Inline Agent** — ~500ms TTFT acceptable, since the user is not waiting on a single pulse — they are typing while it runs. Throughput matters more than latency-per-pulse.

Consumer hardware in 2026 hits these on small models (3B–8B parameter range with quantisation). A local Llama or Phi running through `llama.cpp` or `ollama` is within striking distance for the agent loop today; the fluid blank is closer to the edge.

The architectural prerequisite is there — the `LLMRequest` interface does not care whether the endpoint is local or remote — so a local-model integration is a *config + harness* PR, not a runtime PR.

### P. Stop semantics — no auto-revert

`stop task _`:

- Clears `AgentTaskState` (taskId, prompt, evaluations all reset).
- Status line `[task: ...]` disappears.
- **Existing agent edits stay in the buffer** as DynDefs. The user can revert any individual edit via cycling Down. They can also leave them as-is.

The principle: **don't auto-revert — that would be surprising.**

The user already had every opportunity to revert each edit while the task was running, by cycling Down. Their not-having-reverted is implicit consent. Stopping the task is a stop-the-loop action, not a roll-back-everything-the-loop-did action. Roll-back-everything would erase the user's accumulated yes-decisions on each individual edit.

This is the same "respect prior commitments" principle that makes the ownership lock work for blanks (post #4 section I).

### Q. Engineering lesson — EDITS vs DECISIONS (empirical)

Cross-link to post #18 / Principles of HCI material — the agent-task benchmark produced one of the cleanest engineering wins in the project:

- v1 used a **DECISIONS** format: for each candidate word, return one verdict (`KEEP` or an edit). Output proportional to the number of candidates.
- v2 switched to **EDITS** format: only emit lines for words that need editing. Output proportional to the number of edits, which is usually small.
- Result: 97-100% pass rate vs 93-97%, 30% lower latency, **5× faster on 200-word docs at 100% recall vs 25%**.

Why DECISIONS lost: at high candidate counts the model spent its output budget reciting `<idx> | <word> | KEEP` lines and ran out of tokens before reaching real edits. The runtime already provides implicit completeness (every candidate that does not appear in the response is recorded as evaluated and won't be re-asked).

The HCI lesson: **output tokens dominate latency, not input tokens.** A prompt that asks the model to emit a verdict for every input word is paying for a long output. A prompt that asks for only the deltas pays for a short one. For a real-time agent the user feels, this difference is the difference between "snappy" and "sluggish."

(Probably belongs in the Principles of HCI post too, but worth noting here as the empirical foundation for "lightweight.")
