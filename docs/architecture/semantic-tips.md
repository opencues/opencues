---
last_updated: 2026-09-06
status: PROPOSAL — not built. Ruled in principle by Wilfred 2026-09-06 ("what we want is more like the rule system ... takes the available tips as context which is then used to dynamically match").
---

# Semantic tips — the tips pack as a watchlist

## The problem

The tips system is static matching: a pack (`defaults/cues/tips-*/CUE.md`) is a
map from single whitespace tokens to a tip and its cycle targets, and
`ConfigLoader.lookup(word)` is an exact, lowercased key hit. It is instant and
deterministic, which is the right floor. It is also dumb in three ways the
2026-09-06 research made concrete (`~/opencues-website/internal/research/claude-code-cues/`):

1. **It matches tokens, not situations.** "start over", "it forgot the plan",
   "why is this so expensive", "how do I undo that" are the moments the tip
   is for, and none of them contain the trigger word (`/clear`, `/compact`,
   `/model`, `/rewind`). Eight shipped keys contain a space and can never match
   at all; `/clear,` with a comma never matches either.
2. **It cannot carry expertise.** A pack is a vocabulary list. The research
   produced catalogues of situations (stuck moments, prompting mistakes,
   Claude-Code-habits-wrong-in-OpenCode) that are tips in spirit but have no
   token to hang on.
3. **It cannot steer.** The tip text is fixed per token; there is no way to
   say *which* tip matters for *this* sentence when several could apply.

The rules watchlist (`RULES.md` → session-contradiction matcher) already does
what we want, for a different catalogue: the whole draft goes to one debounced
LLM call with the catalogue in the SYSTEM message, the model emits grounded
flags (an exact quote from the buffer + an id that must be on the list), and
the runtime renders a passive advisory. It is benched at 19/19 recall and 0
false alarms across five industries with the prompt unchanged.

**The plan: generalise that matcher into a watchlist engine, and feed it the
tips packs as a second catalogue.** Static matching stays as the zero-latency
floor; the semantic layer sits above it.

## What exists, exactly

| piece | where | what it does today |
|---|---|---|
| `SessionContradictionSource` | `packages/opencues-core/src/contradiction/session-contradiction-source.ts` | priority 88; `getCues` returns `[]` unless `context.sessionCommitments` has entries; one `dispatchChat` with `SESSION_CONTRADICTION_MATCH_SYSTEM + catalog` in the system message, the draft in the user message, `maxTokens: 400`; parses a JSON array of `{quote, commitmentId, tip, reconciled}`; drops a flag unless `quote` is an exact substring of the live buffer AND `commitmentId` is on the list; one flag per span, max 3; emits `source: 'sentence-cue:session-contradiction'`, `cueTip: ⚠ <tip>`, `alternatives: [quote, reconciled]`, span offsets. |
| `renderSessionCommitmentsCatalog` | `packages/opencues-core/src/session-commitments.ts` | `- c<N> [category]: statement` lines under a header; `MAX_COMMITMENTS = 24` because "beyond this the matcher prompt bloats". Rules from `RULES.md` merge first with stable `r<N>` ids (`boot-common.ts` ~L1070). |
| `SessionCueSource` | `packages/opencues-core/src/sources/session-cue-source.ts` | the fused rail: contradiction first, then ask-cues; one debounce (resolver `debounceMs`, 500ms). |
| the resolver's registration | `packages/opencues-runtime/src/modules/resolver.ts` | passive DynDefs for sentence-cue results (no auto-splice; `Ctrl+Alt+↑` applies `alternatives[1]`); the advisory dismissal gesture (`_` once mutes, twice forgets) applies when `alternatives.length <= 1`. |
| `LocalCueSource` + `cueMap` | `packages/opencues-core/src/sources/local-cue-source.ts`, `config-loader.ts` | the static path: `lookupMultiple` over the hash map, `source: 'tips'`, protected from LLM overwrite in `mergeWordDefs`; the resolver's tip-vs-LLM rule skips LLM alts for any word with a tip entry that has alternatives. |
| the pack format | `defaults/cues/tips-*/CUE.md` | frontmatter (`on-host:`), then a ```json block: `[{id, words: {<token>: {tip, alts}}}]`. Parsed by `parseTipsSection`; chrome bakes the packs as constants, so they exist on every host. |
| `tips-mode` | `feature-registry.ts` | `on | off`; gates RENDERING of tips (the word/alts data still flows). |
| the bench | `tests/benchmarks/session-contradiction/company-rules-bench.mjs` | deterministic scoring: every case labelled with the id it violates or null; scores flagged-when-should, silent-when-should, cited-the-right-id; topic-adjacent compliant traps decide shippability. |

## The design

### 1. One engine: `WatchlistSource`

Lift `SessionContradictionSource` into a parametrised class. Nothing about the
matching changes; what becomes a parameter is:

| parameter | session contradiction | semantic tips |
|---|---|---|
| catalogue | the session snapshot + RULES.md, `c<N>`/`r<N>` ids, cap 24 | the host's tips pack(s), `t<N>` ids, cap by token budget (below) |
| header (system) | "SESSION COMMITMENTS — decisions ..." | "TIPS — things this editor's users often don't know. Flag a sentence when one of these would help the person writing it." |
| framing rule | "flag ONLY a direct, specific contradiction" | "flag ONLY when the draft shows the situation the tip is for; naming the topic is not the situation" |
| emoji + source | `⚠`, `sentence-cue:session-contradiction`, priority 88 | `💡`, `sentence-cue:tip`, priority 86 (below the two contradiction engines, above sentence-cues at 85) |
| alternatives | `[quote, reconciled]` (a rewrite to cycle to) | `[quote]` (pure advisory → the `_` dismissal gesture applies), or `[quote, reconciled]` when the pack entry carries a `rewrite:` |
| max flags | 3 | 2 |

Grounding invariants are shared and non-negotiable: the quote must be an exact
substring of the live buffer; the cited id must be on the catalogue; the draft
is untrusted input. **The tip text is DATA** — the runtime renders the pack's
own line for the cited id, never the model's paraphrase. The model may add a
≤80-char "why" (as the contradiction `tip` field does today); it is shown after
the pack line, never instead of it. That is what keeps a semantic tip from
hallucinating a command that does not exist.

`SessionContradictionSource` becomes `new WatchlistSource(SESSION_PRESET)`;
its tests keep passing unchanged. That is the whole of phase 1.

### 2. The pack gains a `when:` line

A token alone cannot describe a situation. The pack entry grows one optional
field, and the catalogue renders from it:

```json
{ "id": "context-management", "words": {
  "/clear": {
    "tip": "Fresh start - clears context but keeps CLAUDE.md",
    "when": "wants to start over, begin an unrelated task, or says the model keeps circling",
    "alts": ["/compact", "/rewind"] } } }
