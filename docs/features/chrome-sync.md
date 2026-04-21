# Chrome Sync

`opencues sync chrome` bundles your local `.opencues/` configs into the Chrome extension's `dist/configs/` directory so a browser content script can read them. The native hosts (claude-code, opencode, codex) don't need this — they have filesystem access and hot-reload from `~/.opencues/` natively. Chrome content scripts can't, so the configs have to be shipped into the extension build.

This doc is about **which `.opencues/` dirs feed that bundle** — not what gets bundled (that's host-compat's job: see `docs/features/host-compat.md`).

---

## Chrome is different from the native hosts

The native hosts use a two-tier search path — `~/.opencues/` (user-level) plus `<cwd>/.opencues/` (project-level) — exactly like `.editorconfig` or `.npmrc`. The project you `cd` into determines what the integration sees.

Chrome has no cwd. It's a browser extension that runs in every tab, across every site, on every page. There's no meaningful notion of "the current project" from Chrome's perspective. Inheriting the cwd model would mean:

> Run `opencues sync chrome` from `~/scratch` → Chrome loses every config from the project you actually care about.

Worse, for the long-running `--watch` mode:

> Start `sync chrome --watch` from some random terminal → it binds to that terminal's cwd forever, silently missing edits in the project you're editing.

That's what happened during sync-demo testing: the watcher got started from `~/testing` and silently ignored all edits to the opencues repo's own `.opencues/`. The bug isn't the watcher — it's the cwd inheritance.

So `sync chrome` deliberately doesn't inherit cwd. It defaults to user-level only. Projects are opt-in.

---

## Source discovery rules

Precedence (low → high; later overlays earlier on same-name files):

1. **`$OPENCUES_HOME`** — if set, becomes the sole source. Env override, for CI / power users.
2. **`~/.opencues/`** — the user-level default. Always first unless `$OPENCUES_HOME` is set.
3. **Each `--include <path>`** — added in the order given, stackable, repeatable.
4. **`--project`** — if passed, adds `<cwd>/.opencues/`. Highest project priority.

**`--pack <name>`** and **`--source <path>`** *short-circuit the chain* — they become the sole source. Useful for testing a pack in isolation.

---

## Choosing flags

| Situation | Command |
|---|---|
| Typical home user — one set of configs in `~/.opencues/` | `opencues sync chrome --wsl` |
| Iterating on the opencues repo's own `.opencues/` | `opencues sync chrome --include ~/opencues/.opencues --wsl --watch` |
| Bundling a project you're currently inside | `opencues sync chrome --project --wsl` |
| Bundling configs from *n* projects at once | `opencues sync chrome --include ~/a/.opencues --include ~/b/.opencues --wsl` |
| Trying out a single pack end-to-end | `opencues sync chrome --pack demo-pack --wsl` |
| Sandbox test from an arbitrary dir | `opencues sync chrome --source /tmp/.opencues --wsl` |
| Preview what would be bundled | `... --dry-run` |

The `--wsl` flag deploys to `/mnt/c/Users/<u>/AppData/Local/opencues-chrome/dist/configs/` on Windows. Drop it on Linux/macOS (or use `--target <path>` for a custom install dir).

### Why `--include <path>` over `--project`?

Both opt a project in, but `--include` is the path you typed — it survives `cd`, backgrounding, and wrong terminals. `--project` is "whatever my shell happens to be in right now." For one-shots either works; for `--watch` always prefer `--include`.

---

## What this means for `--watch`

The watcher reads the source list once at startup (the initial `resolveSources` call). Subsequent re-syncs use the same list. So:

- **`sync chrome --wsl --watch`** watches `~/.opencues/` only. Edits anywhere else are invisible to chrome.
- **`sync chrome --include ~/opencues/.opencues --wsl --watch`** watches `~/.opencues/` AND `~/opencues/.opencues/`. Edits in either propagate within the debounce window (~250ms).
- **`sync chrome --project --wsl --watch`** watches `~/.opencues/` AND `<cwd>/.opencues/` — where `<cwd>` is frozen to the directory the watcher was started in. This is the ergonomic footgun: subsequent `cd` moves do nothing.

Rule: `--watch` + explicit `--include` paths is the safe combination.

---

## Mental model

The three roles:

| Role | Lives at | Scope |
|---|---|---|
| **User-level** | `~/.opencues/` | "My default cues across every project I work on" |
| **Project-level** | `<cwd>/.opencues/` | "This repo's specific cues" — only the native hosts use it automatically |
| **Chrome bundle** | `integrations/chrome/dist/configs/` on build-side, `~/AppData/.../opencues-chrome/dist/configs/` on run-side | "Everything the browser extension can see" |

The native hosts implicitly merge user + project. Chrome doesn't — you build the chrome bundle explicitly, because chrome runs everywhere and is scoped by the user's choice, not by a filesystem cwd.

---

## Migrating from the pre-April-2026 behaviour

Before this change, `sync chrome` defaulted to user + `<cwd>/.opencues/` merged, same as the native hosts. If you had a script or muscle memory that did:

```bash
cd ~/myproj
opencues sync chrome --wsl
```

...the new equivalent is:

```bash
cd ~/myproj
opencues sync chrome --project --wsl      # one-shot
# or, for --watch:
opencues sync chrome --include ~/myproj/.opencues --wsl --watch
```

The `--user` flag that existed before (explicit "only ~/.opencues") is gone — it's now the default, so it had no purpose.
