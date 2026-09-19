---
last_updated: 2026-09-19
---

# Tables & calculators

`table-lookups-mode: on` (off by default) turns the `_` into an offline
reference desk: eight bundled data tables and a library of pure-code
calculators answer with **no LLM call, no network, and no way to be wrong the
way a generated answer can** — the answer is a table row or arithmetic over the
words you typed. When the thing you asked isn't in the table, nothing fires and
the `_` falls through to the normal lookup, so a miss costs nothing.

Two ways in:

- **Keyword forms**, always: a shape in `defaults/blanks/tables/BLANK.md`
  claims the `_` (`hex for tomato _`, `days between 3 march and 19 september _`).
  Zero LLM, works without a decision package.
- **Plain phrasings**, with `decisions-provider` on: the `_` route names the
  calculator (`what's the postgres port _`, `how old is someone born 14 march
  1990 _`), a grammar captures the operands from your own words, and the same
  code answers. The model only ever picks an id; it never emits the argument.

Every answer replaces the command and stands alone (`hex for tomato _` →
`tomato: #ff6347`); prior prose survives (`ok done. hex for tomato _` → `ok
done. tomato: #ff6347`). `undo _` reverts a fill like any other.

The demo-friendly rule of thumb: **if the answer is the same in ten years, it
belongs here.** Anything live (prices, weather, rates) stays on the network
blanks; anything opinion-shaped stays generative.

---

## The seven families

All seven families are shipped (188 calculators + the eight tables + six
country facts); each follows the same three gates: a closed id, grammar-captured
operands, the table or parser as the last gate. Reference tables (NATO
alphabet, morse, country codes, cooking measures, sizes) are the next wave.

### 1. Reference tables ✅ (the original eight)

| you type | you get |
|---|---|
| `unicode for em dash _` | `em dash: — U+2014` |
| `unicode for copyright sign _` | `copyright sign: © U+00A9` |
| `hex for tomato _` | `tomato: #ff6347` |
| `rgb for #1e90ff _` | `#1e90ff: rgb(30, 144, 255)` |
| `http status for not found _` | `404 Not Found` |
| `http status 418 _` | `418 I'm a teapot` |
| `mime type for png _` | `png: image/png` |
| `default port for postgres _` | `postgres: 5432` |
| `convert 5 miles to km _` | `5 miles = 8.04672 km` |
| `convert 100 celsius to fahrenheit _` | `100 celsius = 212 fahrenheit` |
| `how many feet in a mile _` | `1 mile = 5280 feet` |
| `calc 17 * 23 _` | `17 * 23 = 391` |
| `calc 15% of 240 _` | `15% of 240 = 36` |
| `calc pi to 5 decimals _` | `pi to 5 decimals = 3.14159` |
| `atomic number of gold _` | `Gold (Au): atomic number 79` |
| `boiling point of water _` | `water: boils at 100 °C` |
| `ph of lemon juice _` | `lemon juice: pH 2` |

Country facts live on the sibling `countries` blank and are named by the same
route: `capital of france _`, `what money do they use in brazil _`, `how many
people live in japan _`, `what do they speak in switzerland _`.

Plain phrasings that reach the same rows: `what port does redis use _`, `which
http code for too many requests _`, `how do i type a degree symbol _`, `what's
the content type for json _`, `at what temperature does water boil _`, `how
acidic is vinegar _`.

`convert` and `calc` only claim the `_` when a number follows, so `convert this
to markdown _` and `calculate the risk _` stay rewrite requests.

### 2. Dates & durations ✅ (20 calculators)

Calendar arithmetic on whole days (a DST change never makes a day 23 hours
long); the clock is the host's. Dates read the way people write them:
`2024-03-01`, `14 july 1789`, `march 3rd`, `3/3/2024` (day first), `today`,
`tomorrow`, `friday` (the next one), `next saturday`, `christmas`, `new year`,
`halloween`.

