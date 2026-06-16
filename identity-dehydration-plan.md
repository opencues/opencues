# Continuous dehydration/rehydration + non-classified blank integration — plan

**Status**: planned, not started. Read top-to-bottom; everything you need to start is here.

This doc covers two related features:

1. **Continuous dehydration/rehydration** — runtime swaps values ↔ tokens at every LLM boundary so the LLM never sees classified PII even when the value appears in the user's prose buffer.
2. **Non-classified blank integration pass** — a second LLM call that polishes a blank's raw output (`nvidia $254.00`) to fit the surrounding prose (`$254`).

Both depend on a per-field/per-blank `classified` semantic and a classified-span store in the runtime. Ship as ≥4 PRs (see § Suggested PR sequence) — they layer cleanly.

## Scope boundaries (READ FIRST)

The dehydrator does **NOT** detect ad-hoc PII. It does NOT scan for "anything that looks like an email / phone number / address" and try to redact it. Two narrow surfaces:

1. **DECLARED-SENTINEL VALUES.** A field declared in `IDENTITY.md` (or a blank with `as-context: <safe|raw>`) has a known token + a known value. The dehydrator looks for THAT EXACT VALUE in outbound text. If the user types their own name somewhere (and the name matches `IDENTITY.md`'s `fullName:`), it gets tokenised. A different user's name typed in passing does NOT — there's no inference layer.
2. **USER-TYPED SENTINEL TOKENS.** If the user types the literal `[FULL NAME]` (or any catalog token) in their buffer, the runtime can OPTIONALLY treat that as a request to interpolate — client-side it renders the value; on the next outbound LLM call it dehydrates back to the token. This is gated by a new option (see § User-typed sentinel tokens below) — default off preserves today's "user's text wins" behaviour from `originalBody` preservation in `postProcessContext`.

That's it. No regex PII detection. No "looks-like" heuristics. No inferred classification. The contract is: **the user declares what's sensitive (IDENTITY.md + per-blank `classified:`), and the runtime protects exactly those declared values + token forms**. Everything else is regular prose the LLM sees verbatim.

The narrow surface is deliberate — false-positive redaction of unrelated prose (a phone-number-shaped order ID, a hash that looks like an SSN) is more user-hostile than missing some unclassified PII the user didn't bother to declare. Add fuzzy/heuristic detection in a v2 only if a real miss shows up AND has a cheap fix.

---

## What the codebase already gives us

Before sketching new code, the existing structure does ~60% of the work:

- **`identity-context-mode: safe`** (`packages/opencues-core/src/identity-context.ts:213`, `:267`) is already "send token, not value" for the catalog block. The catalog appended to LLM system messages today carries `[FULL NAME] — user's first + last name combined` — token + description, no value. So **identity values already never reach the LLM via the catalog**. What's missing: the gate that catches the value when it appears in the USER'S PROSE BUFFER (e.g. user typed "I'm Wilfred and I…" and that gets sent to the LLM as-is).
- **`BlankConfig.asContext`** (`cues-md.ts:245`, parsed as `'off' | 'safe' | 'raw'`) — same shape. `safe` = catalog token only; `raw` = inlined value. 4 shipped blanks (`stocks`, `weather`, `hackernews`, `crypto`) all use `as-context: safe`. Same situation: catalog already protects the as-context value; the buffer prose doesn't.
- **`mergeCatalogs(sentinelsCatalog, blankContextCatalog)`** (`blank-context.ts:377`) already merges the two catalogs for the post-processor (rehydration direction). The same symmetric merge serves the dehydrator going the other way — no new data flow.
- **`postProcessContext`** (`identity-context.ts:406`) is the existing chokepoint for **rehydration** (token → value in LLM output). It returns `{ output, report }`; extending the return to also emit char-range substitution spans is small. The call site is `transform-blank-source.ts:resolveSentinels` (`packages/opencues-core/src/sources/transform-blank-source.ts:1645`) — one place to thread spans through.
- **`dispatchChat`** (`llm-provider.ts:1611`) is the single chokepoint for outbound LLM HTTP calls. **CLI-transport providers** branch off at `:1627` via `invokeCli` — the dehydrator needs to live BEFORE the transport branch so both paths get gated.
- **`DynDefs` + `shiftAfter`** (`packages/opencues-runtime/src/state/dyn-defs.ts:48`, `:86`) is the existing word-index-based span store. **Cannot reuse verbatim** — DynDefs is word-keyed; ClassifiedSpan needs to be char-keyed (a value like `+44 7700 900123` includes spaces and word boundaries that don't line up with prose word boundaries). But the shape — `shiftAfter`, `findOverlapping`, invalidate-on-edit — is the right pattern.
- **BlankFill apply path** (`packages/opencues-runtime/src/modules/blank-fill.ts:601` `applyAsyncFill`, `:1012` `applySatelliteFill`) is where a blank's value lands in the buffer. Two paths converge — the integration-pass hook + classified-span emission both need to happen at the convergence point, after substitution-text is computed, before `setText`.

So the structural pieces already exist. The new work is:

- **Per-field `classified` flag** (today: mode-level; new: field-level override of the mode default).
- **Buffer-level dehydration shim** (today: catalog block is token-only; new: extend the gate to user-typed prose).
- **Classified-span store** in `packages/opencues-runtime/src/state/`, char-keyed.
- **Cue gating** consulting the span store.
- **Integration-pass module** for `integrate: true` blanks.

---

## What "classified" means

`classified = true` on a sentinel: the value **never leaves the host in any LLM-bound payload**, in either direction.

- **Pre-dispatch**: if the value appears in the outbound prompt (system or user message), it's replaced with the token. If no token exists for the value, the substring is logged + scrubbed. The catalog block has always carried the token-only form in `safe` mode — this PR extends the same gate to prose anywhere in the request.
- **Post-dispatch**: the existing rehydrator substitutes token → value, AND records a ClassifiedSpan over the substituted region. Future outbound calls dehydrate that span back to the token by char-range, not by value-match (the user might have edited prose around it).

The user **can see the rehydrated value** in their buffer — classified ≠ hidden-from-user. The model never gets to read or write it.

**Why field-level instead of mode-level:** today's `identity-context-mode: safe | raw | off` is global — flip to `raw` and ALL identity is inlined. Users probably want public handles (`github`, `twitter`, `website`) inlined for prose quality but their phone number / email kept in safe-mode. Field-level fixes that.

---

## Default classification

| surface | default | how to override |
|---|---|---|
| identity field | `classified: true` | inline comment in IDENTITY.md: `email: w@example.com # classified: false` |
| blank with `as-context: safe` | `classified: true` (matches existing safe-mode semantics) | `as-context: raw` flips to `classified: false` |
| blank with `as-context: raw` | `classified: false` (matches existing raw semantics) | `classified: true` in BLANK.md to override |
| blank with `as-context: off` | n/a (no catalog entry) | — |
| blank substitute into buffer (any blank) | `classified: false` | `classified: true` in BLANK.md (then the substituted region becomes a ClassifiedSpan) |

**Per-installation override:** OPENCUES.md gains `classified-default: identity | identity+blank | none` for users who want a different baseline.

**Key shipping decision:** the existing `identity-context-mode` scalar stays — it just becomes the **default for unmarked fields**. Per-field `# classified: false` overrides the mode. This keeps every existing user's behaviour bit-identical (everyone on `safe` today gets `classified: true` for all fields, same as before).

---

## User-typed sentinel tokens

A user can literally type `[FULL NAME]` (or any catalog token) into their buffer. Two questions about what happens then:

1. **Should the runtime render the substituted value to the user?** Today `postProcessContext` PRESERVES user-typed tokens (see `originalBody` short-circuit at `identity-context.ts:423`) — they pass through as text. A user writing documentation about sentinels needs this. But a user typing `[FULL NAME]` as a deliberate interpolation shorthand wants the value to render.
2. **Should that typed token be classified on dispatch?** If the runtime DOES interpolate it client-side, then on the next outbound LLM call we should dehydrate it back to the token (so the LLM never sees the resolved value, mirroring the runtime-injected dehydration path).

**New option** (OPENCUES.md scalar): `protect-typed-sentinels: off | on`. Default **off** — today's behaviour preserved (user types `[FULL NAME]`, stays as literal text, sent to LLM as `[FULL NAME]`).

When `on`:
- The runtime walks the buffer on every text-change event, finds any literal catalog-token occurrence (`[FULL NAME]`, `[EMAIL]`, etc.) that the user typed, registers a ClassifiedSpan over that range, and the renderer substitutes the value for display only. Toggling the option flushes / re-registers spans.
- On outbound LLM dispatch, the ClassifiedSpan ranges go through the standard dehydrator → the LLM sees the token form, never the value.
- **The user sees the value, the LLM never does** — symmetric with runtime-injected dehydration.

**Per-field override**: `IDENTITY.md` can add `# protect-typed: false` to opt a single field out — useful if a user wants `[FULL NAME]` literal in some prose but auto-render for everything else.

**Edge cases**:
- User types a token that's NOT in their catalog (`[FAVORITE COLOR]` when no such field exists): no-op. Stays as literal text — same as today.
- User types a token in a code block / quote: out of scope for v1. The runtime can't reliably detect markdown-fenced regions across hosts. Documentation-about-sentinels remains the OFF use case.
- User edits across a typed token's brackets: ClassifiedSpan invalidates (same as runtime-injected spans on intersecting edit). Falls back to literal text.

**Why ship this as part of the plan** rather than as a separate post-MVP: the dehydration shim already has to handle ClassifiedSpan ranges. Adding a typed-token discovery scan on text-change is a small extension (~30 LoC). And it gives users a natural way to interpolate identity into prose without invoking FluidBlank for every field reference (`I'm [FULL NAME], a [JOB TITLE]` is faster to type than three separate `my name _`, `my role _` invocations).

---

## IDENTITY.md frontmatter syntax

IDENTITY.md uses a flat `key: value` format with `# description: ...` inline-comment overrides (see `identity-context.ts:parseIdentityMd:108` for the precedent). The cleanest extension reuses that pattern:

```
firstName:    Wilfred                # classified: true  (default — implicit)
lastName:     Kasekende
email:        w@commandstick.com     # classified: true
github:       https://github.com/wkasekende    # classified: false
linkedin:     https://linkedin.com/in/wkasekende  # classified: false
twitter:      "@inventorBlack"       # classified: false
website:      https://opencues.com   # classified: false
fullName:     Wilfred Kasekende      # classified: true, protect-typed: false
```

(The last line shows the per-field `protect-typed:` override — typing `[FULL NAME]` in prose stays literal even when the global `protect-typed-sentinels` is on, because the user marked this field as opt-out.)

**Parser change** (small): in `parseIdentityMd`, extend the existing inline-comment loop to recognise `# classified: <true|false>` the same way `# description: ...` is recognised today. Add `classified: boolean` to `IdentityField` interface.

**Backward compat**: unmarked fields use the `classified-default` mode (default: `classified: true` — same as today's `safe` mode behaviour). No silent regression.

**Rejected alternative**: a `non-classified:` aggregate line at the bottom (`non-classified: github,twitter,website`). Tempting but creates a second source of truth (a per-field comment vs an aggregate list) — confusing when they disagree. Stick with inline comments only.

---

## BLANK.md frontmatter additions

```yaml
---
name: stocks
as-context: safe
classified: false     # OVERRIDE — even with as-context: safe, this blank's
                      # values can be sent to the LLM (e.g. for integration).
                      # Default for as-context: safe is classified: true.
integrate: true       # opt-in — run integration pass after substitution
integrate-hint: "stock price — match currency formatting, trim trailing .00s if surrounding prose uses whole dollars"
---
```

Or for a sensitive blank:

```yaml
---
name: balance
as-context: safe
classified: true      # default for safe — also blocks integration
# integrate inert (boot-time warning surfaces if user sets it)
---
```

**Validator chokepoint** (in `planBlankContextSlots`, `blank-context.ts:109`):
- `classified: true` + `integrate: true` on the same blank → boot warning, integrate disabled. Same warning surface as the existing `splitValuesInTokenNamesAck` warning (`:127`).
- `as-context: raw` + `classified: true` → integrate disabled (raw mode would inline the value into the catalog, defeating classification). Warning + treat as `as-context: safe` for catalog purposes.

---

## Architecture: classified-span store

New file: `packages/opencues-runtime/src/state/classified-spans.ts`. Parallels `dyn-defs.ts` but char-keyed.

```ts
export interface ClassifiedSpan {
  start: number;      // char offset in liveText
  end: number;        // exclusive
  source: 'identity' | 'blank' | 'manual';
  token: string;      // [FULL NAME], [WEATHER LONDON], ...
  /** Original value that was substituted in. Lets the dehydrator
   *  fall back to value-match if the span is invalidated by an edit. */
  value: string;
}

export class ClassifiedSpans {
  add(span: ClassifiedSpan): void;
  remove(idx: number): void;
  /** Return spans overlapping [start, end). O(n) — n is small. */
  findOverlapping(start: number, end: number): ClassifiedSpan[];
  /** Shift every span at offset >= origin by delta. Mirrors DynDefs.shiftAfter. */
  shiftAfter(origin: number, delta: number): void;
  /** Drop spans whose value no longer matches the slice — call after
   *  user edit, like DynDefs.pruneStale. */
  pruneStale(text: string): void;
}
```

**Lifecycle:**
- Created by `postProcessContext` (extended) when a token → value substitution lands in LLM output.
- Created by `BlankFill.applyAsyncFill`/`applySatelliteFill` when a `classified: true` blank substitutes its value.
- Survives user edits that don't intersect the span (shiftAfter on insert/delete elsewhere).
- An edit that touches a span invalidates it (treated like editing a fluid-blank substitute — user wins, bytes become regular prose). After invalidation, dehydration falls back to value-match.

**Why char-keyed not word-keyed**: identity values like `+44 7700 900123`, `https://github.com/wkasekende`, or multi-word names cross word boundaries that don't align with prose tokenisation. DynDefs is word-keyed because cycling needs word offsets; classified spans need byte ranges.

**The runtime needs to thread spans through host adapters.** Today `setText(text, cursor)` is the host call. Either:
- (a) The runtime keeps the span store entirely internal and re-applies shifts during text-change events (the way DynDefs works). Simplest. Host doesn't need to know spans exist.
- (b) Hosts that can render highlights (chrome, future TUI hosts) read the span store for visual indication. Optional — out of scope for v1.

**Pick (a) for v1.** Spans are runtime-internal state. Host APIs unchanged.

---

## Pre-dispatch dehydration

Single shim in `dispatchChat` BEFORE the transport branch:

```ts
// In dispatchChat at packages/opencues-core/src/llm-provider.ts:1611
const dehydratedReq = ctx.bypassDehydration
  ? req
  : dehydrateRequest(req, ctx.classifiedCatalog, ctx.classifiedSpans);
// ... existing transport dispatch on dehydratedReq
```

`dehydrateRequest` walks `req.messages`, for each:
1. **Span-range substitution** (authoritative, lossless): if any ClassifiedSpan lies within the user message text, replace its byte range with the token. The span tells us the exact range — no value-matching, no false positives.
2. **Catalog-value substitution** (defensive, fallback): for each classified catalog entry, replace every occurrence of the value with the token. Whole-value match only (no substrings); skip values < 3 chars or matching common-word stoplist; non-regex to avoid escaping bugs.

**The new ctx properties** require threading from the source call sites:
- `ctx.classifiedCatalog: Map<string, string>` — token → value, classified entries only. Built once per `getCues` call from Identity + BlankContextSnapshot, filtered by each field's `classified` flag. The existing `buildUserCatalogBlock` + `buildBlankCatalogBlock` (`transform-blank-source.ts:1595`, `:1622`) are the natural composition points — extend them to also return the classified subset.
- `ctx.classifiedSpans: ClassifiedSpan[]` — comes from the runtime's `ClassifiedSpans` store. Plumbed into `CueContext` so sources can pass it through to `dispatchChat`.
- `ctx.bypassDehydration?: boolean` — opt-out for sources that don't need it. Candidates: ConfigIntent (reasoning about provider config, not user data).

**The catalog block itself is still token-only in safe-mode** — no change there. The dehydrator is the ADDITIONAL gate for user-typed prose and runtime-substituted classified values.

**Hot-path cost**: 16 identity values + ~10 blank-context values ≈ 26 string searches per outbound message. For a 200-char input that's ~5kB of work — negligible. For AgentRewrite's full-buffer rewrites that's still bounded — buffers are typically <10kB. Profile if it ever shows up in flamegraphs.

---

## Post-dispatch rehydration (extension of existing post-processor)

`postProcessContext` (`identity-context.ts:406`) today returns `{ output, report }`. Extend to return spans as well:

```ts
interface PostProcessResult {
  output: string;
  report: PostProcessReport;
  spans: ClassifiedSpan[];  // NEW
}
```

Inside the existing `output.replace(TOKEN_RE, ...)` loop, when a token resolves to a value AND the field is classified, push a `ClassifiedSpan` with the substitution range. Compute the byte offset by tracking cumulative position during the replace walk (replace's callback gets the offset — already available).

The call site `resolveSentinels` in `transform-blank-source.ts:1645` returns the rewrite string today. Extend its return shape to include spans; thread up to the runtime, which adds them to the `ClassifiedSpans` store.

---

## Cue gating

Cue sources today dispatch on any word in the buffer. After this PR, they need to skip words inside a ClassifiedSpan unless explicitly opted in.

**Per-cue setting**: each CUE.md (or word group within it) gains `target-classified: false | true | inherit` (default `inherit`).

**Global setting**: OPENCUES.md gains `cues-target-classified: off | on` (default `off`).

**Auditor setting**: AUDITORS.md gains `target-classified: false | true` (default `false`).

**Where the gate fires** (in resolver / source `getCues` paths):

- Word cues (`RoutedWordSourceGroup`): when filtering words to dispatch on, drop any word whose char range intersects a ClassifiedSpan unless `target-classified: true`.
- Sentence cues (`SentenceCueSource`): drop sentences whose range intersects a ClassifiedSpan. (Conservative — a sentence with a phone number embedded is dropped wholesale. Acceptable v1; finer-grained sentence rewrite-preserving-span is a v2.)
- AgentRewrite: dehydrate the whole-buffer outbound payload via the standard shim; rehydrate on response. No extra gate needed — the model never sees classified values either way.
- Auditors: same as word cues — skip words inside a classified span unless opted in.
- FluidBlank / TransformBlank: NO gate. These are the user explicitly invoking — they get to use their own data. (The substituted result lands as ClassifiedSpan if the relevant blank/field is classified.)
- ConfigIntent: NO gate. Reasoning about provider config, not user data.

---

## Idea 2: Integration pass for non-classified blanks

When a blank substitutes a raw value into the buffer, AND the blank has `integrate: true`, run a second LLM call to polish the raw value into the surrounding prose.

**Where it fires**: in `BlankFill.applyAsyncFill` / `applySatelliteFill`, after the substitute value is resolved but before `setText`.

**Gating**:
- `integrate: true` required on the blank.
- Blank's `classified` flag must be `false` (the integration LLM needs to see the value — can't if classified).
- Substitute length ≥ 12 chars (smaller values aren't worth the round-trip).
- Surrounding prose has a "format hint" (a `$`, `%`, unit suffix, date-shape, etc.) — otherwise polish payoff is too small. Detection is a tiny regex set; if none match, skip.

**Prompt** (~300 tokens system):

```
You are integrating a blank's raw output into the user's surrounding text.

INPUT:
  CONTEXT_BEFORE: <≤300 chars of buffer text before the substituted region>
  SUBSTITUTED:    <the blank's raw output, verbatim>
  CONTEXT_AFTER:  <≤300 chars after>
  BLANK_HINT:     <integrate-hint from BLANK.md, if set; else empty>

Rewrite SUBSTITUTED to fit the surrounding prose:
  - Match number/date/unit formatting to the surrounding style ($254.00 → $254 if prose uses whole dollars).
  - Trim redundant prefixes already present in CONTEXT_BEFORE (don't say "NVIDIA: $254" if the user just typed "NVIDIA is at ___").
  - Preserve all numeric/identifier values EXACTLY — never round, never approximate, never invent. If a value would be lost by your edit, abort and return SUBSTITUTED verbatim.
  - Output ONE LINE: the rewritten substituted region only. No labels, no commentary.

If SUBSTITUTED fits perfectly already, return it verbatim.
```

**Validation** (the LLM might hallucinate):
- Extract numeric tokens (regex `\d[\d,.]*`) from input SUBSTITUTED.
- Extract numeric tokens from LLM output.
- If output's numeric set differs from input's (missing or new numbers), REJECT — fall back to original SUBSTITUTED. Logs a warning.
- Numbers may be REFORMATTED (`254.00` → `254`, `1000` → `1k`) — accept if the value is preserved by a tolerant numeric comparator (strip commas/decimals, compare integer part for prices; etc.). Cheap to implement; covers ~95% of legit integrations.

**Cost**: one extra LLM call per filled `integrate: true` blank. On cerebras gpt-oss-120b ~150-250ms. Use the `blanks-llm-*` bucket — this is downstream of a blank's output.

**Cache**: LRU keyed by `(substituted, contextBefore-tail-32, contextAfter-head-32, integrateHint)`. ~256 entries. Same shape as `agent-rewrite-cache.md` describes.

**What it unlocks**:
- Stock blank `$254.00` → `$254` in conversational prose, `$254.00` in spreadsheet-format prose.
- Weather blank `14°C, overcast` → `14°` in a tweet, `14 degrees and overcast` in an email.
- Currency conversion / unit normalization without per-blank custom logic.
- Hackernews `Show HN: I built a thing in Rust (412 points)` → `"Show HN: I built a thing in Rust"` when the surrounding prose doesn't want the upvote count.
- Numbers-with-trailing-zeros cleaned per surrounding convention.

**What it should NOT do** (validator catches):
- Round prices (`$254` is OK; `$250` is not — different value).
- Drop information (`14°C, overcast` → `14°` is OK only if surrounding prose context doesn't reference the cloud cover).
- Translate language (BLANK_HINT can opt in if a blank wants this).

---

## Test impact

| existing test file | what changes |
|---|---|
| `identity-context.test.ts` | parser tests for new `# classified: false` inline syntax; default-true assertion for unmarked fields; `IdentityField.classified` shape pinning; parser tests for `# protect-typed: false` inline syntax |
| `blank-context.test.ts` | validator tests for `classified + integrate` conflict; `as-context: safe` default-classified derivation |
| `transform-blank-source.test.ts` + scenario tests | `resolveSentinels` return-shape extension (spans); no semantic change in default safe-mode behaviour |
| `cycling.scenarios.test.ts` | new scenarios — cycle around / through a classified span; user-edit invalidates span; concurrent classified span + word-cue span |
| `dyn-defs.test.ts` | unchanged — ClassifiedSpans is a separate store |
| `blank-fill.span-as-unit.test.ts` | new — `classified: true` blank's substitute registers a span; `integrate: true` blank fires integration pass |
| new: `classified-spans.test.ts` | unit tests for shiftAfter / pruneStale / findOverlapping invariants |
| new: `dehydration.test.ts` | span-range + catalog-value substitution; bypassDehydration flag honoured; idempotent (dehydrate of dehydrated text is no-op) |
| new: `typed-token-scan.test.ts` | with `protect-typed-sentinels: on`, user-typed `[FULL NAME]` registers a ClassifiedSpan; per-field `protect-typed: false` opt-out honoured; unknown token (`[NOT IN CATALOG]`) no-op |
| new: `integration-pass.test.ts` | validator catches hallucinated numbers; cache LRU works; short-substitute / no-format-hint skip path |
| new: `tests/benchmarks/dehydration/` | end-to-end safety bench: zero classified values leak across 100 transform/fluid/agent compose runs |
| new: `tests/benchmarks/integration-pass/` | before/after polish quality on stocks/weather/crypto in realistic prose; latency cost measurement |

Existing tests should all stay green at default settings — the new feature is opt-in for blanks and per-field for identity, both layering on top of existing behaviour. The `cycling.scenarios.test.ts` adds are the most likely regression-detection surface.

---

## Backward compat + migration

- Existing IDENTITY.md (no per-field `# classified:` comments) → `classified-default: identity` (default) → all fields treated as classified. **Same security posture as today's `safe` mode**. No silent change.
- Existing `identity-context-mode: raw` → mode becomes "default for unmarked fields" only. A field with `# classified: true` stays classified even in raw mode. This is a behaviour shift for raw-mode users (a small minority who deliberately opted into PII inlining); doctor surfaces it as info, not warning. Migration note in CHANGELOG: "if you set identity-context-mode: raw, individual fields you want kept safe now need `# classified: true` explicitly."
- Existing BLANK.md with `as-context: safe` → derives `classified: true` (matches today's safe-mode semantics).
- Existing BLANK.md with `as-context: raw` → derives `classified: false` (matches today's raw inline semantics).
- Existing CUE.md / AUDITORS.md → `target-classified: inherit` (defaults off via global). Today there are no classified spans in the buffer (rehydration doesn't tag them), so cues today touch everything inside the buffer regardless. Post-PR: cues skip rehydrated regions unless opted in. This IS a behaviour change for cues + rehydrated text, but the surface is small (TransformBlank rewrites that wove `[FULL NAME]`). Note in CHANGELOG.
- `SPEC_VERSION` bump candidate: yes. Adds `classified:` per-field to identity-spec, `classified:` + `integrate:` + `integrate-hint:` to blank-spec, two new OPENCUES.md scalars, `target-classified:` to cue-spec + auditor-spec. Bump 0.2 → 0.3 with the first PR that lands a wire-format change. Bump checklist: CLAUDE.md § "When to bump `SPEC_VERSION`".

---

## What this unlocks

- **Latency wins from cerebras prefix-cache**: dehydrated prompts have stable byte content even when user prose changes (the token substitutes for the variable value). Higher cache-hit rate on AgentRewrite's high-frequency reads. Quantifiable via `tests/benchmarks/transform-blank/latency-probe.ts` extended for compose-with-PII inputs.
- **Privacy posture for opt-in raw mode**: today flipping `identity-context-mode: raw` exposes ALL PII. After this PR, the user can flip raw mode for prose-quality benefits but keep specific fields (phone, email) classified — per-field opt-out.
- **Safer compose-style outputs**: when the LLM produces text that ALREADY weaves identity tokens, the rehydrated values get spans automatically. A follow-up "share this draft" or "regenerate from current buffer" call dehydrates them again without the user thinking about it.
- **Integration unlocks blank-driven prose**: today raw blank output is awkward in prose (`$254.00` in a tweet, `Show HN: ... (412 points)` in an email). Per-blank `integrate: true` smooths this without ad-hoc per-blank format logic.
- **Foundation for future** classified-blanks (`balance _` from a bank-pack; `2fa _` from a private auth source) — the same gate covers them with zero per-blank code changes.

---

## Open questions

1. **Should the dehydrator be fuzzy?** (User types "Wilfred K." — initial-truncated. Tokenise?) **Recommendation: no, value-match only.** Fuzzy = false positives on common prefixes; add only if a real miss surfaces.
2. **Whole-value match vs substring?** (User types "@example.com" alone; full email is `wilfred@example.com`.) **Recommendation: whole value only.** Substring collides with unrelated URLs.
3. **Classified-blank fills shown to user verbatim** — fine. But what if the user COPIES that text and pastes into another LLM (outside OpenCues)? Out of scope. The classification covers OpenCues-internal LLM calls, not the user's clipboard.
4. **Integration pass + AgentRewrite** — does the integration pass fire on rewrites AgentRewrite produces? **Recommendation: no, not in v1.** AgentRewrite already pulls catalog values into prose; a third LLM call per tick is too expensive. Revisit if a UX gap surfaces.
5. **The integration LLM hallucinating new numbers** — validator catches via numeric-token diff. **What about NON-numeric hallucinations** (changing the company name when integrating a stock blank)? Recommendation: extract bracket-tokens + identifier-shaped tokens (uppercase abbreviations, ALL-CAPS sequences) too, validate they're preserved. Add to validator gradually as bug reports arrive.
6. **Catalog-value scan in dehydrator** — false-positive risk if a user's name happens to appear as a normal word in unrelated prose. (Imagine identity has `firstName: Marketing`.) **Recommendation: filter by length (≥ 3 chars) + common-word stoplist (a small built-in list of ~50 English words).** Same heuristic the bench grader's `forbidRawValues` uses.
7. **Per-host adapter changes**: does chrome / opencode / shell need anything? **Recommendation: no host changes for v1.** ClassifiedSpans is runtime-internal state. Chrome's `setText` is unchanged. Visual highlighting of classified spans is a v2.
8. **CLI provider transport** (`provider.invokeCli`) — the dehydration shim needs to fire BEFORE the transport branch in `dispatchChat`. Confirmed sites: `claude-cli-daemon.ts`, any future `openai-subscription`-shape provider. Add a regression test that pins both transports go through dehydration.

---

## Upgrade path

For PR1 (parser + flag plumbing):
1. `pnpm install` — `opencues run` self-heals via srcHash drift, no host re-install needed.
2. No user action — defaults preserve today's semantics.

For PR2 (pre-dispatch dehydration):
1. Same auto-update.
2. Bench-driven validation: `tests/benchmarks/dehydration/` confirms zero classified-value leak across 100 runs.

For PR3 (classified-spans + rehydration emission):
1. Same auto-update.
2. No user-visible change — spans are runtime-internal until cues gate on them.

For PR4 (cue gating):
1. Same auto-update.
2. Users who heavily customise cues + use `identity-context-mode: raw` may want to set `cues-target-classified: on` to restore prior behaviour.

For PR5 (integration pass):
1. Same auto-update.
2. Opt-in via `integrate: true` on a blank, optionally `integrate-hint: ...`.

Each PR is independently shippable and reversible. PR1-3 layer; PR4 and PR5 can ship in either order after PR3.

---

## Suggested PR sequence

**PR1 — Classification flag plumbing.** Parse `# classified:` inline comments in IDENTITY.md → `IdentityField.classified: boolean`. Parse `# protect-typed:` similarly → `IdentityField.protectTyped: boolean | undefined`. Parse `classified:` in BLANK.md → `BlankConfig.classified: boolean | undefined`. Add `classified-default`, `cues-target-classified`, `protect-typed-sentinels` to FEATURES registry. Add `target-classified:` to CUE.md + AUDITORS.md parsers. Bump SPEC_VERSION 0.2 → 0.3. **No runtime behaviour change yet** — just metadata flow. Tests: parser unit tests + doctor validator surface. Small, safe, foundational.

**PR2 — Pre-dispatch dehydration shim** in `dispatchChat`. Catalog-value substitution only (no spans yet). New `dehydrateRequest()` + `bypassDehydration` opt-out. The classified catalog gets built per-call from Identity + BlankContextSnapshot. Tests: dehydration unit tests + bench validation that classified values don't leak; latency probe confirms no regression.

**PR3 — ClassifiedSpan store + rehydration with span emission.** New `classified-spans.ts` in runtime. Extend `postProcessContext` to return spans. BlankFill registers spans on classified-blank substitution. Runtime threads spans into `CueContext` so PR2's dehydrator can do span-range substitution (lossless) as well as value-match (defensive). Tests: scenarios in `cycling.scenarios.test.ts` for shift/invalidate; new `classified-spans.test.ts` unit tests; new `dehydration.test.ts` end-to-end.

**PR4 — Cue gating.** Resolver pre-filter consults span store; per-cue + global + per-auditor `target-classified` configs. Tests: word-cue / sentence-cue / auditor skip classified spans by default; opting in re-enables; AgentRewrite + FluidBlank + TransformBlank UNAFFECTED (they don't gate, by design).

**PR5 — User-typed sentinel-token protection.** `protect-typed-sentinels: on|off` scalar + per-field `# protect-typed: false` override. Text-change-handler scan in the runtime that finds user-typed catalog tokens and registers ClassifiedSpans over their ranges. Renderer substitutes the value for display. Default off — opt-in via the scalar. Tests: typed-token-scan suite + a scenario test for "user types [FULL NAME], hits cycle, the span survives a downstream edit." Small layer on top of PR3's span store.

**PR6 — Integration pass.** `integrate: true` + `integrate-hint:` on BLANK.md; runtime calls integration LLM after substitution; validator + cache. New `tests/benchmarks/integration-pass/` bench measures polish quality + latency. Default off — opt-in per blank.

Sequencing: PR1 before everything (other PRs depend on the parser additions). PR2 + PR3 land in order (PR3 makes PR2 lossless). PR4 + PR5 ship in either order after PR3 (both depend on the span store). PR6 ships independent of PR4/PR5 (different mechanism; only depends on PR1's `integrate:` parsing).

Each PR runs the full `pnpm -C packages/opencues-{core,runtime} test` plus the relevant new bench (dehydration/ for PR2-4; integration-pass/ for PR5). The existing `identity-order/` bench (this branch's work) also re-runs to confirm no regression in identity utilization.

---

*Last updated: 2026-06-15*
