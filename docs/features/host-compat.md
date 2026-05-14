---
last_updated: 2026-05-14
---

# Host Compatibility

The OpenStandard runs on four integration hosts — `claude-code`, `opencode`,
`chrome`, `gemini-cli` — that share the same `.md` config format. Native
hosts (CC, OC, gemini-cli) can spawn subprocesses and read the filesystem
unconditionally. Chrome can too, but only when chrome-host (the
native-messaging bridge) is installed — so chrome's spawn capability is
*runtime-detected*, not a static property.

A cue or blank can declare which hosts it works on, but most entries
don't need to: **every entry advertises as compatible with every host by
default.** The runtime attempts the call; if the host can't fulfil it,
the failure surfaces at runtime (exit 127) rather than being hidden
behind a misleading "incompatible host" marker.

---

## Historical note

This used to do auto-exclusion: `script:` / `blankScript:` ending in
`.sh / .bash / .ps1 / .py / .rb / .pl / .exe / .bat / .cmd` would
auto-exclude chrome on the assumption it couldn't spawn subprocesses.
That assumption stopped holding when chrome-host shipped (May 2026) —
chrome-host runs scripts on chrome's behalf, so POSIX shell scripts now
work everywhere with the host installed.

The heuristic was removed in favour of "default everywhere, scope explicitly
when needed." `.sh`-bearing blanks no longer carry a misleading marker in
`opencues list`, and `opencues sync chrome` no longer drops their folders
from the bundle (it just strips the script bytes — chrome-host runs them
from disk directly).

---

## Explicit overrides

Two frontmatter fields:

```yaml
on-host: [claude-code, opencode]               # allow-list
not-on-host: [chrome]                          # deny-list
```

Both accept:
- A YAML array: `[chrome, opencode]`
- A comma-separated string: `chrome, opencode`
- A single value: `chrome`
- Either `on-host` (canonical YAML hyphen) or `onHost` (camelCase)

### Resolution order

1. **`on-host:` is the allow-list** if set. Default-all is bypassed.
2. Otherwise the resolved set is every host.
3. **`not-on-host:` filters** the result (deny wins on overlap).

### When you'd use `on-host:`

- A demo cue that only makes sense in the browser (e.g. a "page word
  count" prompt that needs DOM access)
- A diagnostic blank scoped to one specific host (rare)

### When you'd use `not-on-host:`

- A blank you know will fail on a specific host and want to hide
  rather than let it fail at runtime (e.g. a Windows-only `.exe`
  blank you want excluded from non-Windows native hosts)

In practice, most entries set neither field — failure at runtime is
the friendlier surface than a hidden entry that the user can't figure
out why they don't see.

---

## Where the compat marker is used

| Surface | What it does |
|---|---|
| `opencues list` | Shows `[host1, host2, host3]` per entry. **Hidden when the entry resolves to "all"** (the common case) — `--all` re-surfaces every marker. |
| `opencues validate` | Warns on unknown host names + redundant overrides |
| `opencues sync chrome` | Filters out entries where `chrome` is explicitly excluded via `not-on-host` / `on-host` |

---

## Schema reference

```yaml
---
# Optional. Narrows the default (every host) to this set.
on-host: [chrome, claude-code, gemini-cli, opencode]   # array
on-host: chrome, claude-code                           # comma-separated
on-host: chrome                                        # single value

# Optional. Removes hosts from the default (or `on-host`) set.
not-on-host: [chrome]
not-on-host: chrome, opencode
---
```

Valid host names: **`chrome`**, **`claude-code`**, **`gemini-cli`**, **`opencode`**.

Unknown names are silently dropped at runtime; `opencues validate` prints
warnings about them so typos are caught.

---

## API

`@opencues/core`:

```ts
import { inferHostCompat, formatHostList, HOSTS, NATIVE_HOSTS } from '@opencues/core';

inferHostCompat({});
// → { hosts: ['chrome', 'claude-code', 'gemini-cli', 'opencode'], all: true, source: 'auto' }

inferHostCompat({ 'on-host': ['chrome'] });
// → { hosts: ['chrome'], all: false, source: 'on-host' }

inferHostCompat({ 'not-on-host': ['chrome'] });
// → { hosts: ['claude-code', 'gemini-cli', 'opencode'], all: false, source: 'not-on-host' }

formatHostList(['claude-code', 'gemini-cli', 'opencode']);
// → 'claude-code, gemini-cli, opencode'
formatHostList(['chrome', 'claude-code', 'gemini-cli', 'opencode']);
// → 'all'
```

| Constant | Value |
|---|---|
| `HOSTS` | `['chrome', 'claude-code', 'gemini-cli', 'opencode']` |
| `NATIVE_HOSTS` | `['claude-code', 'gemini-cli', 'opencode']` — hosts that have subprocess + filesystem capability unconditionally (no auxiliary helper needed) |

| Function | Returns |
|---|---|
| `inferHostCompat(input)` | `{ hosts, all, source }` — `source` is `'auto'` / `'on-host'` / `'not-on-host'` |
| `unknownHostNames(value)` | `string[]` of host names that aren't in `HOSTS` (validator helper) |
| `formatHostList(hosts)` | Human display: `"all"` or `"claude-code, gemini-cli, opencode"` |

---

## Why this exists

Two motivations:

1. **`opencues sync chrome`** filters the bundle: explicit `not-on-host: [chrome]` entries are dropped at bake time so the extension doesn't ship code it can never run. Script-bearing folders still bundle (chrome-host can run them) but their script bytes are stripped — host runs from disk.

2. **Author intent** — sometimes you DO want to gate (a chrome-only demo cue, a Linux-only diagnostic). The override fields make the gate explicit + machine-readable, vs hiding it in script logic.

The OpenStandard's design principle: **default to working, declare exceptions, validate everything.** Host-compat is a clean instance of that.
