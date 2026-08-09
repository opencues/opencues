# Versioning policy

Until May 2026 every internal package sat at `0.1.0` regardless of what landed — the version field was inert. That stops now. Going forward, treat versions as load-bearing and bump them on every shipping change.

## Semver, applied per package

- **`0.x.y` = pre-stable.** Minor (`0.1 → 0.2`) for breaking changes; patch (`0.1.0 → 0.1.1`) for additive features, fixes, and refactors that preserve the public API. We expect to stay <1.0 across all packages until the first public launch.
- **`1.0.0` = first stable.** The first version a package is committed to publish with API stability guarantees. Don't reach for it before then. After 1.0, standard semver: major for breaking, minor for additive, patch for fixes.

## When to bump, by package class

- **`@opencues/core`** — bump on any source change that ships externally (resolver behaviour, source classes, parsers, registry shape, SPEC parser surface). The version is what hosts and external readers will depend on.
- **`@opencues/runtime`** — bump on any change to public exports, the `HostAdapter` contract, render-directive shape, state-class shape, or per-host adapter band. Per-host bands count: a CC-only fix that doesn't touch shared modules still bumps runtime.
- **Integration packages** (`@opencues/claude-code`, `chrome`, …) — bump when *the integration's own code* changes (patch source, host shim, bootstrap). Don't bump just because core/runtime did — the integration picks up the new versions via its `dependencies` field and the version there reflects integration-level work.
- **`opencues` CLI** (`packages/opencues-cli`) — bump on any change to the command surface, install flow, or `seed-configs` behaviour.
- **`SPEC_VERSION`** (the cues-spec, exported from `@opencues/core`) — bumps independently of packages. Only move when the wire format of `CUES.md` / `CUE.md` / `BLANK.md` / `OPENCUES.md` / `AUDITORS.md` changes, or when a documented frontmatter key is added/removed/repurposed. Implementation-detail refactors in the parsers don't bump the spec. See `SPEC.md` for the spec definition.

## Discipline

- Bump the version in the **same commit/PR** as the change. Don't batch bumps separately — that disconnects the version from the diff that motivated it and makes git blame less useful for "when did X become available?"
- When `@opencues/core` or `@opencues/runtime` bumps, integrations that depend on it update their `dependencies` field in the same PR (or the next one) so versions don't drift in lockfiles.
- **Update the changelog in the same PR as the version bump.** The root `CHANGELOG.md` has an `[Unreleased]` section for accumulating changes; spec-affecting changes also land an entry under `spec/CHANGELOG.md`. Without an entry the version bump is opaque — readers six months later have to grep PRs to learn what changed. The version field says *what* version; the changelog says *why*. They ship together.
- The version snapshot table in CLAUDE.md will go stale fast. Regenerate it with the one-liner whenever versions matter for context; don't treat the literal table as ground truth.

## Which changelog when

Two changelogs, with clear scopes:

| Changelog | Covers |
|---|---|
| `CHANGELOG.md` (root) | Every shipping change across the monorepo — `@opencues/core`, `@opencues/runtime`, the CLI, every integration. The `[Unreleased]` section accumulates entries between releases; cut a release by promoting it to a dated version heading. |
| `spec/CHANGELOG.md` | Only changes to the open standard (`spec/` — cue / blank / auditor / core schemas). A spec entry is required when `SPEC_VERSION` bumps, when a documented frontmatter key is added/removed/repurposed, or when wire-format behaviour changes. Implementation refactors that preserve the spec don't need an entry. |

A single PR can land entries in both. If unsure whether a change is spec-affecting, default to root-only — drift is easier to catch when entries are duplicated than when one is missing.

## What makes a good changelog entry

