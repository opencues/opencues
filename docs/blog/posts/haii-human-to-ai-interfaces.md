# Human to Artificial Intelligence Interfaces (HAII)

As a HCI (Human to Computer Interface) specialist I would like to encourage more development in the cross-section of HCI x AI.

I call it HAII! (Human to Artificial Intelligence Interfaces)

The means through which we extract value through LLM models is not just by pinging the raw model, it is often through various harnesses which have be bolted ontop of developed natively to further augment the LLM models underneath.

By developing new HAII we unlock new value from our existing models thus reducing the need for developing smarter, more costly models which tax our environment.
(Bunch of waffle about benefits of extending current models)

We have a swath of OpenSource models and models which can run locally however the harnesses we have designed have not been optimised to utilise them and deliver value in a reliable way that makes a user not feel an itch to reach for a smart more expensive model.

I would like to challenge engineers and designers around the world to not settle for the status quo, regardless of how good, well funded it is but to ponder what the future could be.

> Bewilderment is the enemy of invention.

We should use the tools of today to build the tools of tomorrow.

---

## STAGING NOTES (not yet formatted)

### A. Fill `(Bunch of waffle about benefits of extending current models)`

The concrete benefits of investing in harness-level work over model-level work:

- **Token efficiency.** A better harness on a 70B model can match worse harnesses on 200B+ models for the same task. Empirical: the 3-pass transform-blank pipeline went from 19% (single-call) to 86–90% accuracy *on the same model*. That is a model-class jump achieved by harness redesign alone.
- **Environmental cost.** Training a frontier model is expensive in water, electricity, and compute. Better harnesses make existing trained models more capable without retraining. The carbon math here is straightforward — re-using inference is dramatically cheaper than re-training.
- **Latency.** "Output tokens dominate latency" is a harness-level lesson, not a model-level one. The EDITS-format change in the agent-task loop cut latency 30% and made it 5× faster on 200-word docs — without changing models.
- **Privacy.** A good harness on a local model > an okay harness on a frontier cloud model, *for the user's purposes*. Better harness work shifts the local-vs-cloud trade-off in favour of "stays on your machine."
- **Cost to user.** $0/month to run a Phi-class or Llama-class model locally with the right harness. $20+/month for a frontier cloud product. Cost asymmetry of two orders of magnitude, often for the same delivered value.
- **Democratisation.** The frontier-model race is funded by ~5 organisations on the planet. Harness work is open to anyone with a laptop and an API key. The contributors who can move HAII forward outnumber the contributors who can move model capability forward by something like four orders of magnitude.
- **Iteration speed.** Harness changes ship in hours; model changes ship in months. The whole feedback loop (idea → benchmark → deploy → measure) is days at the harness layer and quarters at the model layer.

The point is not that frontier models don't matter — they do, and improvements there compound. The point is that the *ratio* of investment in models vs harnesses is currently lopsided. Most of the value users feel from "AI got better" came from harness improvements, not model improvements, and we are nowhere near the ceiling of what harnesses can do.

### B. The HAII coinage elevated as a defined term

The post coins HAII but does not define it crisply. A working definition worth pinning at the top:

> HAII (Human to Artificial Intelligence Interface) — the design discipline concerned with how a human extracts value from an AI system. The interface, harness, prompt scaffolding, output rendering, error handling, and interaction grammar that sit between the user and the model.

HAII is to AI what HCI is to computers — a sister discipline, not a subset, even though every HAII is technically also an HCI. The reason it deserves its own name is that the constraints, affordances, and failure modes are genuinely different (see C and K below).

This blog series is, in effect, an extended HAII case study: cues + blanks as the spine, and OpenCues as the worked implementation.

### C. HCI / HAII relationship sharpened

HAII is *technically* a subset of HCI — AI systems are computer systems, so any interface to an AI is an interface to a computer. But the everyday assumptions of HCI break in HAII territory:

| Property | Classical HCI | HAII |
|---|---|---|
| Output | Retrieved / deterministic | Generated / variable |
| Same input → same output? | Yes | No |
| Behaviour stable across sessions? | Yes | No (model upgrades, tuning) |
| Output length predictable? | Yes | No |
| System can be "wrong in plausible ways"? | Rarely | Routinely |
| Latency budget | ~100ms or it feels broken | 200ms–10s, often visible to user |
| Cost per interaction | Effectively zero | Non-trivial, varies by model |

Each row is a design assumption HCI baked in over four decades that HAII has to consciously *unbake*. A HAII designer cannot reach for "the system always responds the same way" or "latency is invisible if it's under 100ms" or "the system never says something untrue." The whole grammar has to be re-derived.

This is why HAII is its own thing rather than a chapter in the HCI textbook. It is operating on a substrate the textbook did not anticipate.

### D. Concrete harness-level wins — worked examples

Empirical results from the OpenCues codebase that show what HAII work actually achieves:

