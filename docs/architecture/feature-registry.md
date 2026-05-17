# Feature Registry

OpenCues has ~13 optional runtime gates (`fluid-blank-mode`,
`user-context-mode`, `voice-mode`, …) plus a handful of numeric
tunables (`agent-debounce-ms`, `max-concurrent-auditors`, …) that
users can toggle through the selector-satellite menu (`opencues
settings _`). Each one historically lived in 4–7 different files
across runtime / CLI / chrome-host / OPENCUES.md / per-host
bootstraps. Adding a feature meant editing all of them in lockstep;
forgetting one shipped a silent bug to users.

The **feature registry** at `packages/opencues-core/src/feature-registry.ts`
is now the single source of truth. Every install-boundary site
imports from it instead of hardcoding its own copy. **Adding a
feature is one PR appending one entry; nothing else can drift.**

---

## What lives in the registry

| Export | Shape | Used for |
|---|---|---|
| `FEATURES` | `readonly FeatureSpec[]` | Optional features (scalar + prereqs + push hosts) |
| `MENU_TUNABLES` | `readonly MenuTunableSpec[]` | Non-feature numeric/enum cycling settings |
| `CORE_CONFIG_FILES` | `readonly string[]` | Always-on config files (OPENCUES.md / CUES.md / AUDITORS.md) |
| `CORE_TEMPLATES` | `Record<basename, repo-path>` | Core files that ship a seed template |
| `chromeHostFileList()` | `() => string[]` | Files chrome-host MUST push to chrome.storage |
| `seedableOptionalFiles()` | `() => SeedableFile[]` | Files seed-configs copies to ~/.cues/ |
| `getMenuDefinitions()` | `() => Map<scalar, def>` | Selector-satellite cycling menu schema |
| `findFeature(scalar)` | `(scalar) => FeatureSpec?` | Lookup by scalar key |
| `getDefaultValue(spec)` | `(spec) => string` | First value's id (the default) |
| `getCyclableValues(spec)` | `(spec) => ValueSpec[]` | Values minus exposeInMenu:false ones |

`FeatureSpec` carries:

