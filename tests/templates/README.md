# Template instruction tests

These scripts verify that the instructions in the scaffolded `.cues/`
templates (`CUES.md`, `BLANKS.md`, `OPENCUES.md`, plus the
per-kind `new/*.md` files) actually work when followed. Each test walks
through the user journey documented in the template comments and asserts
the behaviour matches.

## What's tested

| Script | Scope |
|---|---|
| `test-init-flow.sh` | `opencues init` → `opencues new cue/blank` → `opencues validate` → 0 errors |
| `test-cues-examples.sh` | Uncomments the `### synonym` + `### formal` examples in CUES.md; verifies match regex hits the documented example words and the `## Tips` JSON keys look up to their declared alternatives |
| `test-blanks-cascade.sh` | For each BLANKS.md example (MATH / FACTUAL / GRAMMAR), verifies the match/keywords fast-path routes the documented example inputs to the correct mode — deterministic, no LLM |
| `test-blanks-shapes.sh` | Scaffolds each of the four `new blank` shapes in turn, uncomments the relevant shape, validates, and checks the declared fields parse |
| `llm-smoke.sh` | **Optional** (requires `GROQ_API_KEY`). Runs a handful of end-to-end LLM queries: synonym of "happy", compute of "4 * 12", factual "capital of France". Asserts shape of response, not exact words. |

## Run all

```bash
tests/templates/run.sh
```

Each script writes verbose output to stderr; final pass/fail summary on
stdout. Non-zero exit on any failure.

## Non-goals

- These are NOT LLM-quality benchmarks (use `tests/benchmarks/` for that).
- They do NOT exercise the integrations (CC, OC, Chrome) — just
  the template + CLI + config-loader contract.
- They do NOT assert deterministic LLM output content — only shape.

## Shipping a new cue — what to run before merging

When you add or substantially rewrite a `defaults/cues/<name>/CUE.md` (or
change a prompt body in any `### alternatives` section), you MUST run
the LLM smoke before shipping. Domain cues have two classes of bug that
pre-LLM tests cannot catch:

1. **Prompt leakage.** A prompt that lists word pairs as prose ("Distinguish
   between: shall vs will, indemnify vs hold harmless") gets read by the
   LLM as the input words — it returns alts for every pair, ignoring
   the actual highlighted word. Symptom in production: `INDEX >=
   words.length` drops every response entry, user sees no highlights.
2. **Indexing drift.** Examples in the prompt use 1-based indices but
   the runtime sends 0-based inputs. The LLM copies the 1-based pattern;
   parser rejects. Fix: write prompt examples as `0=word → 0:a,b,c`
   (see `defaults/cues/grammar/CUE.md`).

### Checklist before merging a new domain cue

```bash
# 1. The fast-path smoke (no LLM) — verifies the cue.md parses and the
#    routing keywords / match regex are correct.
bash tests/templates/test-cues-examples.sh

# 2. The LLM smoke — add an entry in the "Shipped domain cues" block of
#    llm-smoke.sh with one known keyword (single-word) + three keywords
#    (multi-word), then run:
export GROQ_API_KEY=...
bash tests/templates/llm-smoke.sh

# 3. Manual Chrome smoke — pass 4 of the fresh-install test in
#    docs/features/chrome-sync.md. Pick a three-word sentence that
#    exercises your new cue + at least one other (e.g. grammar
#    default) to verify per-word routing.
```

If the LLM smoke fails with "missing index N" or prose in the response,
the cue's prompt is the problem. Follow grammar's structure:
- Brief guidance (2-3 sentences).
- A `Format:` line.
- A block of per-word `0=word → 0:alt,alt,alt` examples.
- No "Distinguish between: A vs B, C vs D" lists — those look like
  input to the LLM. Put domain nuance in a shell of examples instead.

Full authoring guide: `docs/features/word-cue-routing.md`.