- **Narrow jobs > wide jobs.** The 3-pass transform-blank pipeline (EXTRACT → APPLY → VERIFY) outperforms single-call by ~70 percentage points on the same model. Splitting the work, not improving the model, is what unlocked the accuracy.
- **Sequential composition for "X and Y" instructions.** Asking ONE LLM call to "pluralize AND make past tense" → 47% accuracy. Splitting into two sequential calls → 73%. The model handles one transform at a time much better than two; the harness orchestrates.
- **Output tokens dominate latency.** A 320-line prompt with short output beats a 60-line prompt with long output. Implication: optimise for output efficiency, not input compression.
- **EDITS vs DECISIONS format (agent-task).** The harness asks the model to emit only edits (not "verdict per word"). Result: 97–100% pass rate vs 93–97%, 30% lower median latency, **5× faster on 200-word docs at 100% recall vs 25%**. Same model, harness change.
- **Always-claim + LLM classifier > heuristic gating.** Earlier transform-blank versions used a regex/keyword heuristic to decide whether to fire. Brittle. Switching to "always claim + let the LLM say NONE" added one ~400ms call per non-transform `_` but eliminated a class of misclassifications. Cleanliness gain bought with a known latency cost.
- **Soft-fail on rate limit.** Catch in the client, return empty, let the next debounce be the implicit retry. No retry loop inside `runOnce` — that would compound rate-limit failures. UX consequence: user sessions don't crash on transient failures.
- **Reserve reasoning headroom in `max_tokens`.** Earlier `max_tokens` floor was 128; long-text accuracy dropped 85% → 50% on truncation. Floor of 768 fixed it. Lesson: when using `reasoning_effort: 'low'`, you need budget for *both* reasoning + output, not just output.

Every one of these is a harness-level decision that changed user-felt quality without touching the model. None of them required GPUs.

### E. The bewilderment quote, grounded in Musashi

The pull-quote at the end is a direct read of Miyamoto Musashi's *Book of the Void* (see post #6 for the fuller treatment). Musashi's distinction:

- **Bewilderment** = mistaking "I don't know what's there" for the void.
- **The void** = the un-built thing, surfaced by deeply knowing what *is* there.

Engineers and designers tackling AI face Musashi's bewilderment constantly. They do not know what a HAII *could* be, so they default to the only AI HCI they have seen: a chat box. The chat box is not the void. It is the bewilderment. It is the shape we reach for when we have not yet mapped what is actually possible.

The discipline this post is calling for — "not settling for the status quo" — is Musashi's discipline applied to HAII. Know the prior art (the chat box, the autocomplete pop-up, the IDE assistant pane) deeply enough that the *gaps in it* become visible. The gaps are the void.

OpenCues' two-direction model is one attempt at one of those gaps. It is not the only one. The whole point of HAII as a discipline is that there are many more gaps to surface, and most are still un-named.

### F. The two-direction model as the most concrete HAII primitive shipped so far

This post is the manifesto; the rest of the blog series is the demonstration. Worth surfacing here as the spine:

> Two directions of intent on text. **Cues** (system → user) — the LLM offers alternatives the user did not ask for. **Blanks** (user → system) — the user places `_` to summon a value. Same character, infinite uses, dispatched contextually.

This is one HAII primitive. There are obviously others, and the field is wide open. But naming this one in the manifesto post grounds the abstract call-to-action — "develop new HAII" — in something concrete that already exists, ships, and works in production.

### G. Status quo critique unpacked

What "the status quo" actually looks like, listed explicitly so it can be challenged item by item:

- **Chat as the default HCI.** Every new AI product ships a chat box because every previous AI product shipped a chat box.
- **Provider lock-in.** The model and the product are bundled. Switching the model is a re-purchase of the product.
- **Cloud-only.** Most products do not work without a network connection.
- **No inline editing.** Output appears in a separate panel; the user copies it back.
- **No ownership locks.** The user cannot trust accepted suggestions to stay accepted; the model can re-edit them.
- **Latency exposed, not masked.** The user watches the spinner.
- **Single-modal turn-based input.** Type, send, wait, read, type again. No interleaved cues, no in-flight steering.
- **Settings via dialog.** Configuration is a separate UI surface, not the artifact the user is in.
- **No revertibility at granularity.** Accept all or reject all; per-word revert is rare.
- **No different-modality non-blocking cues.** The model cannot signal "I am uncertain" without taking a turn.

Each of these is a design choice — not a constraint of LLMs. Each one is open territory for HAII work to challenge.

### H. Concrete challenges to fellow engineers and designers

What to actually go work on:

- **Build a HAII for a specialised tool.** Voice transcription editor. In-game chat copilot. Calendar input. Mobile keyboard. AR text input. Each substrate has different constraints; each yields different primitives.
- **Replace one chat panel in your product with an inline primitive.** Even one. Pick a feature where users currently switch to a chat surface and think about what `_`, dim+cycle, or in-place edit could do for that feature instead.
- **Run benchmarks on your harness.** Document the deltas. Share the experiment logs.
- **Author cue/blank packs for a domain you know deeply.** Legal, medical, financial, gaming, music production, accounting, copywriting. Each domain has vocabulary and conventions that a domain expert can encode and an LLM cannot infer.
- **Port OpenCues to a new substrate.** The runtime is host-agnostic. Each new host opens a new class of users to inline primitives.
- **Optimise a known harness for local models.** Take a working pattern (transform-blank, agent-task) and tune it for a 7B local model. Surface what breaks, what stays, what needs rethinking.
- **Write the post-mortem.** When your harness ships and fails, write up *why*. The field has very little of this material.

