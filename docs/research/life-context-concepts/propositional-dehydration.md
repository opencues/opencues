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

## Rules extracted

- Force and skeleton are sufficient for contradiction; content is
  never required by the matcher.
- The swap must be invariant-preserving over the contradiction
  algebra (polarity, modality, quantifiers, temporal order,
  coreference); everything else may generalise or tokenise.
- Matching is deterministic local algebra; models only extract.
- Granularity of generalization is the privacy dial, chosen per
  slot type.
