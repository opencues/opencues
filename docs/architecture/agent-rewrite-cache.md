# AgentRewrite cache — implementation reference

The agent-task loop ticks once per debounce. Most ticks would be wasted
LLM calls without short-circuit logic — either the buffer hasn't
changed since the last round, or the user is bouncing between known
states (backspace + retype). Two layered caches collapse those cases
to zero LLM work.

Source: `packages/opencues-runtime/src/modules/agent-rewrite.ts`.
Public observable: `agent-rewrite.round-completed` event carries
`latencyMs` — a `0` there is the cache-hit fingerprint visible to
the agentic harness and the event-bridge.

---

## Two tiers, two reasons

### Tier 1 — skip-on-stable (`_lastStableSnapshot`)

`agent-rewrite.ts:188-191` tracks the last `(snapshot, task, cursor)`
triple where the round produced no surviving hunks (LLM returned
identical text, or the three-way merge dropped every hunk). On the
next tick, if `(adapter.getText(), state.prompt, getCursorOffset())`
matches that triple, the round exits before it builds a cache key.

**Cost when hit**: zero. No map lookup, no key construction, no token
accounting, no network. The bulk of the savings during idle typing
on a settled buffer.

**Invariants** — to be considered stable, BOTH conditions must hold:

1. The LLM returned text that was either identical or whose hunks all
   got dropped by the merge (e.g. a duplicate edit the user already
   typed past).
2. `validateLLMRewrite` accepted the response. A truncation glitch is
   never recorded as stable — the next tick must retry.

### Tier 2 — `_rewriteCache` (LRU map)

`agent-rewrite.ts:178`. A `Map<string, string>` keyed on a five-part
fingerprint. On miss, the LLM call fires and the result is stored.

**Cache key** (line 779-781):

```ts
makeCacheKey(snapshot, task, cursor, windowWords, auditorSignature)
//          ↑ \u0000-separated to disambiguate without an escape pass
```

| Component | Reason it's in the key |
|---|---|
| `snapshot` | the buffer text — identical input must produce identical output |
| `task` | the agent prompt (`"correct spelling"`, `"translate to french"`, …) — different prompts must not share rewrites |
| `cursor` | position-sensitive: the cursor sentinel changes the LLM input; same buffer with cursor in a different sentence can flip a terminal-punctuation decision |
| `windowWords` | flipping the `agent-window-words` setting at runtime must invalidate naturally (different LLM input → different output) |
| `auditorSignature` | a stable hash over every active auditor's `(name, priority, promptText)` — toggling or editing an auditor changes what each isolated-mode call sees |

**Auditor signature** (line 788-791):

```ts
auditors.map(a => `${a.name}\u0001${a.priority}\u0001${a.promptText}`).join('\u0002')
```

Empty list → empty string (zero overhead for the no-auditors path).

**Bounded LRU**: cap 64 entries (`REWRITE_CACHE_MAX`). On overflow,
drops the oldest. Insertion order = recency because the hit path does
`delete + re-insert`, refreshing the entry's position.

---

## Determinism assumption

Caching only works if `(prompt + body) → rewrite` is a pure function.
Two structural choices make that true today:

1. **Provider config**: Groq at `temperature: 0` + fixed `seed: 42`.
   Byte-identical output for identical input.
2. **Merge invariants**: `validateLLMRewrite` (length sanity, no
   forbidden patterns) rejects malformed responses before they reach
   the cache. A glitched round-trip doesn't poison future hits.

If a future provider is added without temperature/seed pinning, the
cache will start serving stale rewrites that the user might find
surprising (same typo → different correction each time, except for
the cached one). The fix is to either (a) refuse non-deterministic
providers for agent tasks, or (b) downgrade caching to a session-
scoped no-op when determinism is unknown.

---

## Hit scenarios