| you type | you get |
|---|---|
| `days between 3 march and 19 september _` | `200 days (28.6 weeks)` |
| `working days between 1 sep and 30 sep _` | `21 working days (Mon–Fri, no holidays counted)` |
| `weekday of 14 july 1789 _` | `Tuesday (14 Jul 1789)` |
| `90 days from today _` | `Fri 18 Dec 2026` |
| `3 weeks from friday _` | `Fri 16 Oct 2026` |
| `2 months after 31 jan 2026 _` | `Tue 31 Mar 2026` |
| `45 days ago _` | `Wed 5 Aug 2026` |
| `weeks until christmas _` | `13.9 weeks (97 days, Fri 25 Dec 2026)` |
| `days since 1 jan _` | `261 days (37.3 weeks)` |
| `in 45 minutes _` | `13:15` |
| `3 hours from now _` | `15:30` |
| `duration 3 hours 20 minutes plus 1 hour 55 _` | `5 h 15 min` |
| `age if born 14 march 1990 _` | `36 years (since 14 Mar 1990)` |
| `iso week of 19 september _` | `week 38 of 2026` |
| `day of year _` | `day 262 of 365` |
| `leap year 2100 _` | `2100 is not a leap year` |
| `quarter _` | `Q3 2026` |
| `easter _` | `Sun 28 Mar 2027` (the next one) |
| `last friday of october _` | `Fri 30 Oct 2026` |
| `second tuesday of november 2026 _` | `Tue 10 Nov 2026` |
| `unix time _` | `1789817400` |
| `unix 1700000000 _` | `Tue 14 Nov 2023 22:13:20 UTC` |
| `iso now _` | `2026-09-19T11:30:00.000Z` |
| `seconds in 3 days _` | `259200 seconds (4320 minutes, 72 hours)` |

Plain phrasings: `how many days between 3 march and 19 september _`, `what day
of the week was 14 july 1789 _`, `how long until new year _`, `how old is
someone born 14 march 1990 _`, `when is easter _`, `when is the last friday of
october _`, `what date is timestamp 1700000000 _`, `what day number is today _`.

Not claimed (prose that merely uses a keyword): `in the end _`, `after the
meeting _`, `the last one _`, `first draft _`, `until then _`, `since you asked _`.

### 3. Timezones ✅ (6 calculators)

ICU (`Intl.DateTimeFormat`) does offsets and daylight saving; the only data is
a ~330-entry map from the names people type (cities, `est`, `cet`, `ist`,
`aest`, `utc+5`, an IANA name) to a zone.

| you type | you get |
|---|---|
| `time in tokyo _` | `20:30 Sat 19 Sept (GMT+9, UTC+09:00)` |
| `3pm london in tokyo _` | `23:00 Sat 19 Sept in tokyo (GMT+9, UTC+09:00)` |
| `9am est to utc _` | `13:00 Sat 19 Sept in utc (UTC, UTC+00:00)` |
| `utc offset of tokyo _` | `UTC+09:00 (Asia/Tokyo, GMT+9)` |
| `is it dst in london _` | `yes — BST, UTC+01:00 (standard is UTC+00:00)` |
| `is it dst in tokyo _` | `no — Asia/Tokyo does not observe daylight saving (UTC+09:00)` |
| `overlap between london and new york _` | `14:00–17:00 london = 09:00–12:00 new york (3 h of 9–5)` |
| `overlap between london and sydney _` | `no overlap of 9–5 (sydney is +9 h from london)` |
| `meeting at 3pm london for new york tokyo _` | `London 15:00 · New York 10:00 · Tokyo 23:00` |

Plain phrasings: `what time is it in sydney _`, `timezone of lisbon _`,
`daylight saving in sydney _`, `call at 10am berlin with sydney _`.

### 4. Number formatting & number theory ✅ (26 calculators)

