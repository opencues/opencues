# Pre-Launch TODO

Checklist for open-sourcing OpenCues. Items marked "cannot do now" require manual setup outside the codebase.

---

## Community & Social (cannot do now)

- [ ] Create Discord server — community hub for support, feedback, feature requests
- [ ] Add Discord invite link to README — after "Contributing" section
- [x] Create Twitter/X account — [@openCues_](https://x.com/openCues_)
- [x] Create Reddit — [r/OpenCues](https://www.reddit.com/r/OpenCues/) (private until launch)
- [x] Contact email — hello@opencues.com
- [ ] Website — opencues.com (not yet live)
- [ ] Record demo GIF/video — 30s clip showing navigation, cycling, blanks (typed + fluid)
- [ ] Add demo GIF to README — below the tagline, before "The Standard"

## GitHub Project Setup (cannot do now)

- [ ] Choose open-source license — currently proprietary (`LICENSE`). Switch to MIT/Apache 2.0/GPL
- [ ] Update `LICENSE` file and README "License" section
- [x] Add `CODE_OF_CONDUCT.md` — Contributor Covenant v2.1
- [x] Create `.github/ISSUE_TEMPLATE/` — bug report + feature request templates
- [x] Create `.github/PULL_REQUEST_TEMPLATE.md`
- [ ] Add GitHub Actions CI — at minimum: `pnpm build` + `pnpm test` on PR (turbo caches across packages). Part of **Stage 8** of the repo re-org — see [docs/architecture/repo-structure.md](docs/architecture/repo-structure.md#stage-tracker).
- [ ] Add README badges — license, build status, Discord, npm version
- [x] Transfer repo or create org — now at `opencues/opencues` (private until launch)
- [ ] Enable GitHub Discussions — for Q&A, ideas
- [x] Add `SECURITY.md` — responsible disclosure policy

## Marketing / Brand Communication

- [ ] **Finalise OpenCues messaging across CLI + README + docs** — tagline, one-liner, "what is OpenCues" pitch are still placeholder/scratch. Audit every user-facing surface for consistent voice:
  - CLI `help` banner tagline (currently: "LLM cues and `_`-gated blanks for any editor.")
  - CLI `version` / `install` banners
  - README hero + "Why OpenCues?" + "Supported Editors" sections
  - Per-integration READMEs (`integrations/*/README.md`)
  - `package.json` `description` fields (drives `npm` listings + `opencues help` first line until banner replaced it)
  - Per-host installer help text
  - Glossary one-liners (`docs/glossary.md`)
  - GitHub repo description + topics
  - Discord/Twitter/Reddit bios once finalised
  Treat as one pass after the messaging is locked, not piecemeal.

## README Improvements

- [x] Add badge area at top (license, build, Discord) — placeholders added, commented out
- [x] Add screenshot/GIF placeholder — `<!-- ![Demo](assets/demo.gif) -->`
- [x] Add "Why OpenCues?" section — what problem it solves, why an open standard
- [x] Add "Supported Editors" table — Claude Code (done), VS Code (planned), Chrome (planned)
- [x] Update License section — TODO comment added, awaiting license choice
- [x] Add "Community" section — placeholder added, commented out
- [ ] Add "Star History" widget — social proof for discovery

## Documentation

- [x] Add `docs/guides/quickstart.md` — 5-minute getting started (simpler than full README)
- [x] Review `CONTRIBUTING.md` for open-source — added "good first issues" section + contributor expectations
- [ ] Add architecture diagram image — replace ASCII art with SVG/PNG

## Package Publishing — Stage 8 of the repo re-org

See [docs/architecture/repo-structure.md](docs/architecture/repo-structure.md) for the target shape. Most of the structural work (scoped names, per-integration `package.json` with version + compatibility metadata, `bin` entries, install scripts) is already done — Stage 8 wires the actual publish pipeline on top.

- [x] Adopt `@opencues/*` npm scope (Stage 4a)
- [x] Per-integration `package.json` with `version` + `compatibility` (Stage 2)
- [x] `bin/install.cjs` + `bin` field in each integration (Stage 6′) — works as `pnpm --filter @opencues/X dev-install` today; becomes `npx @opencues/X` post-publish without code changes
- [x] `files: [...]` whitelist in each integration's `package.json` to control what gets bundled (Stage 6′)
- [ ] **Stage 8 — Choose Changesets vs hand-managed versions.** Changesets is mainstream (shadcn/ui uses it) but adds overhead for a small project. Hand-managed `npm version patch` per integration works fine until automated changelogs become valuable.
- [ ] **Stage 8 — Set up GitHub Actions release workflow** with OIDC publish to npm (no token management). Triggered by changeset version PR merge OR by manual `pnpm release`.
- [ ] **Stage 8 — Drop `private: true`** from each integration's `package.json` and from `@opencues/core` / `@opencues/runtime`. Run `pnpm publish --access public` (first time) for each scoped package.
- [ ] **Stage 8 — Update top-level README** to lead with `npx @opencues/claude-code` (and `oc`/`chrome`) as the primary install path; current `pnpm --filter ... dev-install` becomes the contributor fallback.
- [x] Add `package.json` version field — v0.1.0 (pre-release) across all packages
- [x] Add `CHANGELOG.md` — v0.1.0 initial pre-release with all 18 features (per-package CHANGELOGs land with Changesets in Stage 8)

## Pre-Launch Audit

- [x] Audit for secrets — no hardcoded keys found; `.claude/` with personal paths is not tracked
- [ ] Review git history — squash or clean commits with sensitive data
- [ ] Test clean install — clone on fresh machine, follow README exactly
- [ ] Verify all doc links — last clean pass found zero broken links across 68 markdown files, but several new docs have landed since (user-context, ambient-context, universal-integration, chrome-llm-keys, plus per-feature summaries). Re-run before launch.
- [ ] **Build a feature registry to kill install-boundary drift.**
  Today the set of optional features (their scalars, their config
  prerequisites, which host script must push them) is encoded
  separately in `packages/opencues-runtime/src/modules/config-loader.ts`
  (scalar enum + parsing), `integrations/chrome/host/host.cjs` (file
  push list), `packages/opencues-cli/src/commands/doctor.cjs` (the
  feature-wiring section), and `packages/opencues-cli/src/commands/seed-configs.cjs`
  (which files to copy). Adding a feature requires editing all four.
  We've already hit two drift bugs from this — USER.md not pushed by
  host.cjs, and doctor's hardcoded scalar list staying valid only as
  long as someone remembers. Replace with a single
  `packages/opencues-core/src/feature-registry.ts` declaring each
  feature's scalar / default / prereq file / required-fields-test /
  pushedBy hosts; have all four sites import from it. New feature =
  one PR touching the registry; impossible for the sites to drift.

- [ ] **Add chrome e2e install-chain harness.** Every "go test"
  cycle during the user-context + ambient-context ship (May 2026)
  hit a hidden defect at an install-boundary join — USER.md not
  pushed by chrome-host, template frontmatter in wrong position,
  ConfigLoader silent on missing files, DynDefs leaking across
  buffers. Unit tests covered each component in isolation (35 for
  user-context, 23 for ambient, etc.) but the *path from filesystem
  → chrome-host → chrome.storage → ConfigLoader → Resolver → LLM*
  has never been exercised by a single test. `opencues doctor` now
  surfaces the join state statically, but a runtime e2e would
  prove the chain is wired end-to-end.
  - Spawn the chrome-host process (`host/host.cjs`) against a
    temp `.cues/` containing OPENCUES.md + USER.md + AUDITORS.md.
  - Stand up a fake chrome.storage shim that captures pushes.
  - Boot the runtime against a fake DOM with a focused `<input>`.
  - Assert: the host pushed every expected file; ConfigLoader read
    USER.md and parsed the scalar; an `_` keypress triggers a
    FluidBlank call that includes the user-context catalog.
  - One slow test, but it would have caught all four defects in a
    single run instead of four back-and-forth rounds. Eats into
    integration-test budget; worth it because the install boundary
    is exactly where unit tests can't reach.

## Shipped-defaults curation

- [ ] **Decide the default blank set for v0.1.** Today we ship 14
  blanks under `defaults/blanks/` (affirmations, answer, brightness,
  claude-status, countries, crypto, dictionary, gh-issues, hackernews,
  opencues, prompt, stocks, volume, weather). Some are demo-ish or
  niche and probably shouldn't be the user's first impression.
  - `prompt` — likely drop. Improver only useful for Claude/Cursor
    contexts and ships its own LLM call; overlaps with TransformBlank.
  - `affirmations` — drop or move to an example pack.
  - `gh-issues` — drop or gate behind a setup step (needs PAT).
  - `hackernews` / `crypto` — keep or move? Demo-feeling.
  - Keep: weather, dictionary, countries, answer, claude-status,
    volume, brightness, stocks (with key), opencues, plus runtime
    blanks (fluid + transform).
  - Decide and prune `defaults/blanks/<name>/` accordingly. Removed
    blanks can move to a `samples/` pack or live in CONTRIBUTING.md
    as "starter kit ideas".

- [ ] **Decide chrome TS-class fallback** (Option A vs B in
  `integrations/chrome/CLAUDE.md` § Pre-launch decision). If we drop
  the fallback, the curated default-blank set above is what gets
  baked into the extension for first-run-without-host.
