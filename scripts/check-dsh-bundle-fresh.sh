#!/usr/bin/env bash
# check-dsh-bundle-fresh — the committed dsh bundle matches its sources.
#
# WHY THIS EXISTS
#
# `integrations/dsh/client.js` is a build artifact that IS committed, unlike
# every other bundle in this repo. It has to be: the dsh plugin marketplaces
# install by cloning the repo with `--ignore-scripts`, so `prepublishOnly`
# never runs and a gitignored bundle would be absent — the node half loads,
# the config route answers, and nothing paints or fills.
#
# Committing derived output buys that at the price of staleness, which is the
# single worst failure mode in this codebase's history: a bundle that is
# quietly one version behind its source produces no error anywhere. So the
# price is paid back here. esbuild is byte-reproducible for identical inputs
# (verified: two consecutive builds hash identically), so "rebuild and diff"
# is an exact test rather than a heuristic.
#
# TURBO OUTPUTS. `turbo.json` carries an `@opencues/dsh#build` override whose
# `outputs` are `client.js` + `default-opencues.md`, because this package
# writes to its ROOT rather than `dist/` (the artifact is committed and listed
# in npm `files`). Without the override the generic `dist/**` matched nothing,
# turbo warned the task produced no outputs, and — worse — cached it with none:
# a cache hit then restores nothing, so the build reports success while leaving
# the committed artifact stale or absent. The comment lives here because turbo
# validates task keys strictly and rejects a `//` comment inside one.
#
# A failure means: you changed src/ (or core/runtime, which are inlined) and
# did not rebuild. Fix with `pnpm build --filter @opencues/dsh` and commit.
#
# Prefer THAT form over `pnpm --filter @opencues/dsh build`: the latter runs
# the package script directly and skips turbo, so it bundles whatever
# core/runtime dist happens to be on disk rather than building them first.
#
# Correction, because the first version of this comment asserted otherwise: no
# drift was ever actually observed from that. The "different bundle" it
# claimed was a unit-confusion on my part — build.mjs prints KiB ("987 kB")
# and `ls` prints bytes (1,011,171), which are the same file. Verified after
# the fact: identical sha256 either way. The turbo form is still the better
# habit because it guarantees the inlined packages are current, but it is
# insurance, not a fix for a demonstrated bug. This script builds them itself
# below regardless, which is the actual guarantee.
#
# Exits 0 clean, 1 stale. Wired into pre-pr.sh and CI.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DSH="integrations/dsh"
BUNDLE="$DSH/client.js"
DEFAULTS="$DSH/default-opencues.md"

if [ ! -f "$DSH/build.mjs" ]; then
  echo "● dsh bundle freshness: skipped (no integrations/dsh)"
  exit 0
fi

for f in "$BUNDLE" "$DEFAULTS"; do
  if [ ! -f "$f" ]; then
    echo "✗ $f is missing — it must be committed, not gitignored."
    echo "  A clone-based marketplace install would ship a plugin with no browser half."
    echo "  Fix: pnpm build --filter @opencues/dsh && git add $f"
    exit 1
  fi
done

before_bundle="$(sha256sum "$BUNDLE" | cut -d' ' -f1)"
before_defaults="$(sha256sum "$DEFAULTS" | cut -d' ' -f1)"

# The bundle inlines @opencues/{core,runtime} DIST, so a stale dist would make
# this check compare against the wrong thing and pass a genuinely stale bundle.
# Build them first — the same order `opencues install dsh` uses.
for pkg in @opencues/core @opencues/runtime; do
  if ! pnpm --filter "$pkg" build >/dev/null 2>&1; then
    echo "✗ could not build $pkg — cannot verify the dsh bundle against current sources"
    exit 1
  fi
done

if ! (cd "$DSH" && node build.mjs >/dev/null 2>&1); then
  echo "✗ dsh bundle build failed — see: cd $DSH && node build.mjs"
  exit 1
fi

after_bundle="$(sha256sum "$BUNDLE" | cut -d' ' -f1)"
after_defaults="$(sha256sum "$DEFAULTS" | cut -d' ' -f1)"

stale=0
[ "$before_bundle" != "$after_bundle" ] && stale=1
[ "$before_defaults" != "$after_defaults" ] && stale=1

if [ "$stale" -eq 1 ]; then
  echo "✗ the committed dsh bundle is STALE — it does not match current sources."
  [ "$before_bundle" != "$after_bundle" ] && echo "    client.js            ${before_bundle:0:12} → ${after_bundle:0:12}"
  [ "$before_defaults" != "$after_defaults" ] && echo "    default-opencues.md  ${before_defaults:0:12} → ${after_defaults:0:12}"
  echo ""
  echo "  A rebuild has already been run, so the working tree is now correct."
  echo "  Commit it:  git add $BUNDLE $DEFAULTS"
  echo ""
  echo "  Why it matters: marketplaces install by cloning this repo with"
  echo "  --ignore-scripts, so whatever is committed here IS what those users run."
  exit 1
fi

echo "● dsh bundle freshness: committed artifacts match their sources"
