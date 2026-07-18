# Contradiction cues - MCP-fed context that fact-checks what you type

Working product document, July 2026. Unpublished. This is the strategy for
beating agent-platform competitors (Warp, Copilot, Raycast, BoltAI) on MCP:
they use MCP synchronously inside an agent loop (ask, call, wait), we use MCP
as a background-refreshed context cache that the passive cue layer reads with
zero added latency. MCP as materialized view, not MCP as RPC.

Positioning line: competitors use MCP to let you ask; OpenCues uses MCP to
tell you - before you ask, without the wait.

## Wilfred's shortlist (July 2026)

Picked as favourites, in rough priority: weekday-date mismatch (ship
first), calendar busyness, reservation drift, opening hours, public
holiday collision, transit reality, informal double-promising, ETA
honesty (opt-in framing). Plus: **TfL London bus integrated times with
inline lists** - live arrivals as both a cue (disruption contradicts your
stated plan) and a blank (`next buses from here _` -> an inline list).
Note the shortlist signature: city-life logistics (getting places,
meeting people, plans with friends), not finance or work tools.

## The pattern

Every contradiction cue has the same skeleton:

1. **Entity extraction** - cheap local gates first (date/time regex, name
   match against cached contacts, number patterns), LLM only after a gate
   fires. The NLU-per-keystroke cost is the real constraint, not data lag.
2. **Lookup** in a cached MCP-fed store, refreshed on an interval matched to
   the data's volatility.
3. **Mismatch test** - what you typed vs what the data says.
4. **One quiet cue**, dimmed, dismissable, with the correction inline.

## The cue vs blank rule

- Catching a mistake -> **cue** (passive, cached, staleness-of-minutes OK).
- Fetching a value -> **blank** (explicit, tolerates ~1s, may be live).
- Data that flips in seconds (stock prices, live CI) must never be a cue:
  a wrong correctness-cue is worse than no cue because it trains distrust.

## Why the winners win

The best ideas share three traits:

1. The ground truth is in data you already possess (inbox, contacts,
   calendar, messages), not a service you'd have to adopt.
2. The error is about time or commitments - your own mental model going
   stale.
3. The correction arrives at the only moment it is useful: mid-sentence,
   before send. Grammarly can't (no calendar), Copilot can't (IDE only),
   chatbots can't (you'd never think to ask).

The emotional core: the cue corrects your own stale memory, which feels like
a superpower. Cues that correct the world feel like a feed; cues that catch
you feel like surveillance (see spooky tier).

## Tier 0 - zero integration (buffer, compose state, clock only)

Ship these first: free, universal, they train users to trust cues.

- **Weekday-date mismatch**: "see you Thursday the 24th" -> the 24th is a
  Friday. Needs only a clock. Propagates through whole email threads.
- **Countdown errors**: "only 2 weeks until the wedding" -> it is 3 weeks.
  Pure date arithmetic against a date mentioned or known.
- **Self-inconsistent figures**: "$40k" in paragraph one, "$45k" in
  paragraph four. Source is the buffer itself.
- **Split-the-bill math**: "that's $25 each" on a $120 bill among 4 -> $30.
  Inline arithmetic checks on money and quantities.
- **Greeting-recipient mismatch**: "Hi Sarah" when the To: field is
  mike@... . Ground truth is the compose window itself.
- **Attachment promise**: "attached is" with nothing attached. (Gmail has
  this; we have it everywhere.)
- **Private-in-public**: "let's discuss this privately" typed into a
  reply-all with 15 recipients. Content intent vs recipient list.

## Tier 0.5 - public calendar truths (tiny public dataset, zero privacy cost)

- **Public-holiday collision**: "see you in the office Monday" -> Monday
  is a bank holiday. Needs only a country + a public holiday table.
- **DST asymmetry window**: US and EU switch clocks on different dates;
  for ~2 weeks twice a year every recurring transatlantic call shifts.
  "usual 9am call Monday" -> for that week it lands an hour off for them.
  Nobody tracks this; a table of switch dates does.
- **Tax/civic deadlines**: "I'll file in May" -> filing deadline is
  April 15. Registration windows, school enrollment cutoffs.
