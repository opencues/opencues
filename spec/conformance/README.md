# Conformance suite — opencues/0.8-alpha

A corpus of fixtures any conformant OpenCues implementation can exercise against. This suite is the bridge between "I read [`../cue-spec.md`](../cue-spec.md)" and "the parser actually matches the standard". Used today by `@opencues/core` as its parser regression net (adding a fixture this week caught one drift); designed so a future second runtime could exercise the same fixtures.

The suite is **a fixture tree, not a runner** — files describing what conformant behaviour looks like; each consumer wires its own runner. The reference implementation ships one under [`packages/opencues-core/src/conformance.test.ts`](../../packages/opencues-core/src/conformance.test.ts) (the everyday user of these fixtures today). A future second-runtime author would follow the same template at [§ Runner template](#runner-template) below.

## What's here

```
conformance/
├── README.md                       ← you are here
│
├── valid/                          ← MUST be accepted by any conformant runtime
│   ├── cue/<name>.md               ← valid CUE.md examples
│   ├── blank/<name>.md             ← valid BLANK.md examples
│   ├── auditor/<name>.md           ← valid AUDITOR.md examples
│   ├── kata/<name>.md              ← valid KATA.md examples (0.5-alpha)
│   ├── identity/<name>.md          ← valid IDENTITY.md examples (0.2-alpha)
│   └── masters/<MASTER>.md         ← valid CUES.md / BLANKS.md / AUDITORS.md / OPENCUES.md
│
├── invalid/                        ← MUST be rejected by any conformant runtime
│   ├── cue/<name>.md               ← invalid CUE.md examples
│   ├── cue/<name>.expected.json    ← which linter rule MUST fire
│   ├── blank/<name>.md             ← invalid BLANK.md examples
│   ├── blank/<name>.expected.json
│   ├── auditor/<name>.md
│   ├── auditor/<name>.expected.json
│   ├── kata/<name>.md              ← invalid KATA.md examples (0.5-alpha)
│   ├── kata/<name>.expected.json
│   ├── identity/<name>.md          ← invalid IDENTITY.md examples (0.2-alpha)
│   └── identity/<name>.expected.json
│
├── wire/
│   ├── README.md
│   └── parser-alternatives.json    ← LLM wire-format inputs + expected parse output
│
└── routing/
    ├── README.md
    ├── per-word-dispatch.json
    ├── priority-tiebreak.json
    ├── catch-all-fallback.json
    └── blank-shapes.json
```

## How to use the suite

### As the reference runtime (current primary user)

The suite is `@opencues/core`'s regression net. The runner at [`packages/opencues-core/src/conformance.test.ts`](../../packages/opencues-core/src/conformance.test.ts) loads every fixture and asserts the reference parsers + wire-format handler + routing algorithm agree with what the spec describes.

Run it: `cd packages/opencues-core && npx vitest run src/conformance.test.ts`. 70 tests pass; a few `.todo` markers name linter rule codes the parser doesn't emit yet (visible-by-design gaps for a follow-up parser-side change). KATA.md and IDENTITY.md fixtures add their own runners — kata from `@opencues/runtime`'s `kata.test.ts`, identity from this same core runner.

This is the everyday value of the suite today — every parser change runs against the fixture tree before merge.

### As an implementer building a second runtime (not yet — forward-looking)

No second implementation of OpenCues exists today. The spec is designed so one could ship (a non-JS port, an alternative implementation); the conformance suite is the contract such a runtime would target. If you're considering it:

1. **Parse every `valid/**/*.md`** with your runtime's loader. Each one MUST be accepted. If your parser rejects a valid fixture, that's a conformance bug.
2. **Parse every `invalid/**/*.md`** with your runtime's loader. Each one MUST be rejected, and the rejection MUST raise the rule code declared in the sibling `<name>.expected.json` file. (A rejection with a different rule code is allowed but suggests your loader's diagnostics drift from the standard's vocabulary.)
3. **Run every `wire/parser-alternatives.json` case** through your LLM-response parser. The structured output MUST equal `expected`.
4. **Run every `routing/*.json` scenario** through your router. For each scenario, the listed words MUST route to the listed sources in the order shown.

You MAY skip:
- LLM-mode cue fixtures if your runtime is static-only.
- `blankScript:` fixtures if your runtime is browser-only (host-compat auto-detects).
- Auditor fixtures if your runtime doesn't implement the auditor surface.

A runtime that skips a surface is still **conformant for the surfaces it implements** — there's no "you must implement everything" rule. The suite labels each section so implementers know what's scoped to which surface.

### As a contributor to OpenCues

Adding a feature that changes the spec? You update the suite:

- New frontmatter field accepted? Add a fixture to `valid/`.
- New rejection rule? Add a fixture to `invalid/` + a sibling `.expected.json`.
- New wire-format extension? Add cases to `wire/parser-alternatives.json`.

PRs that change `spec/*.md` without touching `spec/conformance/` get flagged in review. The suite is the executable contract.

## Fixture format

### `valid/**/*.md`

Just the file. If your runtime accepts it, you pass. No expectation metadata needed — the rule is "accept".

**Note on `type: blank` discriminator** — `valid/blank/*.md` fixtures explicitly declare `type: blank` in their frontmatter, even though the spec says `type` is "rarely needed" (production runtimes typically infer it from folder layout — files under `blanks/` are blanks). Including the explicit discriminator makes the fixtures parser-portable: any conformance runner that loads fixtures by content alone (without preserving the `valid/blank/` path hint) can still tell what surface the file is. Implementers MAY treat path-inferred `type` and explicit `type:` as equivalent.

### `invalid/**/*.md` + sibling `.expected.json`

```json
{
  "rule": "cue-missing-trigger",
  "severity": "error",
  "summary": "Source declares neither match: nor keywords: — unreachable"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `rule` | string | yes | The linter rule from [`core.md` § Linting rules](../core.md#linting-rules) that this fixture MUST trigger. |
| `severity` | `"error"` \| `"warn"` | yes | Whether the rule blocks load (`error`) or allows load with a warning (`warn`). Conformant runtimes treat `error` rules as load-blocking. |
| `summary` | string | yes | Human-readable description of what makes the fixture invalid. |

A runtime that rejects with a different rule code is allowed (the rejection itself is correct), but vocabulary drift is worth flagging in your own conformance run.

### `wire/parser-alternatives.json`

```json
[
  {
    "description": "single line, one word, two alts",
    "input": "0:lawyer,attorney",
    "expected": [
      { "wordIndex": 0, "alts": ["lawyer", "attorney"] }
    ]
  }
]
```

The `expected` array is the structured output your parser MUST produce. The original word (`alternatives[0]` per [`cue-spec.md` § Alternatives invariant](../cue-spec.md#alternatives-invariant)) is added by the runtime at substitution time and is NOT part of the wire format itself — these fixtures cover the parser only.

### `routing/*.json`

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

(JSON rather than YAML so the runner needs no parser dependency. Implementers who prefer YAML can translate; this shape is intentionally minimal.)

The `sources` list declares the cue sources in scope (frontmatter-equivalent — the body doesn't matter for routing). The `expectations` list pairs an input word with the source `name:` that MUST claim it.

## Kata fixtures

New in `0.5-alpha` ([`../kata-spec.md`](../kata-spec.md)). The `KATA.md`
surface is a **format** contract — a conformant parser MUST accept every
`valid/kata/*.md` (parse to a usable kata with ≥1 step) and reject every
`invalid/kata/*.md` (treat as absent), raising the rule named in the
sibling `.expected.json`.

Unlike cue/blank/auditor fixtures, the KATA.md parser lives in
`@opencues/runtime` (`parseKataMd`), not `@opencues/core` — so the
reference runner for this surface is
[`packages/opencues-runtime/src/modules/kata.test.ts`](../../packages/opencues-runtime/src/modules/kata.test.ts)
§ "spec conformance — KATA.md fixtures", which discovers this tree
structurally. A second runtime exercises them the same way: accept
`valid/`, reject `invalid/`.

Rule codes used by the invalid fixtures:

| Rule | Meaning |
|---|---|
| `kata-no-steps` | The file declares no `## ` step section. A kata with zero steps is not usable and MUST be treated as absent. |

The `.cues/katas/` surface is discovered per the normal search path, so
kata fixtures are format-only — there is no kata routing or wire-format
contract (the coaching runtime is reference-impl, not standard; see
`kata-spec.md` § Out of scope).

## Out of scope for this suite

- **Cycling behaviour** — what happens after cycle Up/Down on a substituted alt. Cycling is OpenCues-runtime-specific; the standard only specifies the alternatives invariant.
- **Render directives** — ANSI dim, inverse, CSS Custom Highlight. Each integration owns rendering.
- **Hot-reload cadence** — `core.md` says SHOULD detect changes; the standard doesn't specify polling intervals.
- **LLM provider routing** — each runtime picks providers however it wants.
- **Performance** — no latency, throughput, or memory bounds are part of conformance.

## Versioning

The suite versions with the spec. A fixture MAY pin its target version in frontmatter:

```yaml
spec: opencues/0.1-alpha
```

…but in practice almost all fixtures omit it (see below). The versioning *model* is a per-version fork: when the spec bumps, `conformance/<old>/` and `conformance/<new>/` would coexist for one minor cycle so an implementer pinned to the old version keeps its fixtures. **In practice that fork has never been cut** — the suite grows in place as a single flat tree. Fixtures omit `spec:` and are read at the omit-default (`opencues/0.1-alpha`); surfaces added by later minors (kata at `0.5`, identity's dehydration at `0.6`) are additive and don't invalidate an older reader's fixtures, so the flat tree has held.

**Status (`0.8-alpha`, July 2026).** The spec has moved `0.1 → 0.7`
(IDENTITY.md + `as-context:` / `contextTtl:` at `0.2`, Kata at `0.5`,
bidirectional identity-context dehydration at `0.6`, removal of the
never-implemented `CueResult.linked` field at `0.7`). The suite tracks
it in place. Surfaces now covered: cue / blank / auditor / masters /
wire / routing (in `@opencues/core`'s runner), KATA.md (driven from
`@opencues/runtime`'s `kata.test.ts` — `parseKataMd` lives there), and
**IDENTITY.md** (`valid/identity/` + `invalid/identity/`, driven from
`@opencues/core`'s `conformance.test.ts`: valid files MUST parse and
derive well-formed tokens; invalid files replay their frontmatter
through `validateSentinelWrite` and MUST be refused with the expected
error code — `invalid-key` / `value-too-long` / `collision` /
`capacity-exceeded`). **Remaining coverage gap:**

- `post-processor/` — LLM-output → post-processed-output pairs for
  verbatim resolve, unknown-strip, originalBody preserve, tolerant
  matching.
- `valid/blank/` — at least one fixture exercising
  `as-context: safe` with a derived `[BLANK NAME]` token.
- `routing/` — mode-gate composition (the rule that
  `blank-context-mode: raw` MUST downgrade to `safe` when
  `identity-context-mode` is NOT `raw`).
- `dehydration/` (`0.6-alpha` surface) — buffer-text → dehydrated-text
  pairs pinning the matching floor (case-insensitive, word-boundary,
  longest-value-first, CJK adjacency) + round-trip pairs pinning the
  hydrate-restores-original invariant and the both-present
  preserve-wins precedence. See `identity-context-spec.md`
  § Dehydration.

A second implementation targeting `0.8-alpha` should treat
the spec text in `identity-context-spec.md` and `blank-spec.md`
§ Sentinel aspects as authoritative until these remaining fixtures land.
(The reference implementation's executable equivalents:
`packages/opencues-core/src/dehydrate.test.ts` +
`sources/dehydration-outbound.test.ts`.)

## Runner template

A complete conformance runner is ~80 lines in TypeScript. Pseudo-shape:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = './spec/conformance';

// 1. Valid fixtures — all MUST be accepted
for (const surface of ['cue', 'blank', 'auditor']) {
  for (const file of readdirSync(join(root, 'valid', surface))) {
    const content = readFileSync(join(root, 'valid', surface, file), 'utf8');
    const result = myRuntime.parse(content);
    assert(result.ok, `${file} MUST be accepted`);
  }
}

// 2. Invalid fixtures — all MUST be rejected with the expected rule code
for (const surface of ['cue', 'blank', 'auditor']) {
  for (const file of readdirSync(join(root, 'invalid', surface))) {
    if (!file.endsWith('.md')) continue;
    const content = readFileSync(join(root, 'invalid', surface, file), 'utf8');
    const expected = JSON.parse(
      readFileSync(join(root, 'invalid', surface, file.replace('.md', '.expected.json')), 'utf8')
    );
    const result = myRuntime.parse(content);
    assert(!result.ok, `${file} MUST be rejected`);
    assert(result.rule === expected.rule, `${file} expected ${expected.rule}, got ${result.rule}`);
  }
}

// 3. Wire format fixtures — parser output MUST equal expected
const wireCases = JSON.parse(readFileSync(join(root, 'wire/parser-alternatives.json'), 'utf8'));
for (const { description, input, expected } of wireCases) {
  const actual = myRuntime.parseLLMResponse(input);
  assert.deepEqual(actual, expected, description);
}

// 4. Routing scenarios — each word MUST route to the named source
for (const file of readdirSync(join(root, 'routing'))) {
  if (!file.endsWith('.json')) continue;
  const scenario = JSON.parse(readFileSync(join(root, 'routing', file), 'utf8'));
  for (const { word, routesTo } of scenario.expectations) {
    const actual = myRuntime.route(scenario.sources, word);
    assert.equal(actual?.name, routesTo, `${file}: '${word}' MUST route to '${routesTo}'`);
  }
}
```

Wrap with whatever test framework you use. The reference implementation's runner lives at [`packages/opencues-core/src/conformance.test.ts`](../../packages/opencues-core/src/conformance.test.ts) — uses vitest, ~280 lines, exactly the pattern above plus a hand-rolled routing algorithm (since `@opencues/core` doesn't ship a router — that lives in `@opencues/runtime`).

## Status

The 0.8-alpha suite is **seed**, not exhaustive. Coverage:

| Area | Fixtures | Notes |
|---|---|---|
| Valid CUE.md | 5 | Static, LLM, combined, full-frontmatter, groups-synonyms |
| Valid BLANK.md | 5 | stepValues, blankScript, impl, full-frontmatter, selector-satellite |
| Valid AUDITOR.md | 2 | Minimal, full-frontmatter |
| Valid KATA.md | 2 | Full-frontmatter, minimal (no frontmatter) |
| Valid IDENTITY.md | 2 | Minimal single-field, typical multi-field (camelCase / snake_case / kebab-case token derivation) |
| Valid masters | 4 | CUES.md, BLANKS.md, AUDITORS.md, OPENCUES.md |
| Invalid CUE.md | 5 | Missing name, missing trigger, empty body, unknown host, spec-too-new |
| Invalid BLANK.md | 5 | Missing name, missing keywords, no binding, multiple bindings, script missing |
| Invalid AUDITOR.md | 2 | Missing name, empty body |
| Invalid KATA.md | 1 | No steps |
| Invalid IDENTITY.md | 4 | Bad key (invalid-key), oversize value (value-too-long), token collision, capacity overflow |
| Wire fixtures | 10 | Single/multi-line, whitespace tolerance, numeric skip, `=` synonym |
| Routing scenarios | 4 | Per-word dispatch, priority tiebreak, catch-all fallback, blank shapes |

Expand by appending fixtures — the runner discovers files structurally, no central registry to update.

## Contributing fixtures

Each new fixture:

1. Pick the right directory (`valid/<surface>/`, `invalid/<surface>/`, `wire/`, `routing/`).
2. Name it after the property it pins (`blank-readonly-with-set.md` is better than `case47.md`).
3. For invalid examples, add the sibling `.expected.json` with the linter rule code from [`core.md` § Linting rules](../core.md#linting-rules).
4. If the fixture exercises a new rule code, update `core.md` § Linting rules first.

PRs land in `spec/conformance/` separate from spec narrative changes. Reviewer is whoever maintains the spec.
