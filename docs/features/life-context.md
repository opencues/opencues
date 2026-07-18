# Life-context

Let OpenCues **reason over your calendar** while you type. When it's on, the LLM
that answers a `_` lookup — and a proactive cue — can see your upcoming events,
so you get answers a search box never could:

```
am i free thursday _   →  Free — nothing before 2pm
next event _           →  The Founding: Castle Growathon — Sat Aug 23, all day
```

…and if you type something your calendar contradicts, a cue quietly flags it:

```
I'm free at 3pm today.   — heads up: Dentist is 3:00pm–3:45pm
```

The heads-up also shows on the status line, so you don't have to cycle anything
to see it.

**This feature does not use MCP.** It reads plain iCalendar (`.ics` / webcal)
feeds — the same "subscribe" URL your calendar app already exports.

**OFF by default** — it carries calendar PII, so you opt in explicitly.

---

## Privacy — what reaches the LLM

- **Event times** are sent in the clear. A busy interval isn't personal, and the
  times are what the reasoning needs.
- **Event titles are never sent.** They stay on your machine as `[EVENT 1]`
  tokens; OpenCues fills the real title back in locally *after* the LLM answers.
  So the provider's logs never see "Dentist" — only "there's an event 3:00–3:45".

Same safe-mode boundary as [identity-context](identity-context.md).

---

## Turn it on

**1. Add a calendar feed** (any `.ics` / webcal URL):

```bash
opencues calendar add https://api.example.com/ics/get?...
```

`add` fetches the URL and checks it's really a calendar before saving it, then
tells you how many upcoming events it found.

Where to get the URL:

| Calendar | How to get the `.ics` URL |
|---|---|
| **Luma** | Account → Account Syncing → Calendar Syncing → Copy URL |
| **Google** | Settings → *your calendar* → Integrate calendar → **Secret address in iCal format** |
| **Outlook / M365** | Settings → Calendar → Shared calendars → Publish → ICS link |
| **Apple iCloud** | Share Calendar → Public Calendar → copy the `webcal://` link |

**2. Flip the scalar** in `~/.cues/OPENCUES.md`:

```
life-context-mode: on
```

(or cycle to it via `opencues settings _` in any editor.)

**3. Load it now** (optional — a running host also polls on its own):

```bash
opencues calendar refresh
```

---

## Managing feeds

```bash
opencues calendar list              # your feeds + live event counts
opencues calendar list --json       # scriptable
opencues calendar add <url>         # add (verifies it fetches + parses)
opencues calendar remove <url|N>    # remove by URL or 1-based number
opencues calendar sync              # fetch feeds → ~/.cues/life-context.json now
opencues calendar refresh           # ask a running host to re-poll (cache-busted)
```

Feeds live one-per-line in `~/.cues/life-context-feeds.txt`. Add as many as you
like — they're merged, deduped, and windowed to the next ~60 days.

---

## How it stays fresh

- A running editor re-polls your feeds every ~30 minutes
  (`life-context-poll-minutes`, min 5), picking up new events and any feed you
  add without a restart.
- `opencues calendar sync` rebuilds the snapshot on demand.
- `opencues calendar refresh` forces a fresh, cache-busting pull within ~20s.

Every host reads one shared file (`~/.cues/life-context.json`) — no per-editor
calendar setup. On Chrome it arrives through the config sync you already run.

---

## What you can ask

| You type | You get |
|---|---|
| `am i free thursday _` | free/busy computed from your events |
| `am i free at 2pm today _` | precise — respects the exact interval |
| `next event _` | the next event's title **and** its day/time |
| `whats on today _` | today's events with times |
| `when was my last meeting _` | past events are still nameable |
| *"I'm free at 3pm today."* | a cue flags a clash with your calendar |

---

## Notes & limits (prototype)

- The calendar-conflict cue needs a host that renders cues (native editors,
  Chrome contenteditable surfaces). Plain `<input>` fields and hosts without
  cycling show blank answers only, not the proactive cue.
- Recurring events are supported for simple daily/weekly rules; exotic RRULEs may
  be approximated.
- It's a **suggestion**, never an edit — the cue appends a heads-up you can
  ignore; nothing in your calendar is ever changed.

Design + internals: [`docs/architecture/life-context.md`](../architecture/life-context.md).
