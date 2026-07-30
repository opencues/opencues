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
