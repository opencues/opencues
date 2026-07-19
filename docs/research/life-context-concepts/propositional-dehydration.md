# Propositional dehydration: detecting promises and contradictions without exposing them

Status: concept, 19 Jul 2026 (Wilfred's idea, worked through in
session). Not implemented. Sibling of the location model in
contradiction-cues.md: the same privacy pattern applied to meaning
instead of space. Extends the dehydration technique the shipped
calendar-context feature already uses for entities ([EVENT N
LOCATION] tokens) from entities to whole propositions.

## The idea in one line

Split every sentence into what kind of move it is and what it is
about; the contradiction engine only ever needs the first part plus
an anonymised logical skeleton of the second, so promises and claims
can be tracked (and contradicted) without the content leaving the
machine in readable form.

## The linguistic basis (this is old, solid theory)

- Illocutionary force vs propositional content (speech act theory,
  Austin/Searle). "I'll pay you back Friday" = force COMMISSIVE +
  proposition pay(SELF, you, money, friday). The force carries the
  intent; the proposition carries the private detail. They separate
  cleanly.
- Searle's taxonomy gives the detector targets. Only two classes
  matter to the contradiction ledger: COMMISSIVES (promises,
  offers, commitments - the things you can break) and ASSERTIVES
  (claims about the world - the things you can be wrong about).
- Semantic role labeling / frame semantics supplies the skeleton:
  who did what to whom, when (PropBank/FrameNet-style
  predicate-argument structure). AMR is the maximal version.
- Hypernym generalization (WordNet ladders) is the fallback when a
  content word must survive at all: Venmo -> transfer, grill ->
  purchase item. SEMANTIC SNAPPING - the nearest-station trick
  applied to vocabulary; the category is a k-anonymity cell.

## Pipeline (same shape as the location model)

    sentence
      -> local extraction: force + frame with typed opaque tokens
         "I'll Venmo you the 60 quid on Friday"
         => COMMISSIVE(firm) TRANSFER(agent=SELF, recip=P7,
            theme=M3, deadline=D1)
      -> local ledger append (tokens, force, timestamps)
      -> IF a cloud model is needed at all, it sees only the
         skeleton: "SELF will TRANSFER THEME to PERSON by DATE"
      -> contradiction MATCHING is pure local algebra (no model):
         same token bindings + polarity flip / deadline passed /
         double-binding of one slot
      -> cue rendered by LOCAL rehydration: names re-enter only on
         the user's screen.

Privacy is the pipe shape, not a policy: the readable proposition
has no field to leak through because matching never needed it.

## The contradiction algebra (what the swap MUST preserve)

Substitution is only safe if these survive verbatim; each is
contradiction-bearing:

1. Polarity (negation) - flip it and you fabricate a contradiction.
2. Tense/aspect/modality - will / might / did / was going to / try
   to. Hedged commissives ("I'll try") are weak commitments and must
   stay weak; firmness is a ledger field.
3. Quantifiers and counts - all/some/never/twice.
4. Temporal relations - by/before/after can be abstract ordering
   over date tokens; the order is the substance.
5. Coreference bindings - "pay you back" and "the money I owe you"
   must resolve to the same M3 token locally, across days. This
   local alias/embedding store is the hard engineering and the real
   ledger.

Everything else (verbs, names, amounts, platforms) is swappable or
tokenisable.

## Worked example end to end

    Mon:  "I'll Venmo you the 60 quid on Friday"
          ledger: COMMISSIVE firm TRANSFER(SELF->P7, M3, by D1)
    Sat:  "I never sent it" (or "already paid you!")
          extract: ASSERTIVE neg TRANSFER(SELF->P7, M3)
          match:   same bindings, polarity vs commitment, D1 passed
          cue:     "you told Sarah you'd send the 60 by Friday"
                   (rehydrated locally)

The provider never saw Sarah, Venmo, 60, or Friday's referent. The
double-promise cue is the same machinery: one D-token bound to two
different P-tokens by two commissives = clash, no content needed.

## What this unlocks strategically

The messages/payments tier of the cue catalog (double-promising,
I-already-paid-you, drafted-but-never-sent, contradicting-past-you)
was rated the whoa tier largely BECAUSE it implied feeding private
messages to a provider. Propositional dehydration rebuilds it at the
same trust level as calendar-context's tokens: the creepiest tier of
the catalog becomes the most defensible one. It also completes the
invariant set: never send location (presence model), never send
identity (safe-mode tokens), never send propositions (this).

## Extraction options

- Cloud LLM on dehydrated text: entities pre-tokenised locally
  (existing safe-mode machinery), model classifies force + roles on
  the skeletonised sentence. Weakest privacy of the three, still
  far better than raw.
