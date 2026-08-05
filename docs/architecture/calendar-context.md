# Calendar-context — proactive steering from ingested life-data

*Status: prototype, shipping behind `calendar-context-mode: off` (default). Phase 1a
(fluid-blank reasoning) + Phase 2 (conflict cue) are built; the ingest producer
is calendar-feed (`.ics` / webcal) based. See the phasing table below.*

The system periodically ingests a **bounded snapshot** of your life-data (today
the next ~60 days of calendar events), holds it as **safe-mode context**, and
lets **cues** (LLM→user suggestions) and **blanks** (`_` answers) *proactively
steer* off it while you type. When your text touches something the context
covers — a time, "free", a date — the relevant fact surfaces.

> Not: `_` → invoke a tool → fill.
> But: **background-ingest a snapshot → it becomes context → cues/blanks use it.**

**This feature has no dependency on MCP.** The ingest mechanism is a *producer*
that writes a snapshot file; the shipped producer reads iCalendar feeds. MCP is
one *possible future* producer (see § Future ingest sources), not part of the
current design or code path.

## Why this fits OpenCues (and is far safer than a tool-runner)

It's the existing `identity-context` / `blank-context` / `ambient-context`
pattern with a new source. The runtime already knows how to take a catalog of
sanitized facts, dehydrate the values, and let sources reference them. The
calendar producer just fills that catalog from `.ics` feeds instead of
IDENTITY.md or a stock blank.

Crucially, it has **no user-triggered invocation, no write tools, no action
channel.** The entire ingest surface is "fetch a small snapshot on a cadence and
write it to a file."

## Architecture — one produced file, every host consumes

```
┌─ calendar feeds (.ics / webcal — Luma, Google, Outlook, Apple, any) ─┐
│   listed one-per-line in ~/.cues/calendar-feeds.txt              │
└───────────────▲──────────────────────────────────────────────────────┘
                │  bounded fetch (next ~60 days), parse, dedup, sort
       ┌────────┴─────────┐
       │ PRODUCER          │   `opencues calendar sync` (CLI) OR a host-side
       │ (ics.ts parser)   │   poller — fetch → parseIcs → snapshot
       └────────┬─────────┘
                ▼
     ~/.cues/calendar.json   ← the ONE shared snapshot (times in the clear,
                │                   titles as [EVENT N] tokens hydrated locally)
     ┌──────────┴───────────────────────────┐
     ▼ (native hosts read the file directly) ▼ (chrome via the config bundle)
  CUES (capable model)                      BLANKS (fast/capable model)
  calendar-conflict flag + statusline       `am i free thursday _`, `next event _`
```

- **Feeds** — `~/.cues/calendar-feeds.txt`, one `.ics`/`webcal` URL per line,
  edited by `opencues calendar add/remove`. Any iCalendar feed works; one parser
  (`packages/opencues-core/src/ics.ts`) covers Luma, Google, Outlook/M365, Apple.
- **Producer** — fetches every feed, parses to normalized events, dedups, sorts,
  windows to the next ~60 days, and writes `~/.cues/calendar.json`. Two
  triggers: the `opencues calendar sync` CLI command, and a host-side poller (see
  § Freshness / cadence). **No per-host poller duplication** — one file, produced
  once, consumed everywhere.
- **Consumption** — the resolver loads the snapshot into a `CalendarContextSnapshot`
  (`packages/opencues-core/src/calendar-context.ts`) and feeds it to cues + blanks
  exactly like the other context catalogs. Sources *reference* it in the
  keystroke path; nothing fetches per `_`.

## The snapshot — PII boundary

`calendar-context.ts:buildCalendarContextSnapshot` builds the in-memory shape:

```ts
{ events: [{ token: '[EVENT 1]', title, start, end, allDay?, location? }, …],
  catalog: Map<'[EVENT 1]', title>,   // for local hydration
  ingestedAt }
```

Calendar-context is a **reasoning** catalog, unlike the *substitution* catalogs
(identity/blank/system-context), and it splits its data by sensitivity:

- **Event TIMES reach the LLM in the clear.** A busy interval is not PII, and the
  times ARE the reasoning substrate ("is 915 between 900 and 945?"). Rendered as
  minutes-since-midnight so availability is pure arithmetic, not fragile clock
  reasoning, with a 12h gloss alongside.
- **Event TITLES are PII, so they stay local as `[EVENT N]` tokens.** The LLM
  emits the token verbatim; the runtime hydrates the real title via
  `postProcessContext` AFTER the response — the same dehydrate/hydrate path
  identity-context safe mode uses. A hostile calendar invite title never reaches
  the provider's logs.

Two render paths, both in `calendar-context.ts`:

