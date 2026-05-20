# Wire-format conformance fixtures

The LLM-mode `alternatives` parser is normative — every conformant runtime MUST parse the wire format identically. This directory pins the parser's contract.

The wire format is specified in [`../../cue-spec.md` § LLM wire format](../../cue-spec.md#llm-wire-format-parser-alternatives):

> The runtime regex is `(\d+)\s*[:=]\s*([^|\n]+)` — `=` is accepted as a colon synonym. Numeric-only words (`/^-?\d+(\.\d+)?$/`) MUST be skipped by the parser.

## Files

- [`parser-alternatives.json`](./parser-alternatives.json) — covers the `parser: alternatives` shape (default for LLM-mode cues).

## Fixture shape

Each fixture is an array of cases. Each case is:

```json
{
  "description": "Human-readable name for the case",
  "input": "Raw LLM response text",
  "expected": [
    { "wordIndex": 0, "alts": ["alt1", "alt2", "alt3"] }
  ]
}
```

- `description` — what property this case pins. Used in test failure messages.
- `input` — the LLM response string as it would arrive from the model. May span multiple lines.
- `expected` — the parsed structure. An array of objects, each `{ wordIndex, alts }`.

The original word (`alternatives[0]` per the spec) is added by the runtime at substitution time and is NOT part of the wire format. These fixtures cover the parser only — `alts` in `expected` is the bare list of LLM-proposed alternatives.

## What's covered

| Case | Pins |
|---|---|
| `single line, one word, two alts` | Simplest possible response |
| `multi-line, one word per line` | Multiple words in one batched call |
| `whitespace around colon and commas` | Tolerance for whitespace |
| `equals sign as colon synonym` | The `=` synonym from the spec |
| `numeric-only alt rejected` | Numeric-only words MUST be skipped |
| `mixed numeric and word alts` | Numeric in middle position |
| `empty lines between groups` | Blank lines tolerated |
| `extra columns after pipe` | Pipe terminator from `[^|\n]+` regex |
| `index with leading zero` | Numeric parsing tolerance |
| `unicode and emoji in alts` | UTF-8 passthrough |

## What's not covered (deliberately)

- **`parser: raw`** — opaque to the runtime; per the spec, sources using `raw` MUST also declare a `metadata` schema documenting how the response is consumed. No universal parser contract to pin.
- **LLM-driven JSON-mode responses** — runtime-specific, not part of the standard.
- **Model error responses** (rate-limit JSON, billing failures) — handled by the LLM-client layer, not the cue parser.
