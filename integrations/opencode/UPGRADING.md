# Upgrading the OpenCode pin

This is the runbook for moving the OpenCode integration from one upstream
SHA to another. It's the workflow that produced the v1.4.11 → v1.4.14 bump
in May 2026 — the first multi-version exercise — and is the path every
future bump should follow.

## Prerequisites

- A clean worktree of the OpenCues repo. Don't do this on a branch with
  unrelated work-in-progress; the fork-side state changes are easier to
  reason about in isolation.
- The OpenCode fork at `~/.opencues/forks/opencode/` (or wherever `--target` points).
  If it doesn't exist, install will clone fresh and most of the dance
  below collapses.

## The dance

### 1. Pick the target SHA

```bash
git ls-remote --tags --refs https://github.com/sst/opencode | tail -10
```

Prefer a tagged release over `HEAD` — tags are reproducible and the
upstream's own release process gates them. Resolve the tag's SHA:

```bash
git ls-remote https://github.com/sst/opencode refs/tags/v1.4.14
```

### 2. Diff the patch surface against the current pin

The integration patches four files in the fork. Before bumping, confirm
upstream hasn't moved or rewritten them:

```bash
cd ~/.opencues/forks/opencode
git fetch origin <new-sha>
git diff <old-sha>..<new-sha> -- \
  packages/opencode/src/cli/cmd/tui/app.tsx \
  packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx \
  packages/opencode/src/cli/cmd/tui/feature-plugins/home/footer.tsx \
  packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/footer.tsx
```

**Three outcomes:**

- **Empty diff.** Patches will apply byte-identically. Proceed to step 3.
- **Cosmetic drift** (whitespace, nearby unrelated edits). The python
  string-replace patcher is line-anchored — if the anchor strings still
  appear verbatim, patches still apply. Test in step 6.
- **Anchor strings moved or rewritten.** You'll need to port the patches.
  Open `integrations/opencode/patches/setup.sh`'s `patch_*_tsx` functions
  and update the anchor strings. The `git diff` you just ran is your
  reference.

### 3. Update the pin

Three small edits, one source of truth:

- `integrations/opencode/pin.json` — `{ "version": "<new>", "sha": "<short-new>" }`
- `integrations/opencode/compat.json` — **append** an entry to `tested[]`,
  don't replace. The array is the historical record of every SHA we've
  proven; pruning it loses information.
- `integrations/opencode/README.md` — the "Compatible with" line in the
  table at the top.

Adjacent docs that should track but aren't load-bearing:
- `README.md` (repo root) — the heads-up paragraph in `## Install`.
- `packages/opencues-runtime/adapters/oc/REPAIR.md` — the pin string at
  the top.

The fork's `hostVersion` is templated from `pin.json` at install time
(see `setup.sh` `patch_app_tsx`), so it tracks automatically. Don't
hand-edit it.

### 4. Uninstall the old patches

```bash
opencues uninstall opencode
```

This reverts all four patched files via `git checkout --`, removes the
injected `opencues.ts` bootstrap, and clears `node_modules/@opencues/*`.
**Important:** if uninstall doesn't list all four patched files in its
plan, `bin/install.cjs`'s `pathsForFork().patched` array is out of sync
with `setup.sh`'s `patch_*_tsx` functions — fix that first or the leftover
edits will block step 5's `git checkout`.

### 5. Move the fork to the new SHA

```bash
cd ~/.opencues/forks/opencode
git fetch origin <new-sha>
git -c advice.detachedHead=false checkout <new-sha>
# bun install runs automatically as part of step 6 — no need here
```

If the checkout complains about local changes, something from step 4
got missed. `git status --short` will show what; revert manually with
`git checkout -- <file>` and re-try.

### 6. Reinstall

```bash
opencues install opencode
```

Five steps run: fork-presence check, `bun install` (deps refresh for the
new SHA), build core + runtime, copy artefacts into the fork's
`node_modules/`, apply patches. If any step fails:

- **`bun install` fails:** upstream may have added a dep that conflicts
  with the bun version on PATH. Check `~/.opencues/forks/opencode/package.json` for
  any `engines` constraints or new build-time tools. The runtime side is
  not at fault.
- **Build fails with `Cannot find module '@opencues/core'`:** core's
  `dist/` is missing. `build_both()` in `setup.sh` already orders core
  before runtime; if you've vendored or reordered, restore that.
- **Patch fails:** the python `src.replace` returned the source unchanged
  because an anchor string moved upstream. Go back to step 2's diff,
  update the anchor, retry. Patches are idempotent — re-running won't
  double-apply.

### 7. Smoke check

```bash
opencues run opencode
```

Watch `/tmp/opencues.log` for the boot line:

```
[HH:MM:SS][info] OpenCues runtime starting (OpenCode v1.4)
```

Then exercise the four checks from `integrations/opencode/README.md`'s
Verify table:

