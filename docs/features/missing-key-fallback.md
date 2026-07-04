---
last_updated: 2026-07-04
---

# Missing-Key Fallback

Turns "no LLM API key configured" from a silent dead extension into a visible, in-buffer message. Implemented by `MissingKeyFallbackSource` (`packages/opencues-core/src/sources/missing-key-fallback-source.ts`), wired by `buildSourcesFromConfig` (`packages/opencues-core/src/sources/build-sources.ts`), and driven by the host-supplied `missingKeyFallbackMessage` option on `Resolver` (`packages/opencues-runtime/src/modules/resolver.ts`).

---

## The problem this fixes

Before this source existed, a fresh install with no API key set meant typing `_` produced **no substitute at all** — indistinguishable from a broken or unpatched extension. There was no error, no log line visible to the user, and no in-buffer signal; the user's only diagnostic path was checking `/tmp/opencues.log` or asking in an issue tracker. This shipped alongside a companion fix for a different silent-failure class (see [`formatLLMErrorAsSubstitute`](#relationship-to-formatllmerrorassubstitute) below) in commit `d6112e6` ("chrome+runtime: replaceAllText undo-fix + no-silent-failure UX across all integrations", May 2026).

## What it displays, and when

`MissingKeyFallbackSource.supports()` claims any buffer containing an unbound `_`:

```ts
supports(context: CueContext): boolean {
  return context.words.includes('_');
}
```

But the source is only ever added to the resolver's source list in the first place when a build-time check confirms no LLM-backed **blank** source could be wired — `buildSourcesFromConfig` (`packages/opencues-core/src/sources/build-sources.ts`):

```ts
if (options.missingKeyFallbackMessage && options.missingKeyFallbackMessage.length > 0) {
  const hasLLMSource = sources.some(s => s.id === 'fluid-blank' || s.id === 'transform-blank' || s.id === 'config-intent');
  if (!hasLLMSource) {
    sources.push(new MissingKeyFallbackSource({ message: options.missingKeyFallbackMessage }));
  }
}
```

This is a **blanks-bucket-only** check: it looks at whether `fluid-blank`, `transform-blank`, or `config-intent` were built, not whether cues-bucket word-cue sources resolved. Auditors and agent-rewrite are out of scope of `buildSourcesFromConfig` entirely (they resolve via `boot-common`'s `buildAgentLLMResolver`) and don't factor into this check either way.

When wired, the source has priority `1` — the lowest of any shipped source, below every real LLM source (`FluidBlankSource` = 92, `TransformBlank` = 93, etc.) — so if anything real does manage to resolve, it wins first. On a match, `getCues` returns two alternatives:

```ts
alternatives: ['_', this.config.message],
```

`alternatives[0]` is the bare `_` and `alternatives[1]` is the host's hint message, which the runtime substitutes by default. Cycling back one step (Ctrl+Alt+Up in reverse, or the equivalent dismiss gesture) restores the bare `_`, letting the user get the message out of their way without deleting it manually. `isCycleable` is `false`, so it doesn't offer further alternatives to step through beyond that dismiss.

## Per-host message customization

The message text is supplied by each host's boot code via `ResolverOptions.missingKeyFallbackMessage` (`packages/opencues-runtime/src/modules/resolver.ts`):

```ts
/**
 * Host-specific in-buffer message shown when no LLM source could be
 * wired (no working API keys). Chrome passes "open the extension
 * popup", native hosts (CC/OC) mention `~/.cues/.env`. Omit to keep
 * the silent-no-op (e.g. when the host shows the warning elsewhere).
 */
readonly missingKeyFallbackMessage?: string;
```

Two distinct strings exist:

- **Chrome** (`packages/opencues-runtime/adapters/chrome/v1/boot.ts:405`):
  ```
  [OpenCues: no API key — open the extension popup]
  ```
  Chrome has no `~/.cues/.env` to point at (no filesystem access), so it points at where its own API-key inputs live instead.

- **Every native host** — CC (`adapters/cc/v2.1/boot.ts`), OC (`adapters/oc/v1.4/boot.ts` and `adapters/oc/v1.14/boot.ts`), Gemini CLI (`adapters/gemini/v0.41/boot.ts`), and Shell (`adapters/shell/v1/boot.ts`) — share `NATIVE_HOST_MISSING_KEY_MESSAGE` (`packages/opencues-runtime/src/boot-common.ts:774-775`):
  ```
  [OpenCues: no API key — set CEREBRAS_API_KEY (or another provider's key) in ~/.cues/.env or your shell env]
  ```

Each host computes its own `hasAnyKey` (`Object.values(apiKeys).some(Boolean)`) and passes the message conditionally:

```ts
missingKeyFallbackMessage: hasAnyKey ? undefined : NATIVE_HOST_MISSING_KEY_MESSAGE,
```

If `hasAnyKey` is true — even just one provider has a key, regardless of whether that provider is actually usable for blanks specifically — the message is `undefined` and the fallback never installs, per the `options.missingKeyFallbackMessage.length > 0` gate in `buildSourcesFromConfig` above. Passing `undefined`/empty is documented as an explicit opt-out ("regresses to silent no-op — only do this if the host surfaces the warning some other way, e.g. statusline"); no shipped host currently exercises that opt-out.

Each host also constructs its `Resolver` unconditionally, even with zero keys present — this is called out explicitly in the boot comments (e.g. `adapters/cc/v2.1/boot.ts`: "Resolver is constructed even with no keys so the MissingKeyFallbackSource can substitute a visible in-buffer hint on `_` instead of silent no-op") — because without a `Resolver` instance at all, there's nothing to call `subscribe()` on and the fallback source would never get a chance to fire.

## How it composes with multi-provider auto-fallback

The gate is coarse-grained by design: it fires on "zero of the three blanks-bucket LLM sources could be built," not per-provider or per-bucket-tier granularity. If any provider across any bucket has a key, `hasAnyKey` is true at the host layer and the fallback message is withheld entirely — even if that key belongs to a provider that can't actually serve blanks (e.g. a provider explicitly excluded from the blanks bucket per `docs/architecture/llm-routing.md`'s `trainsOnInput` guard). In that edge case, the current behavior is: no missing-key fallback text will show if a key exists anywhere, even one that can't serve blanks — this is a known coarseness in the `hasAnyKey` check rather than a per-bucket resolution check. The doc has not found evidence this edge case is separately handled; a maintainer investigating a "why didn't the fallback fire" report should check whether the configured key's provider is actually eligible for the blanks bucket.

