# BlankIntent

An LLM gate that decides whether a keyword script-blank should actually
run. Today a registered blank keyword near `_` runs the blank's script
**unconditionally** — so writing `the weather was lovely today _` wrongly
fires a weather fetch. With BlankIntent on, a one-shot LLM call gates each
keyword-matched blank: a genuine invocation runs; prose that merely
*mentions* the keyword is left alone.

OFF by default. Opt-in via `blank-intent-mode: on` in `~/.cues/OPENCUES.md`
(or `enable blank intent mode _` if `fluid-config-mode` is on).

---

## What it does

| You type | Without it | With it on |
|---|---|---|
| `weather london _` | fetches weather | fetches weather (INVOKE) |
| `the weather was lovely today _` | **wrongly fetches** | nothing — left as prose (CEDE) |
| `volume _` | reads volume | reads volume |
| `the volume was great at the show _` | **wrongly reads** | nothing (CEDE) |

The keyword is still **required** — the LLM never summons a blank you
didn't name; it only decides *whether* the keyword you typed is a real
invocation. So it can't be tricked by pasted/ambient text into running a
fetch or a script. On any LLM error it falls back to the old proximity
behaviour, so local blanks keep working offline.

## Typed actions — get, set, step

When it's on, the gate also extracts *what* you meant for settable blanks
(volume, brightness):

| You type | Result |
|---|---|
| `volume _` | reads the current volume → `54%` |
| `volume 30 _` | **sets** volume to 30 → `30%` |
| `volume up _` / `brightness down _` | **steps** by the blank's step size (volume 6, brightness 10), clamped 0–100 |

(Fetch/lookup blanks like weather and stocks are read-only — they ignore a
typed number; the number there is the lookup target, e.g. `weather tokyo _`.)

## Reach (line-scoped)

With the gate on, a keyword anywhere on the **same line** as `_` is
considered — you no longer need to tune how close the keyword must sit
(`what is the current weather in london right now _` works). A keyword on a
*previous* line is ignored. The LLM does the precision; the line is just
"is a tool plausibly in play here."

## Cost & trade-offs

- ~250ms per keyword-matched `_` (cerebras, cached after the first hit) —
  only on `_`s that have a blank keyword on the line; plain lookups
  (`draft an email _`) pay nothing.
- **Copula phrasings cede:** `volume is _` reads as prose, so it does
  nothing — use `volume _`. (A known trade-off of the precision.)
- Foreign-language invocations cede (the keyword list is English).

## See also

- Architecture / internals: [`docs/architecture/blank-intent.md`](../architecture/blank-intent.md)
- The settings-only sibling that inspired it: [Fluid Config](fluid-config.md)
- Config reference: [`docs/configuration.md`](../configuration.md)
