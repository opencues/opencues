#!/usr/bin/env bash
# lint-version-bump.sh — assert that PRs touching package src/** also
# bump the package's version.json. Catches the silent-drift class that
# PRs #37 / #38 / #39 / #40 / #41 hit (source changed, version stayed
# at 0.1.5 forever, downstream forks couldn't detect drift via version
# strings — only the srcHash check in PR #42 covered them).
#
# The srcHash mechanism makes version bumps NOT load-bearing for drift
# detection. They remain load-bearing for:
#   - npm publish readiness (semver is the version contract)
#   - changelog discoverability (PR #31's discipline)
#   - human grep-ability ("what version added X feature?")
#
# Scope: only the workspace packages whose dist is bundled into forks.
# Integration packages (@opencues/{chrome,claude-code,shell,opencode,gemini-cli})
# are version-bumped opportunistically, not enforced.
#
# How to run:
#   bash scripts/lint-version-bump.sh                  # default: against origin/master
#   BASE=HEAD~3 bash scripts/lint-version-bump.sh      # custom base
#
# CI: wired into ci.yml as the `version-bump-gate` job. Local pre-PR
# check via scripts/pre-pr.sh.
#
# Bypass: a commit message containing `[skip version-bump]` exempts the
# range. Use sparingly — typically for chore/docs/refactor PRs that
# legitimately don't ship behaviour changes.

set -eo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BASE="${BASE:-origin/master}"

# Try to resolve BASE — fall back to HEAD~1 if origin isn't fetched
# (clean clones in CI sometimes lack it on first push).
if ! git rev-parse --verify "$BASE" >/dev/null 2>&1; then
  if git rev-parse --verify HEAD~1 >/dev/null 2>&1; then
    BASE="HEAD~1"
  else
    echo "lint-version-bump: no comparison base (no $BASE, no HEAD~1). Exiting 0."
    exit 0
  fi
fi

# Skip the gate if any commit in the range is marked.
if git log "$BASE..HEAD" --pretty=%B 2>/dev/null | grep -q "\[skip version-bump\]"; then
  echo "lint-version-bump: skipped (commit message contains [skip version-bump])."
  exit 0
fi

# Packages we enforce on. Source dir → package.json relative to repo.
declare -a PACKAGES=(
  "packages/opencues-core/src:packages/opencues-core/package.json"
  "packages/opencues-runtime/src:packages/opencues-runtime/package.json"
  "packages/opencues-cli/src:packages/opencues-cli/package.json"
)

FAIL=0

for entry in "${PACKAGES[@]}"; do
  SRC_DIR="${entry%:*}"
  PKG_JSON="${entry#*:}"

  # Did source change?
  SRC_CHANGED=$(git diff --name-only "$BASE" HEAD -- "$SRC_DIR" 2>/dev/null | wc -l)
  # Did the package's own root-level package.json change?
  PKG_CHANGED=$(git diff --name-only "$BASE" HEAD -- "$PKG_JSON" 2>/dev/null | wc -l)

  if [ "$SRC_CHANGED" -gt 0 ] && [ "$PKG_CHANGED" -eq 0 ]; then
    # Source changed, package.json didn't. Bug.
    echo "✗ $SRC_DIR changed but $PKG_JSON wasn't bumped."
    echo "    Files changed in $SRC_DIR:"
    git diff --name-only "$BASE" HEAD -- "$SRC_DIR" | sed 's/^/      /'
    FAIL=1
    continue
  fi

  if [ "$SRC_CHANGED" -gt 0 ] && [ "$PKG_CHANGED" -gt 0 ]; then
    # Both changed — but did the VERSION field move? A bare formatting
    # tweak of package.json doesn't count.
    OLD_VERSION=$(git show "$BASE:$PKG_JSON" 2>/dev/null | node -e "
      let s = ''; process.stdin.on('data', c => s += c).on('end', () => {
        try { console.log(JSON.parse(s).version); } catch { console.log(''); }
      });
    ")
    NEW_VERSION=$(node -e "console.log(require('./$PKG_JSON').version)")
    if [ "$OLD_VERSION" = "$NEW_VERSION" ]; then
      echo "✗ $SRC_DIR changed and $PKG_JSON was edited, but version stayed at $OLD_VERSION."
      echo "    Bump version to record the change. See docs/architecture/versioning.md."
      FAIL=1
    else
      echo "✓ $SRC_DIR + $PKG_JSON: $OLD_VERSION → $NEW_VERSION"
    fi
  fi
done

if [ "$FAIL" = "0" ]; then
  echo "✓ Version-bump gate clean."
  exit 0
else
  echo ""
  echo "FAIL — version bump required when source changes."
  echo "       Bypass for non-shipping changes: include [skip version-bump] in a commit message."
  echo "       Policy: docs/architecture/versioning.md"
  exit 1
fi
