# cue-spec — the Cue file format & runtime contract

> **Status:** `0.7-alpha`. Expect changes.

A **cue** is the LLM→user surface: while a user types plain text, a cue source proposes alternatives for words it recognises. The user can cycle through them with a keyboard input (or any runtime-defined trigger). This document specifies the `CUE.md` file format and what a conformant runtime MUST do with one.

---

## The format

A cue is a folder at `<root>/cues/<name>/` containing a `CUE.md` entry file plus optional bundled resources (`scripts/`, `references/`, `assets/`). The folder name is the source id.

Every cue is folder-shaped — there is no flat-file alternative. A source that ships nothing alongside its `CUE.md` still gets its own folder, so adding a helper later is a drop-in operation rather than a flat→folder migration. Uppercase entry filenames (`CUE.md`, `BLANK.md`) follow the same convention as `OPENCUES.md`, `CLAUDE.md`, `README.md`.

### Anatomy

```
<root>/cues/<name>/
├── CUE.md                    (required)
│   ├── YAML frontmatter      (required)
│   │   ├── name              (required)
│   │   ├── match | keywords  (one required — the trigger)
│   │   ├── description       (recommended)
│   │   └── priority, parser, model, …  (optional)
│   └── Markdown body         (required — at least one mode)
│       ├── ```json``` block  (Mode 1: static — in-file alternatives)
│       └── prompt text       (Mode 2: LLM — model generates alternatives)
│
└── scripts/, references/, assets/   (optional bundled resources — see core.md)
```


---

## Trigger model

