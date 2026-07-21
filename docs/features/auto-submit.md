---
last_updated: 2026-07-04
---

# Auto-Submit Trigger

Analysis fires automatically as the user types, without requiring an explicit submit action. The `Resolver` module (`packages/opencues-runtime/src/modules/resolver.ts`) debounces normal typing but bypasses the debounce entirely for an explicit `_` trigger.

---

## How It Works

1. **On every text change** (user-sourced only — the resolver ignores its own `setText` echoes), `Resolver.onTextChange` runs.
2. **Config hot-reload check** — if `OPENCUES.md` scalars changed since the sources were last built, the resolver rebuilds before dispatching, so a flag flip (`transform-blank-mode: off → on`, etc.) takes effect without a host restart.
3. **Same-text dedupe** — if the incoming text is identical to the last user-sourced text seen, the change is a no-op echo (some hosts re-emit change events for unchanged content) and is dropped immediately.
4. **Blank-trigger fast path**: if the buffer's trailing edge just gained a `_` (per `blank-trigger-mode` — `immediate`: the instant `_` becomes the last non-whitespace char; `spaced`: only once a confirming space follows), the debounce is bypassed entirely and the resolver dispatches right away. This is what cuts perceived `_` latency roughly in half versus waiting out the debounce.
5. **Otherwise**, a single debounce timer (`debounceMs`, default **500ms**) is (re)armed. When it fires, the resolver dispatches the current text.
6. **In-flight cancellation**: every dispatch bumps a monotonic `_generation` counter. If a newer keystroke supersedes an in-flight LLM call, the stale response is discarded on arrival by generation mismatch rather than being applied over newer text.

There is no separate "space typed" / "typing pause" / "mid-sentence edit" tier system with different debounce values — it's one debounce for anything that isn't a `_`-trigger, plus the immediate `_`-trigger fast path.

---

## Word Stability / Staleness

Because dispatches are generation-tagged, a response that arrives after the buffer has moved on doesn't need a separate "did the text change since the timer was set" check the way a naive setTimeout would — the generation mismatch alone is enough to drop it. Local, non-LLM matches (a word that's already in a loaded `CUE.md`'s `## Tips`, or already covered by an existing `DynDef`) resolve without a network round-trip at all, so they're not subject to the debounce or generation dance in the first place.

---

## Portability

### Standard (opencues-core)

- The resolver is stateless — it accepts text and word indices, returns results, and has no opinion on when it is called
- No built-in debounce, timer, or text-change detection in opencues-core itself; debounce/generation/dedupe are all runtime-layer (`@opencues/runtime`) concerns
- Supports targeted indices so the caller can request analysis for specific words only
- Returns results keyed by word index, allowing incremental merging with previous results

### Integration responsibilities

- Supply a `HostAdapter` with `onTextChange` — the shared runtime's `Resolver` handles debounce, the `_`-trigger fast path, hot-reload detection, and generation-based cancellation for you
- If implementing outside the shared runtime: debounce normal typing, bypass the debounce for an explicit `_` trigger, and tag in-flight requests so a stale response can't clobber newer text
- Merge incremental results into the existing alternatives map
- Decide when to skip remote cues (all words already have alternatives from local tips or existing `DynDef`s)
