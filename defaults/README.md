# defaults/

Shipped defaults — the source-of-truth for every cue / blank /
auditor / config the standard installation comes with. **Three
consumers read this directory**, and the single-source-of-truth
pattern is what keeps them in sync.

## The three consumers

1. **`opencues seed-configs`** — first-time copy when a user installs
   any integration. Copies `defaults/{OPENCUES,CUES,BLANKS,AUDITORS}.md`
   + every `cues/<name>/CUE.md`, `blanks/<name>/BLANK.md`,
   `auditors/<name>/AUDITOR.md` (+ any colocated scripts) into
   `~/.cues/`. Idempotent — preserves user edits, heals 0-byte files,
   refreshes contract fields without clobbering user fields.
2. **Chrome bake-time bundle** — `integrations/chrome/esbuild.config.mjs`
   inlines `defaults/cues/*`, `defaults/blanks/*`, and
   `defaults/CUES.md` into the extension bundle as
   `__DEFAULT_*__` constants. The extension uses these as fallbacks
   when the live `chrome.storage.local` sync hasn't run yet.
3. **`@opencues/runtime` bootstrap fallbacks** — when a host launches
   with no `~/.cues/` yet (fresh install, before seed-configs runs),
   the runtime can fall back to the shipped defaults rather than
   degrading to empty config.

Adding a new shipped default is one PR: drop a folder under
`defaults/cues/` (or `blanks/` or `auditors/`), commit. The next
`opencues install` will copy it; the next chrome rebuild will
inline it.

## Layout

```
defaults/
├── OPENCUES.md                runtime settings master (voice-mode, llm-provider, etc.)
├── CUES.md                    cue-surface master (project metadata, ignore[], disable[])
├── BLANKS.md                  blank-surface master
├── AUDITORS.md                auditor-surface master
├── IDENTITY.md                   identity-context template (personal-data fields for identity-context-mode)
├── cues/                      shipped cue sources
│   ├── tips-<host>/CUE.md     local-tip lookups (no LLM — ultrathink → Tab etc.)
│   ├── spelling/CUE.md        catch-all spelling correction
│   ├── more-formal/CUE.md     scope:sentence — informal → formal rewrites
│   ├── calendar/CUE.md        scope:sentence — calendar-conflict flag
│   └── example/CUE.md         minimal walkthrough cue (copy + edit)
├── blanks/                    shipped blanks
│   ├── volume/                system volume — script + .cs source
│   ├── brightness/            screen brightness — script
│   ├── weather/, stocks/, … runtime-class blanks (LLM/HTTP)
│   ├── opencues/              the opencues settings selector+satellite blank
│   └── example/               minimal walkthrough blank (copy + edit)
├── auditors/                  shipped auditors
│   ├── grammar/AUDITOR.md     inline grammar fix
│   ├── clarity/AUDITOR.md     inline clarity rewrite
│   └── ...
├── scripts/                   shared shell helpers (speak.sh, statusline.sh)
└── user-blank.d.ts            TypeScript ambient types for user-shipped JS blanks
```

## Distinguishing audiences

- **Standard normative content** — the contracts in `OPENCUES.md`,
  `CUES.md`, etc. are anchors for the spec at `spec/`. Removing one
  is a breaking change.
- **Shipped example content** — `cues/spelling/CUE.md`,
  `blanks/volume/`, the auditor prompts. Quality matters but
  individual entries can be re-tuned without breaking the standard.
- **Walkthrough packs** — `cues/example/CUE.md` and
  `blanks/example/` are deliberately tiny copy-and-edit references
  with field-by-field inline comments. Keep them ~30-70 lines.

See [`docs/features/shipped-defaults.md`](../docs/features/shipped-defaults.md)
for the full lifecycle (when each consumer reads, when the seed
healing runs, how new fields get backfilled into older user
installs).