| you type | you get |
|---|---|
| `1234567 in words _` | `one million, two hundred and thirty-four thousand, five hundred and sixty-seven` |
| `1e9 in words _` | `one billion` |
| `2024 in roman numerals _` | `MMXXIV` |
| `MCMXCIV in numbers _` | `MCMXCIV = 1994` |
| `255 in hex _` | `0xff (binary 11111111, octal 377)` |
| `10 in binary _` | `0b1010 (hex 0xa, octal 12)` |
| `0b1011 in decimal _` | `11` |
| `3/8 as a decimal _` | `0.375` |
| `0.375 as a fraction _` | `3/8` |
| `2.5 as a fraction _` | `2 1/2 (5/2)` |
| `3/8 as a percent _` | `37.5%` |
| `123456 in scientific notation _` | `1.23456e5 (1.23456 × 10^5)` |
| `round 3.14159 to 2 decimals _` | `3.14` |
| `round 1234 to the nearest hundred _` | `1200` |
| `0.00123456 to 3 significant figures _` | `0.00123` |
| `ordinal for 22 _` | `22nd` |
| `1234567 with commas _` | `1,234,567` |
| `2500000 in millions _` | `2.5 million` |
| `2500000 in lakhs _` | `25 lakh` |
| `factorial of 10 _` | `3,628,800` |
| `is 97 prime _` | `97 is prime` |
| `is 91 prime _` | `91 is not prime (7 × 13)` |
| `prime factors of 360 _` | `2 × 2 × 2 × 3 × 3 × 5 (2³ · 3² · 5)` |
| `gcd of 48 and 180 _` | `12` |
| `lcm of 4 and 6 _` | `12` |
| `fibonacci 20 _` | `6,765` |
| `cube root of 27 _` | `3` |
| `4th root of 81 _` | `3` |
| `log base 2 of 1024 _` | `10` |
| `mean of 3 5 8 13 _` | `7.25` |
| `stats of 3 5 8 13 _` | `mean 7.25 · median 6.5 · sd 4.35 · min 3 · max 13 · n 4` |
| `sum of 1 to 100 _` | `5050` |
| `5 choose 2 _` | `10 combinations (20 permutations)` |
| `probability of 3 heads in 5 flips _` | `31.25% (10/32) exactly · 50% at least 3` |

Plain phrasings: `what's 255 in hex _`, `spell out 1e9 _`, `average of 3, 5, 8
and 13 _`, `what are the odds of 3 heads in 5 flips _`, `permutations of 3
from 10 _`.

### 5. Percent & money ✅ (19 calculators)

All closed-form. The VAT rate is the `vat-rate` tunable (default 20, in the
settings menu under Blanks); a rate written in the command wins. Never
exchange rates or inflation (live data).

| you type | you get |
|---|---|
| `20% off 85 _` | `68 (saves 17)` |
| `85 is what percent of 340 _` | `25%` |
| `percent change 80 to 92 _` | `+15% (80 → 92, +12)` |
| `85 plus 20% _` | `102 (+17)` |
| `tip 15% on 64.20 _` | `tip 9.63 · total 73.83` |
| `tip 20% on 100 split 4 ways _` | `tip 20 · total 120 · 30 each (4 ways)` |
| `split 143 four ways _` | `35.75 each (4 ways)` |
| `split 143 four ways with 15% tip _` | `41.11 each (4 ways, total 164.45 with 15% tip)` |
| `120 plus vat _` | `144 (20% VAT: 24)` |
| `120 ex vat _` | `100 (20% VAT: 20)` |
| `vat on 120 _` | `24 (20% of 120 → 144 inc)` |
| `120 plus 19% vat _` | `142.80 (19% VAT: 22.80)` |
| `compound 1000 at 5% for 10 years _` | `1,628.89 (interest 628.89, yearly)` |
| `simple interest 1000 at 5% for 3 years _` | `150 (total 1,150)` |
| `monthly payment on 250000 at 6% over 30 years _` | `1,498.88/month (total 539,595.47, interest 289,595.47)` |
| `apr to monthly 12% _` | `1% per month (12.68% effective annual)` |
| `doubling time at 7% _` | `10.24 years (rule of 72: 10.3)` |
| `margin cost 40 sell 60 _` | `margin 33.33% · markup 50% · profit 20` |
| `break even fixed 5000 price 25 cost 10 _` | `334 units (333.3 → revenue 8,350)` |
| `80000 a year per hour _` | `38.46/h (40 h/wk, 52 wk)` |
| `35 an hour per year _` | `72,800/yr (40 h/wk, 52 wk) · 6,066.67/month` |
| `unit price 6 for 4.20 _` | `0.70 each` |
| `discount to reach 85 from 100 _` | `15% off` |
| `cagr 100 to 250 over 5 years _` | `20.11%/yr` |