| Scenario | Tier | Effect |
|---|---|---|
| Agent loop re-fires on stable text after correction | 1 | Zero work. |
| User backspaces a typo then retypes it identically | 2 | LLM skipped; cached rewrite re-applied. |
| User re-arms the same task on the same buffer | 2 | Re-issuing the prompt is free. |
| User edits a character → new snapshot | miss | LLM called, result cached. |
| Auditor body edited mid-session | miss | `auditorSignature` changes; effectively invalidates the whole cache. |
| `agent-window-words` flipped at runtime | miss | `windowWords` differs; entries shadowed (still in the LRU, but unreachable). |

---

## Observability

The cache is structurally observable from outside the runtime:

- **`agent-rewrite.round-completed`** event includes `latencyMs`. A
  cache-hit round-trip is `0` or `1` ms. A real LLM round-trip is
  typically 280–700ms on Groq. The agentic harness's event-bridge
  records every round.
- **`debug-mode: on`** in OPENCUES.md enables `_logFn` info-level
  output. A hit logs `AgentRewrite: cache hit (<N> entries) —
  skipping LLM call`.

Sample event stream during a five-input spelling-correction
benchmark:

```jsonl
{"type":"agent-rewrite.round-started","textLen":19,"prompt":"correct spelling"}
{"type":"agent-rewrite.round-completed","latencyMs":428}  ← cold (LLM call)
{"type":"agent-rewrite.round-started","textLen":19,"prompt":"correct spelling"}
{"type":"agent-rewrite.round-completed","latencyMs":0}    ← warm (cache hit)
```

---

## Current limits + extension points

The cache is intentionally small + simple. Likely future work areas:

1. **Cache size**. 64 entries is conservative — sized for backspace-
   retype during a single buffer's worth of editing. Long writing
   sessions across many buffers may LRU out useful entries. Bumping
   to 256–1024 is a one-constant change with no compatibility risk.

2. **Cross-session persistence**. The cache is in-memory only.
   Survivable storage (per-buffer in `.cues/<workspace>/cache.json`?)
   would survive host restarts but adds a serialisation pass + a
   schema versioning problem. Worth doing once we have a real long-
   running session profile to measure value against.

3. **Approximate-match cache keys**. Today the key is exact-text. A
   prefix-trie or embedding-keyed cache could return useful
   corrections for "hii my name is wil" when "hii my name is will"
   is already cached. Big design surface — probably warrants its own
   doc when seriously pursued.

4. **Negative caching**. If the LLM returns a result we reject in
   `validateLLMRewrite`, we currently re-issue next tick. Storing
   the rejection in a parallel `_rewriteCacheNegative` (with shorter
   TTL) would skip the wasted call. Tradeoff: validates can be
   flake-driven (transient API truncation), so a TTL is essential.

5. **Telemetry**. `_logFn` says `cache hit (N entries)` but not the
   hit rate. Adding `cacheHits / cacheMisses` counters + emitting
   them on round-completed would let benchmarks surface efficiency
   without external aggregation.

6. **Manual invalidation**. No public API. Users wanting to force a
   fresh LLM call would currently have to type a character + delete
   it. A `.opencues-clear-cache` sentinel or a `Cycling` modifier
   could trigger explicit invalidation.

Anything in this list is additive — none breaks the determinism
assumption or the existing observability contract.

---

## Tests

Pinned behaviour:

- `agent-rewrite.test.ts` — 33 integration tests covering full
  pipeline; cache hits surface as `latencyMs: 0` round-completed
  events.
- `agent-rewrite.auditors.scenarios.test.ts` — 15 scenarios; auditor
  signature changes invalidate cache.
- `word-diff.test.ts` — 27 unit tests; merge invariants the cache
  relies on for the "drop hunks" → stable path.

---

## Cross-references

- Feature concept: `docs/features/agent-task.md`.
- Outer module ref: `docs/architecture/agent-task.md` § Cadence.
- Determinism + auditor isolation rationale:
  `spec/auditor-spec.md` § Composition (isolated mode).
- Benchmark recipe: drive `agentically <prompt> _` via the agentic
  harness, observe `/tmp/opencues-events-<pid>.jsonl` for
  `agent-rewrite.round-completed` `latencyMs` fields.
