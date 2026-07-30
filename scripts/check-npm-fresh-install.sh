#!/usr/bin/env bash
# check-npm-fresh-install — the published-CLI cold-start gate.
#
# Verifies `npm install -g opencues` works on a genuinely fresh machine by
# driving a pristine node:22 Docker container end-to-end:
#
#   1. npm i -g opencues                (from the PUBLIC registry)
#   2. opencues version                 (light command — must NOT clone)
#   3. opencues validate                (repo-needing — must fetch the repo
#                                        pinned to the CLI's own version tag
#                                        and bootstrap it; the container has
#                                        NO pnpm, so this also exercises the
#                                        corepack fallback)
#   4. tag check                        (~/.opencues/repo at exactly v<cli>)
#
# WHEN TO RUN (documented in CLAUDE.md § cross-PR contract):
#   - after every `npm publish` of the CLI (versioning.md release step)
#   - before merging changes to packages/opencues-cli/src/lib/repo-root.cjs,
#     bin/cli.cjs's repo resolution / REPO_NEEDING set, or
#     scripts/prepublish-guard.cjs
#
# Requires Docker + network. NOT part of pre-pr.sh (several minutes, needs
# the daemon); run on demand. Tests the PUBLISHED package by default; pass a
# tarball path to test an unpublished build:
#   scripts/check-npm-fresh-install.sh [path/to/opencues-X.Y.Z.tgz]
set -euo pipefail

TARBALL="${1:-}"

if ! docker ps >/dev/null 2>&1; then
  echo "check-npm-fresh-install: docker daemon not reachable — start Docker Desktop / dockerd and re-run." >&2
  exit 1
fi

if [ -n "$TARBALL" ]; then
  [ -f "$TARBALL" ] || { echo "no such tarball: $TARBALL" >&2; exit 1; }
  ABS_DIR=$(cd "$(dirname "$TARBALL")" && pwd)
  BASE=$(basename "$TARBALL")
  INSTALL_SRC="/mnt/$BASE"
  MODE=local
  DOCKER_ARGS="-v $ABS_DIR/$BASE:$INSTALL_SRC:ro"
  echo "checking LOCAL tarball: $TARBALL"
else
  INSTALL_SRC="opencues"
  MODE=published
  DOCKER_ARGS=""
  echo "checking PUBLISHED package: opencues@$(npm view opencues version)"
fi

# shellcheck disable=SC2086  # DOCKER_ARGS is deliberately word-split
docker run --rm $DOCKER_ARGS -e INSTALL_SRC="$INSTALL_SRC" -e MODE="$MODE" node:22 bash -c '
set -e
echo "fresh machine: $(node --version) / npm $(npm --version) / git $(git --version | cut -d" " -f3)"
if command -v pnpm >/dev/null; then echo "FAIL: image unexpectedly has pnpm (corepack path not exercised)"; exit 1; fi

npm install -g "$INSTALL_SRC" >/dev/null 2>&1
echo "1. global install: OK"

opencues version >/dev/null
if [ -d ~/.opencues ]; then echo "FAIL: light command triggered a clone"; exit 1; fi
echo "2. light command, no clone: OK"

opencues validate >/dev/null 2>&1 || true   # exit code is validate's own business
if [ ! -d ~/.opencues/repo ]; then echo "FAIL: repo-needing command did not fetch the repo"; exit 1; fi
echo "3. fetch + bootstrap (corepack): OK"

CLI_V=$(opencues version 2>/dev/null | grep -oE "v[0-9]+\.[0-9]+\.[0-9]+" | head -1)
REPO_V=$(git -C ~/.opencues/repo describe --tags 2>/dev/null || echo none)
if [ "$CLI_V" = "$REPO_V" ]; then
  echo "4. version=tag=snapshot: OK ($CLI_V)"
else
  # A dev/unreleased CLI falls back to the default branch; only fatal for the
  # published package, which must always pin its own tag.
  echo "WARN: cli=$CLI_V repo=$REPO_V (tag fallback?)"
  if [ "$MODE" = "published" ]; then echo "FAIL: published CLI must pin its own tag"; exit 1; fi
fi
echo "ALL CHECKS PASSED"
'
