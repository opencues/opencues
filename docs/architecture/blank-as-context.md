# Blank as context — implementation plan (v1)

Production wiring spec for the feature documented in
`docs/features/blank-as-context.md`. Bench evidence + representation
choice live in
`tests/benchmarks/blank-sentinels-matrix/FINDINGS.md`.

## v1 scope (the minimum that ships)

A blank that opts in via frontmatter (`as-context: safe`) contributes
one or more **slot-keyed tokens** to fluid-blank's prompt catalog. Each
slot resolves by calling the existing `Blank.get(keyword)` method —
the same method the keyword-trigger path already uses.

Token shape: `[<BLANK_UPPER> <SLOT_UPPER>]` — two segments, e.g.:

```
[STOCK AAPL]    →  "AAPL: $245.12"
[WEATHER LONDON] →  "London: 13°C Partly cloudy"
[CRYPTO BTC]    →  "BTC: $68,401"
```

No new methods on blank impls. No structured field decomposition. The
existing `get()` output becomes the token value. **This keeps v1 to
zero changes in blank impls and reuses every existing test.**

## What v1 does NOT do (deferred to v2)

- **Multi-field decomposition.** `[WEATHER HOME TEMP]` /
  `[WEATHER HOME CONDITIONS]` (three segments, one slot → multiple
  fields). v2 adds an optional `getContextSnapshot(slot)` method that
  returns `Record<field, value>`. v1 emits one combined token per slot.
- **HTTP-blank rate-limit coordination.** Today each `Blank` already
  caches; the snapshot cache wraps that. v2 might add a coordinated
  budget across all context-eligible blanks.
- **Transform-blank context.** v1 fluid-blank only. Transform-blank
  wiring lands once we re-run the bench against transform-blank's
  longer-output prompts.
- **Word-cues / agent-rewrite.** Out of scope per FINDINGS finding #6 —
  per-word LLM batches × 30 context tokens is a cost cliff.
- **The `opencues blank-context list` CLI.** Useful but not blocking.
  Lands once the runtime side is in.

## Frontmatter additions to `BlankConfig`

Three new fields on the existing `BlankConfig` interface in
`packages/opencues-core/src/cues-md.ts`:

```yaml
# In a BLANK.md (e.g. defaults/blanks/stocks.md)
---
type: blank
blankKeywords: stocks
impl: StocksBlank

# new — opt into ambient context
as-context: safe              # off (default) | safe | raw
context-ttl: 60               # seconds; how long a snapshot stays cached
context-slots:                # explicit slots, OR bind to a sentinel
  - aapl
  - nvda
context-bind: portfolio       # alternative: sentinel field name
context-bind-split: ","       #   → fan-out on commas
split-values-in-token-names: ok  # required ack when context-bind-split is set
---
```

Resolution rules:
- If `context-slots` is set, those literal slot names are used.
- Else if `context-bind` is set, the sentinel field is read; if
  `context-bind-split` is set the value is split on the separator;
  each result becomes a slot.
- If neither is set, the blank contributes no context tokens (no error
  — just silent skip).
- `context-bind-split` without `split-values-in-token-names: ok` →
  the blank is dropped from the context block at parse time with one
  warning. Mirrors the bench design.

## New module: `@opencues/core/src/blank-context.ts`

Mirrors the shape of `sentinels.ts`. Exports:

```ts
export type BlankContextMode = 'off' | 'safe' | 'raw';

export interface BlankContextSlot {
  /** Token emitted into the prompt (e.g. `[STOCK AAPL]`). */
  token: string;
  /** Human-readable description for the LLM catalog. */
  description: string;
  /** Source blank name (e.g. `stocks`). */
  blankName: string;
  /** Slot/keyword passed into Blank.get(). */
  slot: string;
}

export interface BlankContextSnapshot {
  /** Resolved (token, value) pairs ready for the prompt + post-processor. */
  readonly fields: ReadonlyArray<{
    token: string;
    description: string;
    value: string;
  }>;
  /** Convenience lookup: token → value. */
  readonly catalog: ReadonlyMap<string, string>;
}

/** Derive a token from (blankName, slot). `stocks` × `aapl` → `[STOCK AAPL]`. */
export function deriveBlankContextToken(blankName: string, slot: string): string;

/** Plan which slots a blank contributes given its config + sentinels. */
export function planBlankContextSlots(
  config: BlankConfig,
  sentinels: Sentinels,
): BlankContextSlot[];

/** Render the catalog block to append to fluid-blank's system prompt. */
export function renderBlankContextCatalog(
  snapshot: BlankContextSnapshot,
  mode: BlankContextMode,
): string;
```