### I. Local models as a HAII opportunity, expanded

The post mentions this. The expansion worth making explicit:

- **Architecture is already substrate-agnostic.** OpenCues calls the model through an `LLMRequest` interface with `endpoint`, `model`, `apiKey` as config inputs. Local providers (`llama.cpp`, `ollama`, `vllm`, `mlx`) can plug in by satisfying the interface. The runtime does not care.
- **The gap is not "local models don't exist."** Phi-3, Llama-3.1-8B, Qwen-2.5, Gemma — all run on consumer hardware. The gap is that the *harnesses* on top of them have not been optimised for the smaller-model regime.
- **The narrow-jobs lesson matters MORE on local models.** A weaker model fed wide prompts hallucinates and bails. The same weaker model fed narrow single-purpose prompts in a 3-pass pipeline performs dramatically better, because each step is something it can do, even if the whole task is not.
- **Latency budgets are tighter on local models.** TTFT is faster (no network round-trip) but per-token speed is often slower. The harness has to be designed around this profile (fewer output tokens per call, more parallel calls, more aggressive caching).

The opportunity: a harness that makes a local 8B model feel as good as a cloud 70B model for inline primitives. This is not an unrealistic target; the harness lessons that already exist suggest it is reachable.

### J. Tools of today, building tools of tomorrow — the bootstrap angle

Worth making explicit because it is itself a HAII pattern:

OpenCues is being built using OpenCues' substrate. Claude Code writes a chunk of the runtime code. The benchmark suites run via LLM-as-judge. Prompt design itself is iterated with help from the model. The transform-blank prompts were tuned against the transform-blank benchmark with the model in the loop.

The tool is being bootstrapped on the substrate it serves. That is a HAII pattern in itself — *AI as developer tool*, separate from AI as end-user tool. The same primitives (cues, blanks, in-place editing, narrow-jobs split) that help the end user also help the developer building the next iteration.

The "tools of today to build the tools of tomorrow" line is not a slogan; it is a description of the actual development loop.

### K. Why HAII is genuinely its own discipline (not HCI applied to AI)

AI introduces capabilities and failure modes HCI never had to deal with:

- **Output is generated, not retrieved.** Classical HCI assumed the system returned predetermined responses. AI returns synthesised ones. Every HCI principle about predictability has to be re-evaluated.
- **Behaviour shifts between sessions.** A user's mental model of "what the system does when I press X" breaks when the model gets upgraded. HCI assumed the system was stable.
- **Both input and output can be ambiguous and long-form.** HCI optimised for narrow inputs (clicks, short text fields) and narrow outputs (status messages, short results). AI accepts paragraphs and emits paragraphs.
- **The system can be wrong in plausible ways.** A confidently-stated wrong answer is a failure mode HCI did not have to design for. Verification, ownership locks, revertibility — all needed.
- **Latency is variable by design.** Classical HCI strived for sub-100ms response. AI routinely takes 200ms-10s. New patterns needed: optimistic UI, in-place markers, async patterns where the user keeps moving.
- **Calls are expensive.** Free clicks are over. Every interaction has a cost; harness design has to balance UX and economics.
- **The system can take initiative.** The agent-task pattern (system edits the user's text on its own schedule) has no analogue in classical HCI. Designing for "when does the system act on its own?" is new.

Each of these is genuinely new territory. Calling the discipline "HCI" obscures the size of the new design space. Calling it HAII names it and makes it investible.

### L. The community-first angle — what "not settling" looks like

Practical answer to "how do engineers and designers contribute":

- **The OpenCues runtime is open-source.** Anyone can read it, fork it, port it.
- **Cue and blank authoring is folder-drop with hot-reload.** No code, no build, no deploy. Drop a `cue.md` in `~/.cues/cues/<name>/`; the next keystroke picks it up. Lowest possible barrier to "I made a thing that works."
- **Community packs are the distribution path.** Domain experts can publish curated cue/blank libraries; users install them. The system was designed for this from day one (the `host-compat`, `match:`, `keywords:` fields, the `opencues import` CLI).
- **Benchmarks are the evidence layer.** OpenCues' transform-blank and agent-task benchmark suites are public. New harness ideas can be tested against the same suites; results are comparable across contributors.
- **Naming the discipline (HAII) matters.** Once a discipline has a name, contributors can find each other. This post is partially that naming move.

The status quo persists because alternatives are invisible. Make alternatives visible — by shipping, benchmarking, naming, sharing — and the status quo becomes negotiable.
