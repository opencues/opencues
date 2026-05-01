# Host Compatibility

The OpenStandard runs on four integration hosts — `claude-code`, `opencode`,
`codex`, `chrome` — that share the same `.md` config format but differ in
runtime capabilities. Native hosts (CC, OC, codex) can spawn subprocesses
and read arbitrary filesystem paths; chrome can't.

A cue or blank can declare which hosts it works on. Most entries
don't need to: OpenCues **infers** compatibility from what the entry
uses. The annotation is only for the cases where inference can't.

---

## How inference works

`@opencues/core` exports `inferHostCompat(input)`. Inputs are read from
frontmatter. The rule is one line:

> **If `script:` or `blankScript:` ends in a subprocess extension
> (`.sh`, `.bash`, `.ps1`, `.bat`, `.cmd`, `.exe`, `.py`, `.rb`, `.pl`),
> the entry can't run in chrome.** Otherwise it runs everywhere.

That covers every cue + blank we ship today without a single annotation:

| Entry | Auto-detected hosts | Why |
|---|---|---|
| `cues.md ### grammar` (LLM only) | all | no script |
| `blanks.md ### math` (compute parser) | all | no script |
| `blanks/affirmations/cue.md` (list) | all | no script |
| `blanks/stocks/cue.md` (runtime class) | all | no script |
| `blanks/volume/cue.md` (`blankScript: ./volume-blank.sh`) | claude-code, codex, opencode | `.sh` |
| `blanks/brightness/cue.md` (`blankScript: ./brightness-blank.sh`) | claude-code, codex, opencode | `.sh` |

---

## Explicit overrides

Two frontmatter fields, applied AFTER auto-detect:

```yaml
on-host: [chrome]                              # allow-list
not-on-host: [chrome]                          # deny-list
```

Both accept:
- A YAML array: `[chrome, opencode]`
- A comma-separated string: `chrome, opencode`
- A single value: `chrome`
- Either `on-host` (canonical YAML hyphen) or `onHost` (camelCase)

### Resolution order

1. **`on-host:` is the allow-list** if set. Auto-detect is ignored.
2. Otherwise, **auto-detect from `script:` / `blankScript:` extension.**
3. **`not-on-host:` filters** the result (deny wins on overlap).

### When you'd use `on-host:`

- A demo cue that only makes sense in the browser (e.g. a "page word
  count" prompt that needs DOM access)
- A runtime-class blank that ALSO has a shell fallback for native
  hosts. Without `on-host:`, auto-detect sees the `.sh` and excludes
  chrome — the override re-includes it. See
  `.opencues/blanks/opencues/cue.md` for a real example.

### When you'd use `not-on-host:`

- A blank that uses a runtime class but doesn't make sense outside
  one specific host (rare)
- Forcing exclusion when the auto-detect would say "all hosts" but you
  know better

---

## Where the compat marker is used

| Surface | What it does |
|---|---|
| `opencues list` | Shows `[host1, host2, host3]` per entry. `[all]` for universal. |
| `opencues validate` | Warns on unknown host names, on-host:[chrome] + .sh contradictions, and empty allow-lists |
| `opencues sync chrome` (planned) | Filters out entries where `chrome` isn't in the resolved hosts |

---

## Schema reference

```yaml
---
# Optional. Overrides auto-detect. When set, the listed hosts are the
# only ones this entry runs on. Omit if you want the auto-detect default.
on-host: [chrome, claude-code, codex, opencode]   # array
on-host: chrome, claude-code                       # comma-separated
on-host: chrome                                    # single value

# Optional. Removes hosts from the resolved set (after on-host or auto).
not-on-host: [chrome]
not-on-host: chrome, codex
---
```

Valid host names: **`chrome`**, **`claude-code`**, **`codex`**, **`opencode`**.

Unknown names are silently dropped at runtime; `opencues validate` prints
warnings about them so typos are caught.

---

## API

`@opencues/core`:

```ts
import { inferHostCompat, formatHostList, HOSTS, NATIVE_HOSTS } from '@opencues/core';

const result = inferHostCompat({
  script: './volume.sh',
  // optional: 'on-host': ['chrome'],
  // optional: 'not-on-host': ['codex'],
});
// → {
//     hosts: ['claude-code', 'codex', 'opencode'],
//     all: false,
//     source: 'auto'   // or 'on-host' / 'auto+not-on-host'
//   }

formatHostList(result.hosts);
// → 'claude-code, codex, opencode'   (or 'all' if every host)
```

| Constant | Value |
|---|---|
| `HOSTS` | `['chrome', 'claude-code', 'codex', 'opencode']` |
| `NATIVE_HOSTS` | `['claude-code', 'opencode', 'codex']` (subprocess + filesystem capable) |

| Function | Returns |
|---|---|
| `inferHostCompat(input)` | `{ hosts, all, source }` |
| `unknownHostNames(value)` | `string[]` of host names that aren't in `HOSTS` (validator helper) |
| `formatHostList(hosts)` | Human display: `"all"` or `"claude-code, codex, opencode"` |

---

## Why this exists

Three motivations:

1. **`opencues sync chrome`** has to know which entries are safe to bundle into the Chrome extension. Bundling a blank that calls `volume-blank.sh` would silently fail because chrome content scripts can't spawn processes — the user would see a missing-blank message in the extension. Filter it out at sync time, with an honest "this needs subprocess access" reason.

2. **`opencues list`** is a "what's actually going to fire?" diagnostic. Showing the host marker per entry makes it obvious why a cue you defined isn't appearing in chrome — you can see at a glance that it's restricted.

3. **Author intent** — sometimes you DO want to gate (a chrome-only demo cue, a Linux-only diagnostic). The override fields make the gate explicit + machine-readable, vs hiding it in script logic.

The OpenStandard's design principle: **infer what's obvious, declare what isn't, validate everything.** Host-compat is a clean instance of that.
