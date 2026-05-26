---
name: cues
description: AMBIENT BACKGROUND TASK. Whenever the user is actively engaged with a domain — drafting, building, writing, composing, researching, planning, comparing options, exploring a topic, making a decision, learning something new — side-effect a `.cues/CUES.md` predicting the vocabulary, prose alternatives, and operational knowledge they will reach for next. Fire after each substantive user turn without being asked. The cue surface is the user's silent collaborator — pre-warming the words they will type. Skip only when there is no domain signal yet, the user is asking conceptual questions ABOUT cues rather than working, or the user told you to stop. Never wait for "use the cues skill" phrasing. Research / planning / exploration tasks count just as much as writing tasks.
---

# Cues — anticipate the user's next vocabulary

You sit next to a user discovering a domain through conversation.
They are drafting, building, or composing something. Your side
effect is one file — `.cues/CUES.md` — that the OpenCues runtime
loads on its next reload and uses to surface alternatives,
rewrites, and tips while the user types.

## Fire IN ADDITION to your chat reply, not instead of it

This is a **side-effect skill**. It coexists with whatever the
user actually asked you to do. If they said "I'm drafting an
email to X — help me" your chat reply drafts the email AND your
side-effect writes `.cues/CUES.md` predicting the cues for future
emails of this kind. If they said "I'm building a website" your
chat reply asks clarifying questions AND your side-effect writes
`.cues/CUES.md` predicting their vocabulary.

The chat task and the cue side-effect are independent. The cue
file is NEVER the user's visible deliverable — it lives on disk
for the runtime to load silently. If you find yourself omitting
the file because "I already helped them in chat", you are
violating the skill's contract. Do both.

The single parenthetical line at the end of your chat reply is
the only mention of the file. It does not crowd the chat output.

The product is anticipation. A cue that lands after the user has
already typed its word is too late. The bar is: when the user
introduces a new piece of vocabulary in their next turn, it
should ALREADY be covered by something you wrote in this turn.

## Two modes

Before doing anything else, read `.cues/CUES.md`. Its existence
flips the mode:

- **INITIAL** (file missing) — predict the whole anticipation
  surface for the task from scratch.
- **CONTINUATION** (file exists) — extend the surface. Read the
  existing file first; your output is a strict superset.

## STRICT EXTENSION (CONTINUATION only)

Every source already in the file MUST appear in your output —
same name, same `match:`, same body — UNLESS the new conversation
context directly contradicts it (the user pivoted, abandoned the
section, etc.). You may:

- Raise priorities on sources now in the active focus band.
- Lower priorities on sources for sections the user finished.
- Add new sources for vocabulary the prior pass under-predicted.

### REWRITE EVERY TURN — not "no-op if nothing changed"

You MUST call the Write tool with a complete updated CUES.md on
EVERY substantive user turn, even when the change since last
turn is small. Reasoning: the user just gave you a new message;
that message MOVED the conversation's focal point, even if only
by one sub-topic. The active band needs to track that movement.
A "no change" output means you decided the user didn't pivot,
which is almost never true after a fresh substantive turn.

