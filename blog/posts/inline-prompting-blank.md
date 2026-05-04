# Inline Prompting (Blank / _)

As we developed the concept of a 'cue' we came a limitation in our initial system.

That being the system was designed to take an existing word or span of word, provide feed or provide alternatives. However as this structure was limiting the possibilities of the system to the initial 'cue' prompt.

So I sort out of means of unlocking more possibilities initially starting with a simple problem like if I wrote:
4 + 4 = _ ← How could I get the system to complete the problem.

This involved restructuring our initial mindset behind the system from "The system provides cues to a user" to "A user can provide a cue to the system".

When I initially realised this I was taken-aback (even though my team were whelmed at best). The idea that you could have a bi-directional cueing system with an LLM system which works in real-time could unlock all sorts of new HCI possibilities.

The system -> User cue system worked based on a user selecting the indicated cue, viewing the feedback from the system or cycling through the alternative solutions provided by the system.

However as I pondered the optimal UX for user->system cues, I determined an auto-populate feature would be necessary allowing an LLM to populate the answer to the provided indicated problem.

I personally landed on using the 'Blank'/ underscore as means of indicating a cue due to the human friendliness of the problem statements when expressed; e.g.

- 4 + 4 = _
- Who is the president of the US is _
- The capital of France is _

They appear as problems which us humans would see in some form of basic trivia and the expression is somewhat natural to construct verses using some strange coding symbols.

Additionally you get the marketing benefit of 'Fill the blank' the old saying is brought back into relevance in a modern form factor.

Ok, but how does it work? So initially I built the Blank system to work based on tools, that being having an LLM classify the kind of problem it was facing rapidly (<300ms) and then performing a secondary LLM call which provides additional examples of how to solve the problem and provides steering regarding the format of the answer. This method performed well initially however it required a specialised classifier step. Blank lookups were done via the detection of specific keywords which if matched within a specific proximity of the blank could activate a special blank 'skill' e.g. looking up the price of the nvidia stock. E.g;
Nvd stock -> $136.45

Description of how the old process works.

Upon evolving my ambition for what Blanks could be I realised that I don't to require a user to 'have' to learn some advanced array of terminology or 'spells' to be able to utilise the system. I just wanted the user to know that they need to put down a blank and have the system resolve:
(Double check how new system works)

- What the question is
- What aspects of the text is relevant
- What aspects of the text need to be replaced

By removing the need for specific keywords and having the LLM determine its task and what it is relevant I freed the HCI from requiring advanced user knowledge on how to use it.

The result also pinned the base utility of the HCI to the capabilities of the underlying model within the harness I created instead of the amount of Cues/Blanks a user has installed within their setup.

This development made me more ambitious as it reduced the minimum viable HCI embodiment. Our basic embodiment for a HCI evolved from being primarily just System->user cues to additionally User->system cues.

The mechanic of dynamic questions, context selection and answer replacement was initially just used to answer questions and do dynamic swap-outs e.g.

(Give examples of FluidBlanks)

After playing with the mechanic across, the chrome, claude code and OpenCode embodiments I then pondered could I take it further as a general purpose means of manipulating any text, not just solving the problem defined by the blank.

We evolved FluidBlanks into (Get answer from repo) by allowing the blank to not just refer to a problem which needs to be solved whilst using the external text/ query as context but additionally allowing it to manipulate any parts of the text.

This small addition unlocked the concept which I like to call 'Inline Prompting'. Because a user could now:
(List lots of usecases for inline prompting)

From a HCI perspective it is fascinating.

Instead of going to a search box, or changing my text cursor state, or moving my cursor, or opening a modal. At any time at a moments notice I can prompt an AI to perform a modification on a body of text and have my request resolved in 600ms ~ 1500ms. When designing HCIs the biggest issue is often 'speed' determines utility. Designing a HCI which is artificially slow reducdes the likelihood of the tool being used whena  user has an inkling that it could be the solution they draw for.

Requiring a user to not have to move their cursor, open modals or even move their fingers from a neutral typing state to issue commands which are resolved inline also opens the avenue for deploying AI in locations which were previously not possible such as during the prompting process or within products which have limited UIs but could still benefit the advancements of LLM technology.

The most exciting bit is this is just the beginning, the technology, the scaffold and the amount of tools and cues we the community develop for Inline AIs to use will only grow in the future. I foresee a future where a user has to spend less 'start-up frames'(reference article) going back and forth between applications or surfaces to solve problems since queries can be constructed, issued and resolved inline.

---

