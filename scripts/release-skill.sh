#!/usr/bin/env bash
# release-skill.sh — promote a bench-validated skill from the dev
# harness (gitignored tests/agentic/skills/) to defaults/skills/
# (shipped to users via `opencues install skill`).
#
# Usage:
#   scripts/release-skill.sh <skill-name>
#
# Example:
#   scripts/release-skill.sh cues
#
# The release step is deliberately manual — skill iterations are
# frequent during dev, but defaults/skills/ lives in the public
# repo and every change becomes a public commit. Run this only
# after the bench gives a green light.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: scripts/release-skill.sh <skill-name>" >&2
  echo "       e.g. scripts/release-skill.sh cues" >&2
  exit 2
fi

SKILL="$1"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/tests/agentic/skills/$SKILL/SKILL.md"
DST="$REPO_ROOT/defaults/skills/$SKILL/SKILL.md"

if [ ! -f "$SRC" ]; then
  echo "[release-skill] source not found: $SRC" >&2
  echo "[release-skill] (skill dev harness expected at tests/agentic/skills/$SKILL/SKILL.md)" >&2
  exit 1
fi

mkdir -p "$(dirname "$DST")"

if [ -f "$DST" ] && cmp -s "$SRC" "$DST"; then
  echo "[release-skill] no change — $DST already matches dev"
  exit 0
fi

cp "$SRC" "$DST"

echo "[release-skill] promoted $SKILL"
echo "   from: $SRC"
echo "   to:   $DST"
echo ""
echo "Review the diff:"
echo "   git diff --stat defaults/skills/$SKILL/SKILL.md"
echo ""
echo "Then commit + reference the bench run that validated this version."
