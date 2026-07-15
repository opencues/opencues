# Shipped Defaults

The `<repo>/defaults/` directory holds the grammar / legal / medical / volume / etc. configs that OpenCues ships to every new user. It is **a seed source, not an ambient project config.**

It plays two roles:

1. **Seed source** for `opencues seed-configs` (copied into `~/.cues/` on first install).
2. **Bake-time source** for the Chrome extension's inlined fallback (`__DEFAULT_CUE_FOLDERS__` et al).

It is *not* picked up as an ambient project config — devs working on opencues run `seed-configs` once just like any user.

---

## What lives in `defaults/`

There is no top-level `CUES.md`/`BLANKS.md` in `defaults/` today — only the always-present runtime-settings and auditor master files, plus the folder-based cue/blank/auditor sources (`opencues init` generates fresh, empty `CUES.md`/`BLANKS.md`/`AUDITORS.md` templates for a NEW project — that's a separate code path from `seed-configs`, not a copy from `defaults/`):

```
defaults/
├── OPENCUES.md          # Runtime system settings (voice-mode, word-cues-mode,
│                        # llm-provider, agent-debounce-ms, ...) — frontmatter only.
│                        # User-level only at runtime; schema declared in @opencues/core
│                        # via FEATURES + MENU_TUNABLES.
├── AUDITORS.md           # Auditor master (always-present template).
├── IDENTITY.md          # Personal-data template, fully commented out.
├── cues/                # Folder-based cue sources (one folder per source)
│   ├── legal/CUE.md     # LLM cues: match:/keywords: in frontmatter, prompt in body
│   ├── medical/CUE.md
│   ├── financial/CUE.md
│   ├── more-formal/CUE.md   # scope: sentence cue
│   ├── spelling/CUE.md      # catch-all, lowest priority
│   ├── tips-{claude-code,opencode,gemini-cli,shell}/CUE.md
│   └── example/CUE.md       # minimal worked example for authors
├── auditors/
│   ├── grammar/AUDITOR.md
│   └── clarity/AUDITOR.md   # disabled by default; opt in
└── blanks/              # Folder-based cue-blanks + colocated scripts
    ├── volume/
    │   ├── BLANK.md
    │   ├── volume-blank.sh
    │   └── VolCtl.cs
    ├── brightness/
    │   ├── BLANK.md
    │   ├── brightness-blank.sh
    │   └── BrightCtl.cs
    ├── stocks/BLANK.md
    ├── weather/BLANK.md
    ├── location/BLANK.md        # place/address/POI lookup via OSM Nominatim (map keyword → rich card)
    ├── note/BLANK.md            # keyword add/recall/delete (PROTOTYPE, issue #210)
    ├── hackernews/BLANK.md
    ├── countries/BLANK.md
    ├── crypto/BLANK.md
    ├── dictionary/BLANK.md
    ├── claude-status/BLANK.md
    ├── model/BLANK.md           # "whats my model _" / "list models _" — effective LLM routing, shape-gated
    ├── gh-issues/{BLANK.md,blank.js}
    ├── sentinel/BLANK.md
    ├── loading-animation/BLANK.md # inline loading-animation definition (writes blank-loading-* scalars)
    ├── opencues/BLANK.md        # the settings selector+satellite blank
    └── example/{BLANK.md,time-blank.sh}
```

The `prompt`/`answer`/`affirmations`/`numbers` blanks referenced in older
revisions of this doc no longer exist — `prompt`/`answer` were retired
(their intents now route through FluidBlank/TransformBlank on the
user's configured provider instead of a bespoke Groq-only blank), and
`affirmations`/`numbers` were removed in the same slim-down.

---

## Who reads from `defaults/`

| Consumer | When | What it does |
|---|---|---|
| `opencues seed-configs` | On every invocation (standalone or chained from `opencues install <host>`) | Four phases: (1) **SEED** first-time copy of `OPENCUES.md` + `AUDITORS.md` + the `cues/`/`blanks/`/`auditors/`/`scripts/` folders to `~/.cues/` — preserves non-empty user files; (2) **SYNC** library files (`.sh` / `.cs` / `.ps1`) from `defaults/{blanks,scripts}/` every run — overwrites stale, never overwrites `.md`; (3) **HEAL** re-seed a 0-byte `OPENCUES.md` (the runtime settings file — empty would silently break every runtime-settings read); (4) **COMPILE** colocated `.cs` → `.exe` (WSL only). It never touches `CUES.md`/`BLANKS.md` — those aren't shipped in `defaults/` at all. |
| Chrome `esbuild.config.mjs` | Every `pnpm --filter @opencues/chrome build` | Inlines `defaults/cues/*` and `defaults/blanks/*` into the bundle as `__DEFAULT_*__` constants. The runtime uses these as fallbacks when the bundled `configs/` dir is absent or hasn't been sync'd. |
| `packages/opencues-core/src/cues-md.test.ts` | Unit test | Has `describe` blocks that would read `defaults/CUES.md`/`defaults/BLANKS.md` as real-world fixtures, but both are guarded by `existsSync` and self-skip via `it.skip` since neither file exists today — this coverage is currently dormant, not active. |

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