## STAGING NOTES (not yet formatted)

### A. Description of how the old process works

The original blank system had two layers of dispatch, only one of which is still production. Worth being clear about which is which:

- **Keyword-bound blanks (still current — `BlankSource`, priority 95).** The user types a registered keyword adjacent to `_` (`volume _`, `nvda _`, `weather london _`). The keyword claims the slot. The system runs the script or runtime class behind that keyword, gets a value, populates the blank. This part is alive and well today — it is the "specialised skill" mode for power users who want a known-fast, deterministic lookup.
- **Classifier-routed blanks (deprecated — removed entirely).** For unbound `_` (no registered keyword adjacent), the original architecture made a classifier LLM call: "what kind of problem is this — math, factual, lookup, code?" — then dispatched to a per-class secondary LLM call with class-specific examples and answer-format steering. This worked but had problems: the classifier was a bottleneck, classes accumulated, every new use-case needed a new class registration.

The post's example `Nvd stock -> $136.45` is the keyword-bound path (the keyword `nvda` / `nvd stock` matches the registered stocks blank). That path still works the same way today.

The classifier-routed path was replaced by FluidBlank.

### B. How the new system works — FluidBlankSource

The replacement, sitting at priority 92 (below keyword-bound blanks at 95, so a known keyword still wins):

- **Two-pass pipeline, no classifier.**
  - **P1 SEGMENT** — one LLM call. Question: "what part of the surrounding text is the lookup phrase, and what is the question being asked?" Output: a `<span>` of words and an inferred query.
  - **P3 ANSWER** — second LLM call. Given the question, produce the canonical short answer.
  - Naming is historical (P2 was the original classifier — it was deleted, leaving a 1 → 3 jump).
- **Generality over specialisation.** The same pipeline handles math, factual lookups, translations, unit conversions, code/symbol lookups, definitions — anything answerable in a short canonical form. There is no per-mode classifier, so adding a new "kind of question" requires no code changes; the model already handles it.
- **The user does not learn a vocabulary.** They type a question that ends with `_`. The pipeline figures out where the question starts, what it is asking, and what to put back.

### C. Examples of FluidBlanks

```
4 * 12 = _                          →  48
capital of France _                 →  Paris
unicode for em dash _               →  U+2014
100 celsius in fahrenheit _         →  212
hello in french _                   →  bonjour
who is the president of the US _    →  <name>
define ephemeral _                  →  lasting for a very short time
population of france _              →  ~68 million
colour code for navy _              →  #000080
5 miles in km _                     →  8.05
```

The user did not need to know any of these were possible in advance. They just typed a question with `_` on the end.

### D. (Get answer from repo) — the TransformBlank evolution

The post's "could I take it further as a general purpose means of manipulating any text" pivot is the TransformBlank feature. From the architecture reference:

- **What it does.** Detects an imperative instruction next to `_` and rewrites the surrounding text in place.
  - `change boy to girl _ the boy ran fast` → `the girl ran fast`
  - `pluralize and make past tense _ the child runs to the park` → `the children ran to the parks`
  - `make this formal _ <draft>` → polished version
  - `make it british english _ <draft>` → BrE version
- **Two layouts both work.**
  - `<INSTRUCTION> _ <TARGET>` — instruction first.
  - `<TARGET> <INSTRUCTION> _` — text first, then realised "I want to transform this" and added the imperative at the end. This is what most users do in practice.
- **Priority 93** — between keyword-bound (95) and fluid lookup (92). A known keyword still wins; fluid catches the rest; transform sits in the middle for instructions that aren't keyword-bound but aren't lookups either.
- **3-pass pipeline.**
  - **EXTRACT** — "is this an imperative? if yes, what's the instruction and what's the target?" If no, bail to NONE and let FluidBlank claim the slot.
  - **APPLY** — execute the instruction on the target. Pure rewrite, no decisions about validity.
  - **VERIFY** — check the draft for AGREEMENT, COVERAGE, STRUCTURAL COMPLETENESS, and CONCEPT-SWAP PROPAGATION bugs. Either pass through or emit a corrected rewrite.
- **Sequential composition for "X and Y" instructions.** "pluralize AND make past tense" is split into two sequential APPLY calls (the output of one feeds the target of the next). Asking one APPLY call to do both at once dropped accuracy from 73% to 47%.
- **Latency** — ~1.4–1.6s end-to-end in production.

This is where "Inline Prompting" actually lands as a name. The user is *prompting* the system in line with their text — but instead of "answer this question," the prompt is "rewrite this text per these instructions."