Token-naming convention pinned by FINDINGS as `safe-tokens`. Prompt
shape mirrors `renderSentinelsCatalog` so the LLM sees one unified
context block with no mode shift.

## New module: `@opencues/runtime/src/modules/blank-context-cache.ts`

In-memory snapshot store, lazy refresh:

```ts
export class BlankContextCache {
  /** Build a snapshot for the requested slots. Returns cached values
   *  per (blankName, slot) when within TTL; calls Blank.get() for
   *  stale entries. */
  async snapshot(
    plan: BlankContextSlot[],
    blanks: Map<string, Blank>,
    config: { ttlMs: number; capacity: number },
  ): Promise<BlankContextSnapshot>;
}
```

Behaviour:
- Lazy refresh — only fetches on prompt-build, never a background
  cron. Idle cost zero.
- Capacity cap of 32 tuples; oldest entries evicted first.
- Failed fetches emit a `[STALE]` marker rather than blocking — same
  fail-soft pattern existing blanks use (`AAPL: error`).

## Sentinel integration — one catalog, two sources

Today fluid-blank renders one `<context>` block via
`renderSentinelsCatalog`. v1 appends the blank-context block to the
same prompt section. From the LLM's view there's no distinction —
both kinds of tokens are "context I might use." The post-processor's
hallucination-strip already handles arbitrary token names, so the
existing `sentinels.postProcessSentinels` is reused with a **merged
catalog**:

```ts
const mergedCatalog = new Map([...sentinels.catalog, ...blankContext.catalog]);
const result = postProcessSentinels(output, { catalog: mergedCatalog, originalBody });
```

Single substitution pass, no new code path. The post-processor's
tolerant-match logic (handles `[STOCK_AAPL]` underscore drift,
`[stock aapl]` case drift) generalises to multi-segment names for
free.

## FEATURES registry entry

`packages/opencues-core/src/feature-registry.ts` gets one new entry:

```ts
{
  key: 'blank-context-mode',
  values: ['off', 'safe', 'raw'],
  default: 'off',
  exposeInMenu: true,
  description: 'How blanks expose ambient context to fluid-blank',
}
```

Auto-propagates to `doctor`, `chrome-host`, `seed-configs`. Typed
field added to `OpenCuesState` in `config-loader.ts` per the
"deliberate non-derivation" rule.

## Mode gate composition with sentinels

| `blank-context-mode` | `identity-context-mode` | Effect |
|---|---|---|
| `off` | any | Feature disabled |
| `safe` | `off` | Works — only resolved tokens flow; binding field read locally |
| `safe` | `safe` / `raw` | Works — both catalogs merged in the same `<context>` block |
| `raw` | `raw` | Works — values inlined in the catalog |
| `raw` | `off` / `safe` | Reject at config-load; warn user. Inconsistent — raw blank values exposed while sentinel values are not |

## Wire points (concrete file list)