- Local small model (3-8B): speech-act tagging + SRL is well within
  reach; then NOTHING leaves the machine. The Ollama tier makes the
  whole ledger local.
- Rules-first gate (as everywhere in the cue engine): modal-future
  markers ("I'll", "I will", "by <date>"), payment/sending verbs
  etc. gate which sentences get extraction at all; precision-first.

## Limits and honesty

- Structure leaks a little: skeleton traffic reveals promise
  frequency and slot types. Granularity is the dial (MONEY vs
  AMOUNT_60), same knob as station-vs-stop snapping.
- Indirect speech acts ("I suppose the 60 can wait till Friday" is
  a commitment wearing a shrug) cost recall. Fine: missed promise =
  missed cue, never a wrong one (precision rule).
- Sarcasm/joke commitments exist; firmness scoring plus the
  dismissable-cue UX absorbs them.
- The coreference store must be curable (user can unlink a wrong
  M3 binding) - the cycle gesture is the natural UI.

## The ledger lifecycle (added 19 Jul 2026)

### Write path - when a sentence becomes an entry

Extraction hooks the same buffer stream the cue engine watches, with
one extra discipline: commitment requires commitment. Entries are
born twice:

    gated sentence   -> entry created, status DRAFTED
    buffer submitted -> status COMMITTED (the clock starts)
    buffer abandoned -> entry deleted (this deletion stream is the
                        drafted-but-never-sent cue's data, free)

Dehydration applies at the MODEL BOUNDARY, not at rest: locally the
ledger keeps full fidelity (resolved dates, vault pointers) because
local is where rehydration happens anyway; tokens exist for whatever
crosses to a provider. Entry shape:

    #411  force=COMMISSIVE firm=high pol=+
          TRANSFER(SELF -> P7, M3, by D1)
          D1 => 2026-07-24 (local)   thread=whatsapp:P7
          status: OPEN

### Read path - three triggers

1. New-utterance trigger (real time): every newly gated sentence is
   checked against OPEN entries before becoming one itself. Match
   key = (binding overlap, force relation): ASSERTIVE(neg) over same
   bindings -> contradiction cue; a second COMMISSIVE binding the
   same D-token to a different P-token -> double-promise cue.
   Scoped by thread/recipient first: O(handful), not O(ledger).
2. Clock trigger (background): timer scan over open entries; a
   passed deadline moves OPEN -> OVERDUE but NEVER pops a
   notification. Overdue entries wait in ambush and surface only
   contextually - next time the user types to that person or
   touches those bindings. The passive layer never initiates; that
   is what keeps a promise ledger from becoming a guilt engine.
3. Evidence trigger (later, with integrations): calendar-context,
   payment feeds, sent mail can CLOSE entries silently (a matching
   transfer clears -> fulfilled). V1 is linguistic evidence only.

### State machine - how entries are invalidated

- FULFILLED: ASSERTIVE(+, past) over same bindings ("just sent
  it!") -> close silently. Self-reports are trusted; we never
  fact-check the user's own completion claim (precision rule).
- SUPERSEDED: new COMMISSIVE, same bindings, new D-token ("make it
  Sunday") -> old closed, child entry opened; chain kept.
- BROKEN: polarity clash, or overdue + ASSERTIVE(neg) -> cue fires
  ONCE; accepted or dismissed, entry goes DORMANT. Never nag twice.
- WITHDRAWN: release over the bindings ("forget the 60, honestly")
  -> close silently.
- EXPIRED: deadline-less promises decay after ~4-6 weeks; stop
  matching, no cue. Bounds the ledger, prevents ancient false
  positives.
- CURED: dismiss -> dormant; the cycle gesture unlinks a wrong
  coreference binding (the curable store).

Every transition input is itself an F(p) extraction: fulfillment is
an assertive, renegotiation a commissive, withdrawal a release. The
state machine consumes the same algebra it is built from - no second
NLP system.

### The hard part: binding across weeks

"The money I owe you" must find M3 from twelve days ago. Resolver
order: thread/recipient scope (promise-talk recurs with the same
person) -> slot-type compatibility (MONEY) -> local embedding
similarity over the vault -> confidence threshold below which NO
match happens. Missed binding = missed cue (cheap); wrong binding =
wrong accusation (fatal). Silence over error, as everywhere; a
mis-bind is cured with one cycle gesture.

### Lifecycle worked example

    Mon  "I'll Venmo you the 60 Friday"    -> #411 OPEN (D1=Fri)
    Wed  "actually, make it Sunday x"      -> #411 SUPERSEDED
                                              -> #412 OPEN (D2=Sun)
    Sun  D2 passes silently                -> #412 OVERDUE (waiting)
    Tue  to Sarah: "I definitely paid..."  -> ASSERTIVE(+) candidate
         "...wait, did I?"                 -> hedge detected, no close
    Wed  "ugh, I never sent it, sorry"     -> ASSERTIVE(neg) + overdue
                                              -> cue fired once
                                              -> DORMANT

## Scoping and disambiguation across many promises (added 19 Jul 2026)

Two distinct problems needing different machinery: "is this
utterance about an existing promise?" (coreference) and "do two
promises collide?" (conflict).

### One ledger, many scopes - scope comes free

Single local DB across all hosts (a WhatsApp promise can surface in
Gmail), but every entry is stamped at write time with a scope key
the host adapter already knows: Chrome sees the tab and thread
(WhatsApp active chat, Gmail To: field, Slack channel); terminals
see the session. Entry = frame + (host, thread, recipient). Where a
promise lives is never inferred, always recorded.

### Two match modes, two indexes

- Coreference (scope-narrow): cascade same thread -> same person on
  other channels (needs identity link) -> global (rare, very high
  threshold only). Promise-talk overwhelmingly recurs where it
  started.
- Conflict (resource-wide): must IGNORE scope - the double-promise
  cue is precisely cross-thread (Alice in one chat, Bob in
  another). Second index keyed by contended resource (D-tokens /
  time slots; later amounts, objects). A new commissive binding a
  slot = one lookup in the resource index across all scopes.

Same table, two access paths: coreference is scope-first, conflict
is resource-first.

### Discrimination cascade (several open promises, same person)

Candidates scored on stacked evidence, single threshold:

- slot-type compatibility ("sent it" + transfer verb -> MONEY/OBJECT
  entries; the dinner promise is excluded)
- predicate class (send ~ TRANSFER, not RETURN - money over drill)
- lexical echo (definite NPs naming a slot - "the 60", "the drill",
  "Thursday" - near-decisive)
- recency prior (ties break to most recent open entry)
- temporal echo (date ladder position)

Best above threshold -> match; nothing above -> silence. No
interrogation dialogs; the passive layer never asks.

### Transparency + cycle as the disambiguation UI

The rehydrated cue NAMES the promise it matched ("you told Sarah
you'd send the 60 by Friday"), so a wrong match is visible
instantly; cycling rotates through the other candidate promises.
Cycle-away is negative evidence, cycle-to is a confirmed link - the
binding store learns from the core gesture. Transparency plus
curability beats attempted infallibility.

### Cross-channel identity: conservative by default

WhatsApp-Sarah vs sarah.k@gmail: a wrong merge produces a
cross-person false accusation, the most fatal error available. v1
treats channels as separate people unless linked via the local
contacts vault (phone + email on one card) or explicit config.
Unlinked = a missed cross-channel cue (the cheap failure). Identity
merging is opt-in; identity splitting is the default.

### Scale

5-20 ledger-worthy promises per week per human; low hundreds open
at steady state. With both indexes every match is a scoped lookup
over a handful of rows - microseconds. The real scale problem is
noise, and write-path gating (committed + gated + commissive/
assertive only) keeps the ledger small enough to stay precise.

### Structural boundary

The ledger only contains the USER'S OWN promises: OpenCues reads
the buffer being typed, not incoming messages. "Sarah promised ME
the 60" is invisible to it. A real limitation and a clean privacy
line: track what you said, never surveil what others say.

## Rules extracted

- Force and skeleton are sufficient for contradiction; content is
  never required by the matcher.
- The swap must be invariant-preserving over the contradiction
  algebra (polarity, modality, quantifiers, temporal order,
  coreference); everything else may generalise or tokenise.
- Matching is deterministic local algebra; models only extract.
- Granularity of generalization is the privacy dial, chosen per
  slot type.
- Commitment requires commitment: entries bind on buffer submit,
  not draft; the abandoned-draft stream is itself cue data.
- The ledger never initiates: overdue entries surface only when the
  cursor returns to relevant context. One cue per entry, ever.
- Self-reported fulfillment is trusted; evidence integrations may
  tighten later.
- Below-threshold bindings do not match: silence over error.
- Coreference matches scope-first; conflict matches resource-first.
  Two indexes, one table.
- Cues name the promise they matched; cycling rotates candidates
  and teaches the binding store.
- Identity merging across channels is opt-in; splitting is the
  default (a wrong merge = cross-person false accusation).
- The ledger tracks what the user said, never what others said.
