# Blank: the exact spot _

Status: explored 18 Jul 2026; Plus Code encoder implemented and
round-trip verified in the spike. Unpublished draft.

## One-liner

Share a precise place as text: a Plus Code plus a pinned-map link,
composed from a place you named, an anchor you declared, or (later,
opt-in) where you actually are.

## Use case

Addresses locate buildings; meeting happens below building-level.
The blank emits a ~14m-precise, universally-resolvable location as
plain text that survives forwarding, plus a map link. Recipient
needs nothing installed.

Scenarios ranked:

- The "which entrance" problem (killer case): Bank has 15 exits,
  King's Cross spans three postcodes, the O2 is 20 minutes door to
  door. "Meet at the station" is a mutual-search ritual.
- Green space: picnics, pitches, "the hill by the tennis courts" -
  one address, 40 hectares.
- Stranger meetups: Marketplace/Vinted collections at a precise
  neutral spot.
- Access instructions: courier side gates, Airbnb real entrances.
- The unaddressed world: trailheads, parked cars, breakdowns
  (what3words built its brand here; Plus Codes do it open).
- Travel: Tokyo/Seoul addressing; Plus Codes bypass addressing
  entirely (their original design purpose).

Honest competitive split vs messenger location-share buttons: the
phone 📍 button owns "where I am now" (case 3, deferred). The blank
owns what the button cannot do: naming a FUTURE meeting point at a
third place, from DESKTOP, in ANY channel (email, Slack, forums,
event text), surviving copy-paste. That is cases 1+2 - so the v1
scope (no sensing) targets the actual unserved gap, not a
compromise.

Composition: the spot becomes a field in other artifacts - calendar
event location carries the Plus Code (recipient navigates to the
bandstand, not the park), and inline-directions accepts it as a
destination. Precision, once expressed, flows through the artifact
chain.

## The three-case split (who supplies the coordinate)

1. Place named in the sentence (dominant case): "here's the exact
   spot for the bandstand _" - coordinate belongs to the named place,
   resolved from cached OSM/stops data or one polite geocode. User
   position never involved. Ships day one.
2. Declared anchor: "the exact spot of mine _" -> home.pin from
   config. Note anchors get an optional precise field: home = station
   (routing), home.pin = plus code (the door, used ONLY in artifacts
   the user composes). A home can be configured AS a plus code so no
   address string ever exists in config. Ships day one.
3. Live position: "I'm here, come find me _" - requires a sensed
   presence provider (browser geolocation on Chrome host; phone GPS
   in some future host). Opt-in, per-use, one-shot read -> compose ->
   discard; never stored, never ambient. Browser geolocation honesty:
   it works by sending the visible wifi neighborhood to Google/Apple
   location services - the one presence rung that phones home by
   design. Desktop v1 ships cases 1+2 only.

## Mechanics

- Plus Codes (Open Location Code): open Apache-licensed algorithm,
  ~15 lines, offline base-20 encoding. Spike verified: East Finchley
  station = 9C3XHRPM+VX, round-trip error 8.4m inside the 14m cell.
- Map link: google.com/maps/place/<code with + as %2B> or
  maps.google.com/?q=lat,lon - keyless deep links, same pattern as
  inline-directions.
- Zero API for encoding; at most one geocode for case 1 names not
  already in cache (respect Nominatim: setup-time tool, never
  typing-time; prefer cached stops.txt and OSM extracts).

## Resolution rules (hardened after a live mistake, 18 Jul 2026)

During the demo the assistant generated approximate coordinates for
"the cafe corner of Cherry Tree Wood" from memory: 411m off, outside
the park, presented with 14m-precision confidence. Wilfred caught it
by local knowledge. Rules extracted:

1. Coordinates are DATA, never generation. The LLM extracts the
   place NAME only; the coordinate comes from the resolver (cached
   OSM extract, stops.txt, one polite geocode) or the blank does not
   fill. A generated coordinate is a hallucination wearing precision
   clothing - worse than vagueness.
2. The sender is the safety net and the UX provides it: the fill
   sits in the sender's buffer, clickable and cycleable, before
   sending. Blanks beat agents here - output is reviewable text,
   not an executed action.
3. Sub-place ladder: named POI inside the parent polygon (OSM has
   cafes in parks) -> else parent centroid + the user's own words
   carry the last 50m ("the cafe corner" as text does what the pin
   cannot).

Link-form decision from the same session: plus code as the
human-facing text (short, speakable, survives mangling), raw
coordinates in the URL (maximum cross-app compatibility).

## Fill format (proposed)

    the bandstand: 9C3XGV57+V8 - map: <link>

Plain text code survives forwarding and works offline at the other
end (any maps app resolves it); link is the escalation.

## Privacy rules (inherited from the location model)

Exact coordinates appear only in output the user explicitly composed,
never gathered ambiently. Ambient presence is stop-snapped and
LLM-invisible; this blank is the deliberate-share exception and is
recognisable as such by its own grammar - typing it IS the consent.

## Dependencies

Plus Code encoder (trivial, done), anchors + optional .pin fields,
cached place data; case 3 additionally needs a sensed presence
provider and its permission flow.

## London reliability tiering (18 Jul 2026 session evidence)

- Tier A, trust blind: stations/stops/platforms (NaPTAN, authoritative
  government data; TfL API even carries station ENTRANCES - the
  "which exit at Bank" killer case sits on the best layer), parks,
  streets, postcodes (ONS via postcodes.io), landmarks, chains.
- Tier B, good existence / currency risk: independent cafes, pubs,
  shops. Position trustworthy; still-open-ness lags (OSM misses
  churn); hours patchy on independents.
- Tier C, fragile: colloquial names as lookup keys (live failure:
  "Cherry Tree Wood Cafe" != OSM's "The Cherry Tree Cafe" - name
  search returned nothing; category-bounded-by-geometry found it).
  Sub-place features (bandstands, gates) hit-and-miss.
- Tier D, availability: public Overpass 504'd twice mid-session with
  perfect data behind it. Production = local Geofabrik London extract
  queried like the GTFS SQLite; public endpoints are setup/spike
  tools only.

Resolver rules that convert C to B: category+geometry over bare
names; confidence gating (exact in-area -> fill; fuzzy -> fill with
cycle alternatives; nothing -> no fill); the sender check catches
the residue (proved twice in one session).

TASK - reliability benchmark before shipping: ~50 real London places
(20 Tier A, 20 named businesses, 10 colloquial sub-places), run the
resolver ladder against a local extract, score hit/position/currency
per tier. Turns "how reliable" into a percentage.

## Open decisions

- Default map provider in the link.
- Whether case 3 ships at all before a mobile-adjacent host exists.
- Whether to also emit what3words for UK-emergency familiarity
  (proprietary - probably not; Plus Codes are open).