## Relationship to `formatLLMErrorAsSubstitute`

`formatLLMErrorAsSubstitute` is a **related but distinct** mechanism, shipped in the same commit (`d6112e6`) but structurally independent:

| | `MissingKeyFallbackSource` | `formatLLMErrorAsSubstitute` |
|---|---|---|
| Failure class | Zero API keys configured — a **build-time** condition | A live LLM HTTP call failed **at request time** (401/403, 404, 429, 400, network) — a **mid-session** condition |
| Shape | A standalone `CueSource` pushed onto the resolver's source list | A formatter callback passed into `FluidBlankSource` (and reused by TransformBlank / ConfigIntent) that runs inside a `getCues()` `catch` block |
| Trigger | `buildSourcesFromConfig`'s `!hasLLMSource` check at construction time | `classifyLlmError` (exported from `fluid-blank-source.ts`) pattern-matching the caught error against HTTP status codes, on every failed call |
| Silence preserved for | N/A — always shows once installed | 5xx and LLM-internal failures (no-span, malformed JSON) — "aren't user-actionable," per the source comment |
| Host wiring | `ResolverOptions.missingKeyFallbackMessage` | `ResolverOptions.formatLLMErrorAsSubstitute`, backed by `nativeHostFormatLLMError` (`boot-common.ts`) for native hosts and a chrome-specific formatter in `chrome/v1/boot.ts` |

In short: a missing key means the LLM-backed source was never built, so `MissingKeyFallbackSource` fills the gap it left behind. A present-but-failing key means the real source *was* built and ran, but its live call errored, so its own error-formatter substitutes a message instead. Both land as ordinary substitutes and both register as `clearOnEdit` spans (typing into the message wipes it back to `_` via `BlankFill.applyClearOnEdit`), but they're two separate code paths guarding two separate failure classes.

## See also

- `docs/architecture/llm-routing.md` — the three-bucket LLM routing (cues / auditors / blanks) that determines whether a given provider's key is eligible for the blanks bucket at all.
- `docs/architecture/cerebras.md` — default-provider context for why `CEREBRAS_API_KEY` is named first in the native-host message.
