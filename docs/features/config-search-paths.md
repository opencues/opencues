---
last_updated: 2026-04-22
---

# Config Search Paths

OpenCues looks for your `.md` configs in up to three locations, in
this precedence order. The runtime polls every layer on every
keystroke — so adding a `.cues/` to a new project takes effect
within ~2 seconds, no restart.

```
$OPENCUES_HOME           ← env override (top priority)
<cwd>/.cues          ← project-level
~/.cues              ← user-level (always loaded last unless overridden)
```

This convention deliberately mirrors `.editorconfig`, `.npmrc`, and
`.claude/skills/`: an opaque, host-neutral directory at the project
root, plus a global default in `~`.

---

## The three layers

### 1. `$OPENCUES_HOME` (env override)

If the environment variable is set, it becomes the **sole** source —
project and user paths are ignored. Used by:

- CI / power users who need a deterministic config
- The runtime itself when re-launching subprocesses
- The `opencues sync chrome` CLI (under the hood)

```bash
OPENCUES_HOME=/some/fixed/path opencues run claude-code
```

### 2. `<cwd>/.cues` (project-level)

The runtime checks the directory the host process was launched from.
A `.cues/` at the project root scopes its configs to that project.
Project-level files **win on name conflicts** with user-level
(matching the precedence model used by `.npmrc` etc.).

Created with `opencues init` (which scaffolds the directory
structure with starter templates).

### 3. `~/.cues` (user-level)

The global default. Configs here apply to every project unless
overridden. Created with `opencues seed-configs` (which copies the
shipped `defaults/` into `~/.cues/`).

---

## Precedence on name conflicts

Where two layers define the same file or folder, they're **merged**,
not replaced. The merge rule is:

- `CUES.md` frontmatter (project-level): the `ignore:` array is
  union-merged; system-settings keys are user-level only
- `cues/<name>/CUE.md` folder cues → project layer's `<name>` wins on
  conflict; uniquely-named cues from each layer all load
- `blanks/<name>/BLANK.md` cue-blanks → same as folder cues

Missing layers are silently skipped — there's never a "config
missing" error from the layering itself. A user with no `.cues/`
anywhere gets empty config (CC/OC), which is a valid degraded
state.

The merge is implemented in `discoverFolderConfigs` and
`mergeConfigs` in `@opencues/core`, exercised by the runtime's
`ConfigLoader._loadOnce`.

---

## Special case: `OPENCUES.md` system settings

The frontmatter of `OPENCUES.md` holds **system-wide settings**
owned by the runtime — voice-mode, fluid-blank-mode, word-cues-mode,
tips-mode, debug-mode, cursor-navigate, blank-trigger-mode,
ambient-context-mode, user-context-mode, plus numeric tunables
(agent-debounce-ms, max-concurrent-auditors, blank-loading-*)
and global LLM provider/model overrides (llm-provider, llm-model,
<feature>-provider). Schema is declared in `@opencues/core`'s
`FEATURES` + `MENU_TUNABLES` registry. Because these settings
apply across every integration, projects can't override them. The
runtime reads `OPENCUES.md` only from the **user-level entry**
(or `$OPENCUES_HOME/OPENCUES.md` when set). The canonical
filename is exported as `CORE_SETTINGS_FILE`.

(`CUES.md` is a separate file — cue master config + project
metadata — see the per-file table above. The names are similar
but the schemas are unrelated; a pre-2026 design plan to merge
them never landed.)

- `opencues seed-configs` (no flag) copies `defaults/OPENCUES.md` to
  `~/.cues/`; `seed-configs --project` skips it (settings are
  user-level only)
- A 0-byte `OPENCUES.md` is treated as missing — `seed-configs`
  re-seeds it on every install. The `OpenCuesSettingsBlank`
  silently no-ops on null/empty content
  (correct behavior for "no file"), so an empty file would otherwise
  silently break `opencues ___` / `config ___` blank-fills on every
  native host. Chrome is unaffected — its storage adapter falls back
  to the bake-time `__DEFAULT_CUES_MD__` constant

---

## Chrome is different

Chrome content scripts can't read the filesystem, so the layered
search-path model doesn't apply. Instead, `opencues sync chrome`
bundles a snapshot of your config into the extension's
`dist/configs/` directory. By default, only `~/.cues/` feeds
that bundle — projects are opt-in via `--include`. See
[Chrome Sync](chrome-sync.md) for the full source-discovery rules.

The native hot-reload model (re-poll on every keystroke) is also
chrome-specific in its variant — chrome polls a content-addressable
`.version` hash file every 2.5s instead. See
[Chrome Hot-Reload](chrome-hot-reload.md).

---

## Hot-reload behavior

The runtime's `ConfigLoader` wraps every read through a TTL-checked
re-load. On every text change (a "pulse"), if more than
`HOT_RELOAD_TTL_MS` (~2000ms) has elapsed since the last load and
no other reload is in flight, every search-path layer is re-walked
and the result merged. Files added, deleted, or modified take effect
within ~2 seconds without restarting the host.

See [Hot-Reload Config](hot-reload-config.md) for the polling
mechanism details.

---

## `seed-configs` — populate `~/.cues/` from the repo

`opencues seed-configs` walks `<repo>/defaults/` and copies any file
that doesn't already exist at the destination. Flags:

| Flag | Effect |
|---|---|
| (no flag) | Copies into `~/.cues/` (user-level). Skips files that already exist. |
| `--project` | Copies into `<cwd>/.cues/` instead. Skips `OPENCUES.md` (its frontmatter holds system-wide settings, which don't belong at project level). |
| `--force` | Overwrite existing files. Use with care. |

Run `seed-configs` once after a fresh install; the host integrations
work without it (they degrade to empty config), but you'll have no
example tips, no domain cues, no cue-blanks until you do.

The shipped defaults under `defaults/` cover all four hosts. Per-host
filtering (e.g., excluding `.sh`-based blanks from chrome) is
handled at install / sync time via [host-compat](host-compat.md).

---

## Code reference

- `packages/opencues-runtime/src/modules/config-loader.ts` — the
  three-layer walk + merge + hot-reload loop
- `packages/opencues-core/src/discover.ts` — `discoverFolderConfigs`,
  the merge primitive used by ConfigLoader
- `packages/opencues-cli/src/commands/seed-configs.cjs` — the seeder

---

## Portability

### Standard (`@opencues/core`)

- Parsers (`parseCuesMd`, `parseSingleCueMd`, `discoverFolderConfigs`)
  are stateless and have no notion of layering
- `mergeConfigs(...configs)` takes parsed configs in precedence order
  (lowest first) and produces the merged result
- The library doesn't know or care where configs came from on disk

### Integration responsibilities (`@opencues/runtime` adapters)

- Resolve the three search paths according to `$OPENCUES_HOME` /
  `cwd` / `~` for the host
- Read each layer's files and parse independently (don't merge files
  textually — merge their parsed structures)
- Pass parsed layers to `mergeConfigs` in precedence order (user
  first, project last, env override → use that as the only source)
- Re-walk every layer on every hot-reload pulse — cached file
  contents will not pick up new files created in any layer