### E. Use-cases for Inline Prompting

A reasonably complete list of what a `_` can do today:

**Lookups (FluidBlank)**
- Math: `4 * 12 = _`
- Factual: `capital of france _`, `population of japan _`
- Translation: `hello in spanish _`
- Unit conversion: `100 celsius in fahrenheit _`, `5 miles in km _`
- Code / symbol: `unicode for em dash _`, `colour code for navy _`
- Definition: `define ephemeral _`

**Live data (keyword-bound BlankSource)**
- Stocks: `nvda _`, `Reddit stock _`
- Crypto: `btc _`, `eth _`
- Weather: `london weather _`
- News: `HN posts _`
- Country facts: `population of france _` (handled by Countries blank when keyword matches)

**OS state (keyword-bound, write-back)**
- `volume _` — read current OS volume; Up/Down changes it
- `brightness _` — same for screen brightness

**Settings (selector / satellite)**
- `opencues settings _` — cycles the system's own settings, writes back to disk

**Text manipulation (TransformBlank)**
- Literal swap: `change X to Y _ <text>`
- Style shift: `make this formal _ <draft>`, `make it british english _ <draft>`
- Grammatical transform: `pluralize _ <text>`, `make past tense _ <text>`
- Composed: `pluralize and make past tense _ <text>`
- Tone: `make this more confident _ <draft>`
- Format: `code-style _ <text>`, `bullet-list _ <text>`