- **Sunset/golden hour**: "photos at 7, golden hour" -> sunset is 5:30 in
  November. Niche but delightful.

## Tier 1 - calendar (the flagship)

- **Busyness conflict**: "let's meet Thursday at 3" -> you have a hard block
  2:30-4. The launch demo.
- **Cancelled-meeting reference**: "we'll cover it at Monday's sync" ->
  Monday's sync was cancelled this week.
- **Others' availability** (shared calendars): "Priya can walk you through
  it tomorrow" -> Priya is OOO through Thursday.
- **Deadline drift**: "the offsite is in three weeks" -> calendar says five.
- **School-hours assumption**: "call during school hours Tuesday" ->
  Tuesday is a half-term holiday.
- **Stale meeting link**: pasting last week's Zoom link -> today's event
  carries a different link.
- **Informal double-promise**: told Alice "Saturday works" an hour ago, now
  typing the same to Bob. Commitments that exist only in messages, not yet
  on any calendar - arguably more valuable than the calendar cue because
  untracked promises are the ones people break.

## Tier 2 - inbox extraction (one pipeline, many cues)

Your inbox already contains the ground truth for most of your logistics:
confirmations, tickets, receipts, tracking. Nobody reads them twice; a cue
engine can. One email-parsing pipeline yields all of these:

- **Flight/train times**: "I land at 4" -> confirmation says 4:50, and
  that's arrival-local time, 1:50 for the person you're texting.
- **Reservation drift**: "dinner's at 7" -> OpenTable says 7:30, table for
  4, and you're inviting a 5th.
- **Return windows**: "I'll just return it" -> window closed Tuesday.
- **Voucher/gift-card expiry**: "let's use the voucher this weekend" ->
  expired Thursday. Also balance: "it has $50" -> $12 left.
- **Package promises**: "your gift arrives by Saturday" -> tracking says
  Monday.
- **Warranty claims**: "still under warranty" -> purchased 26 months ago,
  warranty 24.
- **RSVP never sent**: "we're going to Emma's wedding" -> you never replied
  and the RSVP deadline passed.
- **Free-trial conversion**: "the trial is free" -> it converts to paid
  tomorrow per the signup receipt.
- **Itinerary self-consistency**: "late breakfast Sunday?" -> checkout is
  10am and the flight is at noon per confirmations. Trip pieces that don't
  fit together.
- **Prescription ready**: "I'll pick it up Friday" -> pharmacy email says
  ready today / refill expired.
- **Streaming availability**: "let's watch it on Netflix" -> left Netflix
  last month, now on Hulu. (External catalog data, refreshable, low
  sensitivity.)

## Tier 3 - contacts and people data

- **Birthday off-by-one**: "happy birthday!!" -> their birthday is
  tomorrow. Enrichment twin: composing an unrelated message on their
  birthday -> want to mention it?
- **Anniversary math**: "we've been married 12 years" -> 13.
- **Stale contact forwarding**: "here's Dave's number: ..." -> contacts
  has a different number for Dave. Same for old email addresses.
- **Recipient timezone**: "how about 9am?" to someone whose contact card
  says Sydney -> that's 11pm for them. DST edge: "3pm your time / 6pm
  mine" -> offset changed last week, it's actually 7pm.
- **Allergy/dietary notes**: "I'll make the satay" while planning dinner
  with Jenna -> your note on Jenna: nut allergy. Small data, high stakes.
- **Name spelling**: "Hi Jon" -> their signature and address say John.

## Tier 4 - messages and payment history (opt-in, the whoa tier)

- **"I already paid you"**: "I Venmo'd you yesterday" -> no transfer in
  history. Reverse direction saves friendships: "you owe me $60" -> they
  paid you $60 last week.
- **"I texted you the address"**: that message was drafted, never sent.
  Deeply human - everyone has vivid memories of sending things they didn't.
- **Contradicting past-you**: "we've never discussed discounts" -> you
  offered 15% in a thread on May 3.
- **Gift duplication**: "I'm getting Dad a grill" -> sibling claimed the
  grill in the family group chat.
- **Duplicate purchase**: "I'll order the book" -> order history shows you
  bought it in March.

## Tier 5 - world data (maps, transit, weather)