| Path | Used by | Emits |
|---|---|---|
| `renderCalendarContextCatalog` | fluid-blank (BLANK) | events + CURRENT-MOMENT anchor + the availability/lookup RULES (answer free/busy, name the event with day+time) |
| `renderCalendarContextForCue` | sentence-cue (CUE) | the same events + anchor, WITHOUT the answer rules — the CUE.md body owns the task (flag a scheduling contradiction) |

The CURRENT-MOMENT anchor is computed **live at resolve time**, never from the
snapshot's `ingestedAt` — otherwise a snapshot pulled yesterday makes yesterday's
events read as "today" after midnight.

## Consumption — cues and blanks

- **Blank (answer):** `am i free thursday _` → the LLM reads the snapshot and
  answers from the event times (`Free — nothing then` / `Busy ([EVENT 1])
  3:00–3:45pm`). `next event _` / `whats on today _` → the event's title token
  PLUS its day + time (`[EVENT 1] — Sat Aug 23, all day`), never the bare title.
- **Cue (proactive):** the shipped `defaults/cues/calendar/CUE.md`
  (`scope: sentence`, `uses-calendar-context: true`, `priority: 90`) reads each
  sentence; if it claims availability that contradicts the calendar it flags a
  heads-up — `I'm free at 3pm today` → *"— heads up: Dentist is 3:00pm–3:45pm"*.
  The cue is a **passive advisory, not a cycleable alternative.** The source
  extracts the LLM's appended heads-up into a `⚠` `def.cueTip` and emits
  `alternatives: [originalSentence]` (length 1) — so there is nothing to cycle
  TO, only the flag. (Cycling a heads-up INTO the buffer would splice the
  advisory text into the user's message — the whole reason it's withheld.) It
  reveals as a passive `⚠ <message>` inline note (no countdown, no
  `(underscore to cycle)` hint — see `inline-cues.md` § The note vocabulary) and
  on the **status line**, so no keystroke is needed to see it; ignore it to
  dismiss. Priority 90 sits above default cues (e.g. the formalizer at 85) so a
  calendar conflict wins the sentence claim.

### Model routing

Reasoning over a snapshot ("free at 3pm given these events?") is a **cue-class**
job — it routes through the **cues / auditors bucket** (a capable model), not the
fast blanks bucket. This is the existing three-bucket routing
(`docs/architecture/llm-routing.md`); no new mechanism. The isolated latency of
the conflict-cue LLM call is benched at `tests/benchmarks/fluid-blank-ambient/
calendar-context-cue-latency.ts` (median ~319ms on groq gpt-oss-120b; a rare tail
spike is the provider, not the pipeline — the whole context is in the prompt, no
extra call).

## Security model

Because ingest is *read-only and file-based*, the model is the **safe-mode
context** boundary already proven for identity/blank-context — not a tool-call
threat model.

1. **Read-only, bounded, periodic.** Fetch `.ics` on a cadence; window to the
   next ~60 days, cap at 50 events. No writes, no per-`_` invocation, no user
   input steering a fetch.
2. **Snapshot dehydrated.** Titles never leave the machine (`[EVENT N]` tokens,
   hydrated locally). Times are non-PII by design.
3. **Capable model must not `trainsOnInput`.** The cues bucket carries prose, so
   it refuses train-on-input providers (the existing resolver guard).
4. **No action channel.** Output is a *cue* (a suggestion you see) or a *blank
   fill* (text you review). Worst-case prompt-injection from a malicious invite
   title = a bad *suggestion*, never an action — the ambient-context invariant.
   **Do not wire calendar-context output into any side-effect layer** without
   re-reviewing `security-audit.md` row #21.
5. **On by default, but inert without a feed.** `calendar-context-mode: on` in
   OPENCUES.md — yet with no feed configured the snapshot is empty, so
   `renderCalendarContextCatalog` returns `''` and the resolver forwards nothing:
   zero data leaves the machine until the user runs `opencues calendar add`. That
   feed-add is the real consent gate — adding a calendar is the deliberate act, so
   a redundant second mode-toggle isn't needed. The residual once a feed exists:
   only anonymized busy-interval **times** cross the wire (titles + locations are
   dehydrated); a reasoning catalog can't hide the times it reasons over. Explicit
   `off` disables even a configured feed. (Contrast system-context, which is a
   pure-substitution catalog — nothing sensitive ever crosses the wire — so its
   on-by-default has no residual at all.)

## Freshness / cadence

- **CLI sync** — `opencues calendar sync` fetches every feed and rewrites the
  snapshot on demand (also run with `--silent` from install/cron).
- **Host-side poller** — a running host re-polls the feeds on a cadence
  (`calendar-poll-minutes`, default 30, clamped [5, 1440]) and re-reads the
  feeds file each poll, so `add`/`remove` are picked up without a restart.
