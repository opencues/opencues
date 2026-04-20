# Word-Alt Routing

Every `### alternatives` section in `cues.md` (or folder-based `cues/<name>/cue.md`) becomes one cue source. OpenCues routes **each highlighted word** to exactly ONE of those sources at resolve time. A project's source set is a small routing table, not one giant merged prompt.

This mirrors the blank-routing model (`ClassifiedSourceGroup`): inputs go through a classifier, land on one source, and that source's prompt is the one the LLM sees. The two models differ only in how the classification happens — blanks use heuristics + an optional LLM classifier, word-alts use fast-path match/keywords rules.

---

## The two source types

The rule is one line:

> **A source that sets `match:` OR `keywords:` is a DOMAIN source. Everything else is a DEFAULT source.**

| Type | Triggers | Fires for | Typical use |
|---|---|---|---|
| **Domain** | `match:` regex OR `keywords:` list | only words that hit the regex / keyword list | narrow vocabularies (legal, medical, formal connectors) |
| **Default** | *neither* | every word no domain claimed | the general "synonyms" source most projects want |

`opencues list` surfaces each source's routing role (`domain` / `default`). `opencues validate` warns when:
- No default exists (every word-alts config path → silent drop)
- Two or more defaults exist at the same priority (non-deterministic tie-break)

---

## Routing rules (per word)

For one highlighted word:

1. **Try each domain source in priority-descending order.** First entry whose `match:` regex hits the word OR whose `keywords:` list contains the word (case-insensitive) wins.
2. **If no domain matched**, use the highest-priority default.
3. **If no default exists**, the word gets no cue and isn't navigable.

Step 3 is intentional. It lets you build opt-in projects (e.g. "only legal terms get alternatives") without needing a catch-all.

### Examples

Given this config:

```yaml
### synonym     # no match, no keywords       → DEFAULT
parser: alternatives
priority: 50

### legal       # keywords:                   → DOMAIN
parser: alternatives
keywords: contract, plaintiff, tort
priority: 70

### medical     # match:                      → DOMAIN
parser: alternatives
match: \b(diagnosis|prescription|symptom)\b
priority: 70
```

| Word | Routed to | Why |
|---|---|---|
| `happy` | synonym | no domain hit → default |
| `contract` | legal | keyword hit |
| `diagnosis` | medical | regex hit |
| `plaintiff` | legal | keyword hit |
| `synced` | synonym | no domain hit → default |

Drop the `### synonym` section and `happy` / `synced` silently disappear (no cue). That's the opt-in pattern.

---

## Multi-word dispatch

For a text with N highlighted words:

1. Route each word to one source (or skip if no match + no default).
2. Group words by destination source.
3. Dispatch **one LLM call per group, in parallel** (`Promise.all`). Each call sees a sub-context containing only its own words, renumbered 0..k.
4. Map the results' indices back to the original word positions before returning.

For "the contract shall indemnify the diagnosis", that's:
- 1 call to `legal` for `[contract, indemnify]` (if you have a legal `match:` covering `indemnify`)
- 1 call to `medical` for `[diagnosis]`
- 1 call to `synonym` for `[the, shall, the]` *(if stopword filtering is off — otherwise those drop earlier)*

...dispatched simultaneously. Latency is `max(calls)`, not `sum(calls)`.

---

## Why not combine into one prompt?

The previous model (`combineWordSources`, now deprecated) merged every source's prompt body into one giant prompt, passed the whole thing + all words to the LLM, and parsed one response. Two structural problems:

1. **Cross-contamination.** A sloppy or hijacking prompt in one source poisoned ALL words. During sync-demo testing, a prompt of the form *"always output exactly: bundled, deployed, shipped"* caused every word in the input to come back as those three words — including `happy`, which should have been routed to `synonym`. Per-word dispatch structurally prevents this: a prompt can only affect words its source is called for.
2. **Scale.** Combined prompts grow linearly with source count and start confusing the LLM at ~5+ domains. Per-source calls keep each prompt small and focused.

Isolation is the same reason blanks have always used `ClassifiedSourceGroup`. Word-alts now follow suit.

---

## Where the routing is enforced

| Surface | What it does |
|---|---|
| `@opencues/core` `RoutedWordSourceGroup` | The runtime class. Classifies words, groups by source, dispatches calls. |
| `buildSourcesFromConfig` | Takes every `### alternatives` section and wraps them in ONE `RoutedWordSourceGroup`. |
| `opencues list` | Marks each word-alts source `domain` or `default` so the routing is visible at a glance. |
| `opencues validate` | Warns on zero defaults + on multi-default priority ties. |
| `cues.md` / `new/cue.md` templates | Teach the distinction at scaffold time so users don't learn it from a warning. |

---

## API

`@opencues/core`:

```ts
import { RoutedWordSourceGroup, ConfigSource } from '@opencues/core';

const group = new RoutedWordSourceGroup({
  id: 'word-alts',
  sources: [synonymConfig, legalConfig, medicalConfig],  // all ConfigSource
});

// Route one word (used by list + validate for diagnostics):
group.classify('contract');   // → legalConfig
group.classify('happy');      // → synonymConfig (falls through to default)
group.classify('plaintiff');  // → legalConfig
group.routingStats;           // → { domains: 2, defaults: 1 }

// Normal use: the resolver calls .getCues() with the full context.
const result = await group.getCues(context);
// → one dispatch per destination source, results index-remapped to `context.words`.
```

| Method / getter | Returns |
|---|---|
| `classify(word)` | The `ConfigSource` that would handle this word, or `null` if none. |
| `supports(context)` | `true` iff the context has at least one non-blank word. |
| `getCues(context)` | Dispatches per-group LLM calls, flattens + remaps results. |
| `routingStats` | `{ domains: N, defaults: M }` for diagnostics. |

---

## Design principle

The OpenStandard's word-alt model:

> **Classify each word to one source, dispatch in isolation, let priority break ties.**

Same rules as blanks. Same resolution order. Same enforcement surfaces (validate, list, templates). Keeping the two models parallel means one mental model covers the whole standard.
