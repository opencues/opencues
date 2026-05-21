# blank-spec — the Blank file format & runtime contract

> **Status:** `0.1-alpha`. Expect changes.

A **blank** is the user→system surface: when a user writes `_` (underscore) in their text, the runtime substitutes a value sourced from somewhere — a list, a shell script, an in-process function. Blanks are how text touches the world: volume, weather, stock prices, dictionary entries, settings toggles. This document specifies the `BLANK.md` file format and what a conformant runtime MUST do with one.

---

## The format

A blank is a folder at `<root>/blanks/<name>/` containing a `BLANK.md` entry file plus optional bundled resources. The folder name is the source id.

Every blank is folder-shaped — there is no flat-file alternative. A declarative blank that ships nothing alongside its `BLANK.md` still gets its own folder, so adding a `<name>-blank.sh` helper later is a drop-in operation rather than a flat→folder migration.

### Anatomy

```
<root>/blanks/<name>/
├── BLANK.md                  (required)
│   ├── YAML frontmatter      (required)
│   │   ├── name              (required)
│   │   ├── blankKeywords     (required — the trigger)
│   │   ├── stepValues | blankScript | impl   (exactly one — the binding)
│   │   ├── description       (recommended)
│   │   └── blankStep, blankFormat, blankSatellite, …  (optional)
│   └── Markdown body         (optional — documentation only)
│
├── <name>-blank.sh           (when blankScript is declared — sibling executable)
└── scripts/, references/, assets/   (optional bundled resources — see core.md)
```

---

## Trigger model

A blank fires when **all** of these hold:

1. The user's text contains `_` (the blank marker).
2. A word adjacent to `_` (within `blankProximity`, default 1) matches one of the blank's `blankKeywords`.
3. The runtime has loaded the blank source.

