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
# the daemon); run on demand — after every publish, and when touching
# repo-root.cjs / cli dispatch / prepublish-guard / install.sh.
#
# MODES (first arg):
#   npm  (default)  npm i -g in node:22 (published pkg, or a tarball arg)
#   curl            the real user path: `curl -fsSL https://opencues.com/install | bash`
#                   in node:22 (add a tarball arg to test a LOCAL install.sh
#                   instead of the live endpoint)
#   bun             bun add -g in oven/bun (NO node/pnpm/corepack — exercises
#                   the bun x pnpm@9 bootstrap rung; git apt-installed since
#                   the image lacks it and git is a documented prereq)
#   all             npm + curl + bun in sequence
# Usage:
#   scripts/check-npm-fresh-install.sh [npm|curl|bun|all] [path/to/opencues-X.Y.Z.tgz]
#   scripts/check-npm-fresh-install.sh [path/to/opencues-X.Y.Z.tgz]   # npm mode
set -euo pipefail

MODE=npm
case "${1:-}" in
  npm|curl|bun|all) MODE="$1"; shift ;;
esac
TARBALL="${1:-}"

if ! docker ps >/dev/null 2>&1; then
  echo "check-npm-fresh-install: docker daemon not reachable — start Docker Desktop / dockerd and re-run." >&2
  exit 1
fi

PKG_MODE=published
INSTALL_SRC="opencues"
DOCKER_ARGS=""
ABS_DIR=""; BASE=""
if [ -n "$TARBALL" ] && [ "$MODE" != "curl" ]; then
  [ -f "$TARBALL" ] || { echo "no such tarball: $TARBALL" >&2; exit 1; }
  ABS_DIR=$(cd "$(dirname "$TARBALL")" && pwd)
  BASE=$(basename "$TARBALL")
  INSTALL_SRC="/mnt/$BASE"
  PKG_MODE=local
  DOCKER_ARGS="-v $ABS_DIR/$BASE:$INSTALL_SRC:ro"
  echo "package under test: LOCAL tarball $TARBALL"
elif [ "$MODE" = "npm" ] || [ "$MODE" = "all" ]; then
  echo "package under test: PUBLISHED opencues@$(npm view opencues version)"
fi

run_npm_mode() {
# shellcheck disable=SC2086  # DOCKER_ARGS is deliberately word-split
docker run --rm $DOCKER_ARGS -e INSTALL_SRC="$INSTALL_SRC" -e MODE="$PKG_MODE" node:22 bash -c '
set -e
echo "fresh machine: $(node --version) / npm $(npm --version) / git $(git --version | cut -d" " -f3)"
if command -v pnpm >/dev/null; then echo "FAIL: image unexpectedly has pnpm (corepack path not exercised)"; exit 1; fi

npm install -g "$INSTALL_SRC" >/dev/null 2>&1
echo "1. global install: OK"

opencues version >/dev/null
if [ -d ~/.opencues ]; then echo "FAIL: light command triggered a clone"; exit 1; fi
echo "2. light command, no clone: OK"

opencues validate >/dev/null 2>&1 || true   # exit code belongs to validate
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
}

run_curl_mode() {
  echo "── curl mode: the real \`curl | bash\` user path (node:22) ──"
  if [ -n "$TARBALL_SH" ]; then
    echo "   (local install.sh: $TARBALL_SH)"
    docker run --rm -i node:22 bash < "$TARBALL_SH"
  else
    docker run --rm node:22 bash -c 'curl -fsSL https://opencues.com/install | bash'
  fi
  echo "curl mode: ALL CHECKS PASSED"
}

run_bun_mode() {
  echo "── bun mode: bun-only machine (oven/bun; no node/pnpm/corepack) ──"
  BUN_SRC="opencues"
  BUN_DOCKER_ARGS=""
  if [ -n "$TARBALL" ]; then
    BUN_SRC="/mnt/$BASE"
    BUN_DOCKER_ARGS="-v $ABS_DIR/$BASE:$BUN_SRC:ro"
  fi
  # shellcheck disable=SC2086
  docker run --rm $BUN_DOCKER_ARGS -e BUN_SRC="$BUN_SRC" oven/bun:latest bash -c '
set -e
apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq git >/dev/null 2>&1
if command -v pnpm >/dev/null || command -v corepack >/dev/null; then
  echo "FAIL: image has pnpm/corepack — bun rung not exercised"; exit 1
fi
bun add -g "$BUN_SRC" >/dev/null 2>&1 || bun add -g "$BUN_SRC"
export PATH="$HOME/.bun/bin:/usr/local/bin:$PATH"
opencues version >/dev/null && echo "1. bun global install + light command: OK"
opencues validate >/dev/null 2>&1 || true
[ -d ~/.opencues/repo/node_modules ] || { echo "FAIL: bun bootstrap did not install workspace deps"; exit 1; }
[ -f ~/.opencues/repo/packages/opencues-core/dist/index.js ] || { echo "FAIL: core not built"; exit 1; }
echo "2. fetch + bun x pnpm@9 bootstrap + core build: OK"
echo "bun mode: ALL CHECKS PASSED"
'
}

case "$MODE" in
  npm)  run_npm_mode ;;
  curl) TARBALL_SH="$TARBALL"; run_curl_mode ;;
  bun)  run_bun_mode ;;
  all)  run_npm_mode; TARBALL_SH=""; run_curl_mode; run_bun_mode ;;
esac
