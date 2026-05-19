# next-prompt-cues — experiment log

Goal: when a user prompts the LLM with a question, get back the
answer AND a JSON list of 3 predicted-next-prompt cues. The cues
shape the user's next move — a clickable, copy-and-edit-able
suggestion strip that anticipates "what would I ask after seeing
this answer?"

This is OpenCues's "predictive prompt" experiment. Cues here are
LLM-output strings (not the standard `_`-gated runtime cue surface)
— they augment a normal Q&A response. Future integration: render
them as the satellite menu after a chat reply lands, or as inline
suggestions in a prompt-improver flow.

## Bench shape

- **15 cases** across 6 categories: knowledge, how-to, debug,
  compare, creative, code-spec (`cases.ts`).
- **Prompt variants** in `prompts.ts`: `PROMPT_V1` (minimal),
  `PROMPT_V2` (named directions: deeper / related / action).
- **Judge** in `judge.ts` — pinned to Groq `gpt-oss-120b`, scores
  each output on four flags: `schema` (parses as JSON),
  `distinct` (three different directions), `relevant` (each cue
  connects to the answer), `advancing` (each cue would
  meaningfully advance the conversation).
- **Run:**
  ```bash
  GROQ_API_KEY=... npx tsx tests/benchmarks/next-prompt-cues/run.ts --variant v2
  OPENCUES_BENCH_PROVIDER=cerebras-gpt-oss npx tsx tests/benchmarks/next-prompt-cues/run.ts --variant v2
  ```

## Iteration log

### v1 @ 600 max tokens — 12/15 (80%)

Baseline. Minimal prompt: "output JSON with answer + 3 distinct,
advancing cues."

Failures (3, all `schema`): `h-dotfiles`, `c-react-vue`,
`cs-binary-tree`. All long-answer cases — the model produced
markdown-rich answers (numbered lists, code fences inside the
`answer` field) and the JSON got truncated by the 600-token cap
before the closing brace.

**Hypothesis:** the failures are budget-bound, not prompt-bound.
The judge never even got to see the cues because the parser
rejected the truncated JSON first.

### v1 @ 1500 max tokens — 15/15 (100%)

Same prompt, just more output budget. Confirms: every fail in the
600-token run was truncation, not a prompt deficiency. JSON now
closes cleanly on every case.

**Takeaway:** for structured-output prompts with arbitrarily-long
answer fields (code, multi-step how-to), budget tightly to the
LARGER side. Output cost is per-token; under-budgeting silently
breaks the contract.

### v2 @ 1500 max tokens — 15/15 (100%)

Same accuracy as v1, but the prompt now enforces a fixed taxonomy of
cue directions:

  - `deeper`   — drill into the same topic (mechanism, edge cases, trade-offs)
  - `related`  — pivot to an adjacent topic the answer raises
  - `action`   — propose a concrete next step (sample code, checklist, setup)

The IDs are stable strings the calling code can route on. Downstream
integrations can then render them in fixed slots (e.g. "ask deeper /
ask related / take action" as three persistent surfaces). This is
where v2 earns its keep — accuracy parity, but a richer contract.

**Decision:** ship v2 as the canonical prompt. The taxonomy
constraint isn't measurable in the current judge (which only scores
distinct / relevant / advancing — not "are the IDs in fact those
three directions"), but it's a real integration win.

## What this judge does NOT measure

- **Does the answer remain CORRECT?** The judge only scores cues.
  An LLM that produces 3 great cues but a wrong answer still passes
  this bench. A future variant should pair this judge with a
  per-category answer-quality check.
- **Are the cues TRULY UNGUESSABLE-OTHERWISE for a user?** A user
  might also ask things the model didn't predict — recall against
  human ground-truth would need a real-user dataset.
- **Cue text quality at the keystroke level.** "show me sample
  code" passes "advancing" but is generic. A user-quality bench
  would penalise template-y cues vs context-specific ones.

These are the obvious next stretches when the bench is upgraded.

## Provider notes

- Default `groq · openai/gpt-oss-120b`. All 15 cases pass at 1500
  max_tokens.
- Other providers honour the `OPENCUES_BENCH_PROVIDER` env-var
  switch (gemini-flash-lite / cerebras-gpt-oss / claude-haiku /
  openai-nano). Not yet sweep-bench'd here; the v2 prompt should
  port without provider-specific changes (no provider-specific
  reasoning hooks in the prompt).
- Reasoning models (gpt-oss medium+, gpt-5-mini, etc.) will pay
  thinking-token overhead on top of the 1500 output budget — bench
  with `MAX_TOKENS=2048` and `OPENCUES_GEMINI_THINKING=none` (or the
  equivalent for the provider) to compare cleanly.

## Followups

- **Sweep providers** at v2 + 1500 tokens so we have the same
  5-provider matrix as fluid-blank / transform-blank.
- **Holdout set.** Today's 15 cases are in-prompt — the prompt
  knows what shapes they'll have. Need 15-20 unseen cases (e.g.
  legal questions, music theory, recipe variants) to confirm the
  prompt generalises.
- **Integration scenario.** Once the prompt is stable, add it
  somewhere the runtime can consume — likely as a new
  `AnswerWithCuesSource` that lights up after a chat reply,
  populating selector-satellite cues for the user to one-click.
- **Streaming.** Today the bench waits for the full JSON. For real
  use, the model could stream the `answer` field first (so the user
  sees the reply immediately) and stream the cues last — needs a
  custom parser that handles partial JSON.