Plain phrasings: `what's 120 ex vat _`, `85 out of 340 _`, `invest 5000 at 7%
for 20 years monthly _`, `mortgage 300000 at 4.5% over 25 years _`, `years to
double at 5% _`, `45k a year hourly _`.

Not claimed: `off the record _`, `split the difference _`, `tip of the iceberg
_`, `at what cost _`.

### 6. Text metrics & transforms ✅ (33 calculators)

These work on **the text before the command** (put the command on its own
line or after a sentence end), or on an inline argument when you write one
(`slug for My Blog Post _`). A metric fills after the text and keeps its label;
a transform **replaces** the text, the same gesture as a rewrite request but
deterministic, and `undo _` reverts it. Inline arguments stop at a sentence
end, so multi-sentence text uses the buffer form. Reading speed is the
`reading-wpm` tunable (default 238, settings menu under Blanks).

Over `The quick brown fox jumps over the lazy dog. The dog sleeps.`:

| you type | you get |
|---|---|
| `word count _` | `word count 12 words · 60 chars · 2 sentences · ~3 s read` |
| `character count _` | `60 chars (49 without spaces, 12 words)` |
| `sentence count _` | `2 sentences (avg 6 words)` |
| `line count _` | `1 line (1 non-empty)` |
| `reading time _` | `~3 s (12 words at 238 wpm)` |
| `speaking time _` | `~5 s (12 words at 150 wpm)` |
| `longest word _` | `sleeps (6)` |
| `most common word _` | `the ×3 · dog ×2 · brown ×1` |
| `count of the _` | `the ×3` |
| `title case _` | `The Quick Brown Fox Jumps Over the Lazy Dog. The Dog Sleeps.` |
| `upper case _` / `lower case _` / `sentence case _` | the text recased |
| `wrap at 20 _` | `The quick brown fox` / `jumps over the lazy` / `dog. The dog sleeps.` |
| `truncate to 11 _` | `The quick b…` (`truncate to 5 words _` counts words) |
| `reverse _` | `.speels god ehT .god yzal eht revo spmuj xof nworb kciuq ehT` |
| `reverse words _` | `sleeps. dog The dog. lazy the over jumps fox brown quick The` |
| `repeat 3 times _` | the text three times |

Inline forms and identifiers:

| you type | you get |
|---|---|
| `slug for My Blog Post Part 2 _` | `my-blog-post-part-2` |
| `title case for the lord of the rings _` | `The Lord of the Rings` |
| `snake case for userFirstName _` | `user_first_name` |
| `camel case for user first name _` | `userFirstName` |
| `pascal case for user first name _` | `UserFirstName` |
| `kebab case for userFirstName _` | `user-first-name` |
| `constant case for userFirstName _` | `USER_FIRST_NAME` |
| `initials of Ada King Lovelace _` | `A.K.L.` |
| `acronym for portable network graphics _` | `PNG` |
| `repeat 3 times for ab _` | `ababab` |
| `pad to 8 with 0 for 42 _` | `00000042` |
| `lorem 5 words _` | `Lorem ipsum dolor sit amet.` |

Line tools, over several lines: `sort lines _` (also `sort lines descending _`,
`sort lines numerically _`), `dedupe lines _`, `number the lines _` → `1. …`,
`bullet the lines _` → `- …`, `strip whitespace _`.

Not claimed: `please reverse the decision _`, `sort of tired _`, `the slug
crawled _`, `repeat after me _`, `title of the book _`, `lower the bar _`.

### 7. Geometry, physics, fitness & media ✅ (32 calculators) · encodings ✅ (25)