Cues fire on **deterministic structural matching**, not on LLM judgement. This is the load-bearing distinction from [SKILL.md](https://github.com/anthropics/skills): a SKILL.md `description` is read by the LLM to decide whether to invoke. A `CUE.md` source fires when its `match:` regex or `keywords:` list literally matches a word the user typed.

The `description:` field in `CUE.md` is documentation only — used by `opencues list`, validators, and human readers. It does NOT control invocation.

---

## Configuration spec

### Frontmatter (required)

| Field | Type | Notes |
|---|---|---|
| `name` | string | Unique identifier for this source. |

A source MUST also declare **at least one** trigger field:

| Field | Type | Notes |
|---|---|---|
| `match` | regex (string, ECMA syntax) | Word matches if regex matches. Case-insensitive by default. |
| `keywords` | comma-separated list **or** YAML list | Word matches if it (case-insensitively) equals any keyword. |

A source with neither `match` nor `keywords` is unreachable. Validators MUST error.

### Frontmatter (recommended)

| Field | Type | Notes |
|---|---|---|
| `description` | string | Human-readable summary. Used by `opencues list` and validators. NOT a trigger. Validators SHOULD warn when absent. |

### Frontmatter (optional)

| Field | Type | Default | Notes |
|---|---|---|---|
| `priority` | number | `50` | Higher wins on routing ties. Range 0–100 by convention. |
| `parser` | `"alternatives"` \| `"raw"` | `"alternatives"` | LLM response shape. See § Wire format. |
| `provider` | string | runtime default | Override the LLM provider for this source (e.g. `groq`, `openrouter`, `gemini`, `openai`, `anthropic`, `cerebras`). The set of recognised provider IDs is runtime-specific; runtimes that don't recognise the value MAY skip the source (`provider-unsupported` warn) or fall through to their default. Provider and `model:` are paired — when only one is set, the other defaults to the resolved provider's built-in default. |
| `model` | string | provider default | Override the model for this source. When `provider:` is also set on the same tier, this MUST be a model the resolved provider serves. |
| `endpoint` | string | provider default | Override the HTTP endpoint URL. Rare — only useful when pointing at a self-hosted gateway speaking the resolved provider's wire shape. |
| `enabled` | boolean | `true` | `false` = source is disabled, kept on disk for documentation. |
| `scope` | `"words"` \| `"blanks"` \| `"sentence"` \| `"all"` | inferred from path | Where this source applies. `words` (default for `cues/`) — per-word triggers via `match:` / `keywords:`. `blanks` (default for `blanks/`) — `_`-triggered. `sentence` — whole-sentence rewrites; needs neither `match:` nor `keywords:` and is gated by the runtime's `sentence-cues-mode` toggle (off by default). `all` — any of the above. Explicit only when overriding the path-inferred default. |
| `classify` | string | none | Free-text classification hint surfaced to the LLM and validators (e.g. "Legal terminology, contract drafting"). |
| `on-host` | list | auto-detected | Allow-list: which hosts may load this source. See `core.md`. |
| `not-on-host` | list | none | Deny-list, applied after `on-host`. |
| `type` | string | inferred from path | Discriminator. `cues/` paths default to a cue source; explicit `type:` is rarely needed. |
| `spec` | string | `"opencues/0.1-alpha"` | Spec version this file targets. Files that omit `spec:` MUST be treated as `opencues/0.1-alpha`. Runtimes MUST refuse files declaring a newer `spec:` than they support. |

### Body — required, at least one of two modes

A cue source MUST declare a **behavior**. Trigger-only files (frontmatter, no body) are invalid; validators MUST error.

A single `CUE.md` MAY use Mode 1, Mode 2, or **both combined**. In combined mode, matched words served by the static JSON block skip the LLM call; matched words NOT in the static block fall through to the prompt-body LLM call. Useful when a domain has a small set of curated overrides plus a long tail handled by the model — see § Examples for a worked example.

#### Mode 1 — Static (in-file data)

The body contains a fenced ` ```json ` code block holding an array of tip groups:

```json
[
  {
    "id": "<group-id>",
    "words": {
      "<word>": {
        "tip": "<display tip>",
        "alts": ["<alt1>", "<alt2>"],
        "speak": false
      }
    }
  }
]
```

Per-word fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `tip` | string | yes | Short hint a runtime MAY display alongside the cycling. |
| `alts` | string[] | yes | Cycling alternatives. The original word is **not** included here; runtimes prepend it as `alternatives[0]` (see § Alternatives invariant). |
| `speak` | boolean | no | Per-word TTS hint. Runtimes that support TTS MAY honor it; the standard does not require TTS. |

Or, equivalently, a `groups` shape for sets of synonyms sharing one tip:

```json
[
  {
    "id": "<group-id>",
    "groups": [
      {
        "synonyms": ["<word1>", "<word2>"],
        "tip": "<shared tip>",
        "alts": ["<alt1>", "<alt2>"]
      }
    ]
  }
]
```

No LLM call is made for static-mode sources. Lookups are O(1) hash-map matches.

#### Mode 2 — LLM (prompt body)

The body is plain Markdown describing what alternatives the LLM should propose. The runtime appends the wire-format instruction (see below) and sends the user's text + matched indices to the model.

A source MAY include both a JSON tip-group block AND prompt text — runtimes MUST prefer the static block for matched words and fall back to LLM for unmatched ones in the same source. Use this when a source has a small set of curated overrides plus a long tail handled by the LLM:

```markdown
---
name: legal
description: Legal terminology
match: contract|agreement|clause|herein|whereas
---

\`\`\`json
[{
  "id": "legal-overrides",
  "words": {
    "herein": { "tip": "Avoid; replace with explicit reference", "alts": ["in this agreement", "above", "hereunder"] }
  }
}]
\`\`\`

For other matched terms, suggest 3 alternatives that preserve legal meaning.
Format: INDEX:alt1,alt2,alt3
```

`herein` is served by the static block (no LLM call); other matches like `contract` fall through to the prompt body.

---

## Runtime contract

### Alternatives invariant

For plain-word cues, `CueResult.alternatives[0]` is the **original word** as it appears in the user's text; `alternatives[1..n]` are the proposed substitutions. This lets runtimes implement "back to original" by cycling to index 0 without a special case.

```
text:           "the contract was signed"
matched word:   contract  (wordIndex 1)
alternatives:   ["contract", "agreement", "deal", "covenant"]
                 ^^^^^^^^^^  original at [0]
```

For `_`-blank cues, `alternatives[0]` is the first proposed value; the underscore is not a word that meaningfully cycles back to.

### Output shape — `CueResult`

A cue source produces zero or more `CueResult` objects per matched word.

**Required fields:**

| Field | Type | Notes |
|---|---|---|
| `wordIndex` | number | Position of the word in the input text (0-based). |
| `word` | string | The matched word as it appears. |
| `alternatives` | string[] | Element 0 is the original word; elements 1..n are proposed alternatives. |
| `priority` | number | Inherited from source frontmatter. |
| `source` | string | The source's `name`. |

**Optional fields:**

| Field | Type | Notes |
|---|---|---|
| `cueTip` | string | Display hint shown alongside the cycling. |
| `altCueTips` | `Record<string, string>` | Per-alternative override tips. |
| `spanStart`, `spanEnd` | number | Character span (multi-word alternatives). |
| `metadata` | object | Source-defined; runtimes MAY ignore. |

### LLM wire format (`parser: alternatives`)

A conformant LLM-mode source MUST instruct the model to emit one cycling group per line:

```
INDEX:alt1,alt2,alt3
INDEX:alt1,alt2
```

`INDEX` is the integer word index; `alt1,alt2,...` is a comma-separated list. Whitespace around commas and after the colon is trimmed. The runtime regex is `(\d+)\s*[:=]\s*([^|\n]+)` — `=` is accepted as a colon synonym. Numeric-only words (`/^-?\d+(\.\d+)?$/`) MUST be skipped by the parser.

For the `raw` parser, the response is opaque to the runtime; sources using `raw` MUST also declare a `metadata` schema documenting how the response is consumed.

### What a runtime MUST do

- Display `alternatives[currentIndex]` as the visible substitution for the matched word.
- Cycle through `alternatives` on a runtime-defined cycling input.
- Update visible text and cursor on each cycle.
- Resolve routing: each word goes to **exactly one source**. See `core.md` § Routing.
- Resolve priority ties: higher `priority` wins; equal-priority sources merge in source declaration order.

### What a runtime SHOULD do

- Reject cue sources that declare neither `match:` nor `keywords:` (`cue-missing-trigger` error). Catch-all behaviour is expressed as `match: .*` plus a low `priority:`, not via field absence — see `core.md` § Routing.
- Emit telemetry compatible with `opencues list` / `opencues validate`.

### What a runtime MAY do

- Display `cueTip` in a secondary surface (status line, tooltip, side pane).
- Implement multi-word spans (`spanStart`/`spanEnd`).
- Honor per-word `speak: true` hints to read alternatives via TTS. TTS itself is non-standard (see [`@opencues/runtime`'s `SPEC.md`](../packages/opencues-runtime/SPEC.md)); the `speak` field is reserved here only so static-mode authors have a portable place to declare the intent.
- Cache LLM responses.

---

## Conformance

A `CUE.md` file is **valid** iff:

1. Frontmatter has `name` (string).
2. At least one of `match:` (string parseable as regex) or `keywords:` (list) is present.
3. Body declares at least one behavior: a parsable JSON tip-group block, OR non-empty prompt text outside any code block.
4. If `on-host` / `not-on-host` are present, every host name is from the known set declared in `core.md`.

A runtime is **conformant** iff it satisfies every MUST in § Runtime contract.

For the consolidated linting matrix (severity, rule names, what each rule checks), see [`core.md` § Linting rules](./core.md#linting-rules). Cue-specific rules: missing `description` (warn), zero or multiple defaults at the same priority (warn), `on-host` contradicting an auto-detected host (warn) — these three are spec text without a reference-runtime implementation yet; see `core.md`'s tracked-gap list.

---

## Examples

### Minimal LLM-mode source

`cues/legal/CUE.md`:

```markdown
---
name: legal
description: Legal terminology — contract drafting, statutory definitions, compliance language
match: contract|agreement|clause|indemnify|warrant|liability|shall
priority: 70
---

Suggest 3 alternatives for each highlighted legal term that preserve
legal meaning. Prefer standard contract-drafting terminology.

Format: INDEX:alt1,alt2,alt3
```

### Minimal static-mode source

`cues/extended-thinking/CUE.md`:

```markdown
---
name: extended-thinking
description: Extended thinking shortcuts — ultrathink, Tab, deep thinking
keywords: ultrathink, Tab, deep thinking, think harder
priority: 60
---

\`\`\`json
[
  {
    "id": "extended-thinking",
    "words": {
      "ultrathink": {
        "tip": "Add ultrathink to prompt for max reasoning",
        "alts": ["Tab", "deep thinking", "think harder"],
        "speak": true
      }
    }
  }
]
\`\`\`
```

### Full source with all optional fields

```markdown
---
name: medical
description: Clinical terminology with synonym support
match: \b(diagnos|prognos|sympt|patho)\w+\b
keywords: patient, clinical, diagnosis
priority: 75
parser: alternatives
model: claude-haiku-4-5
enabled: true
on-host: [chrome, claude-code, gemini-cli, opencode]
spec: opencues/0.1-alpha
---

Propose two clinical-vocabulary alternatives per matched term.
Format: INDEX:alt1,alt2
```

---

## Author self-test — validating a `match:` regex

A cue source's `match:` is the only thing standing between "fires correctly" and "fires on every plain word the user types." Before shipping a source, walk through this checklist:

1. **Write 5–10 realistic text snippets** the source SHOULD fire on (true positives). Verify the regex matches.
2. **Write 5–10 snippets it should NOT fire on** (true negatives — common words, unrelated jargon). Verify no match.
3. **Write 2–3 ambiguous edge cases.** A word like "shall" might be legal jargon OR everyday English; decide which side this source claims.
4. **Inspect declared triggers with `opencues list --cues`** (or equivalent) to see every source's `match:`/`keywords:`/`priority:` side by side, then reason through which one wins on a sample paragraph. The reference CLI does not ship a live match-tester flag today — a runtime MAY add one (e.g. `--match-test "<text>"`) as a nice-to-have; until then, this is a manual regex-tracing step.
5. **Check for unintended substring matches.** `match: state` will fire on "statement," "estate," "statistics." If you mean the word, anchor with `\b`.

Resist the urge to write a regex that catches everything. A narrow, accurate `match:` plus a DEFAULT source for the long tail is almost always better than one over-greedy regex.

---

## In scope

- The `CUE.md` file format and frontmatter schema.
- The `CueResult` runtime output shape.
- The LLM `alternatives` parser wire format.
- Routing rules (per-word dispatch, priority resolution, catch-all idiom — detailed in `core.md`).

## Out of scope

- How alternatives render (ANSI, CSS, popups — runtime decides).
- Which keys cycle (Up/Down, Tab, voice — runtime decides).
- Cursor movement during cycling.
- Span / cycling state machines (an OpenCues-runtime implementation detail).
- Prompt content for LLM-mode sources beyond requiring the wire format.

---

## Relationship to OpenCues runtime

The OpenCues runtime ([`@opencues/runtime`'s `SPEC.md`](../packages/opencues-runtime/SPEC.md)) implements this spec plus its own non-standard knobs (TTS voice, debug logging, cursor navigation). Other runtimes that read this spec are not required to implement those knobs.

If a runtime-specific field proves universally useful, it can be promoted to this spec in a future version. See `core.md` § Promotion path.