| Test | What it checks |
|---|---|
| Type `we should ultrathink this approach`, navigate, cycle Up | Local-lookup tip cycle |
| Type `opencues settings _`, cycle Up | Selector/satellite blank |
| Type `weather _ paris` | LLM/HTTP cue-blank |
| Status bar shows tip when a word is highlighted | Footer wiring |

If a smoke check fails, runtime diagnostics are in `/tmp/opencues.log`.
Look for ANSI/render errors first (the OpenTUI API has subtly changed
between minor versions before — see `oc/REPAIR.md` § "Host quirks").

### 8. Run the harness

```bash
# from your opencues-agentic clone:
... TODO: harness invocation ...
```

The harness is the truth-teller for non-eyeball-visible regressions
(state machine drift, span invalidation, etc.). It should be green
before merging the pin bump.

### 9. Commit

One commit, scoped tight:

```
chore(opencode): pin to v1.4.14
```

The PR body should link to the upstream release notes and call out any
non-trivial findings from step 2's diff.

## Common upgrade gotchas

- **`pin.json` and `hostVersion` drift.** Fixed in May 2026 — `hostVersion`
  is now templated from `pin.json` at patch time. If you see the templating
  layer disappear, restore it. The cost of letting `hostVersion` go stale
  is a misleading boot log line that lies during incident triage.

- **`pathsForFork().patched` and `setup.sh`'s `patch_*_tsx` count drift.**
  Whenever you add a new patched file, both lists need to grow together.
  setup.sh's `run_step "Patching fork (N files + bootstrap)"` label
  is also a counter — keep N truthful.

- **build order in `build_both`.** Must be `build_core && build_runtime`
  because runtime imports core's types. Reversing it works on warm
  checkouts (stale `dist/` files satisfy the type-resolver) and breaks
  on cold ones — exactly the failure mode worktrees and fresh CI hit.

- **bun.lock churn.** Upstream rebuilds the lockfile freely between
  patch versions. The drift is normal; it's not a signal of a problem.

## Same-minor vs cross-minor bumps

Same-minor (e.g. 1.4.11 → 1.4.14): expect this whole runbook to take
~10 minutes. Patch surface usually clean. Adapter band stays put.

Cross-minor (e.g. 1.4.x → 1.5.x): expect this runbook *plus* a new
adapter band at `packages/opencues-runtime/adapters/oc/v1.5/` and
likely real patch porting in step 2. The current band is preserved
side-by-side so users on the older minor aren't broken; install picks
which band based on `pin.json`'s major.minor.

As of May 2026 we have crossed a minor: the `oc/v1.14/` band ships
alongside `oc/v1.4/`. Both are byte-identical sans documentation
strings — the v1.14 band was created by copying v1.4 verbatim because
upstream's 1.4.14 → 1.14.17 jump didn't actually change any of our
patch anchors or runtime contracts at that specific SHA. The bands
exist as side-by-side directories so they can diverge cleanly when
a future 1.14.x SHA does change anchors. **Switching bands**: edit
`pin.json`, run uninstall → fetch + checkout → install. `setup.sh`
derives `PINNED_BAND` from `pin.json`'s major.minor and substitutes
`__OPENCUES_BAND__` in the bootstrap source at copy time.

## Upstream state — important context (May 2026)

`sst/opencode` is **hostile to incremental same-minor follow-up bumps**.
Findings from the May 2026 review against `master`:

- The **1.4.x line is dead.** The very first commit past `v1.4.14`
  (`40ba8f357`) is `sync release versions for v1.14.17` — upstream
  jumped straight from 1.4.14 to 1.14.17 with no tagged stops.
- **No 1.14.x tags exist** as of this writing. Upstream is shipping
  patch versions (currently 1.14.44 at HEAD) without git tags. Every
  bump past 1.4.14 is therefore SHA-pinned with no human-readable
  release marker.
- The 1.4 → 1.14 bump was **silent** — no announcement in the log
  beyond the routine `sync release versions` chore commit. There is
  no breaking-change list to consult.

**Operational consequences:**

1. The next OC bump is forced to be cross-minor. Plan accordingly:
   real patch porting in step 2, a new `oc/v1.14/` adapter band, and
   likely OpenTUI / SolidJS API drift on top of the anchor-string
   changes. Budget hours, not minutes.
2. Pinning by **tag** is no longer an option for anything past v1.4.14;
   step 1 of the runbook ("Pick the target SHA") collapses to picking
   a SHA from `git log` directly. Prefer commits whose message starts
   with `sync release versions for v1.14.NN` — those are upstream's
   internal release boundaries and are the closest thing to a stable
   anchor in the 1.14.x line.
3. Don't over-fit to upstream's release cadence. We pin what we
   tested; if upstream ships 1.14.99 tomorrow, our pin doesn't have
   to chase it. Run the harness suite against any candidate before
   bumping.

If upstream resumes tagging at any point, drop this section.