- **Opening hours**: "that ramen place tonight?" -> closed Mondays.
- **Travel-time reality**: "I'll be there in 20" -> traffic says 35, or
  "meet at 9" -> 50 min away in current traffic, leave by 8:05.
- **Transit disruption**: "I'll take the 8:15" -> cancelled, next is 8:45.
- **Weather vs plans**: "picnic Saturday!" -> 70% rain forecast.
- **Event-time drift**: "game's at 8" -> moved to 8:30.
- **Moved/closed venues**: forwarding an address -> that business moved.
- **Passport-before-travel**: "booked Spain for August!" -> passport
  expires in July / under 6 months validity. Generalizes to licence,
  registration, insurance renewals.

## Tier 5b - city-life logistics (the shortlist lane, London-flavoured)

- **Last-train cue**: 11:40pm, typing "one more drink" or "I'll stay a
  bit longer" -> last train home is 12:04, last Tube ~00:30. The single
  most relatable transit cue for city dwellers.
- **Weekend engineering works**: "let's meet at Oxford Circus Sunday" ->
  that line is part-suspended this weekend, rail replacement bus. TfL
  publishes planned closures weeks ahead - perfect cache material.
- **Strike days**: "see you at work Tuesday" -> tube strike Tuesday.
- **Live bus/tube arrivals (TfL)**: cue when the stated plan breaks
  ("I'll get the 73" -> 12 min gap, you miss the film) and blank for
  `next buses from here _` -> inline list. Inline lists are a UX note:
  multi-line blank output.
- **Kick-off drift**: "watch the match at 3" -> moved to 5:30 for TV.
  Premier League reschedules constantly; fixture feeds are public.
- **Sold-out shows**: "let's get tickets for Saturday" -> Saturday is
  sold out, Friday has seats.
- **Film times**: "the 8pm showing" -> that cinema's showing is 8:40.
- **No tables for weeks**: "let's try that place Friday" -> earliest
  booking is three weeks out.
- **Bin-day shift**: "bins go out Thursday" -> collection moved a day for
  the bank holiday. Council data, deeply British, weirdly lovable.
- **Road closures**: "drive over Sunday" -> marathon closes those roads.
- **MOT/car admin**: "I'll drive us to Cornwall" -> MOT expired last
  week. UK flavour of the renewals family.
- **Venue rules**: "bring Rex to the pub garden" -> no dogs per the
  venue listing. "Bring the kids to the 7pm show" -> it's a 15.
- **Visiting hours**: "I'll pop by the hospital tonight" -> visiting
  ends at 7.
- **Live flight delay**: "I land at 4" -> your flight is already delayed
  45 min. Delays are sticky once posted, so cache-friendly enough to cue.
- **Fasting before appointment**: "grab breakfast before my blood test"
  -> the appointment letter says fasting required. Small, human, high
  value.
- **Voting day**: "I'll vote Saturday" -> the election is Thursday.
- **Registry duplication**: "I'll get them the toaster" -> already
  claimed on the wedding registry. Public data source, unlike group-chat
  mining.
- **Potluck duplication**: "I'll bring dessert" -> two people in the
  thread already said dessert.
- **Delivery-window planning**: "I'll be in Saturday for the parcel" ->
  the DPD window is Friday. You are planning a day around a wrong date.
- **Tide times**: "beach walk at 4" -> high tide, no beach. Coastal
  niche, delightful.

## Tier 5c - physics cues: calendar x maps fusion (round 4, the core lane)

The unifying idea: plans that violate physics - you cannot be in two
places, and you cannot get there that fast. Universally understood, no
explanation needed. These fuse two cached sources (calendar + travel
times) rather than reading one.

The impossible sandwich (calendar x calendar x maps):

- **Back-to-back across town**: "yes, 2pm works" -> your 1pm is in
  Hammersmith, this is Shoreditch, 55 minutes apart. The flagship of
  the class: neither meeting alone is a conflict; the pair is.
- **Duration mismatch**: "quick call at 4:30?" -> you have a hard stop
  at 4:45 and the caller books 30 minutes.
- **No-prep gap**: "I'll prep before the meeting" -> there is no free
  gap before it.
