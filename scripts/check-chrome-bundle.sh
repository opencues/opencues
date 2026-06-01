#!/usr/bin/env bash
# check-chrome-bundle.sh — assert that `pnpm build` actually produces
# every Chrome dist file the extension needs to load. Catches the
# silent-build-failure class where esbuild errors but downstream CI
# steps don't notice (e.g. a missing `external:` declaration causes
# the build to skip the bundle without aborting). See PR #49 (June
# 2026) where `node:fs` imports in boot-common.ts broke chrome's
# bundle.
#
# Strategy: after `pnpm build`, check every expected dist artifact
# exists with non-trivial size. If anything's missing, fail loudly
# with the file list.
#
# Pre-condition: `pnpm build` has been run. Wired into ci.yml after
# the Build step.

set -eo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHROME_DIST="$REPO_ROOT/integrations/chrome/dist"

# Files chrome's manifest.json and content scripts depend on. Each
# must exist and be at least 100 bytes (catches "the build emitted
# an empty file because the entry point was missing").
EXPECTED=(
  "content.js"
  "background.js"
  "popup/popup.js"
  "popup/popup.html"
  "popup/popup.css"
)

if [ ! -d "$CHROME_DIST" ]; then
  echo "✗ $CHROME_DIST doesn't exist. Did \`pnpm build\` run?"
  exit 1
fi

FAIL=0
for f in "${EXPECTED[@]}"; do
  full="$CHROME_DIST/$f"
  if [ ! -f "$full" ]; then
    echo "✗ Missing: $full"
    FAIL=1
    continue
  fi
  size=$(wc -c < "$full" 2>/dev/null | tr -d ' ')
  if [ "$size" -lt 100 ]; then
    echo "✗ Suspiciously small ($size bytes): $full"
    FAIL=1
    continue
  fi
done

if [ "$FAIL" = "0" ]; then
  echo "✓ Chrome bundle artifacts present in $CHROME_DIST/"
  exit 0
else
  echo ""
  echo "FAIL — chrome bundle incomplete. Most common causes:"
  echo "  - boot-common or another runtime module references a node:* import"
  echo "    that esbuild can't bundle for the browser. Mark it external in"
  echo "    integrations/chrome/esbuild.config.mjs (see PR #49)."
  echo "  - the build emitted to a different dist path (chrome dist must"
  echo "    stay at integrations/chrome/dist/ for the manifest to load)."
  exit 1
fi
