# blank-context-recall

Focused bench: when blank-context-mode is on and a catalog of ambient tokens
is injected, how often does the LLM **emit a catalog token** vs. answer in
plain prose (which means the post-processor never gets to substitute)?

The matrix bench (`blank-sentinels-matrix/FINDINGS.md`) measured recall on
DIRECT queries (user names the field explicitly). This bench measures
INDIRECT queries — the user asks about a topic the catalog covers without
naming a specific token.

## Method

Two prompt variants:

- **baseline** — production `renderBlankContextCatalog` (no inline examples)
- **examples** — same block + 3-5 input→token examples

Each variant runs against a 30-case suite:
- 15 cases where the catalog SHOULD be used (positive: indirect questions
  about stocks / weather / crypto)
- 10 cases where the catalog should NOT be used (negative: factual lookups
  unrelated to the catalog — `capital of france _`)
- 5 cases that are ambiguous (could go either way)

## Metric

For each case:
- `tokenEmitted`: did the LLM emit `[STOCKS]` / `[WEATHER]` / `[CRYPTO]`?
- `correctEmission`: did the LLM emit a token IF the case was positive,
  AND emit no token IF the case was negative?

Recall = correctEmission rate across the suite.