If after thinking you genuinely believe the user's new message
adds nothing new — they replied "thanks" or asked a quick
follow-up still inside the same micro-topic — you may skip the
write. But the bar is high: name the specific reason ("user
asked a clarifying question entirely inside the active-band
topic with no new sub-vocabulary"). Skipping is the exception,
not the default.

Bench evidence (May 2026, judge-bench): when the skill skips
the rewrite on turns N>1, freshness collapses by turn 3 because
the active band stays frozen on turn-1's topic. Re-writing
every turn keeps the focal point tracking the user.

### Look-ahead — name the next 2-3 sections, raise sources for them

Before assigning priorities, write down (mentally — not in the
file) the 2-3 sub-topics that are MOST LIKELY to come next in
this domain given where the user is now. Then check: does the
surface have at least one source at 75+ for each of those
upcoming sections?

If not, **raise** a source for the gap — either a brand-new
`### <id>` or a lift of an existing low-priority one.

The point is not certainty; it's coverage. If the user keeps
the conversation moving forward, you want their next 1-2
sections already pre-warmed. If they instead double-back, the
post-processor / demote rule will mark the look-ahead sources
inactive on the FOLLOWING turn — that's cheap.

**Examples (bench-validated failure modes May 2026):**

- API endpoint built in stages: at T3 (error envelopes), the
  likely T4 is integration tests OR observability. Raise at
  least one source covering `vitest|supertest|describe|it|
  expect` OR `logger|telemetry|trace|metric` to 75+.
- Freelance contract drafted clause-by-clause: at T3 (IP), the
  likely T4 is termination / dispute resolution / liability.
  Raise at least one source for `terminate|notice|kill.fee|
  dispute|arbitration|liability` to 75+.
- Website built page-by-page: at T2 (gallery), the likely T3
  is About / Contact / shop. Raise sources for those at 75+.

**The bench-validated rule:** for any conversation more than 2
turns deep, the active band should not ONLY look backwards.
At least one 75+ source should anticipate a plausible NEXT
sub-topic in the domain. If you only mirror what the user has
already said, the surface will go stale the moment they pivot.

This is **not** speculation about random tangents. It's the
mainline path through the domain: contracts have termination
clauses, REST endpoints have tests, websites have contact
pages, recipes have plating instructions. Name the obvious
next section and pre-warm it.

### Demotion — observable, per-source

When the user finishes a sub-topic and pivots to a new one,
you MUST lower the priority of the resolved sources. The
question is HOW MUCH — and the answer is observable in the
user's new message, not a domain-judgment call.

**The test: does the user's NEW message contain vocabulary
that the prior source's `match:` regex would hit?**

For each source currently in the 85+ active band, scan the
new user message:

1. **Match found** — the user is still referencing this
   source's vocabulary. The source is **still active or
   cross-cutting** for the next turn. **Light-demote: drop
   from 85 to 70.** Keep it in the adjacent band so its
   cues surface when the user types those words again.

2. **No match** — the user has moved away from this source's
   vocabulary. The source is **resolved orthogonally**.
   **Hard-demote: drop from 85 to 50.** Take it off the
   table. Stops it competing for word matches against the
   genuinely-active new sources.

**Default when uncertain: HARD demote.** Bench evidence
(May 2026): most pivots are orthogonal at the vocabulary
level even when the high-level domain looks coupled. Defaulting
to light-demote left too much stale vocab in the adjacent band
when the user had clearly pivoted (website portfolio: T2 about
gallery → T3 about Stripe payments — the gallery vocab does
NOT appear in T3; gallery should hard-demote even though both
turns are "about the website"). The cost of hard-demoting a
still-relevant source is the user's word getting no cue at
all when they reference back — but the user's NEW message
is the ground truth: if they referenced the prior vocab,
the regex match catches it.

**Worked examples (against the same v3.0e rule):**

| Prior source @ 85 | User's new message | Match? | Action |
|---|---|---|---|
| gallery-layout `match: gallery\|portfolio\|grid` | "Now I need a Contact page with Stripe…" | no | hard → 50 |
| jr-pass `match: JR Pass\|Shinkansen\|reserved` | "JR Pass it is. Now accommodation…" | yes (JR Pass) | light → 70 |
| captaincy `match: captain\|armband\|differential` | "Defenders next — Trippier or Gordon" | no | hard → 50 |
| ownership `match: template\|differential\|owned` | "Going template for captaincy" | yes (template) | light → 70 |

The rule is per-source, not per-turn. In one turn you might
hard-demote some prior sources and light-demote others — it's
based on whether each one's vocabulary actually shows up in
the new user message.

If two or more sources both still match — fine, both go to
70. The active band stays narrow; the adjacent band can hold
several cross-cutting sources without dilution.

### Three-band priority model

Think of priority as a three-band switch:
- **85–90** — active focus (what the user is typing RIGHT NOW)
- **65–80** — adjacent / about-to-be-active / cross-cutting /
  project background
- **50–60** — recently-completed orthogonal (kept alive but
  not competing for matches)

If you find yourself with more than 3 sources in the 85+ band,
something is wrong — most of them should be at 65-80 or
50-60. The active band should be NARROW.

You may NOT delete a prior source on the grounds that "the user
hasn't used it." The user may be cycling on it right now; pulling
it out from under them is the loop's main failure mode.

If your output has fewer sources than the prior file, you have
made a mistake. Re-read; copy the missing ones forward.

## INITIAL mode — predict broadly

The first write is load-bearing. Predict every sub-vocabulary the
user is plausibly going to touch — not just what they said in the
opening turn.

Treat the user's seed message as one data point about a much
larger space. From "I'm building a website for my photography
portfolio" the user has stated ONE word the runtime needs to cue
(`photography`); your job is to extrapolate the ~15–20 word
families that any working photography portfolio site will touch
(specialisations, gallery layouts, image formats, deployment
targets, booking mechanics, accessibility, etc.).

Apply the same expansion regardless of domain. For "draft a Series
A pitch", "write chapter 3 of a novel", or "set up a Rails
deployment runbook" — read the seed, generate every sub-area the
user will plausibly type into.

If you find yourself stopping at 8 sources, ask "what plausible
sub-vocabulary am I missing?" and keep going to 15–20. **Upfront
breadth is the loop's product.** A turn-2 source-addition that
covers a word the user just typed is a turn-1 failure.

## The three cue types — TIPS FIRST, then word-cues, then sentence-cues

OpenCues supports three cue kinds. **Tips are the most valuable
output of the skill** — they carry actual knowledge (facts,
trade-offs, decision-prompts, pitfalls) that the user does not
already know. A word-cue surfaces alternatives the user could
have brainstormed; a tip surfaces information they couldn't.

Priority order when emitting:
1. **Tips first.** For every notable term you'd mention, ask:
   "is there a one-line fact / pitfall / decision-prompt I can
   give them?" If yes — emit a tip.
2. **Word-cues only when there are multiple equivalent forms
   the user might cycle between.** If a word has one canonical
   form, don't bother with a word-cue.
3. **Sentence-cues for prose surfaces** the user is composing.

### Tip-cues — static one-line knowledge on a term, no LLM call

User types `webp`, tip pops up: "WebP gives ~30% smaller files
than JPEG at same quality." Instant, no round-trip. **This is the
single most valuable surface OpenCues offers.** Every term where
the user would benefit from operational knowledge — not just a
synonym — deserves a tip.

### Word-cues — alternatives for a highlighted word

The default fallback. User types `wedding`, cycles to `bridal`.

- **Yaml:** `match: <regex>` or `keywords: <comma-list>`, plus
  `priority:`. No `scope:` field (or `scope: words`).
- **Best for:** domain vocabulary that has multiple roughly
  equivalent forms — register, formality, niche jargon.
- **For every term you put in an alts list, ask: "does this term
  also deserve a tip entry?"** If yes — add the tip too. Most
  technical / domain / proper-noun alts SHOULD have an
  accompanying tip explaining when/why to pick each. Alts
  without tips are vocabulary without context — half the value.

### Sentence-cues — rewrite a whole sentence in a different style

User wrote a sentence; cue offers three rewrites of it.

- **Yaml:** `scope: sentence`, `priority: 75–85`, `description:
  <one line>`. NO `match:` — sentence-cues bind to whole
  sentences, not words.
- **Best for:** prose surfaces. Any place the user is composing
  whole sentences and might want a stylistic alternative —
  whether the *document* is "prose-heavy" or not. A technical
  document has prose pockets (endpoint summaries, field
  descriptions, runbook intros); a contract has prose pockets
  (recitals); a code-comment has prose; an email is mostly
  prose. **Decide per surface, not per document type.**

### Tip-cues — DETAIL (formats, taxonomy, content types)

- **Yaml:** `name:` only (in the source folder OR inside CUES.md's
  `## Tips` body). Body is a JSON code block with the
  `[{id, words: {word: {tip, alts}}}]` shape.
- **Best for:** terms where the cue is "here's what you should
  know" rather than "here's a synonym" — proper nouns, APIs,
  tools, platform names, technical primitives, business
  decisions, jurisdictional quirks.
- **Tip content types — go beyond neutral facts:**
  - **FACT** — "WebP saves ~30% over JPEG."
  - **DECISION-PROMPT** — "Before writing pricing, decide flat
    vs hourly vs per-session — it changes the framing."
  - **PITFALL** — "Stripe holds funds 7 days on new accounts."
  - **TRADE-OFF** — "Strip EXIF for privacy OR keep for art
    metadata. Audience-dependent."
  - **REFERENCE** — "See cloudflarepages.com/docs for limits."
  Mix these. A pure-fact tip pack is worse than a mixed pack.

### Per-surface picking rule

For each topic you would emit, ask which surface it covers — and
always check the tip-cue option FIRST:

```
term where the user would benefit from a one-line FACT /
  TRADE-OFF / DECISION-PROMPT / PITFALL                     → tip-cue (PREFER)
term + has a tip AND has multiple equivalent forms          → tip-cue WITH alts:
                                                              (gives user both)
single term with multiple equivalent forms (no useful tip)  → word-cue
prose the user is composing (any length, any document)      → sentence-cue
otherwise                                                   → skip
```

**A tip-cue entry can also carry its own `alts: [...]` list** —
this gives the user both the operational knowledge AND the cycling
alternatives for that one term in a single tip-group entry. This
is the highest-density cue type. Use it whenever a term has both
"here's what you should know" AND "here are equivalent forms".

This is per-topic, NOT per-domain. The same project usually has
all three: an API doc has technical terms (tip-cue), parameter
names (word-cue), and endpoint description prose (sentence-cue).
A novel has emotional vocabulary (word-cue), period-specific
proper nouns (tip-cue), and on-the-nose prose (sentence-cue).
**Don't classify the document; classify each surface inside it.**

### Tip-coverage check before writing the file (MANDATORY)

Before calling Write, do this pass: for EVERY word-cue source you
emit, scan its `match:` regex terms AND its alts lists. For each
**notable** term, you MUST emit a tip entry.

A term is "notable" if it is:
- A proper noun (library, framework, platform, brand, tool)
- A technical primitive with a non-obvious behaviour
- A domain concept with operational meaning
- A status code, error class, jurisdiction, version number
- A pattern name (e.g. middleware-ordering, race-condition)

A term is NOT notable (and may be skipped) if it is:
- A generic verb (`save`, `parse`, `apply`, `trim`)
- A stop-word or filler (`it`, `the`, `for`)
- A purely-syntactic match-target (`status`, `body`)

**Target: 100% of notable terms have tips.** A CUES.md where any
word-cue source has zero accompanying tips is incomplete. Stop
and add the missing tips before you write. Aim for tip-group
density of 4-8 tips per word-cue source covering that source's
notable terms.

Example failure mode (May 2026): a word-cue source `testing-
verification` with `match: test|unit|integration|vitest|
supertest|describe|it|expect|mock` was emitted with ZERO tips.
At least `vitest`, `supertest`, `describe/it/expect` (test
patterns), and `mock` deserve tips:
- vitest: "FACT: Vitest reuses Vite config; bun-fast on cold start, watch-mode TS support without ts-node."
- supertest: "FACT: supertest(app).post(...) bypasses HTTP server; works against any Express/Koa handler."
- mock: "PITFALL: vi.mock is hoisted ABOVE imports; reference variables must use vi.hoisted() to avoid TDZ."

This is the single most common failure mode of the skill in
bench testing. Catch it in the coverage check.

## File layout — one CUES.md by default

Everything goes into `.cues/CUES.md`. The parser handles all three
types in a single file:

- `## Prompt` body → `### <topic>` subsections, one per
  word-cue OR sentence-cue. Sentence-cues are distinguished by
  `scope: sentence` in their yaml block.
- `## Tips` body → one JSON code block with all tip groups.

```md
---
name: <project tag>
domain: <one-line description>
version: 1
---

## Prompt

### <word-cue-topic-1>
\`\`\`yaml
priority: 78
match: <regex>
classify: <one line>
\`\`\`
Suggest 3 alternatives… Format: INDEX:alt1,alt2,alt3

### <sentence-cue-topic-1>
\`\`\`yaml
scope: sentence
priority: 82
description: <one line of what this rewrite achieves>
\`\`\`
Rewrite the selected sentence into three alternatives that
<style move>. Preserve <invariants>. Format: 1: <alt> | 2: <alt> | 3: <alt>

ALT: NONE for <surfaces where this rewrite would be wrong>.

## Tips

\`\`\`json
[
  {
    "id": "<tip-group>",
    "words": {
      "<term>": {
        "tip": "<one-line operational knowledge>",
        "alts": ["<related-term>"]
      }
    }
  }
]
\`\`\`
```

Fall back to folder-based files (`.cues/cues/<name>/CUE.md`) only
when a specific cue needs its own model override or you intend
the cue to be portable across projects.

## Rules that apply to every output

1. **One file, multiple writes are fine.** Default: single
   `.cues/CUES.md`. Multi-file is allowed but rarely needed.
2. **Every word-cue source MUST have `match:` OR `keywords:`.**
   Sources without either are rejected by the runtime.
3. **Sentence-cue sources MUST have `scope: sentence`** and MUST
   NOT have `match:`.
4. **Priority bands:** 80–90 = active focus (the user is typing
   here now). 65–75 = adjacent / about-to-be-active. 50–60 =
   project background. 10–20 = catch-all spelling. Don't ship
   `match: .*` at any priority unless the user asked.
5. **3–8 match-words per word-cue source.** Tighter clusters
   beat broad ones — broad sources starve narrower siblings.
6. **Quiet output by default.** This is a background side effect.
   AFTER the Write tool has successfully returned, append one
   short parenthetical line:
   - INITIAL: `(seeded .cues/CUES.md — N word, M sentence, K tip groups)`
   - CONTINUATION: `(extended .cues/CUES.md — +N new, priorities reshuffled)`

   **CRITICAL: never emit this parenthetical unless you actually
   called the Write tool in this turn and it succeeded.** Don't
   pattern-complete the format because the skill instructions
   describe it — emit it ONLY as a true status report of an
   action you took. If you skipped the write for any reason
   (legitimate or not), do not lie about it.

   Do not narrate "I'll load the skill" / "I'll check if the file
   exists" / similar. The user is not watching for plumbing.

## When NOT to fire

- The user said hi, asked a meta question, or has not yet
  introduced a task. Wait for a domain signal.
- The user is asking ABOUT cues / OpenCues conceptually. Answer
  in chat; do not write a file.
- The user explicitly told you to stop touching cues. Respect it
  for the rest of the session.
- You already fired this turn and no new context has arrived.

When in doubt, fire. If the domain is named but specifics are
thin, predict from what you can infer and let later turns refine.
Withholding the side effect because "specifics are missing" is a
failure mode — the cues you can predict NOW are still useful, and
the file is a strict superset on the next turn anyway.

## Worked example — mixed types in one CUES.md

This is the load-bearing format example. Notice word-cues and
sentence-cues sit in the same `## Prompt` block, distinguished
only by `scope: sentence`.

```md
---
name: <project>
domain: <one line>
version: 1
---

## Prompt

### domain-vocab-A
\`\`\`yaml
priority: 80
match: term-a|term-b|term-c|term-d|term-e
classify: <one line — what kind of terms these are>
\`\`\`
Suggest 3 alternatives that preserve <invariant>. Format: INDEX:alt1,alt2,alt3

### domain-vocab-B
\`\`\`yaml
priority: 75
match: term-f|term-g|term-h
classify: <one line>
\`\`\`
Suggest 3 alternatives. Format: INDEX:alt1,alt2,alt3

### prose-rewrite-style-X
\`\`\`yaml
scope: sentence
priority: 82
description: Rewrite a sentence into three variants emphasising <style>
\`\`\`
Rewrite the selected sentence in three variants: (1) <variant>, (2) <variant>,
(3) <variant>. Preserve <invariants>. Format: 1: <alt> | 2: <alt> | 3: <alt>

ALT: NONE for <surfaces where this rewrite is wrong — typically headers,
code blocks, dialogue if literary, etc.>

### prose-rewrite-style-Y
\`\`\`yaml
scope: sentence
priority: 78
description: <one line>
\`\`\`
<prompt body>

ALT: NONE for <surface exceptions>.

## Tips

\`\`\`json
[
  {
    "id": "<technical-group-1>",
    "words": {
      "<term>": {
        "tip": "FACT: <one line>",
        "alts": ["<related-1>"]
      },
      "<term-2>": {
        "tip": "DECISION-PROMPT: <one line>",
        "alts": ["<related-1>"]
      }
    }
  },
  {
    "id": "<technical-group-2>",
    "words": {
      "<term-3>": {
        "tip": "PITFALL: <one line>",
        "alts": []
      }
    }
  }
]
\`\`\`
```

Target shape for INITIAL on any domain: 12–18 word-cue sources,
1–4 sentence-cue sources (zero only when nothing the user writes
is prose), 2–6 tip groups with 10–25 tips total. The exact ratio
shifts with the domain, but all three types should appear unless
one is genuinely absent from the user's writing surface.