- **Forgot your own leave**: "let's meet on the 14th" -> you booked
  annual leave on the 14th. People genuinely forget their own holidays.
- **Redeye math**: "Thursday 9am works" -> you land Wednesday 23:55.
- **Wrong-timezone event**: "the webinar's at 3" -> the invite is 3pm
  ET, which is 8pm for you.
- **Dinner after the show**: "let's eat after" -> show ends 22:45,
  kitchen closes 22:00. End-time vs opening-hours fusion.
- **Chauffeur conflict**: "I'll drop you at the airport" -> your own
  9am meeting makes that impossible.

ETA and route reality (maps):

- **"I'll walk, it's 10 minutes"** -> it is a 25-minute walk. Chronic
  human distance underestimation, tiny and funny and universal.
- **Rush-hour blindness**: "meet at 5:30 across town" -> at that hour
  the 25-minute drive is 55. Time-of-day-aware ETA, not current ETA.
- **"On the way" that isn't**: "I'll swing by yours en route to the
  airport" -> 40-minute detour, you would miss check-in.
- **Airport buffer**: "flight's at 6, leaving at 4" -> 50-minute drive
  plus current 45-minute security wait at that terminal = missed. Live
  security-wait feeds exist.
- **Event egress**: "pick you up at 10 when the concert ends" -> 20k
  people leaving the O2; allow 30 minutes plus road closures.
- **Match-day traffic**: "Sunday drive will be fine" -> home fixture at
  the stadium on your route.
- **Station-proximity claims**: "it's right by Angel" -> 15-minute walk
  from Angel. Also "20 minutes on the tube" -> door-to-door is 40; people
  quote platform-to-platform.
- **Meeting-point ambiguity**: "the Starbucks on High Street" -> there
  are three. (Completeness cousin, maps-powered.)
- **Weather-adjusted cycling ETA**: "I'll cycle, 20 minutes" -> rain
  and headwind, closer to 35.

Transit-specific (TfL and friends), beyond the noted set:

- **Night-tube day-of-week**: "I'll tube it back after midnight" ->
  night tube runs Fri/Sat only on that line; tonight is Wednesday.
  Sibling of the last-train cue.
- **Night-bus switcheroo**: "I'll get the last 73" -> after midnight it
  is the N73 from a different stop.
- **Bus diversion**: "get the 43 to mine" -> the 43 is on diversion
  this week and skips that stop.
- **Step-free access**: "meet me at Covent Garden station" to a friend
  with a pram or wheelchair (contact note) -> no step-free access;
  suggest Leicester Square. The accessibility cue - warm, memorable,
  press-friendly.
- **Interchange advice**: "change at Bank" -> that interchange is a
  long walk or closed; better via Monument. (Possibly over-detailed.)

Group feasibility (multi-person, further out):

- **"Let's all meet at 7"** -> Sarah is coming from Croydon and cannot
  arrive before 7:45. Needs shared context; privacy-heavy, park it.

Naming note: "physics cues" is the sticky internal name - OpenCues
checks your plans against physics. The impossible sandwich is the
second demo after calendar busyness: same data sources, deeper insight,
and no competitor can even represent the problem (it needs two
commitments plus a travel-time matrix in cache at typing time).

## Tier 6 - life admin and family (normal-people sweep, round 3)

Parents and kids:

- **Term-time holiday booking**: "booked Center Parcs for the 12th" ->
  that is term time; unauthorised absence means a fine (UK). School
  term-date tables are public per council.
- **Pickup coordination gap**: "I'll get Emma" -> the other parent
  already claimed pickup in the thread (duplicate), or the inverse and
  scarier one: neither of you has (gap cue, the cousin pattern:
  detecting what is missing rather than what contradicts).
- **School-event drift**: "sports day is Friday" -> the school calendar
  says Thursday.

Renters and drivers:

- **Notice-period reality**: "I'll give notice next month" -> tenancy
  requires two months and the break-clause window passed. Contract PDFs
  hold the truth.
- **Driving-licence photocard expiry**: "I'll hire a car in Spain" ->
  photocard expired two months ago. UK photocards lapse every 10 years
  and nobody notices.
