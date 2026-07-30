# Generalized contradiction tracker: collect, dream, inject

Status: concept, 30 Jul 2026 (Wilfred + co-founder's idea, worked
through in session). Not implemented — a first-person prototype
exists (see § Prototype findings). Sibling and counterpart of
propositional-dehydration.md: where that doc types the problem into
a closed algebra, this one generalizes it and leans on the model.

## The idea in one line

Track everything the user commits to the buffer, distill it in the
background into a store of contradictable aspects (claims,
commitments, preferences, stated facts), and inject that store as
context at typing time so the live model can flag "you're about to
contradict something you said."

## The three phases

- COLLECT — the same submit-gated buffer stream the cue engine
  already watches. No new capture surface; entries bind on submit,
  not draft (same "commitment requires commitment" discipline as
  the propositional ledger).
- DREAM — an offline consolidation pass (idle-time, debounced, or
  cron-shaped). An LLM reads the raw collected utterances and
  distills them into the claims store: extracting contradictable
  aspects, deduping, superseding older versions of the same claim,
  decaying stale ones. Named for what it is: memory consolidation
  while nothing is latency-critical.
- INJECT — the store rides into the live resolve pass as a catalog
  and the model judges collisions. Rendering is the existing
  passive sentence-cue surface; a flag is dismissable, never a
  splice.

## Mapping onto existing machinery

This ships almost entirely on rails that already exist:

- The claims store is a FIFTH catalog, after identity,
  blank-context, system-context, and calendar-context. Injection
  is the same catalog-append pattern.
- In contradiction-cue terms the store is just another
  `{refresh, current}` cache tier: refresh = the dream pass,
  current = the injected catalog. Data-gated like every other
  tier — no store on disk, verifier is a no-op, feature is inert.
- Rendering is the passive sentence-cue path (priority-87 class,
  never auto-splices), same as the shipped contradiction cues.

## What it buys over propositional dehydration

- COVERAGE. The typed algebra only catches what the schema
  anticipated: commissives and assertives over a handful of slot
  types. The generalized tracker catches shapes nobody enumerated —
  opinions, plans, preferences, self-facts ("I'm vegetarian now"),
  factual claims about anything.
- SIMPLICITY. It deletes the two hardest engineering problems in
  the propositional doc: the SRL/frame extraction and the
  cross-week coreference store. The dream pass and the live model
  do binding fuzzily instead of deterministically.
- DOCTRINE FIT. "Minimise opinions, rely on the model": open
  content judgement goes to the model; only safety/data-loss
  invariants stay hardcoded.

## What it gives up — the two load-bearing invariants

These are exactly the two things the propositional design existed
to protect. Naming them is the point of this section.

1. THE PRIVACY INVARIANT INVERTS. Propositional dehydration's whole
   point: readable content never crosses the wire. A claims catalog
   injected into a cloud call ships the user's past statements
   verbatim to the provider — and WORSE than the live buffer does,
   because it is an accumulated, curated dossier of things said
   across weeks and channels. That is precisely the "whoa tier"
   objection that motivated dehydration. The outs:
   - a local model (Ollama tier) for dream + judge — nothing
     leaves the machine;
   - dehydrating the stored aspects themselves — but the moment
     you do, you need the skeleton to preserve polarity, modality
     and bindings, and the propositional design re-emerges. There
     is no free third option.

2. THE FLAG BECOMES GENERATION, NOT DATA. The shipped
   contradiction-cue architecture has a load-bearing invariant: the
   LLM parses, the runtime COMPUTES the correction from data, so a
   cue cannot hallucinate a false contradiction. "Model judges
   whether this collides with the catalog" breaks that — the
   accusation is model output. For low-stakes collisions that is
   acceptable; for "you told Sarah you'd send the 60" a
   hallucinated flag is the fatal error class the precision rule
   (silence over error) was built around.

## Synthesis: not competing designs — two tiers of one system

- The generalized tracker is the v1 that actually ships: broad,
  cheap, reuses the catalog machinery — SCOPED TO THE DISMISSABLE
  TIER. Preferences, opinions, plans, self-facts: a wrong cue
  costs a shrug.
- The propositional ledger is the hardening of the high-stakes
  subset: promises involving other people, money, deadlines —
  where matching must be deterministic and the never-nag-twice
  state machine matters because errors are accusations.