- **On-demand refresh** — `opencues calendar refresh` drops a
  `~/.cues/.calendar-refresh` trigger; a running host re-polls (cache-busted)
  within ~20s.
- **No network in the keystroke path.** A `_` that references the calendar reads
  the cached snapshot file — that's what keeps it fast.

## CLI — `opencues calendar`

The user-facing surface (full walk-through in
`docs/features/calendar-context.md`):

```
opencues calendar add <url>        add a feed (fetches + parses to verify)
opencues calendar list [--json]    list feeds + live event counts
opencues calendar remove <url|N>   remove a feed by URL or 1-based index
opencues calendar sync             fetch feeds → ~/.cues/calendar.json
opencues calendar refresh          force a fresh (cache-busting) poll now
```

`add` verifies the feed actually fetches and contains a `VCALENDAR` block before
writing it (a 200 that returns an HTML login page is rejected). Feeds work with
Luma (Account → Account Syncing → Calendar Syncing → Copy URL), Google's secret
`.ics` address, Outlook, Apple iCloud, or any iCalendar URL.

## Use cases

| You're typing… | Steer |
|---|---|
| `am i free thursday _` | "free after 2pm" (computed from event times) |
| `next event _` | "[EVENT 1] — Sat Aug 23, all day" (title + day/time) |
| "I'm free at 3pm today." | cue flags: "— heads up: Dentist is 3:00pm–3:45pm" + statusline |
| "Let's meet on august 23rd." | cue flags the all-day Conference clash |

The unifying value: **the system knows what you'd otherwise stop to look up, and
offers it exactly when your typing needs it** — a gentle cue, or a `_` answer.

## Phasing

| Phase | Scope | Status |
|---|---|---|
| **1a** | Ingest calendar → safe-mode catalog → `free/busy` + lookup blank | **built** (fixture, then real ICS) |
| **1b** | ICS producer + `opencues calendar` CLI + host poller | **built** |
| **2** | Proactive calendar-conflict cue + statusline advisory | **built** |
| **3** | Add email (subjects + snippets) + tasks; per-source consent dials | future |
| **4** | Contacts, files/git; broader ingest sources | future |

## Future ingest sources

The producer/consumer seam (feeds → snapshot file → catalog) is deliberately
ingest-agnostic. Anything that can write a `calendar.json`-shaped snapshot
plugs in without touching the runtime:

- **More feed types** — email (subjects + snippets), task lists, reminders.
- **MCP** — a read-only MCP ingester (Calendar / Gmail / Tasks) that pulls
  bounded snapshots on a timer is *one* candidate producer. It would reuse this
  exact catalog + dehydration path; it is NOT required, and nothing in the
  shipped feature depends on it. If pursued, it drops the hard parts of a
  tool-call hub (no invocation, no writes, no action channel) — the same
  safe-mode ingest shape as the calendar feeds.

The open questions for any new source — relevance gating, dehydration
granularity, cadence vs freshness, cue noise budget — are the same as for the
calendar producer; solve them per source.

## Known limitations / deferred

- **Safe-mode title lookup is weak by construction.** Because titles are
  dehydrated, the LLM sees `[EVENT 1]`, `[EVENT 2]` … with times but *no titles*,
  so `when was the supabase meeting _` can't match the typed word "supabase" to an
  event except by elimination (works with one event; unreliable with several).
  **Deferred fix (keeps the PII boundary intact):** a **local pre-match** — before
  dispatch, on-machine, fuzzy-match the typed query term against the catalog's real
  titles and inject the resolved token (`[EVENT 1]`) so the LLM gets the right
  token without any title leaving the machine. Same shape as identity-context's
  tolerant matching, applied OUTBOUND (query term → token). The `raw`-mode
  alternative (inline titles) is rejected by default — it sends PII.
- **The conflict cue also requires `sentence-cues-mode`** to be on (it rides the
  sentence-cue build gate). That mode is now **on by default** (`!== 'off'`, 2026-08),
  so in practice both gates are open unless the user explicitly disabled one.
  Decoupling it so `calendar-context-mode: on` is sufficient on its own is a follow-up.
- **Segmenter / RRULE** — simple daily/weekly recurrence is handled; exotic
  RRULEs are approximated.

## See also

- `docs/features/calendar-context.md` — user-facing summary + the `opencues calendar` walk-through
- `docs/architecture/blank-context.md` — the catalog shape this reuses
- `docs/architecture/identity-context.md` + `hydration-dehydration.md` — the safe-mode PII boundary
- `docs/architecture/ambient-context.md` — the no-action-channel invariant this depends on
- `docs/architecture/llm-routing.md` — the three-bucket routing that puts reasoning on a capable model
- `docs/architecture/sentence-cues.md` — the `scope: sentence` cue mechanism the conflict cue rides