Blanks fire deterministically. The `description:` field is documentation only — it does NOT control invocation. (Contrast with [SKILL.md](https://github.com/anthropics/skills), where `description` is the LLM's invocation hook.)

When `_` matches no blank, a runtime MAY provide a **fluid-blank fallback** (typically a free-form LLM lookup). The fallback is a runtime feature, not a `BLANK.md` configurable. A runtime that provides no fallback MUST leave unmatched `_` literal. See [`@opencues/runtime`'s `SPEC.md`](../packages/opencues-runtime/SPEC.md) for the OpenCues runtime's implementation.

---

## Configuration spec

### Frontmatter (required)

| Field | Type | Notes |
|---|---|---|
| `name` | string | Unique identifier. By convention, this is also the in-process class name when `impl:` is implicit. |
| `blankKeywords` | comma-separated list **or** YAML list | Words that, when adjacent to `_`, fire this blank. |

A blank source MUST also declare **exactly one** binding profile (see § Binding profiles). Zero binding profiles = invalid (no behavior). More than one = invalid (ambiguous).

### Frontmatter (recommended)

| Field | Type | Notes |
|---|---|---|
| `description` | string | Human-readable summary. Used by `opencues list` and validators. NOT a trigger. Validators SHOULD warn when absent. |
| `tip` | string | Short display hint (one phrase). Surfaced where runtimes show contextual help. |

### Frontmatter (optional)

| Field | Type | Default | Notes |
|---|---|---|---|
| `type` | `"blank"` | inferred from path | Discriminator. Files under `blanks/` are blanks by location; explicit `type: blank` is rarely needed. |
| `priority` | number | `50` | Higher wins on routing ties when multiple blanks could claim the same `_` slot (rare — usually disambiguated by `blankKeywords`). Range 0–100 by convention. |
| `enabled` | boolean | `true` | `false` = blank is parsed but not registered. Use the master `BLANKS.md` `disable: [<id>]` to skip a blank from a project layer without modifying the source file itself. |
| `blankStep` | number | none | Increment size for numeric blanks (Up/Down step). |
| `blankFormat` | `"integer"` \| `"float"` \| `"string"` | `"string"` | Display formatting hint. |
| `blankSuffix` | string | `""` | Appended to the displayed value (`"%"`, `"°C"`, `"$"`). |
| `blankAutoPopulate` | boolean | `true` | Whether to fire `get` on first match. |
| `blankSatellite` | boolean | `false` | Two-word selector + value pattern. See § Flag obligations. |
| `blankDismissible` | boolean | `false` | `_` becomes the last cycling option. |
| `blankReadOnly` | boolean | `false` | Skip `set` / `up` / `down`. |
| `blankProximity` | number | `1` | Word distance from `_` allowed for keyword match. |
| `blankTip` | string | none | Multi-line display hint. Distinct from `tip:`: runtimes that show only short hints SHOULD use `tip`; runtimes with a side pane MAY use `blankTip`. If a file declares both, runtimes pick whichever fits their UI. |
| `blankClearKeywords` | boolean | `false` | After fill, strip the keyword (and any context words between keyword and `_`) from the resulting text. Used when the keyword is purely a trigger and shouldn't survive in the output (e.g. `volume _` → `50%`, not `volume 50%`). |
| `blankKeywordExpansions` | mapping `<keyword>: <expansion>` | none | Map short-form keywords to their expanded form (e.g. `nvda: Nvidia`). The expanded form is passed to `get` as `context` instead of the raw keyword. Authors MAY use the dotted shape `blankKeywordExpansions.nvda: Nvidia` for terse YAML. |
| `stepValues` | YAML list | none | Binding profile — declarative rotation. |
| `blankScript` | string (relative path) | none | Binding profile — shell script. |
| `impl` | string | implicit from `name` | Binding profile — in-process class name. |
| `on-host` / `not-on-host` | list | auto-detected | Host filtering. See `core.md`. |
| `speak` | boolean | `false` | Per-blank TTS hint. Reserved here so authors have a portable place to declare intent; TTS itself is non-standard. |
| `spec` | string | `"opencues/0.1-alpha"` | Spec version this file targets. Files that omit `spec:` MUST be treated as `opencues/0.1-alpha`. Runtimes MUST refuse files declaring a newer `spec:` than they support. |

### Body

The body is typically a short human-readable description or stays empty. For declarative blanks (`stepValues`) and in-process blanks (`impl`), the body is purely documentation.

For shell-script blanks, the body MAY include usage examples or version notes. Runtimes MUST ignore the body for execution; it's documentation-only.

#### Named prompt sections

A blank that drives an LLM-backed binding (an `impl:` class that calls a model, for instance) MAY declare named prompt fragments using `## <Name>` Markdown headings in the body:

```markdown
---
name: my-blank
impl: MyBlank
---

## Extract
Identify the lookup phrase. Return SPAN: <text> or SPAN: NONE.

## Answer
Given the SPAN, return ANSWER: <terse value>.
```

Runtimes that recognise these names MUST parse them into a `prompts: { Extract: …, Answer: … }` map available to the bound implementation. Runtimes that don't recognise a section name MUST preserve it (no error) — it's documentation for the next reader.

Section names are case-sensitive and MUST match the heading text after `## `. Sections are unordered; nested `### ` subheadings are content within their parent section.

---

## Binding profiles

Every blank fulfills the same Blank interface (see § Runtime contract). The author picks one of three ways to provide the implementation.

### Profile 1 — `stepValues` (declarative)

```yaml
stepValues: ["I am strong", "I am brave", "I am worthy", "I am enough"]
```

The runtime MUST synthesize `get`, `up`, and `down`:

- `get()` returns the current entry.
- `up()` advances; wraps at end.
- `down()` retreats; wraps at start.

`set` is unavailable. Read-only by construction.

### Profile 2 — `blankScript` (shell)

```yaml
blankScript: ./volume-blank.sh
```

A native runtime MUST spawn the script as:

```
bash <script-path> <action> [args...]
```

`<action>` is one of `get | set | up | down`. Argument shapes:

| Action | Args | Stdout |
|---|---|---|
| `get` | `<keyword>` `<context-words...>` | First line = current display value. Multiple lines = a cycling list. |
| `set` | `<value>` | Ignored. Used for side-effects. |
| `up` | (none) | New display value. |
| `down` | (none) | New display value. |

Stderr SHOULD be ignored unless exit code is non-zero. The runtime MAY treat non-zero exits as a soft failure (skip this blank, no error UX).

**Native hosts only.** The runtime's auto-detected host-compat MUST exclude shell-script blanks from browser hosts (see `core.md` § Host compatibility). Browser runtimes SHOULD skip these blanks silently.

### Profile 3a — `impl: ./blank.js` (user-shipped JS module)

```yaml
impl: ./blank.js
network: [api.github.com]      # capability: hostnames the blank may fetch
llm: groq                       # capability: LLM provider name (optional)
storage: gh-issues              # capability: storage namespace (optional)
```

When `impl:` is a RELATIVE path (starts with `./` or `../`), the
runtime loads the named JS module in a capability-constrained
context (vm.runInContext on Node, Web Worker in chrome). The
module's exported `get` / `set` / `up` / `down` functions receive a
`BlankContext` object that contains ONLY the capabilities the
frontmatter declared. Anything not declared is `undefined`.

Conformant runtimes MUST:

1. Load the JS file relative to the BLANK.md's folder. Refuse
   absolute paths or `../` escapes outside the user's `.cues/`
   roots.
2. Strip `import` statements before evaluation (no module loading).
3. Strip ESM `export default` syntax to a CommonJS-style module
   export so the JS evaluates as a classic script.
4. NOT expose `fs`, `path`, `os`, `process`, `Buffer`, `require`,
   `__dirname`, `__filename`, or any runtime internals to the
   user's module.
5. Enforce the declared `network:` allow-list as hostname-exact
   (no wildcards in v1.0).
6. Bind storage to the declared namespace; blank A MUST NOT be
   able to read blank B's namespace.

Authoring contract (full TypeScript shape in
`packages/opencues-runtime/src/user-blanks/types.ts`):

```ts
export default {
  get(ctx, args) { /* ... */ return value; },
  set?(ctx, value, args) { /* optional, for cycling */ },
};
```

Full design + threat model: `docs/architecture/user-blanks.md`.

### Profile 3 — `impl` (in-process class)

```yaml
impl: WeatherBlank
```

`impl:` is a naming convention. The class lives in the runtime, not in `BLANK.md`. A class MUST satisfy the Blank interface (§ Runtime contract).

By convention, when `impl:` is omitted, the runtime tries `<PascalCase(name)>Blank` (e.g. `name: stocks` → `StocksBlank`).

A foreign runtime that doesn't recognise the class name MAY treat the blank as "unsupported" and skip it, OR MAY route it to its own equivalent. Conformance does not require honoring foreign `impl` values.

---

## Trust model

Most blanks are registry-safe. The `stepValues` and `impl` profiles ship no executable code in the `BLANK.md` itself: `stepValues` is a static list, and `impl:` names a class that must already exist in the runtime — a third-party `BLANK.md` cannot ship a new class. Both are safe to distribute via a future registry / `add <pack>` mechanism.

The `blankScript` profile is different. It points at a sibling executable (`<name>-blank.sh` and friends) that the runtime invokes with the user's privileges when the blank fires. A malicious `blankScript` is arbitrary code execution, full stop — same threat shape as `npm install <malicious-package>` or `curl | sh`.

### v1.0 carve-out — script-bearing blanks are user-trusted only

For v1.0, the standard carves `blankScript:` blanks out of any future registry distribution. A conformant runtime:

1. MUST source `blankScript:` blanks only from local directories (`<root>/blanks/<name>/`) or shipped defaults (`defaults/blanks/<name>/`).
2. MUST NOT auto-install a `blankScript:` blank from a network source without explicit per-pack user confirmation, including a display of the script's contents for inspection.
3. MUST NOT treat any frontmatter field (`trusted: true`, `signed: ...`) as a substitute for user inspection. Trust derives from the file's *provenance*, not its content.
4. SHOULD log `blankScript:` invocations in a way that makes the source path and exit code visible.

`stepValues` and `impl` blanks are not subject to this restriction — both profiles are safe to grow registry distribution as the standard evolves.

### Sharing script-bearing blanks

Authors who want to share a `blankScript:` blank SHOULD publish the `BLANK.md` + script as documentation (a gist, a blog post, a repo with a README). Users who want to install it copy the files manually after reading the script. This is by design: there is no shortcut around user inspection in v1.0.

A future revision MAY introduce a registry mechanism with cryptographic provenance, sandboxed execution, or signed publisher manifests — all of which are needed before script distribution is safe. v1.0 deliberately omits the registry; sandboxed execution shipped as opt-in (see below) but doesn't yet replace the carve-out for distribution.

### Opt-in OS-level sandbox (v1.0+)

Independent of the registry question, a conformant runtime SHOULD
honour an opt-in OS-level sandbox declared in frontmatter. The
sandbox confines `blankScript:` invocations to a read-only
filesystem view, denies network access by default, and isolates
PID/IPC namespaces. The exact mechanism is platform-dependent
(`bwrap` on Linux/WSL, `sandbox-exec` on macOS, AppContainer on
Windows); the frontmatter is the same:

```yaml
sandbox: strict          # opt-in. omitted / 'off' = unsandboxed (default).
sandbox-net: deny        # 'allow' | 'deny' (default).
sandbox-fs: ro           # 'ro' (default) | 'rw' for the blank's own folder.
```

Hosts MAY fall back to unsandboxed execution when no sandbox tool is
available — the path sandbox and audit log still apply. Authors who
need their blank to work everywhere should design for the strictest
case (no FS writes outside `/tmp`, no network) or document the
permissions they require.

`stepValues` and `impl` blanks are not affected — no script ever
runs for those profiles.

### Why the carve-out and not a blanket ban

`blankScript:` is genuinely useful. Hardware control (volume, brightness), OS state (clipboard, notifications), filesystem operations — these need a shell. Forbidding scripts altogether would push them out into ad-hoc user runtime classes (`impl:`) that compile into the runtime binary, which is a worse failure mode (now you need to fork the runtime to add a script). The carve-out keeps scripts available for user-authored use and shipped defaults; it just doesn't open the registry door for them.

The same trust-model logic applies to auditors, where the standard takes a stronger position (no registry distribution at all in v1.0). See [`spec/auditor-spec.md` § Trust model](./auditor-spec.md) and [`openstandard-notes.md` § Distribution asymmetry](../openstandard-notes.md).

---

## Runtime contract

### The Blank interface

```ts
interface Blank {
  readonly name: string;
  readonly readOnly: boolean;
  get(keyword?: string, context?: string[]): Promise<string>;
  set?(value: string, keyword?: string): Promise<void>;
  up?(): Promise<string>;
  down?(): Promise<string>;
}
```

- `get` returns the current display value.
- `set` (optional) applies a value back to the world.
- `up` / `down` (optional) cycle.
- `readOnly: true` means `set`, `up`, `down` are absent.

All methods are async. The `keyword` argument carries which `blankKeywords` entry triggered the blank (for keyword-disambiguating blanks like stocks). The `context` argument carries surrounding words (for blanks like weather that parse "weather in Paris").

### Lifecycle — what happens after a trigger

1. **Match** — runtime detects `_` adjacent to a `blankKeywords` match.
2. **Populate** — if `blankAutoPopulate: true`, the runtime calls `get(keyword, context)` and substitutes the result at the `_` position.
3. **Cycle** — on a runtime-defined cycling input, the runtime calls `up()` / `down()` (or, for `stepValues`, indexes the list directly).
4. **Accept** — on a runtime-defined accept input, the runtime calls `set(value)` if defined.
5. **Dismiss** — if `blankDismissible: true`, `_` is the final cycling option; selecting it suppresses re-population for this slot until the user cycles away.

### What a runtime MUST do

- Honor `blankAutoPopulate: false` by NOT calling `get` on first match (only on explicit invoke).
- Honor `blankReadOnly: true` by suppressing `set`/`up`/`down` calls.
- Substitute the result of `get` at the `_` position, formatted per `blankFormat` and suffixed with `blankSuffix`.
- Treat cycle attempts on read-only single-value blanks as no-ops (no error UX).
- Skip blanks whose host-compat excludes the running host.

### Flag obligations

- **`blankSatellite: true`** — `get` MAY return `<selector>\t<satellite>` (tab-separated). The runtime MUST splice both as adjacent words. Cycling targets the selector; satellite is updated via `set <selector> <value>`.
- **`blankDismissible: true`** — runtime MUST append `_` to the cycling list. Selecting it sets a "dismissed" flag for that slot; runtime MUST NOT re-populate until the user explicitly cycles away.
- **`blankProximity: N`** — the keyword may sit up to N words before `_`. Default 1.
- **`blankKeywordExpansions.<key>`** — when `<key>` triggers, the runtime MAY pass the expanded form as `context` instead of the raw keyword.
- **`blankStep`, `blankFormat`, `blankSuffix`** — numeric/format hints. Runtime MUST honor for numeric blanks.

---

## Conformance

A `BLANK.md` file is **valid** iff:

1. Frontmatter has `name` and `blankKeywords`.
2. **Exactly one** of `stepValues`, `blankScript`, or `impl` is present (or `impl` is implicit via name convention AND the runtime can resolve it).
3. If `blankScript:` is present, the file exists at the relative path declared.
4. If `on-host` / `not-on-host` are present, every host is known.

A runtime is **conformant** iff it satisfies every MUST in § Runtime contract for the binding profiles it supports.

For the consolidated linting matrix (severity, rule names, what each rule checks), see [`core.md` § Linting rules](./core.md#linting-rules). Blank-specific rules: missing `description` (warn), `blankReadOnly: true` plus a multi-value binding (warn), `on-host: chrome` plus `blankScript:` (warn), multiple binding profiles (error).

---

## Examples

### Minimal — declarative `stepValues`

`blanks/affirmations/BLANK.md`:

```markdown
---
name: affirmations
description: Daily affirmations — cycle through short positive statements
blankKeywords: affirmation, affirm
stepValues: ["I am strong", "I am brave", "I am worthy", "I am enough"]
blankDismissible: true
---
```

### Minimal — shell-script (folder shape)

`blanks/volume/BLANK.md`:

```markdown
---
name: volume
description: System volume — get, set, and cycle in 6% steps
blankKeywords: volume
blankScript: ./volume-blank.sh
blankStep: 6
blankSuffix: "%"
blankFormat: integer
blankAutoPopulate: true
---
```

The folder also contains `volume-blank.sh`. Optional: a compiled helper (`VolCtl.cs`, etc.).

### Minimal — in-process class

`blanks/stocks/BLANK.md`:

```markdown
---
name: stocks
description: Live stock prices — major US tickers
blankKeywords: nvidia, nvda, apple, aapl, googl, msft, amzn
impl: StocksBlank
blankAutoPopulate: true
blankReadOnly: true
blankFormat: string
---
```

The runtime resolves `StocksBlank` to its in-process implementation (HTTPS API call). Foreign runtimes without that class MAY skip this blank.

### Full source with optional fields

```markdown
---
name: weather
description: Local weather — temperature + conditions for a city
blankKeywords: weather, forecast, temp
impl: WeatherBlank
blankAutoPopulate: true
blankReadOnly: true
blankProximity: 2
blankFormat: string
blankTip: "Open-Meteo (cached 5min)"
on-host: [chrome, claude-code, gemini-cli, opencode]
spec: opencues/0.1-alpha
---

Body is documentation. Returns "13°C Partly cloudy" or similar.
Pulls from Open-Meteo. Geocodes the location word in `context`.
```

---

## In scope

- The `BLANK.md` file format and frontmatter schema.
- The Blank interface (`get` / `set` / `up` / `down`).
- The three binding profiles.
- Lifecycle (auto-populate → cycle → accept → dismiss).

## Out of scope

- Prompt content for the fluid-blank fallback (runtime-specific).
- How `_` rendering looks (runtime-specific).
- Which keys accept / dismiss (runtime-specific).
- The shell-blank script's internal implementation language (bash, python, anything).

---

## Relationship to OpenCues runtime

OpenCues' runtime ships a fluid-blank fallback (free-form `_` lookup), specific in-process blank classes (`WeatherBlank`, `StocksBlank`, `OpenCuesSettingsBlank`, etc.), TTS for blank values, and cursor-aware cycling. None of those are required for spec conformance. See [`@opencues/runtime`'s `SPEC.md`](../packages/opencues-runtime/SPEC.md).