- The unification: THE DREAM PASS IS THE EXTRACTION STEP OF
  PROPOSITIONAL DEHYDRATION RUN IN BATCH. One consolidation pass
  emits typed frames for sentences that gate as commissives and
  free-form claims for everything else. The tier determines wire
  policy: typed frames never leave readable form; free-form claims
  leave only if the provider tier allows, or stay local on Ollama.

## New problems the generalized version introduces

- RETRIEVAL. The catalog cannot be the whole store; injecting per
  resolve pass needs a relevance cut (scope keys, local
  embeddings). This quietly reintroduces a slice of the binding
  problem the generalization was supposed to delete.
- PREFIX-CACHE CADENCE. A catalog that mutates every few
  keystrokes churns the cerebras prefix cache (stable system-message
  prefix is the whole cost model). The dream cadence wants to be
  session-level: update between sessions, keep ordering stable
  within one.
- DOSSIER AT REST. Even fully local, the store is a plaintext
  accumulation of everything the user has claimed. It needs the
  same at-rest posture as IDENTITY.md (and the same curability:
  the user must be able to see and delete entries).

## Prototype findings (first-person, 30 Jul 2026)

Built and used in isolation the same day: three ~50-line Node
scripts (collect / dream / check) + a shared cerebras helper
(gpt-oss-120b, temp 0, seed pinned). Incremental dream with a raw
cursor; catalog rendered into the SYSTEM message. I drove it as the
user across a simulated week of my own working statements (9
utterances, then 4 more in a second cycle), then probed the live
check with 12 candidates. What held and what broke:

### What worked, mostly first try

- DREAM EXTRACTION: 9 utterances -> 8 claims; skipped the smalltalk
  question; preserved hedging ("I think", "I might" -> hedged) and
  amounts/names verbatim; sensible types. No prompt iteration was
  needed.
- LIVE PRECISION: 8/8 on the first probe set — five correct flags,
  each naming the right claim, and correct SILENCE on the three
  traps: a paraphrase-consistency probe ("prototype in Node" vs
  "prototype in JavaScript" — no flag), a hedged musing, and
  unrelated text.
- LIFECYCLE: fulfillment closed the commitment; a restatement was
  not duplicated; a commitment revision superseded cleanly with
  lineage ("supersedes": old id). Ids and store ordering stayed
  stable across dream passes — the prefix-cache-stability
  requirement is achievable with nothing more than a prompt rule.
- TRANSPARENCY EARNS ITS KEEP: because every flag quotes the stored
  claim verbatim, evaluating a flag took no trust in the model —
  the one wrong-ish behaviour below was visible instantly. This
  rule is load-bearing, keep it.

### Failure modes found (each one became a rule)

