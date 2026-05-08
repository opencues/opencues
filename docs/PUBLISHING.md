# Publishing — invariants and procedure

OpenCues packages are published to **GitHub Packages, restricted-access**, against the private `opencues/opencues` repository. Public npmjs.com is NEVER a publish target. This document describes the invariants that guarantee that and the procedure for an actual publish.

## TL;DR

- Every publishable package has `"private": true` in `package.json` *today*. Publishing is blocked at the npm level until that's intentionally removed.
- Every publishable package has `publishConfig.registry` pinned to `https://npm.pkg.github.com` and `publishConfig.access: "restricted"`. Even if `private: true` is removed, the publish target is locked.
- Every publishable package has a `prepublishOnly` hook calling `scripts/prepublish-guard.cjs` which aborts the publish if any invariant fails — **including a live check that the GitHub repo is still PRIVATE**.
- Three independent checks would all need to disable / misconfigure simultaneously for a leak.

## Invariants enforced by the guard (`scripts/prepublish-guard.cjs`)

The guard runs from each package's `prepublishOnly` script. It hard-aborts if any of these fail:

1. **Package name in scope.** Must start with `@opencues/` or be the unscoped `opencues` CLI (which can't publish to GH Packages anyway, providing a second layer of safety).
2. **No `"private": true`.** If set, the guard aborts loudly with a message — it runs *before* npm's own private-package refusal so you see *why*.
3. **`publishConfig.registry === "https://npm.pkg.github.com"`.** Pinned in package.json.
4. **`publishConfig.access === "restricted"`.** GH Packages: only org members can install.
5. **No `--registry` CLI override that bypasses publishConfig.** Inspects `npm_config_argv` for hostile flag.
6. **Effective registry resolves to GH Packages.** Inspects `@opencues:registry` config setting.
7. **GitHub repo `opencues/opencues` is currently PRIVATE.** Calls `gh repo view opencues/opencues --json visibility` and aborts if visibility is anything other than `PRIVATE`.

If any check fails, the guard exits with code 1 and a multi-line ASCII-bordered error message. npm/pnpm aborts the publish.

## Bypass

For the rare case where you intentionally want to publish a public package (e.g. when v1 ships and the repo flips public), the guard can be bypassed:

```bash
OPENCUES_PUBLISH_GUARD_BYPASS=i-confirm-public-leak pnpm publish ...
```

The bypass token is intentionally obnoxious. Don't add it to scripts, CI, or shell aliases. If you find yourself wanting to, that's the signal that the underlying invariant has changed and the guard itself should be updated — not bypassed.

## Publishing procedure (when ready)

> **Today, no package should be published.** This procedure is documented for the future moment when v1 lands.

1. **Pre-flight:**
   ```bash
   gh repo view opencues/opencues --json visibility   # verify PRIVATE
   git status                                           # clean working tree
   pnpm -r run build                                    # all packages build
   pnpm -r run test                                     # all tests pass
   ```

2. **Authenticate against GH Packages.**
   - Generate a PAT (classic) at <https://github.com/settings/tokens> with scopes:
     - `read:packages` (for installing)
     - `write:packages` (for publishing)
   - Store in `~/.npmrc`:
     ```
     @opencues:registry=https://npm.pkg.github.com
     //npm.pkg.github.com/:_authToken=<your_PAT>
     ```

3. **Choose the package(s) to publish.** For an alpha release, typically:
   - `packages/opencues-core` first (no dependencies)
   - `packages/opencues-runtime` second (depends on `@opencues/core`)
   - `integrations/<host>` third (depend on both)

4. **For each package, in order:**
   - Bump version in package.json (`pnpm version patch` / `minor`)
   - **Remove `"private": true`** from that single package's package.json (one-package-at-a-time minimises blast radius if something goes wrong)
   - `cd <package>`
   - `pnpm publish` — guard runs, all invariants validated, publish goes to GH Packages
   - **Re-add `"private": true`** immediately after a successful publish, so the next accidental `pnpm publish -r` doesn't republish

5. **Verify the published package is restricted-access:**
   ```bash
   gh api /orgs/opencues/packages/npm/<package-name> --jq '.visibility'
   # Should print: "private"
   ```

   If this prints `"public"`, **stop everything** — the package is exposed. Yank it: <https://github.com/orgs/opencues/packages>.

## Installing (alpha tester instructions)

Anyone with read access to `opencues/opencues` can install. Setup:

```bash
# Generate a PAT at https://github.com/settings/tokens with `read:packages` scope.
# Then add to ~/.npmrc:
echo "@opencues:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=<YOUR_PAT>" >> ~/.npmrc

# Install
pnpm add @opencues/cli
# Or for a one-shot run
pnpm dlx @opencues/cli install claude-code
```

## What's locked down where

| Layer | Mechanism | Defeats |
|---|---|---|
| **L1** — package can't be published at all | `"private": true` in every package.json | Any `npm publish` / `pnpm publish` |
| **L2** — if L1 removed, publish target is locked | `publishConfig.registry` pinned | Default-to-npmjs.com behaviour |
| **L3** — if L2 misconfigured, guard fails it loud | `prepublishOnly` runs `scripts/prepublish-guard.cjs` | Misconfigured publishConfig, --registry override, scope mismatch |
| **L4** — if guard misses something, repo visibility check | Guard calls `gh repo view ... --json visibility`, aborts on non-PRIVATE | Repo flipped public + L1/L2/L3 all wrong |

For a leak to happen, all four layers would need to fail simultaneously *plus* the human running the command would have had to remove `"private": true` first. The bypass exists but is loud + ugly enough that it doesn't blend into muscle memory.

## When this needs revisiting

- **Repo flips public.** Update the guard's `REPO` constant if the public name changes; consider whether the visibility check should now mean "must be PUBLIC" if the goal flipped.
- **Adding new packages.** Each new publishable package needs the four package.json fields (`private`, `publishConfig.registry`, `publishConfig.access`, `prepublishOnly` script).
- **Switching registry.** If we ever migrate from GH Packages to npmjs.com Pro or Verdaccio, update `ALLOWED_REGISTRY` in the guard and `publishConfig.registry` in every package in lock-step. Don't do these in separate commits — the window between commits is the leak window.

## Why no CI publishing today

Considered and rejected for now. CI-published packages would require a long-lived PAT in repo secrets, which is itself a leak surface (anyone who can read repo secrets can publish anywhere that PAT can publish). Until the publish flow is regular enough to need automation, manual + audited `pnpm publish` from a maintainer's machine is safer.
