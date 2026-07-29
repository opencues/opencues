# npm name handover — placeholder → real CLI

The `opencues` name on npmjs.com is currently held by `packages/opencues-park/` (a minimal "in private beta" placeholder published as v0.0.1). This document is the runbook for handing the name over to the real CLI at public launch.

## Pre-state

- `packages/opencues-park/` is published as `opencues@0.0.1` on the public npm registry.
- Package is owned by the `opencues` npm org via the `developers` team (`npm access grant read-write opencues:developers opencues`).
- `packages/opencues-cli/` holds the real CLI but is `private: true` and its `publishConfig` points to `npm.pkg.github.com`.

## Handover steps

1. In `packages/opencues-cli/package.json`:
   - Remove `"private": true`.
   - Remove the `publishConfig` block (currently `{ "registry": "https://npm.pkg.github.com", "access": "restricted" }`). With it gone, publish defaults to the public npmjs registry; the bare `opencues` name is unscoped, so it publishes public.
   - **Version — set by the release cut, not here.** The product version = the CLI version (see [`versioning.md` § Releases & tagging](../architecture/versioning.md#releases--tagging)). The launch release (`LAUNCH.md` Step 4) sets the CLI to **`0.3.0`** and tags `v0.3.0`; this publish just ships whatever the tag says. It must be `> 0.0.1` to supersede the placeholder — `0.3.0` is. (The original "bump to `0.1.0`" line was stale: the CLI passed 0.2.x, and `0.1.0` sits below both the tag and the current version.)

   The net edit (two deletions, nothing else — leave `name`, `version`, `keywords`, `bin`, etc. as-is):
   ```diff
   {
     "name": "opencues",
     "version": "0.3.0",
   -  "private": true,
     "description": "...",
     "keywords": [ ... ],
     ...
   -  "publishConfig": {
   -    "registry": "https://npm.pkg.github.com",
   -    "access": "restricted"
   -  },
     "dependencies": { "enquirer": "^2.4.1" }
   }
   ```
   > Applied at launch time (not pre-staged) so it doesn't collide with other in-flight `package.json` edits. It's a two-line removal — trivial to make from whatever `master` is at launch.
2. From `packages/opencues-cli/`:
   ```
   npm publish --access public
   ```
   The bare name `opencues` is unscoped, so `--access public` is implicit, but pass it explicitly to be safe. Publisher must be logged in as a member of the `opencues` npm org.
3. Verify on https://www.npmjs.com/package/opencues that v0.1.0 is now the latest and `npm install opencues` pulls the real CLI.
4. Delete `packages/opencues-park/` from the repo (the published v0.0.1 stays on npm forever as a historical version, but the source is no longer needed).
5. Remove the pointer to this file from CLAUDE.md's pre-launch checklist.

## Caveats

- **v0.0.1 can never be reused** — npm permanently consumes versions. Don't unpublish the placeholder before publishing the real v0.1.0; there's a 24-hour name lockout after unpublish that would block the handover.
- **2FA + security-key gotcha**: the npm account currently administering the org (`wkasekende`) has security-key 2FA. Org-write commands (`npm access grant`, `npm owner add/rm`) don't accept security-key auth — they only take TOTP codes. To run those, either:
  - Temporarily flip "Require 2FA for write actions" off in account settings (then back on), or
  - Add a TOTP authenticator app as a secondary 2FA method.
  Regular `npm publish` works fine with the security key via `--auth-type=web`.

## Other pre-launch items (not handled here)

The CLAUDE.md pre-launch section also tracks markdown files to remove or gitignore and the LICENSE switch. Those are independent of the npm handover and live in CLAUDE.md directly.