**Continuous editing (agent-task — covered in post #5)**
- `agentically correct spelling _` — arms a continuous LLM editor that runs on every pause-in-typing
- `add task fix grammar _` — extends the active task
- `stop task _` — disarms it

**List blanks**
- `affirmation _` — cycles through a defined list (dismissible)
- `HN posts _` — cycles through live headlines

**Self-improvement**
- `prompt _` — rewrites the surrounding draft prompt in place (the prompt-improver blank)

The shape that matters: **a single character with no fixed meaning**, dispatched contextually by the words around it.

### F. The "Universal Interaction Handle" framing

`_` is not a "fill-in-the-blank widget." It is a *universal interaction handle*. One character — typeable on every keyboard, no modifier, no mode switch, no command — that the system interprets based on what the user typed around it.

The same character does:
- Look something up
- Read external state (volume, weather, stocks)
- Write external state (volume cycling)
- Run an LLM rewrite (transform)
- Arm a continuous LLM editor (agent-task)
- Cycle through a list (affirmations)
- Toggle a setting (opencues settings)

The user does not pick a mode. The keyword + position + content decide. This is an unusual property in HCIs — most input characters are reserved for either text or a single fixed function. `_` is dispatched.

### G. The priority chain

How `_` decides what to do, without the user picking a mode:

```
95  BlankSource          ← keyword-bound (volume, nvda, weather...)
93  TransformBlankSource ← imperative instructions (change X to Y _)
92  FluidBlankSource     ← free-form lookups (capital of france _)
80  SpellingSource       ← misspelled words on plain text
```

Highest-priority source whose `supports()` returns true wins. So a registered keyword always wins (instant, deterministic). If no keyword matches, the input runs through EXTRACT — imperative? if yes, transform takes it. If not imperative, fluid takes it. The user does not see this; they just get the right answer for the shape of input they typed.

### H. Re-evaluation on every edit — blanks are never permanent

Unlike traditional autocomplete (which commits on accept and forgets), blanks are *re-evaluated on every edit*. If the user fixes a typo in `4 * 12 = _`'s context, the answer adjusts. If they edit the prefix of `capital of france _`, the value re-resolves.

The implication: **blanks stay live**. They are not commits, they are anchors that update with their context. Edit the surrounding text and the blank value follows.

This is unique among "fill" UIs and worth naming. Most autocomplete is commit-once; blanks compose with editing rather than fighting it.

### I. Ownership lock — the user's accepted value is stable

There is a critical implementation detail that makes blanks safe to use in mixed text: **only the user can clear a filled blank**. Once the system fills `volume 50%`, no LLM cue or further blank pass can overwrite that value. Only an explicit user edit (typing over it, deleting it) clears the lock.

Why this matters in practice: the user can have `volume 50%` embedded in a paragraph; the LLM can offer cues on every other word in that paragraph; the `50%` will not move, will not get re-themed, will not be replaced by "fifty percent" or "numerous". It is locked until the user touches it.

This is the property that makes blanks composable with the rest of the system.

### J. Inversion of traditional autocomplete

The most quotable HCI angle in the whole project:

> Traditional autocomplete: the *system* decides where the completion appears.
> Blank: the *user* decides where the completion appears.

Traditional autocomplete pops up suggestions while you are typing; you accept-or-dismiss. The system is choosing the moment, the position, and the shape of the suggestion. The user is the responder.

Blanks invert it. The user types `_` *exactly where they want a value to appear*. The system has no choice about position. It only has to figure out what to put there. The user has gone from being the responder to being the *placer*.

A decade of autocomplete UX, inverted by one character.

### K. Reference article — start-up frames link

`(reference article)` at the bottom of the post should point back to **post #1 (HCI)** where start-up frames, active window, and cool-down are defined.

### L. The "no spells to learn" progression

The post says the user "doesn't have to learn some advanced array of terminology or 'spells'". The full progression is worth showing:

| Path | Vocabulary required | Speed | When to use |
|---|---|---|---|
| Keyword-bound (`volume _`) | Yes — but only the keywords for the things you want | Fastest (no LLM) | Power users, deterministic external state |
| Transform (`change X to Y _ <text>`) | None — natural-language imperative | ~1.4s | Rewrites, edits, style shifts |
| Fluid (`capital of france _`) | None — natural-language question | ~600ms | Lookups, computations, definitions |

A new user starts with fluid and transform — no vocabulary needed. As they learn what blanks exist (via cue-tips, via the `opencues list` CLI, via community packs), they graduate to keyword-bound for the things they use frequently. The user can stay at the no-vocabulary level forever and lose nothing meaningful — the keyword path is an *acceleration*, not a gate.

This is rare in HCIs. Most systems have a power-user path that *requires* learning vocabulary; here, the vocabulary is optional sugar on top of a no-vocabulary baseline.

### M. `_` is on every keyboard

Worth saying explicitly: `_` is shift+hyphen on every standard QWERTY layout, every smartphone keyboard, every text input on every platform. No special command, no menu, no modifier-key combo, no IDE plugin. The interaction primitive is *typeable* — and that universality is what lets it port from terminal to browser to mobile keyboard.

### N. Visible failure

If the system cannot fill a blank, the `_` stays. There is no silent "the system tried and gave up" mode. Failure is visible: the user can see the gap they put there, and they can see the gap is still there.

This is a useful property because it inverts the usual autocomplete failure mode. Standard autocomplete that does not surface a suggestion is invisible — the user does not know whether the system tried and could not help, or never tried at all. With blanks, "I asked, system did not answer" is observable. The user can choose to type the answer themselves, or rephrase, or move on.

The visible failure mode is also why the latency budget on blanks is sub-second: the user is *waiting on a visible gap*. If a cue (which is invisible-on-failure) is slow, no one notices. If a blank is slow, everyone notices.

### O. The 3-axis framework applied to Inline Prompting

(Correction to my earlier framing — this is the proper read of the three axes for blanks.)

- **Start-up frames** — minimal *because the user does not need to leave their work to issue the prompt*. No "switch to a chat window," no "open a search box," no "click into an input field somewhere else." The blank is summoned in place, in the artifact the user is already typing in. The prompt happens *where the user already is*.
- **Active window** — the user is not prevented from doing other things while the blank resolves. They can keep typing, navigate elsewhere in the input, prepare the next blank. The prompt does not gate the user's further actions.
- **Cool-down (end-lag)** — the user continues from where they prompted. There is no "return to your region of interest" navigation needed afterward. The result lands in place, in the same text they were editing, at the same cursor position. No context switch back from a popup, a chat window, a separate panel, or a different application.

This is the strongest test of the framework so far. Every other modern AI HCI fails one of these — chat windows fail start-up (you have to switch surface) and cool-down (you have to come back). Search boxes fail cool-down. Modals fail active window. Inline Prompting passes all three because the prompt and the artifact share the same surface.

### P. Multiple `_` in the same input work concurrently

A non-obvious property: a single text input can contain multiple blanks, and they resolve independently, in parallel.

```
set volume to _ and check weather in london _
       ↓                                      ↓
       50%                                    14°C cloudy
```

Each `_` is a separate dispatch decision. Each one fires its own pipeline (keyword-bound, transform, or fluid) based on its own surrounding context. They batch in parallel where possible.

The user can compose entire paragraphs of mixed-source content — live data, computed answers, transformations, settings — by sprinkling `_` characters through their text. The system fills them all.

This removes a limitation users often assume ("one blank per prompt") and points at the more general capability the system has from day one.
