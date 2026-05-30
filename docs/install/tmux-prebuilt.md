# Publishing tmux prebuilts

`oc-install-tmux` (shell integration) tries a prebuilt tarball before
falling back to source build. The prebuilt path is:

```
https://github.com/opencues/opencues/releases/download/tmux-prebuilt-<version>/tmux-<version>-<os>-<arch>.tar.gz
```

Four platforms supported: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`.

When all four tarballs are uploaded under that release tag, every
fresh `opencues install shell` skips the C-toolchain dance — no
`gcc` / `libevent-dev` / etc. needed.

## Building the tarballs

`scripts/build-tmux-prebuilt.sh` produces one tarball for the current
platform. Run it on each target platform, ideally via a CI matrix.

### Local manual run

```bash
# On a Linux x64 box:
bash scripts/build-tmux-prebuilt.sh 3.4
# → tmux-3.4-linux-x64.tar.gz in cwd
```

Build-deps the script needs:

| Platform | Install |
|---|---|
| Debian/Ubuntu | `sudo apt install -y gcc make pkg-config bison curl libevent-dev libncurses-dev` |
| Fedora | `sudo dnf install -y gcc make pkgconf-pkg-config bison curl libevent-devel ncurses-devel` |
| Arch | `sudo pacman -S --needed gcc make pkgconf bison curl libevent ncurses` |
| macOS | `brew install libevent ncurses bison pkg-config` |

### Recommended CI matrix

GitHub Actions, four jobs (Linux x64/arm64, macOS x64/arm64),
triggered manually or by a tag push. Each uploads its tarball as a
release asset under `tmux-prebuilt-<version>`.

Sketch:

```yaml
name: tmux-prebuilt
on:
  push:
    tags: ['tmux-prebuilt-*']

jobs:
  build:
    strategy:
      matrix:
        include:
          - { runner: ubuntu-latest,     platform: linux-x64 }
          - { runner: ubuntu-22.04-arm,  platform: linux-arm64 }
          - { runner: macos-13,          platform: darwin-x64 }
          - { runner: macos-14,          platform: darwin-arm64 }
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4
      - name: Install build deps (Linux)
        if: startsWith(matrix.runner, 'ubuntu')
        run: sudo apt install -y gcc make pkg-config bison curl libevent-dev libncurses-dev
      - name: Install build deps (macOS)
        if: startsWith(matrix.runner, 'macos')
        run: brew install libevent ncurses bison pkg-config
      - name: Build tmux
        run: bash scripts/build-tmux-prebuilt.sh 3.4
      - uses: softprops/action-gh-release@v2
        with:
          files: tmux-3.4-*.tar.gz
```

## How the consumer side picks it up

`integrations/shell/bin/oc-install-tmux` runs this resolution order
the first time `opencues install shell` is invoked:

1. **Vendored already present** (`~/.opencues/vendor/tmux/bin/tmux` exists) → no-op.
2. **Prebuilt tarball** (this doc) → curl, untar into vendor dir, done.
3. **Source build** → existing path; requires gcc + libevent + ncurses.

Override the release-base URL for testing locally:

```bash
OPENCUES_TMUX_PREBUILT_BASE="file:///path/to/local/releases" oc-install-tmux
```

The script looks for `$OPENCUES_TMUX_PREBUILT_BASE/tmux-prebuilt-<version>/tmux-<version>-<os>-<arch>.tar.gz`
— a static HTTP server pointing at your build output works for end-to-end testing.

## Tarball shape contract

```
tmux-<version>-<os>-<arch>.tar.gz
├── bin/tmux
└── share/tmux/…   (terminfo etc., produced by `make install`)
```

Extracted into `$HOME/.opencues/vendor/tmux/`. The binary at
`bin/tmux` must be runnable on the target platform without
additional system packages installed (other than the already-ubiquitous
`libevent` / `ncurses`).

True musl-libc static binaries (no system libs at all) would survive
even more edge cases but require an Alpine container build. Not done
today; the dynamic-link approach works on every Linux/macOS we've
tested.

## Uninstall

The vendored tmux + the entire `~/.opencues/vendor/` tree is removed
by `opencues uninstall shell` (unless `--keep-vendor` is passed).
Prebuilt and source-built paths are indistinguishable to uninstall —
the dir contract is identical.
