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
  "description": "Blank proximity controls keyword↔_ distance",
  "blanks": [
    { "name": "volume",  "blankKeywords": ["volume"],  "blankProximity": 1 },
    { "name": "weather", "blankKeywords": ["weather"], "blankProximity": 3 }
  ],
  "expectations": [
    { "text": "volume _",           "routesTo": "volume"  },
    { "text": "weather in paris _", "routesTo": "weather" },
    { "text": "volume up loud _",   "routesTo": null      }
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
| [`blank-proximity.json`](./blank-proximity.json) | `blankProximity` controls keyword→`_` word distance. |

## What's covered

- Single-source dispatch
- Multi-source priority resolution
- DOMAIN vs DEFAULT (catch-all) semantics
- Declaration-order tiebreak on equal priority
- Blank-keyword exact-match dispatch
- `blankProximity` boundary cases (proximity=1, proximity=3, beyond proximity)

## What's not covered (deliberately)

- **`linked:` cross-word coordination** — runtime concern (how a host cycles linked alts together); the standard only specifies the field shape.
- **Span overlap resolution** — when two multi-word spans overlap, the runtime decides. Out of routing scope.
- **Sentence-cue overlap with word-cues** — covered by `sentence-cues.md` architecture doc, not the routing algorithm per se.
- **Auditor composition** — auditors don't route per word; they fire on the whole buffer. See [`../../auditor-spec.md` § Composition](../../auditor-spec.md#composition).
