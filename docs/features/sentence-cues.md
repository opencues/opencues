# Sentence Cues

A cue that operates at the **sentence** level instead of the word
level. The cue receives whole sentences from your buffer and offers
alternative rewrites of each sentence. Cycling Up/Down at the
sentence swaps in a different rewrite (or reverts to the original).

Where word cues offer per-word synonyms ("ultrathink" → "deepen
analysis"), sentence cues rewrite the whole sentence ("thanks a
bunch." → "Thank you very much.").

OFF by default. Opt-in via `sentence-cues-mode: on` in `~/.cues/OPENCUES.md`.

The first shipped sentence cue is **`more-formal`** — see below.

---

## What changes when you turn it on

Without sentence cues, you have:

  - Word cues highlighting individual words with synonym alternatives.
  - Blanks (`_`) triggering fluid / config / transform pipelines.

With sentence cues on, sentences in your buffer also get cued — each
becomes a one-span highlight you cycle for alternative rewrites. With your
caret in the sentence, a bare **`_`** steps to the next rewrite (the primary,
discoverable gesture); `Ctrl+Alt+↑/↓` is the power path (and the only way to
step **backward**). Same gestures you use for word cues.

| You type (buffer stays as-is) | Ctrl+Alt+Up | Cycle Up again | Cycle Down |
|---|---|---|---|
| `thanks a bunch.` | `Thank you very much.` | `Many thanks.` | (original) |
| `let me know what you think.` | `Please share your thoughts.` | `Your feedback would be appreciated.` | (original) |
| `gonna head out early today.` | `I will be leaving early today.` | `I plan to leave early today.` | (original) |

Sentence-cues are passive — your prose is **never** rewritten without
your keystroke. The runtime keeps the original sentence in place and
holds the rewrites in a cue you cycle through with a bare `_` (or
Ctrl+Alt+Up) at any word inside the sentence. Same gestures as word-cues,
just at sentence granularity.

---

## How to turn it on

Edit `~/.cues/OPENCUES.md` frontmatter:

```yaml
sentence-cues-mode: on
```

Then make sure at least one cue with `scope: sentence` is shipped.
The default install ships `~/.cues/cues/more-formal/CUE.md` —
seed-configs copies it on first run.

Off again is the same with `off`.

---

## Per-cue declaration

Each sentence-scope cue is a normal CUE.md file with `scope: sentence`
in the frontmatter:

```yaml
---
name: more-formal
scope: sentence
priority: 85
---

Rewrite each sentence in the buffer to be MORE FORMAL. …
```

The body is the user-authored prompt — instructions about what
constitutes a "good" alternative for THIS cue. The runtime appends a
standard output-format spec (the SENTENCE/ALT/--- block shape) so
authors only write the *intent*, never the wire format.

You can ship multiple sentence-scope cues side-by-side. Today's
default install ships only `more-formal/CUE.md`; future cues like
`more-concise/CUE.md`, `active-voice/CUE.md`, `plain-english/CUE.md`
follow the exact same one-file pattern (no source-class edits — see
the architecture doc). Each gets its own LLM call per buffer per
resolve. The sentence-cues-mode scalar is a single global
kill-switch on top of all per-cue declarations.

---

## Priority + overlap with word cues

Sentence cues default to priority **85** — higher than typical word
cues (legal=70, medical=70, financial=70, etc.). On a sentence
containing words that have word-cues, the sentence cue wins and
the word cues are suppressed.

The suppression is "outright" by design — a sentence rewrite is
semantically a complete-sentence replacement; offering individual
synonym cues for words inside that span would be confusing and would
fight against the active sentence-cycle.

You can override per cue with `priority: <N>` in the frontmatter if
you want a specific sentence cue to outrank or underrank a specific
word cue.

---

## v1 limitations

These are deliberate v1 simplifications, not architectural
constraints — each can be relaxed in v2:

- **Regex-based segmenter.** Splits on `[.!?]+` followed by
  whitespace/EOF. Abbreviations (`Mr.`, `Dr.`, `e.g.`) and
  period-bearing URLs get split mid-token. The model usually
  emits `ALT: NONE` for the resulting fragments, so the failure
  mode is "no rewrite" rather than "wrong rewrite". v2 could use
  a proper segmenter.
- **`isCycleable: true` — pruned in no-cycling profiles.** Chrome's
  normal-`<input>` profile (no cycling surface) drops every
  sentence-cue at build time, same way it drops cycleable word-cues
  and list blanks. Chrome contenteditables, claude-cues, opencode,
  gemini-cli all support cycling so the cue surfaces there normally.
---

## What it sends to the LLM

For each sentence-scope cue, the buffer is segmented into sentences and
**one call is fired per sentence** (concurrency-capped, default 5 in
flight). Each call carries:

  - System message: your `promptText` from CUE.md + the framework's
    auto-appended output-format spec. This is identical across every
    sentence, so providers with prefix caching reuse it.
  - User message: `INPUT: <a single sentence>`.

The model emits one block for that sentence:

```
SENTENCE: <verbatim sentence>
ALT: <rewrite 1>
ALT: <rewrite 2>
ALT: <rewrite 3>
```

Or `ALT: NONE` for a sentence that doesn't merit a rewrite (fragments,
code, URLs, already-meeting-the-intent).

Per-sentence calls replaced the earlier single-batched-call model
(June 2026): batching every sentence into one prompt silently dropped
~1/3 of sentences on real buffers. One call per sentence means a long
buffer can't blow a single call's token budget, and a slow or dropped
sentence can't take its neighbours down with it.

**What's NEVER sent:**

  - Other cues' settings or prompts.
  - The OPENCUES.md scalar values (no PII unless you put it in your
    buffer).
  - File paths, host info, env vars.

---

## Bench provenance

Validated at `tests/benchmarks/sentence-cues/`:

- **Recall** (informal sentences → ≥1 MORE_FORMAL rewrite):
  **100% on Groq**, 91-100% across all 5 providers.
- **Precision** (CEDE on fragments / code / already-formal):
  **100% across all 5 providers** (150 reject decisions, zero false
  positives — the trust-boundary metric).
- **Latency** (~250-1100 ms per buffer depending on provider).

See `tests/benchmarks/sentence-cues/EXPERIMENTS.md` for the per-provider
sweep.

Re-run after editing the source's output-format spec or the segmenter:

```bash
GROQ_API_KEY=… npx tsx tests/benchmarks/sentence-cues/run.ts --parallel 4
```

---

## Where it works

| Integration | Sentence cues | Notes |
|---|---|---|
| Claude Code | Yes | Standard `OPENCUES.md` flow. |
| OpenCode | Yes | Same. |
| Gemini CLI | Yes | Same. |
| Chrome (contenteditable) | Yes | Same. |
| Chrome (normal `<input>` / `<textarea>`) | No | Universal Integration profile — no cycling surface; pruned at build. |

---

## See also

- [`docs/architecture/sentence-cues.md`](../architecture/sentence-cues.md) — full architecture, segmentation, suppression rules, v1 limitations.
- [`tests/benchmarks/sentence-cues/`](../../tests/benchmarks/sentence-cues/) — bench cases, prompt, experiment log.
- [`packages/opencues-core/src/sources/sentence-cue-source.ts`](../../packages/opencues-core/src/sources/sentence-cue-source.ts) — the source class.
- [`defaults/cues/more-formal/CUE.md`](../../defaults/cues/more-formal/CUE.md) — the shipped canonical cue.
