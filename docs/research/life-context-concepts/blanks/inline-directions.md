# Blank: inline directions (TfL + maps links) _

Status: spiked end-to-end and verified against live APIs 18 Jul 2026
(the most thoroughly proven feature of the set). Unpublished draft.

## One-liner

Journey answers land as text where you type - "234 bus, 6 min" - with
a keyless maps deep link as the escalation to the rich UI; for
recipients, "here's how to get to mine _" packages directions to your
anchor for someone who has nothing installed.

## Use case

- Self: "how do I get home from here _", "last train home _", "next
  trains home _" answered inline while typing plans, no app switch.
- Planning: mode comparisons ("tube 9 min, bus 27") while deciding.
- Recipient: "here's how to get to mine _" -> route summary + maps
  link consumable by anyone with a browser. The most demoable
  recipient blank: the payoff appears in the other person's phone.

## Grammar

    from <place> to <place> [by <mode>[,mode]] [via <place>]
        [arrive by <time>] [step-free] _
    directions to <place> _
    last train home _        next trains home _
    <place> = anchor | free text | "here" (presence ladder)

## Mechanics - all verified in the spike

- Anchors resolve once via anonymous StopPoint search ("east
  finchley" -> 940GZZLUEFY, 85ms).
- Static GTFS (keyless zip -> local SQLite, 1.25M stop_times, 8.6s
  ingest) answers timetable queries in ~10ms: last train, service
  days (night tube Fri/Sat from calendar.txt), first train.
- TfL Journey API (anonymous, 50 req/min/IP) does forward AND
  inverse (arrive-by) math, mode filtering (tube, bus, national-rail,
  overground, elizabeth-line, dlr, tram, river-bus, coach, cycle,
  walking), via= waypoints, and a step-free accessibility preference.
  Verified results: Brixton->Oxford Circus 11 min forward; arrive-by
  21:30 -> latest departure 21:17; East Finchley->Camden tube 9 min
  vs bus 27 (143->134); bus to tube-less Muswell Hill = 234 bus 6 min.
- Free-text disambiguation arrives as HTTP 300 with ranked options.
  THE ANGEL LESSON: naive best-match sent "angel" to a Wallington
  Angel (75 min); production resolution order is anchors -> StopPoint
  search biased by mode context -> journey-planner free text last,
  with residual ambiguity surfaced through the cycle gesture.
- Maps deep links, all verified keyless: Google Maps URLs scheme
  (api=1 is a version marker, not a key; travelmode=transit etc,
  waypoints supported), Apple maps.apple.com, Citymapper, OSM.
  Coordinates from anchors make links exact (no name ambiguity).

## Division of labour ("compute open, link rich")

TfL/GTFS computes the inline answer (instant, readable, no click);
the deep link hands presentation to Google/Apple/Citymapper at their
expense. We never fetch Google route data (that is the keyed API and
its TOS) - we only construct documented keyless URLs.

## Rate limits and freshness

- TfL anonymous 50/min = ~72k/day vs heavy-user need ~140/day (0.2%).
- Static GTFS: one ~10MB zip per week per user, If-Modified-Since.
- Local-first fetching keeps limits per-user; never proxy centrally.
- Freshness matters: the 2017 archive feed said Wed last train 00:41
  vs current 00:28 - a stale cache promises 13 minutes that do not
  exist. Timetable cache TTL: daily refresh via TfL API or current
  GTFS.
- Known nuance: the timetable endpoint appears to exclude night-tube
  schedules (East Finchley Fri showed 00:37; night tube runs later).
  Must resolve before shipping or Friday cues understate options.

## Cue synergies

Same data powers the passive layer: last-train countdown, Sunday trap
(East Finchley: Sun 23:43 vs 00:37 other nights), night-tube
day-of-week, line-status disruption, impossible sandwich (journey
matrix between calendar venues), arrive-by feasibility ("I'll be home
by 11" -> latest feasible departure was the minute you typed it).
See ../contradiction-cues.md for the full cue catalog.

## Dependencies

Anchors (home minimum), GTFS cache, TfL API adapter, presence ladder
for "here" (manual pin / wifi-SSID mapping in v1). Maps provider
preference in config (google | apple | citymapper | osm).

## Open decisions

- Fill format: summary only vs summary + link by default.
- Default maps provider (Citymapper arguably best for London
  transit; Google most universal).
- Non-London rollout order (GTFS covers most world cities keyless;
  UK national data is the gated exception - BODS needs free
  registration).
