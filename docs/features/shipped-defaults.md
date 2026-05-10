# Shipped Defaults

The `<repo>/defaults/` directory holds the grammar / legal / medical / volume / etc. configs that OpenCues ships to every new user. It is **a seed source, not an ambient project config.**

It plays two roles:

1. **Seed source** for `opencues seed-configs` (copied into `~/.cues/` on first install).
2. **Bake-time source** for the Chrome extension's inlined fallback (`__DEFAULT_CUE_FOLDERS__` et al).

It is *not* picked up as an ambient project config — devs working on opencues run `seed-configs` once just like any user.

---

## What lives in `defaults/`

Same shape as any user-level `~/.cues/` or project-level `.cues/`:

```
defaults/
├── CUES.md              # Top-level settings + nested settings: block + ignore: array
│                        # (frontmatter only; body is human-readable description).
│                        # Runtime-owned for the system-settings half — user-level only at runtime.
│                        # Ships here so `seed-configs` can drop a starter file.
├── cues/                # Folder-based cue sources (one folder per source)
│   ├── grammar/CUE.md   # Static cues: body JSON words map
│   ├── legal/CUE.md     # LLM cues: match:/keywords: in frontmatter, prompt in body
│   ├── medical/CUE.md
│   └── financial/CUE.md
└── blanks/              # Folder-based cue-blanks + colocated scripts
    ├── volume/
    │   ├── BLANK.md
    │   ├── volume.sh
    │   ├── volume-blank.sh
    │   └── VolCtl.cs
    ├── brightness/
    │   ├── BLANK.md
    │   └── brightness.sh
    ├── stocks/BLANK.md
    ├── weather/BLANK.md
    ├── hackernews/BLANK.md
    ├── prompt/BLANK.md
    ├── answer/BLANK.md
    ├── affirmations/BLANK.md
    ├── numbers/BLANK.md
    └── opencues/BLANK.md
```

---

## Who reads from `defaults/`

| Consumer | When | What it does |
|---|---|---|
| `opencues seed-configs` | On every invocation (standalone or chained from `opencues install <host>`) | Four phases: (1) **SEED** first-time copy to `~/.cues/` — preserves non-empty user files; (2) **SYNC** library files (`.sh` / `.cs` / `.ps1`) from `defaults/{blanks,scripts}/` every run — overwrites stale, never overwrites `.md`; (3) **HEAL** re-seed 0-byte `CUES.md`; (4) **COMPILE** colocated `.cs` → `.exe` (WSL only). |
| Chrome `esbuild.config.mjs` | Every `pnpm --filter @opencues/chrome build` | Inlines `defaults/cues/*`, `defaults/blanks/*`, and `defaults/CUES.md` into the bundle as `__DEFAULT_*__` constants. The runtime uses these as fallbacks when the bundled `configs/` dir is absent or hasn't been sync'd. |
| `packages/opencues-core/src/sources/classifier.test.ts` | Unit test | Reads `defaults/blanks/<name>/BLANK.md` files as real-world fixtures. |

Nothing reads `defaults/` at host runtime. The runtime only reads `~/.cues/` (user-level), `<cwd>/.cues/` (project-level), and — for chrome — the synced `dist/configs/` bundle.

---

## The dev loop after the rename

If you're iterating on, say, the grammar prompt:

1. Edit `defaults/cues/grammar/CUE.md` in the repo.
2. Run `pnpm exec opencues seed-configs` — idempotent; SKIPS files that already exist in `~/.cues/` (empty 0-byte files re-seed automatically). If you've already seeded a non-empty file and want the update to land, either delete the user-level file first (or `truncate -s 0` it) or edit `~/.cues/cues/grammar/CUE.md` directly for fast iteration and copy back to `defaults/` when ready to ship.
3. Re-run the integration (CC / OC / chrome) — changes picked up on next keystroke via hot-reload.

For Chrome specifically, you can also re-run `pnpm exec opencues sync chrome --wsl` to pick up changes from `~/.cues/` without rebuilding the extension. Or rebuild the extension to refresh the baked-in defaults.

---

## Why not just symlink `.cues/` → `defaults/`?

Tempting but loses the win. A symlink restores role #3 — `<cwd>/.cues/` still resolves from the repo dir, and the native hosts' cwd-based merge kicks in again. The confusion returns.

Separate names mean separate roles. `defaults/` is for code (the install / build pipeline), `~/.cues/` and per-project `.cues/` are for runtime configuration. A dev on opencues is, from the runtime's perspective, just another user.

---

## Migration notes for contributors

- **Seed your user-level configs once.** Run `opencues seed-configs` to populate `~/.cues/`. Your shell does not pick up `<repo>/defaults/` implicitly — the seed step is the canonical way to get the shipped configs into your environment.
- **`<repo>/.cues/` is deleted.** `git rm` hooked into the rename; no orphan dir.
- **The shape of `defaults/` matches `~/.cues/`.** Anything that works in one works in the other. Files are portable via straight copy.
- **New cues ship here.** Add a new `defaults/cues/<name>/CUE.md`, commit, and it's in the next release's seed for users + bake-time defaults for chrome.

---

## Related

- `docs/features/chrome-sync.md` — how `sync chrome` bundles configs for the extension (reads from `~/.cues/` at sync time, `defaults/` at build time).
- `docs/features/host-compat.md` — per-entry host filtering; applies equally to files in `defaults/` during chrome bake.
- `docs/glossary.md § .cues directory` — user-level / project-level conventions.
