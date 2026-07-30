---
last_updated: 2026-04-29
---

# Adding a Cue-Blank

A **cue-blank** is a blank (`_`) bound to a keyword via `blankKeywords`. The user types a command whose keyword **leads the sentence** ending in `_` (e.g., `volume _`, `weather paris _`), the underscore auto-populates with a current value, and Up/Down cycling changes the actual external state. Everything that touches the world is `_`-gated — there is no word-cycling on plain text without `_`.

Cue-blanks ship as either:
- A folder under `defaults/blanks/<name>/` with a colocated shell script (OS-level work like volume, brightness)
- A TypeScript class under `packages/opencues-runtime/src/blanks/<name>.ts` (HTTP/LLM/API work — runs on chrome too)

## 0. Scaffold the folder with `opencues new`

The one-liner that creates the folder + a pre-filled template:

```bash
opencues new blank <name>               # scaffolds ~/.cues/blanks/<name>/BLANK.md
opencues new blank <name> --project     # scaffolds <cwd>/.cues/blanks/<name>/BLANK.md
opencues new blank <name> --dry-run     # prints the plan, creates nothing

# Cues use the same verb:
opencues new cue <name>                 # scaffolds ~/.cues/cues/<name>/CUE.md
```

The scaffold ships every supported shape (typed-with-script, list, selector+satellite, runtime-class) inline-commented — pick one block, delete the rest. `<name>` must match `/^[a-z][a-z0-9-]*$/` (lowercase, hyphens). Refuses to overwrite an existing file. The runtime hot-reloads within ~2.5s of saving — no restart needed.

After editing, drop your `<name>-blank.sh` next to the BLANK.md (for typed-blank shape) and `chmod +x` it. The rest of this guide explains each field.

### Hello-world reference packs

If you'd rather copy-and-edit a working example than fill in a template, the shipped `example/` packs are deliberately tiny (~30-70 lines each) with every field commented inline:

- [`defaults/cues/example/CUE.md`](../../defaults/cues/example/CUE.md) — minimal word-cue. Matches `hi|hey|hello`, returns three formal-greeting alternatives via the LLM. Shows: `name`, `parser`, `scope: words`, `priority`, `match`, prompt body.
- [`defaults/blanks/example/BLANK.md`](../../defaults/blanks/example/BLANK.md) + [`time-blank.sh`](../../defaults/blanks/example/time-blank.sh) — minimal script-blank. `time _` fires the script which prints `date '+%H:%M'`. Shows: `blankKeywords`, `blankScript`, the get/set script contract. (Auto-populate is automatic for any keyword/shape blank; read-only is inferred — a blank with no `blankStep` / `stepValues` / `blankSatellite` simply isn't cycleable.)

Production packs (volume/brightness/weather/stocks) are bigger because they need more fields for production reasons; the example packs strip those back to "what fires the simplest version".

## 1. Folder-based blank (canonical)

Create a self-contained folder with the config and script together:

```
blanks/volume/
├── BLANK.md             # Blank config in YAML frontmatter
└── volume-blank.sh    # Script colocated (blankScript: ./volume-blank.sh)
```

**`defaults/blanks/volume/BLANK.md`:**
```yaml
---
name: volume
type: blank
tip: system volume
speak: true
blankKeywords: volume, vol, sound, audio
blankStep: 6
blankSuffix: '%'
blankScript: ./volume-blank.sh
---
```

Relative `blankScript` paths (starting with `./`) are resolved against the folder. Folder-based is the canonical form. `blankKeywords` desugar at parse time into anchored `blankShapes` — a bare-get shape (`volume _`), a captured-arg get (`volume <x> _`), and (because `blankStep` is present, marking the blank settable) set + step shapes (`volume 30 _`, `volume up _`). A blank auto-populates whenever one of its shapes matches the sentence containing `_` (the segment after the last sentence terminator (`.`/`!`/`?` + whitespace, or CJK `。！？．`) or newline before `_`).

### BlankConfig fields

Not exhaustive — this covers the fields you'll touch authoring a
typical script-backed or list blank. `BlankConfig` has more (sandbox,
context/ai-callable, host/site scoping, user-blank capabilities, …);
see `packages/opencues-core/src/cues-md.ts`'s interface for the full set.

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | Yes | string | Identifier (e.g. `volume`). Also inferred from folder name. |
| `type` | Yes | string | Always `blank`. |
| `impl` | Yes (for runtime-class blanks) | string | Names a built-in `@opencues/runtime` TS class (e.g. `StocksBlank`) or points at user-shipped JS (`./blank.js`). Alternative to `blankScript` for LLM/HTTP-backed blanks — see the runtime-class section below. |
| `tip` | No | string | Label shown in the status line when the keyword/value is highlighted (live `get` output overrides). |
| `blankScript` | Yes (for OS-bound blanks) | string | Path to the script for `get` / `set` / `up` / `down`. Use `./<name>-blank.sh` (relative to the BLANK.md). |
| `blankKeywords` | Yes | string\|string[] | Friendly shorthand: keywords that bind a `_` to this blank when one leads the sentence containing `_`. Desugar at parse time into anchored `blankShapes`. Multi-word phrases allowed. Required: the resolver's auto-populate / cycling path (`BlankSource`) keys off `blankKeywords`, so a blank still needs them even when it also declares `blankShapes`. |
| `blankShapes` | No | BlankShape[] | Explicit anchored routing grammar (`{pattern, action: get\|set\|step, valueGroup?}`), matched against the sentence containing `_`. The low-level routing mechanism; keywords desugar into it. Authoring `blankShapes` **overrides** the synthesized grammar for the runtime dispatch + fluid/transform cede (it wins over `blankKeywords`-derived shapes), but does not replace the `blankKeywords` requirement above. |
| `integration` | No | string | Additive output template describing how the blank's value reads in context, e.g. `"volume is now {value}"`. ADD-ONLY — never deletes surrounding text. |
| `blankStep` | No | number | Increment/decrement amount for numeric blanks. Its presence also marks the blank **settable** (synthesizes set + step shapes from keywords). |
| `blankSuffix` | No | string | Suffix appended to the displayed value (e.g. `%` shows `50%`). |
| `blankDismissible` | No | boolean | Append `_` as the final cycling option so the user can dismiss the value. |
| `blankClearKeywords` | No | boolean | Remove keyword context words from text on populate. |
| `blankClearOnEdit` | No | boolean | Remove spawned words when user edits them. |
| `blankSatellite` | No | boolean | Populate as selector + satellite (see [selector-satellite](../features/selector-satellite.md)). |
| `stepValues` | No | string[] | Static list of values to cycle through. |
| `speak` | No | boolean | Read the tip aloud via TTS when navigated to (default: false). |

> **Removed in the June 2026 slim-down** (all gracefully ignored if still present in old files): `blankAutoPopulate` (populate is now automatic on any shape match), `blankProximity` (routing is unconditionally sentence-scoped), `blankReadOnly` (cycleability is inferred — a blank with no `blankStep` / `stepValues` / `blankSatellite` isn't cycleable), `blankFormat` (numeric stepping is inferred from `blankStep`), `blankTip` (use `tip`), `blankKeywordExpansions`, and the replace/consume dials `blankReplace` / `blankConsumeAll` / `blankConsumeContext` (fill is always additive; command-span clearing is shape-derived).

## 2. Write the blank script (OS-level)

The script accepts `get`, `set`, `up`, `down`. setup.sh seeds it from `defaults/blanks/<name>/<name>-blank.sh` into `~/.cues/blanks/<name>/`, where helper binaries are colocated and resolved via `${SCRIPT_DIR}/<helper>`.

```bash
#!/bin/bash
# blanks/volume/volume-blank.sh
# Called as one of:
#   bash volume-blank.sh get
#   bash volume-blank.sh set <value>
#   bash volume-blank.sh up
#   bash volume-blank.sh down

case "$1" in
  get)
    my-system-query-command 2>/dev/null || echo "50"
    exit 0
    ;;
  set)
    my-system-set-command "$2"
    exit 0
    ;;
  up)
    my-system-command +6
    exit 0
    ;;
  down)
    my-system-command -6
    exit 0
    ;;
esac
```

### Script conventions

- **`get` is synchronous** — output is the current value as a plain string. The runtime awaits stdout to populate the blank.
- **No live-read in the apply path** — do not call `get` from `up`/`down`. It adds latency and races the integration's 200ms post-cycle `get` call.
- **No `&` backgrounding** — run the system command synchronously. The integration calls `get` 200ms after spawning; if the command is still running, `get` reads a stale value.
- **Debouncing**: cycle keypresses are debounced (~50ms) before spawning.

## 3. How it works at runtime

1. User types `volume _` and the analyzer matches `volume`'s anchored shape leading the sentence containing `_`.
2. The runtime calls `blankInvoke({ blankName: 'volume', action: 'get', args: ['volume'] })`.
3. The host adapter's registry runs the registered class OR spawns `bash volume-blank.sh get`.
4. The returned value (e.g., `50`) replaces `_` (display: `50%` because of `blankSuffix`). `metadata.blankName` is set on the WordDef, protecting it from LLM overwrites.
5. User presses Up: `blankInvoke({ action: 'up' })` runs (detached), then `get` runs ~200ms later to refresh the displayed value.

## 4. Adding a list blank (no script)

List blanks cycle through an ordered set of values on a blank — no script, no arithmetic. Type a keyword + `_` and the blank auto-populates with the first value; Up/Down cycles. Multi-word values are span-tracked automatically.

**`defaults/blanks/affirmations/BLANK.md`:**
```yaml
---
name: affirmations
type: blank
blankKeywords: affirmation, affirm
stepValues: ["I am strong", "I am brave", "I am worthy", "I am enough"]
tip: Daily affirmations
blankDismissible: true
---
```

Type `affirmation _` → blank fills with "I am strong". Up/Down cycles: "I am brave" → "I am worthy" → "I am enough" → `_` to dismiss.

## 5. Adding an HTTP/data blank (TypeScript class)

Data blanks are implemented as **TypeScript classes inside `@opencues/runtime`**. Two patterns:

- **Live-fetch** (network request per lookup): `StocksBlank`, `WeatherBlank`, `HackerNewsBlank`, `CryptoBlank`, `DictionaryBlank`. The value is the lookup target (`weather tokyo _`), and the class fetches on `get`.
- **Bundled-data** (static dataset embedded, zero network): `CountriesBlank`. Its data lives in `packages/opencues-runtime/src/blanks/countries-data.ts`, generated by `scripts/gen-countries-data.cjs` (from `mledoze/countries` + `samayo/country-json`) and read in-memory. Prefer this when the data is **stable and small** — it's offline, instant, and immune to a third-party API dying (which is exactly why `CountriesBlank` moved off restcountries.com in June 2026). Refresh by re-running the generator; the class itself does no I/O.

(`OpenCuesSettingsBlank` is a different shape again — a selector-satellite over OPENCUES.md scalars, not a data fetch.)

> The LLM-backed answer + prompt-improver blanks that once lived here were retired June 2026; those intents are now served by the generalized semantic-`_` sources (`FluidBlankSource` for `answer _` / factual lookups, `TransformBlankSource` for `improve prompt _` / imperative rewrites), which run on the user's configured provider rather than a hardcoded one. Prefer a fluid/transform source over a new LLM blank class for any free-form `_` intent.

This applies to both read-only API blanks (e.g. stocks, weather) and dynamic list blanks (e.g. Hacker News titles). The shape:

1. **Add a class** to `packages/opencues-runtime/src/blanks/<name>.ts` implementing the `Blank` interface from `./types`. Implement `get(keyword, contextWords) → Promise<string>` (and optionally `set(value, keyword)` if writable). Return newline-separated output for dynamic lists.
2. **Export it** from `packages/opencues-runtime/src/blanks/index.ts`.
3. **Register it** in each host's `blanksRegistry`:
   - CC: `integrations/claude-code/patches/opencuesRuntime.ts`
   - OC: `integrations/opencode/patches/opencuesBootstrap.ts`
   - Gemini: `integrations/gemini-cli/patches/opencuesBootstrap.ts`
   - Chrome: `integrations/chrome/src/blanks/index.ts`
4. **Add the blank's `BLANK.md`** under `defaults/blanks/<name>/BLANK.md` declaring `blankKeywords` (plus `impl`, `network`, etc.). The `blankScript:` field is **omitted** for hoisted blanks; the host's `blankInvoke` dispatches by blank name.

**Example `BLANK.md` (no blankScript field):**
```yaml
---
name: stocks
type: blank
blankKeywords: reddit, rddt, nvidia, nvda, apple, aapl
tip: Stock price
impl: '@opencues/runtime StocksBlank'
---
```

(No `blankStep` / `stepValues` / `blankSatellite` → the blank is read-only: it fetches once and isn't cycleable. That's now inferred, not declared.)

`@opencues/runtime`'s `BlankFill` module sees the BLANK.md, looks up `blankInvoke('stocks', { action: 'get', args: [keyword, ...contextWords] })`, the host's registry resolves `'stocks'` to the `StocksBlank` instance, and the class's `get()` returns the price.

For dynamic list blanks (Hacker News pattern): the class returns multiple newline-separated lines; the runtime treats each as a cycling alternative. Add `blankDismissible: true` to the BLANK.md to append `_` as the last option.

For OS-level blanks (e.g. `volume`, `brightness`): keep using shell scripts. They wrap platform-specific OS APIs that have no portable JavaScript replacement. The script lives next to the BLANK.md (`defaults/blanks/volume/volume-blank.sh`) and `BLANK.md` declares `blankScript: ./volume-blank.sh`.

## Cycling pitfalls: numeric stepping vs list cycling

The blank cycling cascade has two paths, and a blank must route to the correct one:

1. **Numeric stepping** — parses the displayed value as a number, adds/subtracts `blankStep`, calls `blankInvoke set <value>`. Used by volume, brightness.
2. **List cycling** — cycles through `alts[]` array by index. Used by hackernews, affirmations, and any blank with `blankDismissible: true`.

**The routing rule:** if the blank's metadata has `listBlank: true` (auto-set when `blankDismissible: true` or `stepValues: [...]` or multi-line output that is NOT flagged `blankMultilineIsAnswer: true`), it uses the list path. Otherwise, if `blankStep` is declared, it uses the numeric path. A blank with neither is read-only (no cycling). Multi-line output flagged `blankMultilineIsAnswer: true` is committed as one joined answer (see the multi-line note below), so it is not split into a cycleable list.

**The pitfall:** if a blank returns a value that *looks* like a number (e.g., `10.9°C`) but isn't meant to be stepped, declaring `blankStep` would make the numeric path parse and increment it (`10.9°C` → `11.9` → `12.9`). The fix is structural: don't declare `blankStep` on a non-numeric blank — without it the blank is read-only, and if it has multiple alts mark it dismissible/list so it routes to the list path.

**The fix:** blanks that return non-numeric string values AND have multiple alts (e.g., `blankDismissible: true`) get `listBlank: true` in their metadata automatically — `blankDismissible: true` sets it in `BlankSource`. If you're manually constructing WordDefs for a custom blank, set it explicitly.

**When to use each:**
| Config | Cycling path | Example |
|--------|-------------|---------|
| `blankStep` declared | Numeric stepping | volume (`50%` → `56%`) |
| `blankDismissible: true` | List cycling (automatic) | weather (`10°C Drizzle` ↔ `_`) |
| `stepValues: [...]` | List cycling (automatic) | affirmations |
| Multi-line script output | List cycling (each line is one alt) | hackernews |
| Multi-line output + `blankMultilineIsAnswer: true` | Single joined answer (no split) | location `map` card, claude-status, model |
| none of the above | No cycling (read-only, inferred) | stocks |

**Multi-line: list vs single answer (`blankMultilineIsAnswer`).** By
default a multi-line `get` result is split on `\n` into cycleable
alternatives — correct for a top-N feed (hackernews) whose lines are
genuinely separate choices. But a blank whose output is ONE indivisible
card — the location `map` card (name / address / map link), a status
block, the `model` catalog, note recall — must NOT be split, or only its
first line lands and the rest is silently dropped (opencues #339). Set
`blankMultilineIsAnswer: true` on the BLANK.md: the fill joins the lines
into one answer instead of truncating. The default (`false`) preserves
the list-cycling behaviour, so existing list blanks are unaffected.

The three shipped single-card **built-ins** (`location`, `claude-status`,
`model`) additionally carry this behaviour in code — they're listed in
`SINGLE_ANSWER_BUILTIN_BLANKS`
(`packages/opencues-runtime/src/blanks/single-answer-builtins.ts`), so an
upgrading user gets the joined card from the runtime bundle even if their
on-disk `BLANK.md` predates the flag (`seed-configs` never overwrites an
existing file). The frontmatter flag is the path for **your own** script
blanks; the code set is only for the shipped built-ins. If you add a new
built-in whose output is a single multi-line card, add its name to that
set as well as the flag to its default `BLANK.md`. (`note` is
deliberately NOT in the set: its recall returns multiple matches the
user cycles through, so it stays a list blank.)

### Span invalidation: only word changes kill the span

For list blanks (`blankDismissible`, `stepValues`, multi-line output), the resolved value is stored as a span covering one or more word positions. The runtime only invalidates this span when the **words at those positions change** — it does not invalidate on trailing spaces, punctuation appended elsewhere, or other non-word edits. This is intentional so the user can keep typing around a resolved blank without losing it.

**Implication for custom blanks:** if you're building a blank that should survive normal typing, this behaviour is already there. If your blank's resolved value should be cleared the moment the user edits *anywhere* in the line, use `blankClearOnEdit: true` instead.

### `def.word` after auto-populate

When a blank auto-populates, the WordDef was created at `_` time, so `def.word = "_"`. The runtime patches `def.word` to the resolved value immediately after populate so that per-word invalidation can correctly match the span. It also prepends the resolved value to `def.alts` (via `alts.unshift`) so that cycling starts from the correct position.

**Implication for custom blanks:** if you manually construct a WordDef outside of `BlankSource` → auto-populate (e.g., in a custom integration), ensure `def.word` reflects the currently displayed value, not the keyword that triggered it. Otherwise the def will be silently discarded on the next keystroke.

## Trust model — by binding profile

The standard treats each binding profile differently. From least- to
most-privileged at install time:

- **`stepValues:` blanks** (static lists) are registry-safe. No code
  execution.
- **`impl: <BuiltinName>` blanks** (in-process TS classes) are
  registry-safe. The class must already exist in the runtime; a
  `BLANK.md` cannot ship a new class.
- **`impl: ./blank.js` blanks** (user-shipped JS) are registry-safe
  **subject to declared capabilities**. The runtime sandboxes the
  JS in a vm.Context (Node) or Web Worker (chrome); the blank only
  gets the capabilities it declared (`network:`, `llm:`, `storage:`,
  `secrets:` paired with `secret-hosts.<NAME>`). Per-blank rate +
  storage quotas + output sanitization apply automatically. See
  [`docs/architecture/user-blanks.md`](../architecture/user-blanks.md)
  for the full author contract.
- **`blankScript:` blanks** invoke a sibling executable with the
  user's privileges when the blank fires. OS-level confinement is
  opt-in via `sandbox: strict` (bwrap on Linux, sandbox-exec on
  macOS). Without it, a malicious script has full user filesystem +
  network access — same as any shell command the user could run.
  v1.0 requires script-bearing blanks come only from
  `defaults/blanks/<name>/` or `~/.cues/blanks/<name>/`.

For distributable functionality, **user-JS (`impl: ./blank.js`) is
the recommended path**: it has a real capability contract you can
audit at install time, and the sandbox bounds the blast radius even
if the JS is hostile. `blankScript:` remains for system control
(volume, brightness) where shell access is unavoidable.

**Sharing your script-bearing blank**: publish the `BLANK.md` and
the `<name>-blank.sh` (or `.ps1`, `.exe`, etc.) as documentation —
gist, repo with a README that includes the script verbatim, blog
post. Users who want to install it copy the files manually after
reading the script. There is no shortcut around user inspection in
v1.0.

A future revision MAY introduce a registry mechanism with
cryptographic provenance and (for `impl: ./blank.js`) automatic
capability-diff review on update. See
[`docs/architecture/security-audit.md` § Pre-registry follow-ups](../architecture/security-audit.md).

The same logic applies more strictly to auditors, where the entire surface is user-trusted only in v1.0 (no registry distribution at all). See [`docs/guides/adding-an-auditor.md` § 5 Trust model](./adding-an-auditor.md).

## Checklist

- [ ] Blank folder created: `defaults/blanks/<name>/BLANK.md` (+ `<name>-blank.sh` for OS-level)
- [ ] `type: blank` in frontmatter
- [ ] Script (if any) is executable (`chmod +x`)
- [ ] Script handles `get`, `set <value>`, `up`, `down` as needed
- [ ] Script queries live system value (no file caching)
- [ ] `blankKeywords` set (auto-populate fires automatically when a shape matches); or `blankShapes` declared explicitly for custom grammar
- [ ] For cycleable blanks: declare `blankStep` (numeric), `stepValues` (list), or `blankSatellite`. Omitting all three = read-only (inferred).
- [ ] For self-contained output: rely on shape-derived clearing (a captured arg / typed set-step / `integration:` template consumes the command span). For `wipe`-style answers the blank's `get()` should embed identifying context (`"NVDA: $198.47"`, not bare `"$198.47"`).
- [ ] (Optional) `integration:` template set if you want connective text woven around the value (additive only)
- [ ] For TS-class blanks: registered in each host's `blanksRegistry`
- [ ] For TS-class blanks: `setup.sh` re-run so the runtime build includes the new class
- [ ] For `impl: ./blank.js`: declared `network:` allow-list lists every hostname the JS fetches
- [ ] For `impl: ./blank.js`: every `secrets:` entry has a matching `secret-hosts.<NAME>: [host, ...]` (unbound secrets are refused at load)
- [ ] For `impl: ./blank.js`: `output: rich` is set ONLY if the blank legitimately needs HTML / control chars (otherwise default `safe` strips them)
- [ ] Restart the host (config hot-reloads in ~2s; class registration requires restart)

> **No need to run `setup.sh`** for BLANK.md / script edits — `.md` config files hot-reload within ~2s. `setup.sh` is only needed when editing the TypeScript patches/runtime sources.