```

Catalogue line: `- t17 [context-management] /clear — when: wants to start over,
begin an unrelated task, or says the model keeps circling — tip: Fresh start -
clears context but keeps CLAUDE.md`. Entries without `when:` render as trigger
+ tip and still match semantically, just worse. Backwards compatible: the
static path ignores the field.

This is where "different sets of expertise" lives. A pack is an expertise
catalogue: `tips-claude-code`, `tips-opencode`, and from the research
`tips-prompting` (the 20 prompting mistakes as `when:` lines with a `rewrite:`
each), `tips-git`, whatever a team ships in `<project>/.cues/cues/`. Host
scoping (`on-host:`) already decides which packs are on the catalogue; project
packs join user packs the way RULES.md does today (project first).

### 3. Budget, not a count cap

24 entries was the right cap for a prose watchlist of session decisions. The
Claude Code pack is 128 entries; with `when:` lines it renders at roughly 25
tokens each, ~3.5k tokens — comfortably a cerebras prefix-cached system message
(the fused transform prompt is ~20k tokens at a 99.5% cache rate). So the cap
is a **token budget** on the rendered catalogue (proposed 8k), filled in order:
project packs, then user packs, then shipped; within a pack, in file order. A
pack that overflows logs which entries fell off. No prefilter: the point is to
match situations that do not contain the trigger word, so the whole catalogue
has to be in the prompt.

### 4. Where it sits in the rail

- **Static first, always.** `LocalCueSource` keeps its zero-latency hit and its
  cycleable alts. The semantic result is dropped when its quote span already
  contains a static tip hit for the same entry (the user typed the token; the
  static path has it, with cycling). Dedup key: the pack entry id.
- **One call per job.** The semantic tips call is its own dispatch in the
  debounced whole-buffer rail, queued after contradiction (the fused
  `SessionCueSource` gains a third leg, contradiction → tips → ask), never
  folded into another call's prompt. Two jobs in one prompt was tried and
  retired for the exact reason a second catalogue would repeat.
- **Bucket:** cues (prose-bearing; refuses `trainsOnInput` providers).
- **Scalar:** `tips-mode: on | semantic | off`. `on` is today's behaviour;
  `semantic` adds the matcher; `off` silences both. Registry entry + the
  `OpenCuesState` field + the alignment test; fluid-config picks it up
  automatically.
- **Render:** passive DynDef, `💡` note, statusline via `cueTip`, the
  advisory dismissal gesture (mute 30 min / forget) keyed by the normalised
  quote, exactly as advisory contradictions are.
- **Chrome:** packs are bake-time constants, so the catalogue exists there; the
  `when:` field rides the same bundle. No new bridge.

### 5. The bench is the gate

`tests/benchmarks/tips/semantic-tips-bench.mjs`, modelled on the company-rules
bench: deterministic, every case labelled with the tip id it should surface or
null, three scores (surfaced-when-should, silent-when-should, cited the right
id). Case sources are already written: the research's "phrases beginners use",
"stuck moments", "words that mean trouble" are the recall set; the traps are
topic-adjacent sentences that do NOT need the tip ("the context of this
function is the request object", "compact the JSON", "the model in
models/user.ts"). Ship gate: false-alarm rate on traps ≤ the rules bench's 0,
recall on the stuck-moment set ≥ 90%, on five providers. A tip that fires on
every mention of the word "context" gets turned off in a week, which is the
same failure the rules bench was built to catch.

## Phases

| phase | work | proof |
|---|---|---|
| **0 — bench first** | Render the CC pack with hand-written `when:` lines for ~40 entries into the existing matcher's catalogue slot; run the matcher as-is on the research phrases and traps. No runtime change. | Is the matcher any good at tips? Which header/framing wins? Same question the rules bench asked. |
| **1 — the engine** | `WatchlistSource` with the two presets; `SessionContradictionSource` re-expressed on it; tests unchanged. | `session-contradiction-source.test.ts` green; the rules bench reproduces 19/19. |
| **2 — the catalogue** | `when:` in the pack schema + parser; `renderTipsCatalog` with the token budget and pack order; `tips-mode: semantic`; the third leg in `SessionCueSource`; dedup against static hits. | unit tests on render/budget/dedup; `boot-bands-wiring.test.ts` for every band. |
| **3 — the surface** | `💡` passive note, dismissal keyed by quote, statusline, `tips-mode off` silencing both paths. | cycling scenarios (`*.scenarios.test.ts`): static hit + semantic hit on the same sentence; dismiss; hot-reload of a pack with `when:` lines. |
| **4 — the packs** | `tips-claude-code` refresh from the research (47 missing triggers, `/simplify` → `/code-review`, the eight space keys, the graded think words), `when:` lines throughout; `tips-opencode` with the Claude-Code-habit corrections; new `tips-prompting` with `rewrite:` lines. | the bench, per pack. |
| **5 — hosts** | agentic scenarios on CC and OC (runtime contracts only: the def landed, the dismissal took, no double fire); the chrome E2E. | the harness. |
| **6 — docs** | `docs/features/semantic-tips.md`, this doc promoted from PROPOSAL, `tip-priority.md` (a fifth row: semantic tip on a span), `local-cues.md`, CLAUDE.md pointer, the website. | the release checklist. |

Independent, small, and worth doing first regardless: strip trailing
punctuation in `ConfigLoader.lookup` (with a test on `/clear,` and
`CLAUDE.md.`), and split or drop the eight space keys. That fixes the static
floor while the semantic layer is being built.

## Risks and the answers

- **Latency and cost per keystroke.** One more debounced call per buffer
  change, after contradiction. Cerebras prefix caching makes the catalogue
  nearly free; the user message is the draft. Measured, not assumed: phase 0
  logs `cachedTokens` via `onUsage`.
- **False alarms.** The single biggest risk; the bench's trap set is the gate,
  and precision-over-recall is in the prompt as it is for rules.
- **The model inventing a tip.** Impossible by construction: the id must be on
  the catalogue and the text is the pack's.
- **Two engines, one sentence.** Priority order decides (contradiction 87/88
  over tips 86); the resolver already drops overlapping span defs.
- **Pack authors writing bad `when:` lines.** The bench per pack; a pack ships
  with its cases.
- **Chrome parity.** Packs are baked; the only chrome-specific work is the E2E.

## Open

- Whether `tips-mode: semantic` becomes the default once the bench clears, or
  ships opt-in the way ask-cues did.
- Whether prompting rules live as a `tips-prompting` pack (💡, cycle to the
  rewrite) or as RULES bullets (⚠, advisory). The research page argues both
  have a place; the bench will say which reads better on a real draft.
- The catalogue budget number, and whether project packs may exceed it.
