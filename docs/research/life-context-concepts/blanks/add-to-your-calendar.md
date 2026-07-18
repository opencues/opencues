# Blank: add it to your calendar _

Status: explored and demo-built 18 Jul 2026 (links constructed and
verified well-formed; not yet product code). Unpublished draft.

## One-liner

The sentence you typed already contains the whole event; the blank
re-formats it into a one-tap calendar link for the recipient, inline,
without leaving the conversation.

## Use case

Plans made in chat never reach calendars. The calendar invite system
(iCalendar REQUEST over email) never crossed into social life: it
needs the other person's email (friends coordinate over WhatsApp),
it reads as corporate formality, and it requires leaving the
conversation to re-type a plan that was already typed. So the real
protocol for most human plans is "agree in chat, both parties
re-enter it manually or neither does", and every "what time was it
again?", forgotten dinner and double-booking downstream is that gap.

Scenarios ranked by frequency:

- Couples/family logistics: "dentist for Leo Tuesday 3:40, add it to
  your calendar _" in the partner WhatsApp. Highest frequency, zero
  tooling today.
- Group chat one-to-many: "five-a-side Saturday 2pm _" - one link,
  everyone installs, no attendee list or emails collected. This is
  the lightweight-events category (Partiful, lu.ma) as a text
  affordance instead of a product.
- Informal work edges: freelancer-client, interview scheduling,
  clubs - two calendars, no shared calendar system.
- Cross-timezone: the ctz parameter renders the event in the
  recipient's local time automatically, retiring a class of timezone
  arithmetic errors.

Asymmetry that makes it spread: sender pays one underscore, each
recipient gets a one-tap install; and every sent link is a demo in a
non-user's hands.

Strategic tie to the cue catalog: untracked chat-promises are the
disease behind the double-promising and forgotten-commitment cues.
This blank is the vaccine - the moment of agreement becomes the
moment of record.

## Grammar

    dinner at ours friday 7:30, add it to your calendar _
    add this to your calendar _        (event details from the
                                        surrounding sentence/thread)

## Mechanics (three stages, all standard components)

1. Extraction (LLM's only job): title / when / where from the
   sentence already written. Nothing new enters the prompt.
2. Resolution (local, deterministic): "friday" -> date via the same
   datetime engine the weekday-mismatch cue uses; "ours" -> home
   anchor NAME (never home.pin unless the user composes the address
   in); timezone from tzdb.
3. Construction (offline string building):
   - Google: calendar.google.com/calendar/render?action=TEMPLATE
     &text=..&dates=YYYYMMDDTHHMMSS/YYYYMMDDTHHMMSS&ctz=Europe/London
     &location=..
   - Outlook (live + office365 variants):
     outlook.live.com/calendar/0/deeplink/compose?subject=..
     &startdt=ISO&enddt=ISO&location=..
   - Universal fallback: a plain .ics VEVENT (Apple/desktop) - but
     ics is text that wants to be a file; data: URLs die in chat
     apps. The honest gap.

Zero API, zero network at compose time, zero rate limit.

## The recipient matrix

- Google Calendar: template URL, perfect one-click.
- Outlook personal/work: deeplink compose, perfect.
- Apple Calendar/desktop: needs the .ics as attachment (natural in
  email) or hosted (infrastructure - against the current aesthetic).
  v1 recommendation: ship Google+Outlook links; the plain-text event
  restatement covers everyone else.

## Cue synergies (the stacking)

- Weekday-date mismatch cue fact-checks "Friday the 25th" BEFORE the
  artifact is minted and sent to five people.
- Calendar busyness cue (once calendar lands): "dinner Friday 7:30"
  while you are busy -> cue fires before the invite exists.
- The passive layer is quality control for the generative layer; no
  competitor has both halves.

## Open decisions

- Fill format. Recommended: human text + link, most OpenCues-shaped
  and degrades perfectly for the Apple gap:
      Fri 24 Jul, 19:30 at East Finchley - add to calendar: <url>
  Alternatives: compact single link (cycle to Outlook variant);
  explicit dual links (noisy).
- Duration default (2h dinner / 1h call) surfaced as cycle
  alternatives via the standard Ctrl+Alt gesture.
- Whether the location field defaults to anchor name or nothing.

## Dependencies

Datetime resolver (shared with cues), anchors, tzdb. No presence, no
calendar integration, no API. Shippable before any integration work.
