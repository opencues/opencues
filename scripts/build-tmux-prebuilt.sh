#!/usr/bin/env bash
# build-tmux-prebuilt.sh — produce a tmux 3.4 tarball for the CURRENT
# platform that `oc-install-tmux` can consume as a "prebuilt".
#
# Run this on each target platform (Linux x64, Linux arm64, macOS x64,
# macOS arm64) — usually via a CI matrix job — and upload the four
# tarballs to a GitHub release tagged `tmux-prebuilt-<version>`. After
# that release exists, every fresh `opencues install shell` skips the
# C-toolchain dance and downloads the binary directly.
#
# Output layout matches what `oc-install-tmux` expects:
#   tmux-<version>-<os>-<arch>.tar.gz
#     ├── bin/tmux
#     └── share/tmux/...   (terminfo etc.)
# i.e. when extracted into $HOME/.opencues/vendor/tmux/, the binary
# lands at $HOME/.opencues/vendor/tmux/bin/tmux.
#
# Usage:
#   bash scripts/build-tmux-prebuilt.sh [VERSION]    # default 3.4
#   → ./tmux-3.4-<os>-<arch>.tar.gz in cwd
#
# Build-deps (install before running):
#   Debian/Ubuntu: sudo apt install -y gcc make pkg-config bison curl libevent-dev libncurses-dev
#   Fedora:        sudo dnf install -y gcc make pkgconf-pkg-config bison curl libevent-devel ncurses-devel
#   Arch:          sudo pacman -S --needed gcc make pkgconf bison curl libevent ncurses
#   macOS:         brew install libevent ncurses bison pkg-config
#
# Note: we link DYNAMICALLY against libevent + ncurses (same as
# oc-install-tmux's source-build path). True static linking would
# require building libevent + ncurses statically first — significantly
# more work. Dynamic linking against the system libs is fine in
# practice: every platform we target ships libevent + ncurses, and the
# tmux binary is single-purpose.
#
# If you want fully-static binaries down the line, the right path is a
# musl-libc rebuild in an Alpine container — outside this script's
# scope but documented at docs/install/tmux-prebuilt.md.

set -euo pipefail

VERSION="${1:-3.4}"
WORK="$(mktemp -d)"
OUTPUT="$PWD/tmux-${VERSION}-$(detect_platform).tar.gz"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

detect_platform() {
  local s m
  s="$(uname -s)"; m="$(uname -m)"
  case "$s" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) echo "unsupported OS: $s" >&2; exit 1 ;;
  esac
  case "$m" in
    x86_64|amd64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) echo "unsupported arch: $m" >&2; exit 1 ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

PLATFORM="$(detect_platform)"
OUTPUT="$PWD/tmux-${VERSION}-${PLATFORM}.tar.gz"

echo "▸ building tmux $VERSION for $PLATFORM → $OUTPUT"
cd "$WORK"

curl -fsSL -o "tmux-${VERSION}.tar.gz" \
  "https://github.com/tmux/tmux/releases/download/${VERSION}/tmux-${VERSION}.tar.gz"
tar -xzf "tmux-${VERSION}.tar.gz"
cd "tmux-${VERSION}"

# Configure with a prefix INSIDE our staging tree so `make install`
# produces a self-contained bin/ + share/ tree we can tar straight up.
STAGE="$WORK/stage"
./configure --prefix="$STAGE" --enable-static=no >/dev/null
cores="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)"
make -j"$cores" >/dev/null
make install >/dev/null

# Strip debug symbols to keep tarball small.
if command -v strip >/dev/null 2>&1; then
  strip "$STAGE/bin/tmux" 2>/dev/null || true
fi

# Tar from inside STAGE so paths are bin/tmux + share/tmux/* (no
# absolute-path prefix). Matches what `oc-install-tmux` expects.
cd "$STAGE"
tar -czf "$OUTPUT" bin share 2>/dev/null

size_kb=$(($(wc -c <"$OUTPUT") / 1024))
echo "[32m●[0m wrote $OUTPUT (${size_kb} KB)"
echo ""
echo "Upload to a GitHub release tagged 'tmux-prebuilt-${VERSION}':"
echo "  gh release upload tmux-prebuilt-${VERSION} \"$OUTPUT\" --clobber"
