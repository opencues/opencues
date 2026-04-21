# Shipped Defaults

The `<repo>/defaults/` directory holds the grammar / legal / medical / volume / etc. configs that OpenCues ships to every new user. It is **a seed source, not an ambient project config.**

Before April 2026 these files lived at `<repo>/.opencues/`. That path was ambiguous — it served three roles at once:

1. **Seed source** for `opencues seed-configs` (copied into `~/.opencues/` on first install).
2. **Bake-time source** for the Chrome extension's inlined fallback (`__DEFAULT_CUE_FOLDERS__` et al).
3. **Implicit dev config** — when a dev was `cd`'d into the opencues repo, the native hosts' cwd-based project-level merge picked it up as if it were a normal project.

Role #3 caused confusion ("why does editing `<repo>/.opencues/grammar/cue.md` change behaviour in my CC session but not in chrome?") and leaked dev-specific edits into the shipped defaults. Moving the directory to `defaults/` removes that third role — the repo no longer has an in-tree project config.

---

## What lives in `defaults/`

Same shape as any user-level `~/.opencues/` or project-level `.opencues/`:

```
defaults/
├── cues.md              # Monolithic: static tips JSON + ### grammar prompt
├── blanks.md            # ### math, ### factual, ### classifier, etc.
├── controls.md          # Monolithic controls (inline list/step ones)
├── opencues.md          # NOTE: runtime-owned system settings; user-level only at runtime.
│                        # Ships here only so `seed-configs` can drop a skeleton file.
├── cues/                # Folder-based cue sources
│   ├── grammar/cue.md
│   ├── legal/cue.md
│   ├── medical/cue.md
│   └── financial/cue.md
└── controls/            # Folder-based controls + colocated scripts
    ├── volume/
    │   ├── cue.md
    │   ├── volume.sh
    │   ├── volume-blank.sh
    │   └── VolCtl.cs
    ├── brightness/
    │   ├── cue.md
    │   └── brightness.sh
    ├── stocks/cue.md
    ├── weather/cue.md
    ├── hackernews/cue.md
    ├── prompt/cue.md
    ├── answer/cue.md
    ├── affirmations/cue.md
    ├── numbers/cue.md
    └── opencues/cue.md
```

---

## Who reads from `defaults/`

| Consumer | When | What it does |
|---|---|---|
| `opencues seed-configs` | On first install (run once per user) | Copies every file to `~/.opencues/`. Never overwrites existing files — idempotent. |
| Per-host `seed-configs` (CC / OC / codex install.cjs) | During `opencues install <host>` | Same copy step, scoped to that integration's needs. |
| Chrome `esbuild.config.mjs` | Every `pnpm --filter @opencues/chrome build` | Inlines `defaults/cues/*`, `defaults/controls/*`, `defaults/cues.md`, `defaults/blanks.md`, `defaults/opencues.md` into the bundle as `__DEFAULT_*__` constants. The runtime uses these as fallbacks when the bundled `configs/` dir is absent or hasn't been sync'd. |
| `packages/opencues-core/src/sources/classifier.test.ts` | Unit test | Reads `defaults/blanks.md` as a real-world fixture. |

Nothing reads `defaults/` at host runtime. The runtime only reads `~/.opencues/` (user-level), `<cwd>/.opencues/` (project-level), and — for chrome — the synced `dist/configs/` bundle.

---

## The dev loop after the rename

If you're iterating on, say, the grammar prompt:

1. Edit `defaults/cues/grammar/cue.md` in the repo.
2. Run `pnpm exec opencues seed-configs` — idempotent; will SKIP files that already exist in `~/.opencues/`. If you've already seeded once and want the update to land, either delete the user-level file first or edit `~/.opencues/cues/grammar/cue.md` directly for fast iteration and copy back to `defaults/` when ready to ship.
3. Re-run the integration (CC / OC / chrome) — changes picked up on next keystroke via hot-reload.

For Chrome specifically, you can also re-run `pnpm exec opencues sync chrome --wsl` to pick up changes from `~/.opencues/` without rebuilding the extension. Or rebuild the extension to refresh the baked-in defaults.

---

## Why not just symlink `.opencues/` → `defaults/`?

Tempting but loses the win. A symlink restores role #3 — `<cwd>/.opencues/` still resolves from the repo dir, and the native hosts' cwd-based merge kicks in again. The confusion returns.

Separate names mean separate roles. `defaults/` is for code (the install / build pipeline), `~/.opencues/` and per-project `.opencues/` are for runtime configuration. A dev on opencues is, from the runtime's perspective, just another user.

---

## Migration notes for contributors

- **Seed your user-level configs once.** After pulling a branch that renames the dir, `opencues seed-configs` into `~/.opencues/`. If you'd previously been relying on `<repo>/.opencues/` for your day-to-day CC/OC use, that's gone — your shell no longer picks up those configs implicitly.
- **`<repo>/.opencues/` is deleted.** `git rm` hooked into the rename; no orphan dir.
- **The shape of `defaults/` matches `~/.opencues/`.** Anything that works in one works in the other. Files are portable via straight copy.
- **New cues ship here.** Add a new `defaults/cues/<name>/cue.md`, commit, and it's in the next release's seed for users + bake-time defaults for chrome.

---

## Related

- `docs/features/chrome-sync.md` — how `sync chrome` bundles configs for the extension (reads from `~/.opencues/` at sync time, `defaults/` at build time).
- `docs/features/host-compat.md` — per-entry host filtering; applies equally to files in `defaults/` during chrome bake.
- `docs/glossary.md § .opencues directory` — user-level / project-level conventions.
