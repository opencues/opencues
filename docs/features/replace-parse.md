# Replace parse

**Scalar:** `replace-parse-mode: off | on` (OPENCUES.md, default `off`)

Some imperative `_` asks name one exact piece of the buffer and one edit
to it:

```
her name is Sarha fix the spelling _
oven at 425F — make that celsius _
the ticker is aapl uppercase it _
```

By default these route through transform-blank's fused pipeline, which
rewrites the **whole buffer** and three-way-merges the result. That
works, but for a two-word edit it is a large call with a weak guarantee
(the model *may* touch anything).

With `replace-parse-mode: on`, a small detector call is dispatched **in
parallel** with the fused call — zero added latency, one extra small LLM
call per imperative `_`. The detector proposes three strings: the
command phrase, the target substring, and the replacement value. The
runtime then verifies every claim deterministically before anything
moves:

- command and target must be **verbatim substrings** of the buffer;
- the target must occur **exactly once** outside the command (a copy
  inside the command — "swap **kids** for the formal word _" — is fine);
- a command-side copy must not precede the real target.

Only a detection that passes every check takes the deterministic
bounded-splice path: the target and the command are consumed, the value
lands in the target's place, and **text you didn't point at is
structurally untouchable**. Anything else — a lookup, a whole-buffer
rewrite, an unverifiable claim, a detector error — falls back to the
fused merge exactly as if the mode were off. The detector can only
upgrade a dispatch, never degrade or block one.

The detector runs on the same outbound (dehydrated) text as the fused
call, so `identity-context-mode: safe`'s PII boundary is unchanged;
token echoes are hydrated locally before verification.

Detection accuracy: `tests/benchmarks/fluid-blank-replace/` — 100%
class accuracy, 100% verified splices, and zero fill→replace false
positives on gemma-4-31b (56 cases, 2026-08-27). The bench drives the
shipping prompt/parser/verifier from `@opencues/core`.

Implementation: `packages/opencues-core/src/sources/replace-detect.ts`
(prompt + parser + acceptance gate) and the divert point in
`transform-blank-source.ts`; the splice geometry is the resolver's
existing bounded-target branch (`docs/architecture/blank-sources.md`,
decision table row 2).