| File | Change |
|---|---|
| `packages/opencues-core/src/cues-md.ts` | Add `asContext`, `contextTtl`, `contextSlots`, `contextBind`, `contextBindSplit`, `splitValuesInTokenNamesAck` to `BlankConfig` + parser |
| `packages/opencues-core/src/blank-context.ts` | **NEW** — types, `deriveBlankContextToken`, `planBlankContextSlots`, `renderBlankContextCatalog` |
| `packages/opencues-core/src/blank-context.test.ts` | **NEW** — parser, planner, renderer unit tests |
| `packages/opencues-core/src/feature-registry.ts` | Append `blank-context-mode` entry |
| `packages/opencues-core/src/sentinels.ts` | (no change — post-processor already handles arbitrary tokens) |
| `packages/opencues-core/src/sources/fluid-blank-source.ts` | Accept `blankContext?: BlankContextSnapshot` in source options; append `renderBlankContextCatalog(snapshot, mode)` to system prompt; pass merged catalog to `postProcessSentinels` |
| `packages/opencues-runtime/src/modules/config-loader.ts` | Add typed `blankContextMode: 'off'\|'safe'\|'raw'` field; parse the scalar |
| `packages/opencues-runtime/src/modules/blank-context-cache.ts` | **NEW** — snapshot cache |
| `packages/opencues-runtime/src/modules/blank-context-cache.test.ts` | **NEW** — TTL, cap, error behaviour |
| `packages/opencues-runtime/src/modules/resolver.ts` | At resolver init, plan slots once + create cache; on each fluid-blank call, snapshot + pass to source |
| `packages/opencues-runtime/src/blank-context-integration.test.ts` | **NEW** — end-to-end with mocked LLM |

## Per-blank audit (within current shipping blanks)

| Blank | v1 behaviour | What slot names mean |
|---|---|---|
| **stocks** | `as-context: safe`, `context-bind: portfolio` (split `,`) | Each ticker is a slot — `[STOCK AAPL]` etc. |
| **crypto** | `as-context: safe`, `context-bind: watchlist` (split `,`) | Each symbol — `[CRYPTO BTC]` |
| **weather** | `as-context: safe`, `context-bind: home_city` | One slot per bound city — `[WEATHER LONDON]` |
| **countries** | `as-context: safe`, `context-bind: countries` (split `,`) | Each country — `[COUNTRIES UK]` |
| **dictionary** | `as-context: off` | Words a user looks up don't have a stable ambient set; would surveil typing history |
| **hackernews** | `as-context: safe`, `context-slots: [top]` | Single fixed slot — `[HACKERNEWS TOP]` |
| **affirmations** | `as-context: safe`, `context-slots: [today]` | `[AFFIRMATIONS TODAY]` |
| **opencues-settings** | `as-context: off` | Settings values feeding back into prompts is a loop hazard |
| **prompt-improver** | `as-context: off` | Not a data source |
| **answer** | `as-context: off` | Not a data source |
| **volume / brightness / claude-status / sentinel** | `as-context: off` | Action / system-state blanks; context not useful |

Default frontmatter additions land in `defaults/blanks/*.md` so a
fresh `opencues seed-configs` user inherits the safe defaults. Users
who don't flip the scalar see zero behaviour change.

## Test plan

Five layers, each pinning a contract the next layer depends on:

1. **Parser unit tests** — `blank-context.test.ts`. Every frontmatter
   field, every validation rule (split without ack → dropped, missing
   sentinel binding → silent skip, both `context-slots` and
   `context-bind` set → error).
2. **Planner unit tests** — `planBlankContextSlots` given a config +
   sentinels produces the expected slot list. Cover scalar bind,
   split bind, explicit slots, off.
3. **Renderer unit tests** — `renderBlankContextCatalog` produces the
   expected prompt block in safe + raw modes.
4. **Cache unit tests** — TTL respected, cap enforced, fetch errors
   surface as `[STALE]` markers, repeated calls within TTL don't
   re-fetch.
5. **End-to-end integration test** — `blank-context-integration.test.ts`.
   Load a sentinels file + a blank with `as-context: safe`, mock the
   LLM to emit the expected token, verify substitution in the final
   output. Verifies the merged-catalog plumbing works end-to-end.

Plus the matrix bench is the upstream regression gate; future prompt
edits MUST re-run it.

## Open follow-ups (post-v1)

- v2 `getContextSnapshot(slot) → Record<field, value>` for multi-field
  decomposition (`[WEATHER LONDON TEMP]` + `[WEATHER LONDON CONDITIONS]`).
- Transform-blank wiring once the bench is extended.
- `opencues blank-context list` CLI for user visibility.
- Snapshot persistence across restarts (today it's process-memory only).
- Per-pack `requires-blank-context: [...]` declaration so packs can
  opt in to the catalog the same way they'll opt in to sentinels in
  Phase 2.

---

*Last updated: 2026-06-03.*
