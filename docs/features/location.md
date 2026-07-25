# Location blank

Look up a place, address, or point of interest inline. Type the query,
end with `_`, and the `_` fills with the result.

```
location east finchley iceland _   → 115 High Rd, London N2 8AW
british museum map _               → 🏛 British Museum
                                     Great Russell St, London WC1B 3DG
                                     Mon–Sun 10:00–17:00 · +44 20 7323 8299
                                     britishmuseum.org · maps.google.com/…
```

No API key, no signup — it queries **OpenStreetMap's Nominatim**
directly. Built-in (`LocationBlank` in `@opencues/runtime`), wired on
every host; on by default like the other data blanks.

## Two output modes, one blank

The trigger keyword picks the shape of the answer:

- **`location`** / **`address`** → a terse one-line address.
- **`map`** → a rich **location card**: name, address, opening hours,
  phone, website, and a Google Maps link built from the coordinates.

Same fetch underneath; the keyword just selects the render.

## Grammar

Three shapes, first match wins (`blankShapes` in
`defaults/blanks/location/BLANK.md`):

1. **Leading** — `location <place> _`, `map <place> _`
   (`map british museum _`).
2. **Trailing** — `<place> location _`, `<place> map _`
   (`east finchley iceland location _`) — the query precedes the trigger.
3. **Bare** — `location _` → a usage hint (fills only the `_` so your
   typed command survives for you to complete).

Because it's `blankShapes`-gated, the keyword in ordinary prose ("the
location was great") does **not** fire it — only the anchored command
shape does.

## Notes & limits

- **24-hour cache per query** — Nominatim's usage policy asks callers to
  cache; repeat lookups within the day don't re-hit the API.
- **Identifying User-Agent** is sent on every request (also a Nominatim
  policy requirement).
- **No ratings / reviews / photos** — those are Google-proprietary and
  aren't in OpenStreetMap. The card carries the objective fields OSM has
  (address, hours, contact) plus a Maps link to hand off to Google if
  you want the rest.
- Graceful on failure — an empty result or a 5xx fills a clear "no
  match" rather than hanging the `_`.

## See also

- `docs/guides/adding-a-cue-blank.md` — how blanks + shapes work
- `docs/features/calendar-context.md` — the calendar `where is <event> _`
  location lookup (resolves from your own calendar, not OSM)