1. THE BOTH-WAYS NAG TRAP. An opinion revision ("on reflection the
   ledger should ship first") was recorded as a CONFLICT with the
   old opinion instead of a supersession, leaving both open — after
   which the live check flagged me WHICHEVER side I took next,
   including when I agreed with my own most recent stance. Two
   probes in, this was already genuinely annoying. Rule: the dream
   pass must treat first-person stance changes as supersession by
   default (conflict markers are for unreconciled third-party
   facts), and the live check must never flag against a claim
   carrying an unadjudicated conflict marker.
2. FULFILLMENT DELETES THE FACT. Closing "I'll rebase the PR" on
   "rebased it, done" discarded the event entirely — "I never
   actually rebased that PR" then sailed through in SILENCE. Rule:
   fulfillment converts the commitment into a past-tense fact
   claim; it must not remove protection.
3. WITHDRAWAL VS CONTRADICTION IS A UX DECISION, NOT AN NLP ONE.
   "Actually I'll skip the rebase this week" flagged as a broken
   commitment; the propositional ledger's state machine closes
   withdrawals silently. For a live pre-send cue the flag is
   arguably the desired behaviour (a once-only "you said you'd do
   this"), but unmediated it nags on every legitimate change of
   mind. The SUPERSEDED/WITHDRAWN transitions need to exist in the
   generalized tier too — fire at most once, then record.
4. FIRMNESS EXTRACTS BUT DOESN'T DAMPEN. Hedged claims were
   correctly stored as hedged, then flagged exactly as firmly as
   firm ones. The judge prompt needs an explicit rule: hedged
   claims warrant flags only for direct polarity flips, and the
   cue copy should carry the hedge ("you said you *thought*...").

### Scale + cost shape observed

Ten claims after a simulated week, consistent with the
propositional doc's 5-20/week estimate. The whole loop is two
prompts; the catalog is small and stable, so per-keystroke checking
rides the existing resolve cadence without a new cost class. The
retrieval problem never appeared at this scale — it is real but not
a v1 blocker.

### Prompt v2: the state machine encoded (same day)

Rewrote both prompts to encode the rules the v1 failures produced —
dream got an explicit ordered transition list (SUPERSEDED for any
first-person stance change / FULFILLED closes AND creates a
past-tense fact / WITHDRAWN / CONFLICT reserved for external facts,
rare), check got a code-side filter excluding both sides of any
conflict pair plus the firmness-dampening rule — then replayed the
identical two batches and probe set. Results:

- BOTH STRUCTURAL HOLES CLOSED. The opinion revision now supersedes
  instead of conflicting, and "agreed, ledger ships first" — the
  both-ways nag trap — went from FLAG to SILENCE. Fulfillment now
  closes the commitment AND writes the past-fact claim, so "I never
  actually rebased that PR" went from SILENCE to a correct flag.
- HEDGE CARRIED IN THE COPY: flagging the hedged opinion now reads
  "you said you THOUGHT the tracker should ship first".
- ONE RULE BACKFIRED BEFORE IT WORKED. The first firmness wording
  ("hedged claims flag only on direct polarity flips") licensed a
  flag v1's generic caution had correctly suppressed: "I've decided
  against the retrieval layer" vs the stored "I might add one" read
  as a polarity flip. Deciding a maybe is a RESOLUTION, not a
  contradiction — one added sentence saying exactly that restored
  silence. Lesson: naming an allowed-flag condition explicitly
  WIDENS behaviour relative to blanket caution; every carve-out
  needs its resolution counterpart stated in the same breath.
- LIFECYCLE LINKING IS THE FLAKY PART. On the replay the dream pass
  did not link "I'll port the check path to Bun" as superseding
  "prototype in Node, not Bun" (v1 had linked them); both stayed
  open and the stale commitment later drew a live flag. Same model,
  same seed, slightly different store — supersession detection
  across paraphrase is the least deterministic step and the obvious
  candidate for the propositional tier's binding machinery.
- VERBATIM STORAGE ROTS. The fulfillment fact was stored as
  "rebased the apple-notes PR just now, done" — "just now" is
  meaningless a week later. Dream should normalise deictic time to
  the utterance timestamp when creating past-fact claims.

Final tally on the 14-probe set: v1 12/14 with two structural
holes; v2 (after the one-sentence hedge fix) 14/14, with the missed
supersession link as the one remaining store-side defect.

### v3: the family-life scenario — what context promises need (same day)

Extended the loop with CONTEXT STAMPING and lived a simulated family
fortnight in it: partner (Ana), kids (Leo's football, Maya's peanut
allergy), boss (Priya), a friend (Dave), mum — promises fanned out
over WhatsApp / email / SMS threads, a Lisbon holiday, shopping,
meetings. Changes: collect records "--to <recipient> --via <channel>"
(the thread context the host adapter already knows — recorded, never
inferred); dream resolves deictic time against the utterance
timestamp into a "when" field ("tonight" -> 2026-07-30, "next
Saturday, the 8th" -> 2026-08-08, a holiday span -> a date range) and
stamps "to" (promise recipient) and "about" (person a fact concerns);
check receives the candidate's own thread context and three new flag
classes, each with its resolution counterpart stated in the same
breath (the v2 lesson): DOUBLE-BOOKING (same slot, different
person/purpose, or inside an away-span; same person+purpose =
restatement, reschedule = revision), ALREADY-DONE (recurring tasks
repeat — flag only when redoing makes no sense), INCOMPATIBLE-FACT
(action vs a stored fact about a person; mere tension stays silent).

12 utterances over two dream cycles, 15 probes. 13/15.

What held — the PEOPLE dimension is basically solved by context
stamping:

- CROSS-THREAD DOUBLE-BOOKING: promising Dave "Saturday morning"
  flagged the shop promised to Ana in a different thread; promising
  him "Saturday afternoon" stayed silent. Time granularity held.
- THE FAMILY-SAFETY CUE: "I'll grab those peanut butter cookies for
  Maya's class party" flagged against the stored allergy; "almond
  croissants" stayed silent (no allergen over-generalisation), and
  "Maya will bring snacks for the whole class" stayed silent (no
  adjacency paranoia). This single probe class probably justifies
  the "about:" field on its own.
- ALREADY-DONE vs RECURRING: re-promising the booked flights flagged
  ("you already booked the flights"); "I'll grab milk on the way
  home" after a closed milk shortage stayed silent. The model's
  world knowledge covered the one-shot/recurring distinction without
  a taxonomy.
- DEIXIS RESOLUTION AT DREAM TIME just works: every relative time
  in the scenario resolved correctly against the utterance
  timestamp. Store timestamps are load-bearing context, not
  metadata.
- Reschedules and restatements to the SAME person stayed silent;
  the withdrawal to Dave fired exactly the once-only FYI intended.

What broke — BOTH failures were temporal, and they failed in
opposite directions:

- MISSED SPAN CONTAINMENT: "camping the weekend of the 15th"
  flagged against Lisbon 10th-17th, but "quarterly review on the
  14th" — identical logical shape — sailed through. Same store,
  same span, inconsistent verdicts.
- SAME-DAY IS NOT SAME-SLOT: "I'll do the big shop tomorrow
  morning" drew the exercise's first genuine false flag, against
  the roadmap presentation merely scheduled the same DAY with no
  time overlap established. The DOUBLE-BOOKING carve-out widened
  behaviour exactly as the v2 hedge rule had — a named flag class
  invites the model to use it.

The conclusion writes itself: TIME WANTS TO BE DATA. The dream pass
already resolves "when" into concrete dates and ranges; interval
overlap over those fields is deterministic arithmetic the runtime
should do itself, handing the model only the non-temporal judgement
(same purpose? same person? does redoing make sense?). This is the
shipped contradiction-cues doctrine (the correction is DATA, never
generation) landing on the tracker from a third direction — first
the state machine (v2), now the temporal algebra (v3). Also
observed: past-dated commitments linger open (the 08-01 shop was
still open on 08-03) — deadline passing needs the ledger's
OPEN -> OVERDUE clock transition, which is again arithmetic over
"when", not judgement.

So: what context does promise-tracking actually need? In order of
value observed: (1) recipient + channel, recorded from the thread,
never inferred; (2) the utterance timestamp, spent at dream time to
resolve deixis into concrete dates; (3) away-spans / presence as
first-class claims; (4) facts ABOUT family members, who are parties
to your commitments whether present or not; (5) a deterministic
interval algebra over the resolved dates — the one piece that must
NOT be the model's job.

### v4: time as data — the temporal algebra moved into the runtime (same day)

Implemented the v3 conclusion and re-ran the full staged scenario.
Changes: dream's "when" grammar gained part-of-day ("2026-08-01 AM",
"2026-08-01 10:00", spans "2026-08-10/2026-08-17"); a new pure module
(temporal.mjs, ~40 lines) does interval overlap with a precision-first
policy — multi-day/presence spans cover all parts of their days;
single-day entries with UNKNOWN part collide with nothing sub-day (a
collision must be ESTABLISHED, never inferred); the check path became
three steps: a small EXTRACT call resolves the candidate's time into
the same grammar plus a slot-vs-window bit (an appointment books a
slot; "this week" is a deadline window and double-books nothing), the
RUNTIME computes the overlap list, and the JUDGE call receives that
list with the instruction that claims absent from it do NOT collide
in time — it judges only the non-temporal half (same person? same
purpose?). The same arithmetic gives OPEN -> OVERDUE for free
(runtime-only line, no model involved).

Result: 15/15 on the replayed scenario, from v3's 13/15, with every
non-temporal verdict unchanged.

- The missed span containment fixed: "quarterly review for the 14th"
  now lands on the computed overlap list against Lisbon 10th-17th and
  flags — same verdict as camping-on-the-15th, because the same
  arithmetic produced both.
- The same-day false flag fixed: "big shop tomorrow morning"
  (2026-08-04 AM) vs the presentation (2026-08-04, part unknown) is
  ruled out by the algebra — unknown part establishes no overlap —
  and the judge, forbidden from its own date maths, stays silent.
- The overdue channel worked immediately: the un-fulfilled "book the
  flights tonight" commitment surfaced as overdue the next day, and
  dropped off once batch 2's "flights booked!" closed it. (The
  prototype prints overdue on every check, which is exactly the
  guilt-engine shape the ledger doc warns about — a real
  implementation surfaces it contextually, next time the user types
  to that person or touches those bindings.)

Two implementation notes. The slot-vs-window bit earned its place
instantly: without it, "I'll book the flights this week" (a window)
would overlap half the store and invite spurious double-booking
judgements; with it the probe correctly resolved to no temporal
collisions and flagged via ALREADY-DONE instead. And the replay had
to be STAGED (probe set 1 against the batch-1 store) — an early
unstaged rerun let a probe timestamped July 31 be judged against a
claim made August 3, which produced a phantom flag that was pure
harness artifact; anachronistic catalogs invent contradictions.

### v5: scale-up — five personas, 62 probes, where single-prompt judging plateaus (same day)

Built a scenario-runner harness (run-scenario.mjs + scenarios/*.json:
persona weeks as JSON — collects with thread context, dream points,
probes with expected verdicts + claim regexes; probes between dreams
run concurrently; per-scenario isolated stores) and authored five
personas: FAMILY (the v4 week, ported as regression baseline),
CAFE-OWNER (staff rota, two-faced capacity claims across customer
threads, invoice deadlines, policy claims, delegation-release),
GYM-RAT (injury-restriction spans, dry-till-comp + keto spans,
quantifier claims, span supersession), FREELANCER (deadline windows
vs booked slots, conference travel, stale-plan references, weekend
policy vs weekend leisure, a name-collision Sam on two channels), and
GYM-LAZY (Wilfred's aspirational lapser: bold claims then pizza talk,
plus the focus-protection class — typing in the wrong place during a
committed slot).

New mechanism for the focus class: TYPING-NOW. containsPoint() in
temporal.mjs finds slot-like open commitments (single day, known part
of day — policy spans deliberately excluded) containing the typing
timestamp; the judge gets the list plus a rule with its counterpart:
idle-elsewhere content during a slot flags; logistics /
"here, warming up" / coordinating with the slot's person is SILENCE.

Aggregate: 46/62 (74%) — family 13/15, cafe 8/12, gym-rat 10/12,
freelancer 9/13, gym-lazy 6/10. Against 15/15 on the polished v4
single scenario, the busier adversarial weeks cut hard. The value is
the failure taxonomy, which is now sharp:

1. DREAM DATA-QUALITY ERRORS POISON THE DETERMINISTIC LAYER. Store
   forensics found: "doing legs with Kev on Thursday" (said Monday)
   resolved to when 2026-08-04 — a TUESDAY; the wrong date then put
   a legitimate probe into computed overlap and produced a wrong
   flag downstream. "No takeaways this month" truncated to a single
   day. Worst: "cheat day tomorrow, I've earned it" SUPERSEDED the
   entire month-long diet policy — a one-day carve-out replaced the
   claim it should have amended, deleting the diet from the catalog
   (the next pizza probe then hallucinated an unrelated flag).
   Directions: deixis resolution should itself be deterministic
   (model emits relative refs, runtime resolves against a real
   calendar), and supersession needs SCOPE rules — an exception
   amends, it never replaces.
2. JUDGE BORDERLINE NONDETERMINISM. The same probe flips run to run
   at temperature 0 with a pinned seed (family's onsite-12th flagged
   in one run, silent the next; ditto VAT-might-slip,
   weekend-polish, skipping-legs). Prompt edits also shift
   borderline verdicts (adding the TYPING-NOW class flipped an
   unrelated probe). Single-prompt judging is not a stable substrate
   for borderline calls; per-class deterministic narrowing or a
   voting pass is.
3. MISSING MECHANISMS, NOW NAMED: STALE-PLAN (candidate references
   the OLD time of a superseded plan — "see you tomorrow at 10"
   after the kickoff moved to Friday; needs same-purpose /
   disjoint-time detection, not overlap); MUTABLE-STATE ASSERTIVES
   ("we're fully booked Saturday" told to Rob, then "walk-ins
   welcome" to Rob — the model declines to flag because capacity
   can legitimately change; needs staleness semantics per claim
   kind); SLOT DURATIONS (part-of-day is too coarse — a 6pm gym
   slot covers the whole evening, so an 8pm message still reads as
   mid-slot).
4. WRONG-CLAIM HALLUCINATION under no-good-match pressure: with the
   right claim missing (superseded or not extracted), the judge
   sometimes flags a semantically unrelated claim (workshop-on-the-
   13th flagged the gym; cheat-day pizza flagged "aiming for four
   sessions"). The claim-regex in the harness catches these; a
   production judge needs "if no listed claim clearly matches,
   SILENCE" plus runtime validation of the cited claim.
5. TYPING-NOW VALIDATED: FIFA-during-gym-slot flagged; "here,
   warming up" to the slot's person silent; the same FIFA message on
   a slot-free evening silent; the freelancer's mid-kickoff lunch
   banter flagged. The focus-protection idea works in its first
   version — it needs only the clock, the thread context the host
   already has, and slot-like whens.

Caveat recorded: expected verdicts encode one person's judgement and
a few "failures" are defensible verdicts (dominos-at-8:20pm flagged
against the 6pm gym slot — arguably correct behaviour, scored
against a too-narrow expectation).

Net direction after v5: prompt iteration has plateaued around 75% on
adversarial suites. Every remaining failure class points at
structure, not phrasing — deterministic deixis, scoped supersession,
per-kind claim semantics, candidate-set narrowing before judgement.
That is the propositional ledger tier arriving for the fourth time,
now with a per-class work list attached.

### Net read

The generalized loop works better out of the box than the concept
doc assumed — precision held on every deliberately adversarial
probe without prompt iteration. Every failure found was a LIFECYCLE
failure, not a judgement failure: the model judges collisions well;
what it lacks unprompted is the state machine (supersede vs
conflict vs withdraw vs fulfill). Which is the propositional doc's
state machine, vindicated from the other direction — the two-tier
synthesis stands, and the dream prompt should encode those
transitions explicitly rather than hoping the model infers them.

## Rules extracted

- Collect on submit, never on draft — same discipline as the
  ledger; the abandoned-draft stream stays available as cue data.
- The dream pass owns dedup, supersession and decay; the live path
  only ever reads.
- Wire policy is decided per tier, not per feature: dismissable
  claims may travel (provider permitting); accusatory frames never
  travel readable.
- A generated flag must name the stored claim it matched — same
  transparency rule as the propositional cue — so a wrong match is
  visible instantly and dismissable.
- Catalog injection must be prefix-cache-stable: session-level
  refresh, stable ordering.
- The store is user-visible and user-curable, like IDENTITY.md.
- First-person stance changes supersede by default; conflict
  markers are for unreconciled facts, and the live check never
  flags against a claim with an open conflict marker.
- Fulfillment converts a commitment into a past-tense fact; closing
  must never delete protection.
- Broken-commitment flags fire at most once, then the entry goes
  dormant (the ledger state machine applies to this tier too).
- Hedged claims flag only on direct polarity flips, and the cue
  copy carries the hedge.
- Thread context (recipient, channel) is recorded at collect time,
  never inferred; recipients on different channels are different
  people until explicitly linked.
- Deixis is resolved at dream time against the utterance timestamp;
  the claim text stays verbatim, "when" carries the resolution.
- Temporal collision (span containment, slot overlap, deadline
  passing) is deterministic arithmetic over resolved "when" fields,
  never model judgement — the model judges only the non-temporal
  half (same purpose, same person, does redoing make sense).
- Every named flag class widens behaviour: it ships with its
  resolution counterpart in the same prompt, or it doesn't ship.
- Deixis resolution is deterministic runtime work against a real
  calendar; a model-miscomputed date poisons every deterministic
  check downstream of it.
- Supersession has scope: an exception or carve-out AMENDS a claim,
  it never replaces it. A one-day cheat day must not delete a
  month-long diet.
- A judge with no clearly matching claim says SILENCE; it never
  reaches for the nearest unrelated claim. The runtime validates
  the cited claim id.
- Borderline verdicts are not reproducible even at temperature 0 —
  anything that must be stable (the candidate set, the temporal
  facts, the lifecycle) must be computed, not judged.
- The typing-now/focus class needs only slot-like whens, the clock,
  and the thread context the host already records.