- `scalar` — kebab-case OPENCUES.md key (e.g. `'user-context-mode'`)
- `camelCase` — TypeScript field name (e.g. `'userContextMode'`)
- `values: ValueSpec[]` — each `{id, description, exposeInMenu?}`; first entry is the default
- `description` — dev-facing one-liner (doctor's feature wiring section)
- `menuTip?` — user-facing tip shown in the cycling menu (falls back to `description`)
- `prereqFile?` — `{basename, template?, mustHavePopulatedFields?}` for features that read a config file
- `pushedBy?` — host scripts that must push prereqFile (today: `'chrome-host'`)

---

## The sites the registry replaces

Five sites used to maintain their own copies. Now they all derive
from the registry:

### 1. `doctor.cjs` — Feature wiring + chrome-host parity

```js
// Old: hardcoded list
s.ok('user-context-mode', scalars['user-context-mode'] ?? 'off');
s.ok('ambient-context-mode', scalars['ambient-context-mode'] ?? 'off');
// ... 6 more rows ...

// New: iterate registry
for (const f of FEATURES) {
  s.info(f.scalar, scalars[f.scalar] ?? f.values[0].id);
}
```

Cross-check: when a feature's `mustHavePopulatedFields: true` prereq
file is empty but the scalar is non-default → warn. Catches the
"I enabled it but nothing fires" failure class.

### 2. `chrome/host/host.cjs` — File-push list

```js
// Old: hardcoded
for (const filename of ['OPENCUES.md', 'AUDITORS.md', 'USER.md']) {...}

// New: derived
for (const filename of chromeHostFileList()) {...}
```

`chromeHostFileList()` = `CORE_CONFIG_FILES` + every feature whose
`pushedBy` includes `'chrome-host'`. Adding a chrome-host-pushed
feature is one entry in FEATURES; host.cjs picks it up automatically.

### 3. `seed-configs.cjs` — Templated file copies

```js
// Old: hardcoded for AUDITORS.md, USER.md, ...
const auditorsTarget = ...; if (!hasContent(auditorsTarget)) fs.copyFileSync(...);
const userMdTarget = ...; if (!hasContent(userMdTarget)) fs.copyFileSync(...);

// New: iterate seedables
for (const seed of seedableOptionalFiles()) {
  if (!hasContent(target)) fs.copyFileSync(...);
}
```

### 4. `ConfigLoader.parseOpenCuesMd` — Menu definitions

`OpenCuesSettingDef` (tip + valueOrder + valueTips per cyclable
scalar) used to come from parsing OPENCUES.md's `settings:` block —
which duplicated everything in FEATURES. Now:

```ts
const definitions = mergeDefinitions(getMenuDefinitions(), parseSettingsBlock(lines));
```

The registry is the default; a file-level `settings:` block overrides
it entirely if present (back-compat for users with custom menus +
test mocks). `defaults/OPENCUES.md` ships with NO `settings:` block.

### 5. Host bootstraps — Built-in blanks registry

`BUILTIN_BLANKS` (in `packages/opencues-runtime/src/blanks/index.ts`)
is a sibling registry for built-in blanks (hackernews, stocks,
weather, claude-status, etc.). Each entry is a factory that takes
a context object + returns either a `Blank` instance or `null` (when
prereqs aren't met). Hosts call `createDefaultBlanksRegistry(ctx)`
instead of hardcoding `new XxxBlank()` lists.

This caught a real drift bug in May 2026: **claude-status was
registered on opencode + chrome but missing from CC + gemini-cli**.
The registry refactor fixed it on all four hosts at once.

---

## The one site the registry does NOT replace

`packages/opencues-runtime/src/modules/config-loader.ts`'s
`OpenCuesState` interface remains manually typed:

```ts
export interface OpenCuesState {
  readonly voiceMode: 'active' | 'inactive';
  readonly userContextMode: 'off' | 'safe' | 'raw';
  // ...
}
```

This is deliberate: TypeScript consumers (`resolver.ts`,
`FluidBlankSource`, etc.) get **narrow string-union types** rather
than `string`. Pulling the field type from the registry at compile
time is possible (template literal types) but expensive in
complexity for marginal gain.

Drift between FEATURES and OpenCuesState is caught by
`feature-registry-alignment.test.ts`: every FEATURES camelCase
either has a matching OpenCuesState field OR is in the
`SETTINGS_MAP_ONLY` allowlist (with a comment explaining why it
reads from the settings Map instead of the typed enum).

Features that are read from the settings Map today:
`fluidBlankMode`, `wordCuesMode`, `transformBlankMode` — all
consumed in `resolver.ts` as boolean gates.

---

## How to add a new feature

Concrete example: add `agent-mode: on/off` that needs an `AGENTS.md`
config file pushed to chrome.

**Step 1** — append to `FEATURES` in `feature-registry.ts`:

```ts
{
  scalar: 'agent-mode',
  camelCase: 'agentMode',
  description: 'Agentic rewrite tasks armed via `agentically X _`',
  menuTip: 'Enable agentic rewrites',
  values: [
    { id: 'off', description: 'Disabled (default)' },
    { id: 'on',  description: 'Enabled — `agentically X _` arms a task' },
  ],
  prereqFile: {
    basename: 'AGENTS.md',
    template: 'defaults/AGENTS.md',
    mustHavePopulatedFields: true,
  },
  pushedBy: ['chrome-host'],
},
```

**Step 2** — drop the template at `defaults/AGENTS.md`.

**Step 3** — if TypeScript consumers need the typed enum, also add
to `OpenCuesState` in `config-loader.ts`:

```ts
readonly agentMode: 'off' | 'on';
```

…and parse it in `parseOpenCuesMd()`. The alignment test will
fail with a fix hint if you skip this AND don't add `'agentMode'`
to `SETTINGS_MAP_ONLY`.

**Steps you DON'T do** (registry-derived):

- ~~Edit doctor.cjs~~ — auto-includes the new feature
- ~~Edit host.cjs~~ — auto-pushes AGENTS.md to chrome.storage
- ~~Edit seed-configs.cjs~~ — auto-copies the template
- ~~Edit OPENCUES.md~~ — menu auto-derives the cycling values
- ~~Update the menu-drift test~~ — picks up the new scalar automatically

That's the whole change. Compare to the pre-registry world: 6+
files, ~60 lines, easy to miss one and ship a silent bug.

---

## Hiding values from the cycling menu

`exposeInMenu: false` on a `ValueSpec` makes that value
**parser-valid but absent from the cycling menu**. Today the only
hidden value is `user-context-mode: raw` — a footgun mode (inlines
PII into LLM prompts) that should require a deliberate file edit,
not a one-keystroke toggle.

```ts
{ id: 'raw', description: '...PII reaches provider...', exposeInMenu: false }
```

The registry test pins this contract: `user-context-mode`'s
`valueOrder` (the cycling menu's value list) is `['off', 'safe']`,
NOT `['off', 'safe', 'raw']`. Setting `user-context-mode: raw`
directly in OPENCUES.md still works — only the cycling path
refuses to land on it.

---

## Drift-prevention tests

| Test | Pins |
|---|---|
| `feature-registry.test.ts` | FEATURES shape (scalar/camelCase uniqueness, value structure, helpers behave) |
| `feature-registry-menu.drift.test.ts` | Menu derivation: every cyclable feature in the menu, hidden values excluded, `defaults/OPENCUES.md` has NO `settings:` block |
| `feature-registry-alignment.test.ts` | Every FEATURES scalar has either an OpenCuesState field or a SETTINGS_MAP_ONLY allowlist entry |
| `llm-provider.drift.test.ts` | help.cjs's PROVIDER_DISPLAY / PROVIDER_DEFAULT_MODEL fallbacks match the PROVIDERS registry |
| `registry-drift.test.ts` (runtime) | Every host bootstrap calls `createDefaultBlanksRegistry`; no host hardcodes `new XxxBlank()` |
| `sensitive-field-docs.drift.test.ts` (chrome) | No doc duplicates the sensitive-field regex outside the canonical `chrome-security.md` |

71 tests total across the registry-adjacent files. Run them all
before landing a registry change:

```bash
( cd packages/opencues-core && npx vitest run src/feature-registry*.test.ts src/llm-provider.drift.test.ts )
( cd packages/opencues-runtime && npx vitest run src/blanks/registry-drift.test.ts src/modules/feature-registry-alignment.test.ts )
( cd integrations/chrome && npx vitest run src/sensitive-field-docs.drift.test.ts )
```

---

## When NOT to add to the registry

The registry exists for **install-boundary** drift — things that
get encoded in multiple processes / build artifacts and silently
diverge. Not everything optional should go through it:

- **Per-cue/per-blank settings** (provider, model, priority, etc.) —
  these live in the cue/blank's own frontmatter; the registry is
  global runtime state, not per-entity config.
- **Internal feature flags** that don't have an OPENCUES.md scalar —
  if there's no user-facing toggle, there's no menu / doctor /
  seed-configs surface to wire.
- **Implementation details** of a feature (which LLM provider, what
  prompt template, what timeout) — those belong in the feature's
  own module, not the registry. The registry only knows: does this
  feature exist, is it on, does it need a file?

Rule of thumb: if a user can flip it in `~/.cues/OPENCUES.md` AND
the toggle needs to be visible at the install boundary (doctor,
seed, chrome-host push) → registry. Otherwise → wherever fits the
feature's domain.

---

## Pre-registry archaeology

Six commits in May 2026 collapsed the pre-registry drift surface:

| Commit | What | Drift bug fixed |
|---|---|---|
| `6c280a9` | Feature registry foundation | Multi-site scalar drift |
| `46478ff` | Doctor's feature wiring section | Hardcoded scalar list |
| `3bb71ff` | LLM provider registry + host aliases | Provider lists in 6 sites; doctor said GROQ was "default" when chain was cerebras-first |
| `c76bbef` | BUILTIN_BLANKS + sensitive-field constants | **claude-status missing on CC + gemini-cli** (silent feature gap on 2/4 hosts) |
| `bddbdf7` | Menu schema into registry | OPENCUES.md `settings:` block duplicated FEATURES values; `user-context-mode: raw` hidden by absence rather than `exposeInMenu: false` |
| `224d182` | Doc fixup | Stale "settings block not user-customisable" prose |

Result: `defaults/OPENCUES.md` shrunk 88 lines, the cycling menu
became fully registry-driven (validated end-to-end via agentic
harness scenario 14), and the per-feature checklist collapsed from
"edit 6 files in lockstep" to "edit one file."
