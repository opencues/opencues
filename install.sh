#!/usr/bin/env bash
# OpenCues installer — the `curl -fsSL https://opencues.com/install | bash` path.
#
# Thin by design: verify the two prerequisites the standalone CLI needs
# (Node 22+, git), install the published CLI from npm, print next steps.
# The CLI itself does the heavy lifting on first use (fetches its runtime
# repo pinned to its own version tag; workspace deps via pnpm/corepack).
#
# Portability: bash 3.2 / BSD-safe per CLAUDE.md § Cross-platform shell
# scripts (no bash-4isms, no GNU-only flags). Linted by
# scripts/lint-shell-portability.sh.
set -euo pipefail

say()  { printf '%s\n' "$*"; }
fail() { printf 'opencues install: %s\n' "$*" >&2; exit 1; }

# ── OS gate ──────────────────────────────────────────────────────────
case "$(uname -s)" in
  Darwin|Linux) : ;;
  *) fail "unsupported OS '$(uname -s)' — native Windows isn't supported; run inside WSL2 (see https://opencues.com/faqs)." ;;
esac

# ── Prerequisite: Node 22+ ───────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js 22+ is required and wasn't found.
  macOS:  brew install node
  Linux:  curl -fsSL https://fnm.vercel.app/install | bash   (then: fnm install --lts)
Then re-run this installer."
fi
NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
  fail "Node.js 22+ is required (found $(node --version)). Upgrade node, then re-run."
fi

# ── Prerequisite: git ────────────────────────────────────────────────
if ! command -v git >/dev/null 2>&1; then
  fail "git is required (the CLI fetches its runtime with it) and wasn't found.
  macOS:  xcode-select --install   (or: brew install git)
  Linux:  use your package manager (e.g. apt install git)
Then re-run this installer."
fi

# ── Install the CLI ──────────────────────────────────────────────────
say "▸ installing opencues from npm (npm install -g opencues)"
if npm install -g opencues; then
  :
else
  fail "npm install -g failed. If that was a permissions (EACCES) error, either:
  - use a version manager (fnm / nvm) so globals land in your home dir, or
  - set a user prefix:  npm config set prefix ~/.npm-global   (add ~/.npm-global/bin to PATH)
Then re-run this installer."
fi

command -v opencues >/dev/null 2>&1 || fail "installed, but 'opencues' isn't on PATH — open a new shell (or add npm's global bin dir to PATH) and run 'opencues' to continue."

say ""
say "● opencues $(opencues --version 2>/dev/null | head -1 | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' || echo installed) ready. Next:"
say ""
say "    opencues set-key cerebras csk-...    # cerebras.ai — free tier, lowest latency"
say "    opencues install claude-code         # or: opencode | gemini-cli | chrome | shell"
say ""
say "  Docs: https://opencues.com · problems: opencues doctor"