- **Service-day collision**: "I'll pick you up from the airport
  Tuesday" -> the car is booked into the garage Tuesday per the
  confirmation email.
- **Zombie subscription**: "I cancelled that" -> still charging monthly
  per the bank feed.

Travel:

- **eVisa/ESTA expiry**: "booked the US trip!" -> your ESTA lapsed.
  Confirmation emails carry issue dates; validity is fixed arithmetic.
- **Booking-detail drift**: "the Airbnb sleeps 8" -> the booking says 6.
  Same family as reservation drift: capacity, dates, cancellation
  deadline ("we can still cancel" -> free cancellation ended yesterday).
- **Travel insurance lapsed** before the trip you are typing about.

Home and hobbies:

- **Frost warning vs planting**: "I'll put the tomatoes out this
  weekend" -> frost Sunday night. Gardeners' April heartbreak; weather
  API plus a season table.
- **Cycling into ice**: "I'll cycle in tomorrow" -> ice or storm
  warning.
- **Grocery-delivery mismatch**: "dinner at ours Friday, I'll do the
  roast" -> the supermarket delivery slot is Saturday.
- **Broadcast fragmentation**: "the game's on Sky" -> this week it is
  on TNT/Amazon. UK football's channel roulette; fixture-broadcast
  feeds are public. Sibling of kick-off drift.

Relationships (gentle tier - nudges, never gotchas):

- **Recurring unkept promise**: "I'll call Mum this weekend" -> third
  consecutive weekend typing this. Framing must be warm.
- **Name precision**: "how's Sophie?" -> their daughter is Sofia (or
  Chloe). Contact notes as embarrassment-saver.
- **Overdue-checkup claims**: "I'm all up to date" -> last dental visit
  14 months ago per appointment emails; booster due per health app.

