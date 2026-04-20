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
- [ ] Record demo GIF/video — 30s clip showing navigation, cycling, blanks, controls
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
- [x] Verify all doc links — zero broken links across 68 markdown files
