# LAUNCH.md — go-live runbook

Turnkey sequence for taking OpenCues public. Ordered; each **Go-live** step
assumes the ones above it are done. Internal ops doc — **delete or gitignore
this file after launch** (see Phase 3).

> **One-way gate:** publishing the repo exposes all history. Rotate secrets
> **before** flipping (Step 1) — you can flip visibility back to private, but
> anything the public saw is out. Treat go-public as irreversible for secrets.

Companion: [`npm-handover.md`](npm-handover.md) (the npm publish detail).

---

## Phase 0 — Pre-flight (finish BEFORE the flip)

Everything here can be done while the repo is still private.

- [ ] **Merge [opencues#353](https://github.com/opencues/opencues/pull/353)** — niche-cue removal + Sponsors handle (`FUNDING.yml`) + npm `keywords`. (The Sponsor button needs `FUNDING.yml` on `master`.)
- [ ] **Merge [opencues#354](https://github.com/opencues/opencues/pull/354)** — npm-handover runbook fix + this file.
- [ ] **Merge [opencues-web#19](https://github.com/opencues/opencues-web/pull/19)** — website niche-cue cleanup + homepage title SEO. Deploy the site.
- [ ] **Final brand art** landed — designer swaps the placeholder SVGs under `assets/` (see the `README.md` top comment). Filenames stay; only the art changes.
- [ ] **Hero + quickstart demo videos** produced and embedded in `README.md` (3 `<!-- VIDEO -->` placeholders).
- [ ] **Sponsors listing approved** — check `github.com/sponsors/opencues` no longer says *"coming soon"* (submitted; GitHub-side review).

---

## Phase 1 — Go public (the flip, in order)

### 1. Rotate secrets
Both keys live only in gitignored `.env` files (audited: never committed), so this is precautionary — but do it first.
```bash
# Groq:    https://console.groq.com/keys   → revoke old, create new
# Finnhub: https://finnhub.io/dashboard    → revoke old, create new
# Update the new values in the gitignored .env files:
#   ~/.cues/.env  and  integrations/chrome/.env
```

### 2. Flip repo visibility → public
```bash
gh repo edit opencues/opencues --visibility public --accept-visibility-change-consequences
```

### 3. Upload the social-preview image
GitHub only shows this control on a **public** repo:
> Repo → **Settings** → **General** → scroll to **Social preview** → **Edit** → upload `opencues-og.jpg` (1200×630, on your desktop).

### 4. Cut the `v0.1.0` GitHub Release
```bash
# Draft notes from CHANGELOG.md, then:
gh release create v0.1.0 --repo opencues/opencues \
  --title "OpenCues v0.1.0" --notes-file <notes.md>
```

### 5. README assets → jsDelivr-on-own-repo
Now that the repo is public, jsDelivr can serve it. Swap the `a1rtight/tester`
jsDelivr URLs in `README.md` for your **own** repo (keeps CDN speed, drops the
third-party dependency — see the memory/rationale: relative paths render slower
on GitHub, so keep jsDelivr, just point it at us):
```
https://cdn.jsdelivr.net/gh/opencues/opencues@v0.1.0/assets/<file>.svg
```
(Do this after Step 4 so the `@v0.1.0` tag exists.) Ship as a small README PR.

### 6. Deploy the full org-profile
Swap the teaser for the full version (its repo/docs/spec links resolve now):
```bash
# In opencues/.github:
gh pr create --repo opencues/.github --base main --head launch/full-profile \
  --title "Full org profile" && gh pr merge --repo opencues/.github launch/full-profile --squash
# (branch launch/full-profile is already pushed, unmerged)
```

### 7. npm handover — publish the real CLI
Full detail + 2FA/security-key gotcha in [`npm-handover.md`](npm-handover.md).
```bash
# In packages/opencues-cli/package.json: remove `"private": true` and the
# `publishConfig` block. Version 0.2.57 stays (already > placeholder 0.0.1).
cd packages/opencues-cli
npm publish --access public          # logged in as an opencues npm-org member
# Verify: https://www.npmjs.com/package/opencues shows 0.2.57 as latest
```
Then wire the **npm badge** in `README.md` (uncomment the badge line near the top).

---

## Phase 2 — Announce (post-live, optional)
- Show HN (Show HN: …), Product Hunt, r/ClaudeAI, `awesome-*` list PRs, alternativeto.net.
- Website changelog sync (opencues.com is maintained separately — ping Wilfred).

---

## Phase 3 — Post-launch cleanup
- [ ] Delete `packages/opencues-park/` (source only — the published `0.0.1` stays on npm as history).
- [ ] Remove the npm-handover pointer + the "Pre-launch" section from `CLAUDE.md`.
- [ ] Delete or gitignore **this file** (`docs/launch/LAUNCH.md`).

---

## Caveats / rollback
- **npm `0.0.1` can never be reused** — don't unpublish the placeholder before the real publish succeeds (24h name lockout).
- **Sponsors org-write needs TOTP**, not the security key (`wkasekende` has security-key 2FA). See `npm-handover.md` § Caveats.
- Repo visibility is reversible, but exposed secrets are not — hence Step 1 first.