Completeness cues (the cousin pattern, worth its own exploration):
missing rather than wrong - invite with no date ("party at ours
Saturday!" -> which Saturday? no time, no address), nobody on pickup,
RSVP never sent, "see attached" with no attachment.

## Spooky tier - handle with tongs

High-virality, high-creepiness. Opt-in only, framed as helping you be
accurate, never as catching you out:

- **ETA honesty**: "5 minutes away!" while location says you haven't left
  home. If ever shipped: "want me to give them a real ETA?"
- **"It's on my way"**: maps says it is a 20 minute detour.
- **"First time" claims**: "we've never been to that place" -> location
  timeline says 2024.

## Work-context set (dev/team audience, from the earlier session sweep)

Tickets already closed (Linear/Jira), PR-still-open vs "fixed in main"
(GitHub), archived Slack channels, OOO mentions, on-call rotation flips
(PagerDuty), superseded docs (Notion/Drive), invoice-still-outstanding
(Stripe), figures vs dashboards (analytics), seat counts vs signed contracts,
externals-on-thread confidentiality, near-duplicate ticket creation, role
drift ("Marcus owns billing" -> Dana does).

## Precision principles

- Precision over recall, aggressively. One nag kills the feature.
- MVP bar per cue: explicit entity + confirmed hard ground truth + one
  quiet dismissable cue. No "smart" inference at launch.
- Cache TTL must match data volatility; calendar is fine at 1-5 min.
- Privacy is the moat: context feeds cues without leaving the machine
  (local Ollama) or with identity tokenisation on cloud calls. "Your
  calendar drives your cues without your calendar leaving your machine."

## Rollout ladder (by sensitivity and spookiness)

1. Tier 0 buffer/clock cues (no integration, trains trust)
2. Calendar busyness (flagship demo)
3. Inbox extraction (one pipeline, five-plus cue types)
4. Contacts (birthdays, timezones, allergies)
5. Work integrations (tickets, GitHub, Slack) for the dev audience
6. Messages/payments memory (opt-in, the whoa demo, the trust cliff)

## Data substrate: verified GTFS spike (18 Jul 2026)

Proved the no-login GTFS pipeline end to end on WSL, zero accounts:

1. Mobility Database aggregate catalog CSV (share.mobilitydata.org/
   catalogs-csv, no auth): 3,360 feeds, 46 GB feeds, auth-type field
   filters to keyless ones.
2. TfL tube feed (mdb-latest mirror of source 995, no auth): 10.6MB
   zip, all 11 lines, 1.25M stop_times rows.
3. Loaded to SQLite in 8.6s; last-train query answers in ~10ms.
4. Result: last Victoria line from Brixton - Wednesday 00:41, Friday/
   Saturday 03:21. The Wed-vs-Fri gap IS the night-tube cue, straight
   from calendar.txt service days; times past 24:00 encode
   after-midnight service.

Caveats: that archived feed is Oct 2017 (deprecated source) - the
mechanics are proven but production needs a current source. Options:
TfL Unified API (anonymous, 50 req/min, verified July 2026), a current
third-party GTFS conversion, or BODS (free registration). Non-London:
most world cities publish current GTFS keyless; UK national data is
the gated exception.

Spike part 2 (18 Jul 2026): anonymous TfL Unified API verified live,
zero keys, all 200s. Line status (disruption cue) and live Brixton
arrivals (next-trains blank) both work; /Line/victoria/Timetable/
940GZZLUBXN returned the current timetable in 213ms with the same
past-24:00 convention as GTFS. Current last Victoria line from
Brixton: Mon-Thu 00:28, Fri/Sat 02:57 (night tube), Sun 23:52. Two
product-relevant finds: (1) the 2017 archive said Wed 00:41 vs today's
00:28 - a stale cache would promise 13 minutes that do not exist,
concrete proof the TTL matters; (2) Sunday's last train is 36+ min
earlier than weekdays - the Sunday-night trap is its own high-value
cue variant. Architecture readout: static GTFS/SQLite for instant
queries + TfL API as both the freshness source and the live layer.

Substrate shortlist for other cues: iCalendar/.ics subscription feeds
(fixtures, term dates, bins), schema.org JSON-LD inside confirmation
emails (reservations, flights, parcels - parsing not LLM), IANA tzdb
(DST asymmetry), GOV.UK bank-holidays JSON, OSM opening_hours +
wheelchair tags, local OSRM routing for travel-time matrices (ETA cues
without sending locations to Google), vCard BDAY/TZ, Open Banking (UK,
regulated), DVLA/MOT free APIs, EXIF, XMLTV.

## The anchor model: location without sensing (18 Jul 2026)

Decision direction from Wilfred: users declare home station, work
station, etc. That plus timetables plus the clock plus (later)
calendar is the full physics system - no GPS, no tracking.

- **Anchors are config**: a [places] block in .cues - home, work, gym,
  partner, parents. Humans have 5-10 stable anchor places; that covers
  nearly every journey they type about. Hot-reload means editing an
  anchor takes effect in ~2s like everything else.
- **Free-text resolution, once**: anonymous TfL StopPoint search
  ("brixton" -> HUBBRX in 85ms, verified) at config load; cache the
  IDs. GTFS stops.txt fuzzy match for non-London.
- **Origin resolution ladder** (no sensor needed): explicit in the
  text ("from the office") > current calendar event's venue (calendar
  as location sensor) > time-of-day default (weekday 9-6 = work) >
  city-centre fallback with the cue phrased from the known end ("last
  trains into Brixton leave central London ~00:10") > stay silent.
  Precision rule applies: unsure origin = softer phrasing or no cue.
- **Privacy line**: anchors are strings in a local file. Journey calls
  hit TfL anonymously (TfL sees station pairs from an IP; the
  fully-local RAPTOR tier removes even that). Nothing about the user
  is stored anywhere but their own config.
- **Honest product note**: "one more drink" countdown cues are
  phone-shaped moments; OpenCues is desktop-first today. The launch
  weight goes on planning cues typed at a desk - impossible sandwich,
  arrive-by feasibility, Sunday trap while making plans, first-tube
  vs early flight - where desktop is exactly where the typing happens.

## Anchor collection FTUX (18 Jul 2026)

Design constraint: must work with no onboarding (may add onboarding
later). Collection happens inside the text field, at the moment of
demonstrated value.

- **Level 0, zero anchors**: IANA timezone = consented city-level
  location already on the machine -> selects the GTFS feed. Day-one
  cues with nothing declared: weekday mismatch, holidays, line
  status, last trains phrased from the known end.
- **Three collection paths**: (1) settings-from-text-field:
  `set home station brixton _` -> StopPoint resolve -> write
  [places] -> hot-reload ~2s; (2) just-in-time cue: when an anchor
  cue wanted to fire but could not ("I'll head home" at 23:20),
  offer the set-command once or twice ever, dismissable, then
  silent; (3) commented [places] template in default config for the
  config-reading beta audience.
- **Ambiguity via the core gesture**: wrong-Brixton resolution is
  cycled with Ctrl+Alt arrows like any other edit; original one
  cycle away.
- **Later, proposal never inference**: calendar-derived candidates
  ("meetings cluster at Old Street - set as work?") proposed via
  cue, adopted only explicitly.
- **Future onboarding = a kata**: five-minute places kata teaching
  set home/work and demoing the impossible sandwich, in the
  product's own grammar.
- **Progressive unlock pitch**: timezone -> city cues; home -> last
  trains; work -> commute + sandwich; calendar -> full physics.
  Each anchor visibly unlocks a named capability, giving JIT asks
  an honest pitch.

## Location model: presence providers (18 Jul 2026)

Requirement from Wilfred: never send exact location to an LLM by
default, and design so real location (GPS etc) plugs in first-class
later, not as an afterthought.

**Core insight: for transit math, nearest-stop snapping is not reduced
fidelity, it is native resolution.** Journeys can only start at stops,
so stop-level presence loses nothing for routing while giving
k-anonymity by construction (station cell = thousands of people;
bus-stop cell = dozens, hence the granularity knob).

**Pipeline separation makes the LLM rule structural, not policy.**
sentence -> LLM (intent only, no location in prompt) -> local
deterministic resolver (stop-level presence + timetable math) -> local
template fill. The prompt never contains location because it never
needs it.

**Provider abstraction (the pluggability requirement).** All location
sources implement one interface and emit RawPresence; a single local
PresenceStore normalizes them:

- provider kinds: declared (manual pin, anchors), inferred (wifi SSID
  -> anchor map, calendar venue, timezone->city), sensed (browser
  geolocation, future: CoreLocation, mobile host GPS, phone companion
  push).
- ingest: raw coord -> haversine snap against cached stops.txt
  (local, no API) -> PresenceRecord {stop_id, anchor?, city, ts, ttl,
  source, accuracy_class}. Raw coordinate discarded at ingest.
- the store NEVER holds precise coordinates. Explicit-share blanks
  ("I'm here, come find me _") do a one-shot precise read from the
  best sensed provider, use it in the composed artifact, discard it.
  Sensing precision therefore never changes what the store or LLM
  can see - adding GPS later changes zero downstream contracts.
- arbitration: freshest highest-precision wins, hysteresis on
  flapping; conflicts resolve by provider order in config.
- staleness: TTL (default ~60m), invalidated on network/SSID change;
  origin-dependent cues degrade to known-end phrasing or silence when
  presence is stale (precision rule).

**Consumer contracts.** intent LLM: no location, ever. Resolver:
stop/anchor/city. Cue templates: place names only. Share artifacts
(exact spot, directions to mine): full precision, but only via
content the user explicitly composed - never ambient. Third-party
disclosure surface: anonymous TfL journey calls reveal stop pairs to
TfL per IP; fully-local RAPTOR tier removes even that.

**Exact spot three-case split.** (1) place named in sentence: geocode
the place, user position uninvolved - the dominant rendezvous case.
(2) declared anchor: config coords; anchors gain an optional precise
pin field (home = station for routing; home.pin = plus code for the
door, used only in shared artifacts). (3) live position: only via a
sensed provider, opt-in, per-use; browser geolocation notes - it
works by sending the wifi neighborhood to Google/Apple location
services, the one ladder rung that phones home by design; desktop v1
ships cases 1+2 only.

**Plus codes**: Open Location Code is a 15-line offline base-20
encoding (verified in spike: East Finchley station = 9C3XHRPM+VX,
round-trip 8.4m). Encoding is free; only the coordinate source needs
design. Users can define home.pin AS a plus code so no address string
ever exists in config.

**Config sketch:**

    [location]
    snap = station | stop | area     # default station
    ttl = 60m
    providers = manual, wifi         # ordered; future: + geolocation, phone

    [wifi]
    "HomeWifi-5G" = home
    "OfficeCorp"  = work

Pending decisions: v1 default providers (recommend manual + wifi),
snap default (station), TTL (60m), whether wifi mapping ships in v1.

## Feature docs (one per blank, in isolation)

Each shortlisted blank has a standalone doc in ./blanks/:

- add-to-your-calendar.md - explored, links demo-built. Zero API.
- inline-directions.md - fully spiked and live-verified (TfL, GTFS,
  maps deep links). The reference implementation of the pattern.
- the-exact-spot.md - explored; Plus Code encoder verified. Three-case
  coordinate-source split.
- when-im-free.md - worked through, then PARKED AS FUTURE (18 Jul
  2026): single-shot fill cannot see the recipient's reply, and real
  scheduling is the intersection of two calendars. IMPORTANT
  SALVAGE: the secret ICS feed mechanism designed for it remains the
  intended no-OAuth calendar entry point for the cues (busyness,
  impossible sandwich, calendar-as-presence) - the integration
  outlives the blank that inspired it.

CUT (18 Jul 2026): jump-on-a-call. Verified meet.jit.si requires
creator login since Aug 2023; community instances (meet.ffmuc.net,
fairmeeting.net) still allow anonymous rooms but are donated infra,
and the BYO-standing-room fallback is just pasting a link the user
already owns. Wilfred's verdict: if login is needed anyway, the
blank adds too little. Do not re-propose without a genuinely
zero-friction room source.

Convention going forward: every new blank/cue feature gets its own
doc there before or as it is worked through; this file stays the
master strategy + cue catalog + infrastructure (anchors, location
model, substrate).

## Candidate blanks, round 2 (18 Jul 2026 - listed, not yet drafted)

Filtered by the bars: single-shot; beats-pasting; open-data-or-local
math; consent-by-typing; recipient-needs-nothing.

- meet in the middle _ (STAR): both origins in the sentence, journey
  matrix computes the fair point ("Victoria, ~22 min each"). Novel -
  needs anchors + travel matrix at typing time; no competitor can.
- split the bill _ : local math + keyless monzo.me/paypal.me amount
  link.
- timezone table _ : multi-city slot rendering, pure tzdb offline.
- weather window _ : open-meteo one-liner; composes into picnic
  messages.
- currency _ : ECB official daily reference rates, keyless; no live
  ticks (staleness rule).
- journey cost _ : TfL fares endpoint, fold into inline-directions.
- public-calendar micro-family (one doc): next bank holiday (GOV.UK
  JSON), next fixture (.ics feeds), bin day (council feeds), golden
  hour (astronomy).
- reading time / word count _ : buffer arithmetic, Level-0 tier.
- Rejected at listing: parcel tracking + photos-from-saturday (inbox
  tier, future), flight status (no keyless source), anything needing
  recipient data or pasting-what-you-own.

### what's open near X - MEASURED and reshaped (18 Jul 2026)

Live coverage test of OSM opening_hours on food/drink POIs:
East Finchley 800m = 3/21 tagged (14%); Soho 400m = 180/542 (33%).
Evaluator worked perfectly on tagged data (verified against Sat
22:07: restaurant open, 4am pizza open, daytime cafe closed) - the
DATA is the ceiling, even in the best-mapped district.

Design principle extracted - missing data is survivable for cues,
fatal for discovery blanks: a cue degrades to silence (fires only on
known hours - the closed-Mondays cue SURVIVES); a discovery blank
implies completeness, and listing 2 places when 10 are open misleads
by omission while looking authoritative.

Verdict: discovery form killed; targeted form kept ("is X still
open _" - known hours answer, else honest no-data + maps link);
discovery downgraded to pure link-rich (keyless Google Maps
"open now near" search URL - hours currency is a genuine Google
moat, owner-fed like live traffic).

## Open-standard play

Declare the skeleton in the cues format so third parties can write
contradiction cues we never thought of: entity type + data source +
freshness budget + mismatch template. That turns this from 30 features
into a platform, matching the open-standard story the site already tells.