| you type | you get |
|---|---|
| `area of a circle radius 4 _` | `50.27 (π × 4²)` |
| `area of a rectangle 3 by 4 _` | `12 (3 × 4)` |
| `area of a triangle base 3 height 4 _` | `6 (½ × 3 × 4)` |
| `circumference of a circle radius 4 _` | `25.13 (2π × 4)` |
| `volume of a sphere radius 2 _` | `33.51 (4⁄3 π × 2³)` |
| `volume of a cylinder radius 2 height 5 _` | `62.83 (π × 2² × 5)` |
| `surface area of a sphere radius 2 _` | `50.27 (4π × 2²)` |
| `hypotenuse 3 4 _` | `5` |
| `missing side hypotenuse 5 side 3 _` | `4` |
| `distance between (1,2) and (4,6) _` | `5` |
| `30 degrees in radians _` | `0.5236 (π/6)` |
| `sin of 30 degrees _` | `0.5` |
| `slope 3 in 12 _` | `14.04° (25% grade, 1 in 4)` |
| `bmi 80kg 1.8m _` | `24.7 (normal, 18.5–24.9)` |
| `bmi 180 lb 5ft 11 _` | `25.1 (overweight, 25–29.9)` |
| `bmr male 80kg 180cm 35 _` | `1,755 kcal/day (Mifflin-St Jeor) · ×1.55 moderate 2,720` |
| `heart rate zones at 35 _` | `max 185 · z1 93–111 · z2 111–130 · z3 130–148 · z4 148–167 · z5 167–185` |
| `pace 5k in 24:30 _` | `4:54 /km (7:53 /mi) · 12.24 km/h` |
| `pace marathon in 3:30:00 _` | `4:59 /km (8:01 /mi) · 12.06 km/h` |
| `speed 10km in 48 min _` | `12.5 km/h (7.77 mph, 4:48 /km)` |
| `fuel 400 km at 6.5 l/100km _` | `26 L (400 km at 6.5 L/100 km)` |
| `35 mpg to l/100km _` | `6.72 L/100 km (US gallon); 8.07 UK` |
| `kinetic energy 2kg at 3m/s _` | `9 J (½ × 2 × 3²)` |
| `free fall 5 seconds _` | `122.63 m, 49.05 m/s (no air resistance)` |
| `ohms law 12v 4 ohm _` | `3 A · 36 W (V = I R)` |
| `watts from 230v 3a _` | `690 W (230 V × 3 A)` |
| `kwh cost 1500w for 3h at 0.28 _` | `4.5 kWh = 1.26 (at 0.28/kWh)` |
| `speed of light _` | `299,792,458 m/s (c; ≈ 3.0 × 10⁸ m/s, 1 079 252 849 km/h)` |
| `absolute zero _` | `−273.15 °C (0 K, −459.67 °F)` |
| `gravity on mars _` | `3.72 m/s² (0.38 g); escape velocity 5.03 km/s; day 24 h 37 min; year 687 days` |
| `weight on the moon 80kg _` | `13.21 kg-equivalent on moon (129.6 N)` |
| `half-life remaining 100g after 3 half-lives _` | `12.5 g (100 × ½³)` |
| `half-life 5730 years after 10000 years _` | `29.83% remains (1.75 half-lives)` |
| `decibels 90 plus 90 _` | `93.01 dB (two equal sources add 3 dB)` |
| `wavelength of 440hz _` | `77.95 cm in air (sound); 681.35 km (radio)` |
| `note for 440hz _` | `A4 (440 Hz, A = 440)` |
| `frequency of C5 _` | `523.25 Hz (midi 72)` |
| `bpm 120 _` | `500 ms per beat · ¼ 125 ms · bar (4/4) 2 s` |
| `aspect ratio 1920x1080 _` | `16:9 (1.78)` |
| `scale 1920x1080 to width 1280 _` | `1280×720` |
| `dpi 300 at 6x4 inches _` | `1800×1200 px` |
| `download time 2gb at 50mbps _` | `5 min 20 s (2 GB at 50 Mbit/s)` |

Plain phrasings: `what's the area of a circle radius 4 _`, `escape velocity of
earth _`, `distance to the moon _`, `how long to download 700mb at 20mbps _`,
`cost to run 2kw for 5 hours at 0.30 _`.

Not claimed: `the area of concern _`, `a slippery slope _`, `scale it back _`,
`the speed of the rollout _`, `note to self _`.

