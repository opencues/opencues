# Routing conformance fixtures

Per [`../../core.md` § Routing](../../core.md#routing--which-source-handles-a-word), every matched word routes to **exactly one** source. These fixtures pin the resolution algorithm.

## Fixture shape

Fixtures ship as JSON (no YAML parser dependency required). Cue-routing scenarios:

```json
{
  "description": "Two sources, domain wins over default",
  "sources": [
    { "name": "legal",    "priority": 70, "match": "contract|clause" },
    { "name": "catchall", "priority": 10, "match": ".*" }
  ],
  "expectations": [
    { "word": "contract", "routesTo": "legal" },
    { "word": "hello",    "routesTo": "catchall" },
    { "word": "clause",   "routesTo": "legal" }
  ]
}
```

- `description` — pins what property this scenario tests.
- `sources` — the cue sources in scope. Frontmatter-equivalent — body is irrelevant for routing decisions.
- `expectations` — array of `{ word, routesTo }` pairs. For each, the runtime's router MUST return the source named in `routesTo`.

Blank-routing scenarios use a different shape:

```json
{
  "description": "Blank shapes route the sentence containing _ (keywords desugar to shapes)",
  "blanks": [
    { "name": "volume",  "blankKeywords": ["volume"] },
    { "name": "weather", "blankKeywords": ["weather"] }
  ],
  "expectations": [
    { "text": "volume _",           "routesTo": "volume"  },
    { "text": "weather paris _",    "routesTo": "weather" },
    { "text": "the volume was loud _", "routesTo": null   }
  ]
}
```

`routesTo: null` means no blank claims the slot.

## Files

| File | Pins |
|---|---|
| [`per-word-dispatch.json`](./per-word-dispatch.json) | Each word goes to exactly one source — the highest priority match. |
| [`priority-tiebreak.json`](./priority-tiebreak.json) | Equal-priority sources fall back to declaration order. |
| [`catch-all-fallback.json`](./catch-all-fallback.json) | DEFAULT source claims words no DOMAIN source matched. |
| [`blank-shapes.json`](./blank-shapes.json) | `blankShapes` (or synthesized keyword shapes) route the sentence containing `_`; a command must lead its sentence (terminator/newline boundary). |

## What's covered

- Single-source dispatch
- Multi-source priority resolution
- DOMAIN vs DEFAULT (catch-all) semantics
- Declaration-order tiebreak on equal priority
- Blank-shape sentence-scoped dispatch (command leads its sentence — terminator or newline boundary; mid-sentence keyword mention does not fire)

## What's not covered (deliberately)

- **`linked:` cross-word coordination** — runtime concern (how a host cycles linked alts together); the standard only specifies the field shape.
- **Span overlap resolution** — when two multi-word spans overlap, the runtime decides. Out of routing scope.
- **Sentence-cue overlap with word-cues** — covered by `sentence-cues.md` architecture doc, not the routing algorithm per se.
- **Auditor composition** — auditors don't route per word; they fire on the whole buffer. See [`../../auditor-spec.md` § Composition](../../auditor-spec.md#composition).