- **Lead with the user-visible name** of the thing that changed, bolded. Not a PR number, not a file path. Examples: "Three-bucket LLM routing", "`opencues doctor` LLM routing section", "`applyOpencuesScalar` race on back-to-back disk writes".
- **One sentence on what it does**, one on **why it matters** if not obvious. Cross-link to the architecture doc when there is one.
- **Group by Keep-a-Changelog category** (`Added` / `Changed` / `Fixed` / `Removed` / `Deprecated` / `Security`). Bump-only entries (versions moving without functional change) go under `Changed`.
- **No PR / issue numbers** in the entry itself — git blame on the changelog gives the PR; the entry should make sense without one. (Exceptions: when a fix specifically references a prior incident PR for context, that's fine.)
- **Past tense, plain prose.** "Added X" / "Fixed Y" / "Renamed A → B."

## Releases & tagging

Per-package versions (above) track *what changed in each package*, PR by PR. A
**release** is the separate, higher-level act of cutting a user-facing version
of OpenCues as a whole. Package bumps happen every PR; releases happen on a
cadence.

### One user-facing version

Users don't see `@opencues/core@0.40.2` — they see "OpenCues `vX.Y.Z`". Keep
**one** product version, and make three things equal at every release:

- the **git tag** — `vX.Y.Z`
- the **GitHub Release** — `vX.Y.Z`
- the **`opencues` CLI** version — what `npm i opencues` resolves to

The CLI is the installable artifact, so **the product version IS the CLI's
`package.json` version**. The other packages (`core`, `runtime`, integrations)
keep versioning independently underneath — they're implementation detail and
will sit at different, usually higher, numbers (`core` at `0.40` while the
product is at `0.3` is fine and expected). Don't try to sync them.

### Tag scheme

- **`vMAJOR.MINOR.PATCH`**, `v`-prefixed (`v0.3.0`). Nothing else.
- Pre-1.0: **minor** = a notable feature batch or any breaking change; **patch**
  = fixes and small additions.
- The old date-checkpoint tags (`v2026.06.25`) are **retired** — historical
  only. Don't add more.

### When to cut a release

- **On a meaningful batch** — a shipped feature, a fix users are waiting on, a
  new integration/provider, a spec bump, or a security fix. Roughly weekly if
  changes have accumulated.
- **Not every PR** (tag noise) and **not never** — a neglected `[Unreleased]`
  balloons (it hit 800 lines once between April and July 2026; don't repeat
  that). If `[Unreleased]` is more than a screen or two long, you're overdue.

### How to cut a release

⚠ **Five surfaces ship a release, not one.** npm, the git tag, the GitHub
release, the Homebrew tap and opencues.com. Miss one and users get a
half-release that looks fine from wherever you happened to be standing: the
v0.6.0 cut (Aug 2026) tagged before the release commit merged, published with
`npm publish -w` (which cannot work here), and inherited a Homebrew formula that
had been stale since the release before. Work the checklist top to bottom.

**Before you start**

- [ ] `npm whoami` returns your user. A 401 here is the publish failing later
      for a reason that has nothing to do with the release.
- [ ] `docker ps` works, or accept that step 6's verification gate will be
      skipped (say so in the release notes rather than pretending it ran).
- [ ] `bash scripts/pre-pr.sh` is as green as it gets on your machine, and you
      know which failures are environmental.

**1. Pick the version**

- [ ] Bump from the **last release** per semver — `git tag --sort=-v:refname | head -1`.
- [ ] Check `packages/opencues-cli/package.json`. Per-PR bumps often push it
      **past** the last release; if it is already at a sane number, release
      THAT and skip the intervening ones (semver allows the skip). Never edit
      it downward just to make the sequence tidy.
- [ ] The published CLI pins its own repo checkout to its version tag, so
      version = tag = npm = what users clone. Keep the three identical.

**2. The release commit**

- [ ] `packages/opencues-cli/package.json` `version` → `X.Y.Z`.
- [ ] `CHANGELOG.md`: rename `## [Unreleased]` → `## [X.Y.Z] - YYYY-MM-DD`,
      add a fresh empty `## [Unreleased]` above it.
- [ ] `git commit -m "chore(release): vX.Y.Z"` on a `chore/release-vX.Y.Z`
      branch, PR it, **merge it**.

**3. Tag — AFTER the merge, never before**

- [ ] `git checkout master && git pull` first. Tagging the pre-merge tip
      produces a tagged tree whose CHANGELOG still says `[Unreleased]`, which
      is what every `npm i -g opencues` user then clones.
- [ ] `git tag -a vX.Y.Z -m "OpenCues vX.Y.Z" && git push origin vX.Y.Z`
      (annotated, matching the existing tags).

**4. Publish the CLI**

- [ ] `cd packages/opencues-cli && npm publish`. **Not** `npm publish -w
      packages/opencues-cli` — this is a pnpm workspace and the root
      `package.json` has no npm `workspaces` field, so `-w` resolves nothing.
- [ ] The `prepublishOnly` guard runs here. It lets the unscoped `opencues`
      through to public npmjs precisely because it has no `publishConfig`, and
      refuses every `@opencues/*` library. A guard failure is the guard
      working; read it before reaching for the bypass.
- [ ] `timeout 30 npm view opencues version` says `X.Y.Z`.

**5. GitHub release**

- [ ] `gh release create vX.Y.Z --title "OpenCues vX.Y.Z" --notes-file <notes>`.
- [ ] Notes are curated, not dumped — see the next section.

**6. Verify the publish**

- [ ] `bash scripts/check-npm-fresh-install.sh` — a cold install in a pristine
      container, with the fetch pinned to the new tag. **A publish is not
      verified until this is green.** Needs the Docker daemon.

**7. Homebrew tap** (`opencues/homebrew-opencues`, `Formula/opencues.rb`)

THREE lines change, and the third is the one that gets forgotten:

- [ ] `url` → the new registry tarball
      (`npm view opencues@X.Y.Z dist.tarball`).
- [ ] `sha256` → `curl -sL <tarball-url> | sha256sum`. Compute it from what
      the registry is actually serving; never copy it from anywhere.
- [ ] `assert_match "X.Y.Z"` in the `test do` block. This was stale for two
      releases (still asserting 0.4.1 while the formula moved on), so the test
      was passing against a version the formula did not ship.
- [ ] Branch + PR + merge, same as every other opencues repo.
- [ ] The brew channel serves whatever the formula pins. Skipping this leaves
      brew users on the previous release with no signal that they are behind.

**8. The website** (`~/opencues-website`, repo `opencues/opencues-web`)

**A release is not DONE until this has merged**, and it is usually already half
written: the site often carries a PROVISIONAL entry for the unreleased wave.

- [ ] `md/population/changelog.md`: if a provisional entry exists, rename its
      heading to `# vX.Y.Z` and replace `# current date` with the real date
      (`# 9th AUG 2026` format). If not, write the entry — benefit-first
      bullets under `# TITLE / vN-anchor` headers, in the site's voice, not
      the raw CHANGELOG's.
- [ ] Rename the section anchors to track the real version (`v43-*` → `v60-*`)
      after checking nothing links to the old ones.
- [ ] New capability → a features-page block and usually an FAQ page (that has
      its own checklist in the website CLAUDE.md: hub fold, FAQPage +
      BreadcrumbList JSON-LD, meta description, canonical, sitemap entry).
- [ ] **`SPEC_VERSION` moved since the last release?** Then
      `md/population/open-standard.md` needs BOTH its version strings and the
      **new surface described**. A version bump with no prose is how that page
      spent two spec versions claiming to be current while documenting a
      one-axis scoping model. Check it against `spec/CHANGELOG.md`, not against
      the number.
- [ ] `python3 scripts/update-sitemap-lastmod.py`.
- [ ] Update the website CLAUDE.md "Last synced" line, naming what is still owed.
- [ ] Branch + PR + merge. **Merging is what deploys the site.**

**9. After the deploy lands**

- [ ] Cloudflare Pages check on the merge commit says success.
- [ ] `curl -s -o /dev/null -w '%{http_code}' -L <a new URL>` returns 200.
      The first request to a brand-new path can 404 on a cold edge — retry
      before believing it.
- [ ] `python3 scripts/indexnow-submit.py` (Bing / DuckDuckGo / Yandex).
      Google has no push API; the refreshed lastmod dates do that job.

**10. Close the loop**

- [ ] `opencues install <host>` on your own machines, or they keep running the
      pre-release bundle. `opencues doctor` names every stale one.

### Release notes are curated, not dumped

The GitHub Release body is a **curated highlight of the changelog section**, not
its raw entries. Pick the ~8–12 changes a user actually cares about, lead with
the headline features, group by Added / Fixed / …, and link to the docs. The
full per-package detail stays in `CHANGELOG.md`; the release notes are the
trailer, not the script. (This is also why changelog entries should stay
skimmable — see "What makes a good changelog entry" above.)

### SPEC_VERSION stays decoupled

The open-standard version (`SPEC_VERSION` + `spec/CHANGELOG.md`) has its **own**
cadence and is never folded into the product tag — a product release can ship
with no spec change, and a spec bump can land mid-cycle. Keep them separate. See
the SPEC-bump checklist in CLAUDE.md.

## Why this matters here specifically

OpenCues ships as multiple bundled copies (CC fork's `node_modules/`, chrome's bake bundle, OC's `node_modules/`, etc.). When source has a fix but one bundled copy is stale, debugging is brutal because every copy claims the same `0.1.0`. Real version bumps make "is this build current?" answerable by `cat package.json` instead of by inspecting the resolver internals.

This is also one of the recurring failure modes called out in CLAUDE.md's "Rebuild EVERY fork after a runtime/core fix" rule — version bumps make the rebuild gap detectable.
