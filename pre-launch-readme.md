# Pre-Launch TODO

Checklist for open-sourcing OpenCues. Items marked "cannot do now" require manual setup outside the codebase.

---

## Community & Social (cannot do now)

- [ ] Create Discord server — community hub for support, feedback, feature requests
- [ ] Add Discord invite link to README — after "Contributing" section
- [x] Create Twitter/X account — [@openCues_](https://x.com/openCues_)
- [ ] Record demo GIF/video — 30s clip showing navigation, cycling, blanks, controls
- [ ] Add demo GIF to README — below the tagline, before "The Standard"

## GitHub Project Setup (cannot do now)

- [ ] Choose open-source license — currently proprietary (`LICENSE`). Switch to MIT/Apache 2.0/GPL
- [ ] Update `LICENSE` file and README "License" section
- [ ] Add `CODE_OF_CONDUCT.md` — Contributor Covenant or similar
- [x] Create `.github/ISSUE_TEMPLATE/` — bug report + feature request templates
- [x] Create `.github/PULL_REQUEST_TEMPLATE.md`
- [ ] Add GitHub Actions CI — at minimum: `npm run build` on PR for cues-core
- [ ] Add README badges — license, build status, Discord, npm version
- [ ] Transfer repo or create org — currently `wkasekende/opencues`, consider `opencues/opencues`
- [ ] Enable GitHub Discussions — for Q&A, ideas
- [ ] Add `SECURITY.md` — responsible disclosure policy

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

## Package Publishing (future)

- [ ] Publish cues-core to npm — `@opencues/core` or similar
- [ ] Add `package.json` version field — semantic versioning
- [ ] Add `CHANGELOG.md` — track releases

## Pre-Launch Audit

- [x] Audit for secrets — no hardcoded keys found; `.claude/` with personal paths is not tracked
- [ ] Review git history — squash or clean commits with sensitive data
- [ ] Test clean install — clone on fresh machine, follow README exactly
- [x] Verify all doc links — zero broken links across 68 markdown files
