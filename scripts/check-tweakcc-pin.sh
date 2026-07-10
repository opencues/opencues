#!/usr/bin/env bash
#
# check-tweakcc-pin.sh — CC patcher supply-chain + verification gate.
#
# Bug class (issue #276, July 2026): setup.sh cloned tweakcc UNPINNED
# from upstream main, so every install got whatever that day's HEAD
# was. A HEAD regression (system-prompt pipeline rewriting cli.js
# prompt template literals with double-escaped backslashes) corrupted
# BOTH install shapes — 2.1.110 cli.js died with a SyntaxError, the
# 2.1.170 native repack produced a binary Bun refuses to load — and
# the installer still reported success, because the post-patch syntax
# check was a warning and nothing ever executed the patched artifact.
#
# This gate pins the invariants that closed it:
#   1. compat.json declares tweakcc-pin as an exact 40-hex commit.
#   2. setup.sh checks out that pin after cloning (and verifies HEAD).
#   3. setup.sh disables tweakcc's system-prompt pipeline (separate
#      from patchImplementations — section 4d does NOT cover it).
#   4. The post-patch node --check is fatal, not a warning.
#   5. The patched artifact is executed (--version runtime smoke).
#
# Runs in pre-pr.sh + CI. Pure text assertions — no network, <1s.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPAT="$REPO_ROOT/integrations/claude-code/compat.json"
SETUP="$REPO_ROOT/integrations/claude-code/patches/setup.sh"

fail=0
err() { echo "✗ $1" >&2; fail=1; }

# 1. compat.json tweakcc-pin: present + exact commit sha.
PIN=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$COMPAT','utf8'))['tweakcc-pin']||'')")
if [ -z "$PIN" ]; then
  err "compat.json has no tweakcc-pin — setup.sh would clone tweakcc unpinned (issue #276)."
elif ! echo "$PIN" | grep -qE '^[0-9a-f]{40}$'; then
  err "compat.json tweakcc-pin '$PIN' is not a full 40-hex commit sha — branch/tag pins can move."
fi

# 2. setup.sh reads the pin and checks it out after clone.
grep -q 'tweakcc-pin' "$SETUP" \
  || err "setup.sh does not read compat.json:tweakcc-pin."
grep -q 'git checkout --detach "\$TWEAKCC_PIN"' "$SETUP" \
  || err "setup.sh does not check out \$TWEAKCC_PIN after cloning tweakcc."
grep -q 'ACTUAL_HEAD.*!=.*TWEAKCC_PIN\|"\$ACTUAL_HEAD" != "\$TWEAKCC_PIN"' "$SETUP" \
  || err "setup.sh does not verify the checkout landed on the pin."

# 3. The system-prompt pipeline is disabled (the actual #276 corruptor).
grep -q 'systemPromptsResult.newContent' "$SETUP" \
  || err "setup.sh no longer disables tweakcc's system-prompt pipeline (section 4e) — the #276 corruption vector is live again."

# 4. Post-patch syntax check must be fatal — never a warning.
if grep -q 'node --check.*||.*Warning' "$SETUP"; then
  err "setup.sh's post-patch node --check is a warning again — corruption would ship as 'Done.' (issue #276)."
fi
grep -q 'node --check "\$CLI_JS"' "$SETUP" \
  || err "setup.sh lost the post-patch node --check on the cli.js shape."

# 5. Runtime smoke: the patched artifact must be executed.
grep -q 'OPENCUES_SKIP_CC_RUNTIME_SMOKE' "$SETUP" \
  || err "setup.sh lost the --version runtime smoke on the patched artifact — loader-level corruption (Bun repack) would ship silently."

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "tweakcc-pin gate FAILED — see docs in this script's header + issue #276." >&2
  exit 1
fi
echo "● tweakcc pin + CC install-verification invariants hold."
