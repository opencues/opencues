# 04 — Inline Cues (Continuous Onboarding)

For blog post #3: "Inline Cues (Continuous Onboarding)".

## What "cue" means here

A **Cue** is the LLM-→-user direction: as you type, the system dims words
that have alternatives. Press Ctrl+Alt+Right to navigate to a dim word; press
Up/Down to cycle through alternatives. Status line shows a tip when a word
is highlighted.

From the glossary:
> **Cue** — The complete package: a word that OpenCues has enriched with
> alternatives, a tip, linked behaviour, or other functionality. When someone
> says "I added a cue for ultrathink," they mean the word now appears
> indicated and has OpenCues functionality behind it.
>
> **Indicated Cue** — The visual signal within the text that a cue exists.
> For example, a word appearing dimmed signals that alternatives and other
> information are available.

## Cue-tips: the continuous-onboarding hook

This is the angle for the "continuous onboarding" framing. A **cue-tip**
appears in the secondary display (status line, tooltip, hover panel —
host-dependent) when a word is highlighted. Concrete example from
`defaults/cues/extended-thinking/CUE.md`:

```yaml
words:
  ultrathink:
    tip: "Add ultrathink to prompt for max reasoning"
    alts: ["Tab", "deep thinking"]
```

Type "ultrathink" in Claude Code → the word dims → arrow over to it → status
line says **"Add ultrathink to prompt for max reasoning"**. You learn what
the word does *while using it*, in the input field, without leaving your
flow.

That's continuous onboarding. The system teaches you about itself in-context,
*as a side effect* of you using it.

### Where this differs from traditional onboarding

- **Tooltips on buttons** require the user to hover something they don't yet
  know exists.
- **Documentation pages** require the user to leave the workflow.
- **Cue-tips** fire on words the user has already typed — the user is
  already engaged with the relevant concept.

## Two cue source types

### 1. Local cues (instant, ~0ms)

Static dictionaries — JSON in the body of a `cue.md` file, loaded once,
hot-reloaded on file change. No LLM call.

Used for:
- "Tips" (claude-code commands, extended-thinking words, etc.)
- Curated synonyms for known words
- Spell-correction-style cues

Latency: under 1ms. The user sees them immediately as they type.

### 2. Remote cues (LLM, ~200-500ms)

Each `cues/<name>/CUE.md` with a `match:` regex or `keywords:` list becomes a
`ConfigSource`. After a debounced pause in typing, eligible words batch into
a parallel LLM call.

Used for:
- Domain synonyms (legal, medical, financial)
- Style variants
- Grammar alternatives

## Per-word routing (the architectural piece)

This is critical to understand. From `CLAUDE.md`:

> Every `### alternatives` section in `CUES.md` (or `cues/<name>/CUE.md`)
> becomes one `ConfigSource`. `buildSourcesFromConfig` wraps the whole set
> in ONE `RoutedWordSourceGroup` that dispatches each highlighted word to
> exactly one child source — never combines them into a giant prompt.

Routing rules:

```
match: <regex> OR keywords: <list>     → DOMAIN  (only fires for matches)
neither match: nor keywords:           → DEFAULT (catches everything else)
```

For each word: highest-priority domain whose match/keyword hits the word
wins; otherwise highest-priority default; otherwise no cue (word isn't
navigable). Words destined for the same source batch into one parallel LLM
call.

**Why this matters for HCI:**

1. **Predictability.** Each word has a deterministic source. No "which model
   answered this?" mystery.
2. **Isolation.** A bad config in the `legal` source can't poison the
   `medical` source. From `CLAUDE.md`: "Sync-demo's 'always output bundled,
   deployed, shipped' used to swap `happy → bundled`. With routing, that
   prompt only affects words its source is called for."
3. **Batching.** Words destined for the same source are sent in one LLM
   call. O(sources), not O(words).

## Cycling — the actual interaction

Once a word is dimmed and you've navigated to it (Ctrl+Alt+Right):

```
Up    → next alternative
Down  → previous alternative
       (wraps at the ends)
```

Cycle progress is **persistent through edits**:

- **Resolver Skip Filter:** once you cycle `attorney → lawyer`, the LLM is
  *not* re-asked about "lawyer" on the next pulse. Without this, the resolver
  would silently swap your alt track to a "lawyer"-themed one. Saves tokens
  AND prevents drift.
- **Deterministic Relocate:** type "Yesterday " in front of a sentence with
  cycled words, and the cycle progress *follows the words to their new
  index*. Only relocates when the match is unambiguous.

These two features — Skip Filter + Deterministic Relocate — together
preserve "what the user has already chosen" through edits. That preservation
is essential to flow state. (See [`11-flow-state-mechanisms.md`](11-flow-state-mechanisms.md).)

## Linked words — agreement preservation

Some words must change together for grammatical agreement. If "boy" → "girl"
changes, "his" should also change to "her". The runtime tracks linked words
as a unit; cycling one cycles all linked partners automatically.

Configured per-source via the `linked:` field on the LLM response.

## Multi-word spans

A cycling alternative can span multiple words. "very good" → "excellent"
(span shrinks 2→1). "Sundar Pichai" tracked as one cycling unit (span = 2).
**N spans concurrent** — multiple spans live independently in the same
input.

## The HCI angle (for the blog post)

1. **Continuous onboarding through ambient hints.** The user is teaching
   themselves about the tool without ever opening documentation. Tips appear
   for words they're using, in the moment they're using them.

2. **Suggestion without commitment.** Cues offer alternatives the user *did
   not ask for*. The visual surface (a dim) is low-friction — the user can
   ignore it entirely. No popup. No interrupt. No modal. Just a slightly
   dimmer pixel.

3. **Cycling preserves flow.** No "picker" UI. No menu. Up/Down cycles in
   place. The hand never leaves the typing position.

4. **Per-word routing surfaces the right voice.** A medical writer types
   "myocardial" and gets medical-tone alternatives; a lawyer types "tort"
   and gets legal-tone alternatives. The system disambiguates *by content*,
   not by the user explicitly switching modes.

## Pitfalls and trade-offs

- **LLM latency is invisible-but-real.** ~200-500ms per pulse. The dim
  appearing late doesn't break anything (it's seconds-budget), but it can
  feel "off" if pulses are missed.
- **The default-source rule is strict.** Authors used to overlapping cue
  sources have to learn "one source per word, deterministic by priority."
  The validator catches multi-default ties.
- **Tip authoring quality is the constraint.** Bad tips train users to
  ignore the status line. Good tips reward the navigation gesture.

## Where this material lives

- `concept.md` — the two-direction core
- `damon.md` — diagrams of the "Cue → highlight → navigate → cycle" flow
- `docs/glossary.md` — Cue / Indicated Cue / Cue-Tip / Linked Words /
  Multi-Word Group / Local Cues / Remote Cues / RoutedWordSourceGroup
- `docs/features/word-cue-routing.md` — full per-word routing spec
- `docs/features/local-cues.md`, `remote-cues.md`, `cycling.md`,
  `linked-words.md`, `multi-word-spans.md`
- `CLAUDE.md` § "Word-alt routing — DEFAULT vs DOMAIN sources"

## Quotable lines

- "Real-time guidance as you type."
- "Every word gets ONE source."
- "Cues offer alternatives the user didn't ask for."
- The system "mirrors how humans give non-verbal cues during conversation —
  nudges, indications, and context — applied to text."
- "Words destined for the same source batch into one parallel LLM call."
