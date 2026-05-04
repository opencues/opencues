# 00 — Foundations: Cues and Blanks

> The whole system reduces to two ideas. Everything else is implementation.
> *— `concept.md` opening line*

This is the conceptual spine of OpenCues. Almost every blog post about the project
will lean on it. Read this first.

## The two directions of intent

| Direction | Surface | Trigger | What it is |
|---|---|---|---|
| **LLM → you** | **Cues** (highlights) | plain text | The LLM offers alternatives you didn't ask for |
| **you → system** | **Blanks** (substitutions) | text containing `_` | You explicitly summon a value into a slot |

That's it. Every feature in OpenCues is one of these two things, dressed up.

## Why the split matters (the contracts)

The two surfaces have **fundamentally different contracts**:

| Property | Cues | Blanks |
|---|---|---|
| User intent | implicit (LLM proposes) | explicit (user summoned) |
| Failure mode | invisible (skip the cycling) | visible (`_` stays unfilled) |
| Latency budget | seconds (you might never look) | sub-second (you're waiting) |
| Determinism | best-effort (LLM judgement) | required (must succeed or fail clearly) |
| External state | none — LLM-only | the entire reason `_` exists |

**Pithy framing (worth quoting):**
> `_` for anything that touches the world. Plain text is LLM-only. Nothing else.

That single sentence is the most compressed statement of the whole architecture.

## What follows from the split

- **Cues** never touch external state. They only ever propose alternatives via LLM
  on plain text. If the LLM is slow or wrong, you don't notice — the dim just
  doesn't appear. Failure is invisible. That permits seconds of latency budget.
- **Blanks** always touch external state. The `_` is a *visible* commitment: a
  pixel-rendered question mark sitting in your text. If the system doesn't fill
  it, you can see it didn't fill. So failure must be visible, and latency must
  be sub-second.
- **Routing** is symmetric. Each plain word gets exactly ONE cue source (domain
  match wins, default catches the rest). Each `_` gets exactly ONE blank
  (keyword match wins, fluid catches the rest). No combining, no overlap.

## Non-extension points (deliberately removed)

These aren't "missing features" — they're shapes the system *refuses* to take. From
`concept.md`:

- ❌ **Word-cycling without `_`** — typing "volume" and pressing Up to call a script.
  Rejected: all external state is `_`-gated.
- ❌ **Numeric stepping on plain words** — "15.5f" → "16.0f". Rejected: too easy
  to fire by accident; ambiguous which number is the user's target.
- ❌ **Catch-everything default word-cues** — every cue source must declare
  `match:` or `keywords:`. No implicit catch-all. (You can opt-in with
  `match: .*` if you really want one.)
- ❌ **Classifier-routed blanks** — fluid-blank covers the territory. The legacy
  `ClassifiedSourceGroup` was removed entirely.

## The HCI angle

This is the rich vein:

1. **Direction of intent is an HCI primitive.** Most text-input systems
   conflate "the system suggests" and "the user requests" into a single
   autocomplete affordance. OpenCues separates them at the architectural level.
   That separation is what lets the two surfaces have different latency
   budgets, different failure modes, different commitment semantics.

2. **The `_` is a literal placeholder for user intent.** It mirrors the
   underscore in language exercises ("fill in the blank"). The user is
   *cueing the system* — same word, opposite direction.

3. **Glossary excerpt — "Never draw a blank":**
   *"Think of blanks as user-placed autocomplete. Unlike traditional
   autocomplete that guesses what comes next, blanks let you decide
   where the completion appears."*

   That reframe — autocomplete-the-user-controls vs. autocomplete-the-system-
   controls — is genuinely novel as an interaction primitive.

4. **Re-evaluation contract.** Blanks are *re-evaluated on every edit*. A blank
   value is never permanent — the surrounding text changing means the blank
   re-asks. This is unusual; most "fill" operations are commit-once.

## Where this material lives

- `concept.md` — the canonical 75-line writeup
- `docs/glossary.md` — the "Cues" / "Blanks" / "Cue-Blanks" entries
- `damon.md` — the "system overview" version with diagrams
- `openstandard-notes.md § 1` — the spec-flavoured framing

## Quotable lines

- "The whole system reduces to two ideas. Everything else is implementation."
- "`_` for anything that touches the world. Plain text is LLM-only. Nothing else."
- "Cues and blanks are sibling concepts, not subtypes."
- "Think of blanks as user-placed autocomplete."
- "Never draw a blank."
- "Cues mirror how humans give non-verbal cues during conversation — nudges,
  indications, and context — applied to text."
