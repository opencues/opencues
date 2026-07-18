# Life-context concepts: contradiction cues + world-data blanks

Research drafts from a 2026-07-17/18 strategy and spike session
(Wilfred + Claude, migrated from the website repo's draft space).
Status: concepts and verified spikes, not implementation.

Relationship to the shipped `calendar-context` feature (merged as
feat/life-context #310, renamed #312): it implements the
calendar-ingest + conflict-cue slice of this material (no MCP,
LOCATION dehydrated to tokens). These docs are the wider map around
it: the strategy (MCP/world data as background-refreshed cache, never
in the hot path or the prompt), an ~80-item contradiction-cue
catalog, the anchor/presence location model, the verified data
substrate (GTFS, TfL anonymous API, OSM, plus codes, keyless deep
links), latency measurements, and per-blank design docs.

Contents:

- `contradiction-cues.md` - master doc: strategy, cue catalog by
  tier, anchors + location model, FTUX for anchor collection, data
  substrate with spike evidence (all keyless-verified), candidate
  round 2, design rules extracted from live failures.
- `blanks/inline-directions.md` - fully spiked (TfL journeys
  forward/inverse, GTFS->SQLite ~10-25ms, maps deep links).
- `blanks/add-to-your-calendar.md` - designed; zero-API link
  construction (Google/Outlook template URLs + ics gap).
- `blanks/the-exact-spot.md` - designed; plus-code encoder verified;
  resolution rules hardened by live mistakes.
- `blanks/when-im-free.md` - designed then PARKED (single-shot fill
  cannot see the recipient's reply); its secret-ICS-feed mechanism
  remains the intended no-OAuth calendar entry point for the cues.
- `propositional-dehydration.md` (19 Jul 2026) - detect promises and
  contradictions without exposing them: illocutionary force +
  tokenised frame skeletons, deterministic local matching algebra,
  semantic snapping via hypernym generalization. Unlocks the
  messages/payments cue tier at calendar-context's trust level.

Key rules extracted (short form): coordinates are data, never
generation; missing data is survivable for cues, fatal for discovery
blanks; blanks must be single-shot; a blank must beat pasting
something the user already owns; precision over recall - a wrong cue
is worse than no cue.
