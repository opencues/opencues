# Word-Cue Routing

Every `### alternatives` section in `CUES.md` (or folder-based `cues/<name>/CUE.md`) becomes one cue source. OpenCues routes **each highlighted word** to exactly ONE of those sources at resolve time. A project's source set is a small routing table, not one giant merged prompt.

Routing is purely fast-path: each word is matched against per-source `match:` regex / `keywords:` list, and the highest-priority match wins. No LLM classifier — the dispatch decision is made deterministically before any prompt is sent.

---

## Every source must declare its scope

The rule is one line:

> **Every word-cue source MUST set `match:` (regex) or `keywords:` (list).** Sources without either are dropped at runtime.

Catch-all "default" sources are not supported — there is no implicit fall-through that colours every word. If you really want one, declare it explicitly: `match: .*`. That makes the catch-all visible in `opencues list` and `opencues validate` rather than hidden behind a flag.

`opencues validate` warns when a word-cue source declares neither `match:` nor `keywords:`.

---

## Routing rules (per word)

For one highlighted word:

1. **Try each source in priority-descending order.** First entry whose `match:` regex hits the word OR whose `keywords:` list contains the word (case-insensitive) wins.
2. **If no source matched**, the word gets no cue and isn't navigable.

Step 2 is intentional. It lets you build opt-in projects (e.g. "only legal terms get alternatives") without a catch-all needing to fire.

### Examples

Given this config:

```yaml
### legal       # keywords:                    → claims listed words
parser: alternatives
keywords: contract, plaintiff, tort
priority: 70

### medical     # match:                       → claims regex hits
parser: alternatives
match: \b(diagnosis|prescription|symptom)\b
priority: 70
```

| Word | Routed to | Why |
|---|---|---|
| `happy` | (none) | no source claims it → no cue |
| `contract` | legal | keyword hit |
| `diagnosis` | medical | regex hit |
| `plaintiff` | legal | keyword hit |

To make `happy` colour, add a source with `match: .*` (catch-all) or expand a domain's `keywords:` to include it.

---

## Multi-word dispatch

For a text with N highlighted words:

1. Route each word to one source (or skip if no match).
2. Group words by destination source.
3. Dispatch **one LLM call per group, in parallel** (`Promise.all`). Each call sees a sub-context containing only its own words, renumbered 0..k.
4. Map the results' indices back to the original word positions before returning.

For "the contract shall indemnify the diagnosis", that's:
- 1 call to `legal` for `[contract, indemnify]` (if legal's `match:` covers `indemnify`)
- 1 call to `medical` for `[diagnosis]`

…dispatched simultaneously. Latency is `max(calls)`, not `sum(calls)`. Words like `the`/`shall` get no cue (no source claims them).

---

## Why per-word dispatch

Per-word dispatch is structural isolation. Two properties fall out of it:

1. **Cross-contamination is impossible.** A sloppy or hijacking prompt in one source can only affect words its source is called for. A prompt of the form `"always output exactly: bundled, deployed, shipped"` only ever colours words that match its `match:` / `keywords:`.
2. **Prompts stay small.** Each LLM call carries one source's prompt and the words destined for it. Total prompt size doesn't grow with the number of registered sources.

Isolation is the structural property that matters.

---

## Where the routing is enforced

| Surface | What it does |
|---|---|
| `@opencues/core` `RoutedWordSourceGroup` | The runtime class. Classifies words, groups by source, dispatches calls. Drops sources with neither match nor keywords. |
| `buildSourcesFromConfig` | Takes every `### alternatives` section, drops un-routable ones, wraps the rest in ONE `RoutedWordSourceGroup`. |
| `opencues validate` | Warns on word-cue sources that declare neither `match:` nor `keywords:` (would silently drop). |
| `CUES.md` / `new/cue.md` templates | Teach the requirement at scaffold time. |

---

## API

`@opencues/core`:

```ts
import { RoutedWordSourceGroup, ConfigSource } from '@opencues/core';

const group = new RoutedWordSourceGroup({
  id: 'word-cues',
  sources: [legalConfig, medicalConfig],  // all ConfigSource
});

// Route one word (used by validate for diagnostics):
group.classify('contract');   // → legalConfig
group.classify('happy');      // → null (no source claims it)
group.classify('plaintiff');  // → legalConfig
group.routingStats;           // → { sources: 2 }

// Normal use: the resolver calls .getCues() with the full context.
const result = await group.getCues(context);
// → one dispatch per destination source, results index-remapped to `context.words`.
```

| Method / getter | Returns |
|---|---|
| `classify(word)` | The `ConfigSource` that would handle this word, or `null` if none. |
| `supports(context)` | `true` iff the context has at least one non-blank word. |
| `getCues(context)` | Dispatches per-group LLM calls, flattens + remaps results. |
| `routingStats` | `{ sources: N }` for diagnostics. |

---

## Design principle

The OpenStandard's word-cue model:

> **Classify each word to one source, dispatch in isolation, let priority break ties.**

Same rules as blanks. Same resolution order. Same enforcement surfaces (validate, templates). Keeping the two models parallel means one mental model covers the whole standard.
