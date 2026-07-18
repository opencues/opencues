# Blank: when I'm free _

Status: worked through 18 Jul 2026, then PARKED AS FUTURE by Wilfred.
Reason: the blank only shares the sender's half - real scheduling is
the intersection of two calendars, and the loop closes in the
recipient's reply, which a single-shot fill cannot see. Multi-turn
by nature, unlike the shipped set. Design below stands for when it
is picked up; the secret-ICS-feed mechanism is still the intended
calendar entry point for the CUES (busyness, sandwich, presence),
independent of this blank. Unpublished draft.

## One-liner

"when I'm free _" fills with your actual open slots as plain text,
computed locally from your own calendar - Calendly without Calendly:
no booking page, no account, no third party ever seeing your
calendar.

## Use case

Scheduling ping-pong ("when works?" "how about..." "no, then...")
is the tax on every informal meeting. Calendly solved it by putting
your calendar behind a third-party booking page - which is overkill
and oddly formal for friends, and hands your availability to a SaaS.
The blank answers the question in the message itself:

    when I'm free _  ->
    "Tue after 2, Wed before 11, Thu is open - next week is better"

Plain text: readable by anyone, on anything, forwardable, no link
required. The recipient replies "Wed 10" and the add-to-your-calendar
blank mints the event - availability -> agreement -> invite, all
inside a chat thread with zero infrastructure.

## Mechanics (settled 18 Jul 2026)

1. Source - THE SECRET ICS URL: Google/Outlook/iCloud/Fastmail all
   issue a private read-only "secret address" ICS feed per calendar.
   One pasted config line:
       [calendar]
       feed = "https://calendar.google.com/calendar/ical/...ics"
   No OAuth, read-only by construction, user-revocable at the
   provider, provider-agnostic - iCalendar pointed at your own life.
   Polled on TTL into the same local cache the busyness cue reads:
   one integration, four features (this blank + busyness cue +
   impossible sandwich + calendar-as-presence).
2. Compute: working-hours window minus busy blocks minus min-slot
   filter, over a horizon (default 5-7 days). Local arithmetic.
   DIFFERENTIATOR: pad busy blocks with travel time from the physics
   engine (2-3pm at Hammersmith means not free in Shoreditch until
   3:41). "Free" means reachable-and-free; no scheduling tool does
   this because none has anchors + journey data.
3. Render: humanised ("Tue after 2"), meaningful-boundary rounding,
   suppress sub-30-min crumbs, duration-aware variants ("free for
   dinner _" = evening slots only).

Zero API at fill time once the cache exists.

## The social masterstroke: curated availability

The fill is a DRAFT in the sender's buffer, not a published page.
Delete Tuesday before sending - free but not offering it to this
person. Calendly's page tells everyone the whole truth; the blank is
computed availability curated by the human, which is how people
actually share time. The sender-check safety net as a social
feature.

Honesty hedge: calendars lie by omission (untracked promises - the
disease the cue catalog treats). The fill offers slots, never
certifies them.

## Privacy notes

- The output discloses availability - but the user is composing it
  into a message deliberately, the same consent-by-typing rule as
  the-exact-spot.
- Only free/busy shape is disclosed, never event contents; config
  may cap detail ("mornings bad, Thu open" vs exact slots).
- Nothing leaves the machine to compute it; contrast Calendly where
  a third party holds the whole calendar.

## Dependencies

Calendar integration (the first permissioned context tier) - this
blank is a strong pull-through reason users will grant it. Working
hours config. The datetime humaniser (shared with cue phrasing).

## Open decisions

- Default horizon and slot granularity.
- Detail cap: exact slots vs coarse shape.
- Whether the fill offers recipient-timezone rendering ("your time")
  when the thread's other party has a known TZ (contacts tier).
- Cross-calendar merge (work + personal .ics) rules.