**Encodings, identifiers, network, colour & generators ✅ (25 calculators)**,
all local; no hashes, no password generators, no JWT decoding, by ruling:

| you type | you get |
|---|---|
| `base64 for hello _` | `aGVsbG8=` |
| `decode base64 aGVsbG8= _` | `hello` |
| `url encode a b&c=d/e _` | `a%20b%26c%3Dd%2Fe` |
| `url decode a%20b%26c _` | `a b&c` |
| `html escape <a href="x">Tom & Jerry</a> _` | `&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/a&gt;` |
| `html unescape Tom &amp; Jerry &lt;3 _` | `Tom & Jerry <3` |
| `hex encode hi _` | `68 69 (2 bytes)` |
| `hex decode 68 65 6c 6c 6f _` | `hello` |
| `binary of hi _` | `01101000 01101001` |
| `ascii of A _` | `A = 65 (0x41, U+0041)` |
| `chmod 755 _` | `rwxr-xr-x (owner rwx · group r-x · others r-x)` |
| `ip to int 10.0.0.1 _` | `167772161 (0x0a000001)` |
| `int to ip 167772161 _` | `10.0.0.1` |
| `cidr 10.0.0.0/22 _` | `10.0.0.0 – 10.0.3.255 · 1,024 addresses (1,022 hosts) · mask 255.255.252.0` |
| `is valid email a.b@example.com _` | `a.b@example.com: valid email format` |
| `validate iban GB82 WEST 1234 5698 7654 32 _` | `…: valid iban checksum` |
| `color contrast #fff #777 _` | `4.48:1 — AA normal text ✗, AA large ✓, AAA ✗` |
| `hex to hsl #ff6347 _` | `hsl(9, 100%, 64%) · rgb(255, 99, 71)` |
| `lighten #ff6347 by 20% _` | `#ffb9ad (hsl 9, 100%, 84%)` |
| `json pretty {"a":1,"b":[1,2]} _` | the JSON indented |
| `json minify { "a": 1 } _` | `{"a":1}` |
| `json validate {"a":1} _` | `valid JSON · object with 1 key` |
| `uuid _` / `uuid v7 _` | a fresh UUID |
| `random 1 to 100 _` | a number |
| `random pick red, green, blue _` | one of them |
| `coin flip _` | `heads` or `tails` |
| `roll 2d6 _` | `7 (4 + 3)` |

Generators are never cached and `undo _` does not replay their value.

Not claimed: `count me out _`, `a random thought _`, `roll with it _`, `in the
long run _`.

**Not shipped, by ruling (2026-09-19):** password / passphrase generators,
hashes (md5, sha*), JWT decoding — attack surface, however convenient.

---

## What it costs

| | keyword form | plain phrasing |
|---|---|---|
| LLM calls | 0 | 0 on a hit (the `_` route request you already pay for names the calculator) |
| tokens | 0 | the table question rides the route request: ≈ +9k prompt tokens at 180 ids when `table-lookups-mode` is on |
| latency | a shape match | the route request (~280 ms) |
| off | the `tables` blank is not registered | the question is left off the request |

Bundle size: ~16 KB of data tables plus the calculator code. No network
permissions, nothing leaves the machine.

---

## Where the pieces live

- `packages/opencues-runtime/src/blanks/tables.ts` — the blank + the eight tables (`tables-data.ts`, generated by `scripts/gen-tables-data.mjs`).
- `packages/opencues-runtime/src/blanks/calc/` — the calculator registry (`registry.ts`), the injected context (`env.ts`: clock, zone, settings, randomness), one file per family. Every calculator carries one worked example; the registry test runs all of them on a fixed clock.
- `defaults/blanks/tables/BLANK.md` — the shapes (84) and keywords (210, longest-first). `blank-md-drift.test.ts` types every example through BlankFill against this file.
- `packages/opencues-core/src/decisions/data-policy.ts` — what the decision leg may name and the grammar that captures each argument (security-audit row #32). `calc-policy-drift.test.ts` pins it to the registry id for id.
- `docs/architecture/decisions.md` § Table — the leg, the probe, and why a wrong argument is structurally a miss.
