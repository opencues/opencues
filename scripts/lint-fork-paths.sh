#!/usr/bin/env bash
# lint-fork-paths.sh — fail if any shipping code constructs a legacy top-level
# fork path (`~/claude-code-cues`, `~/opencode-cues`, `~/gemini-cli-cues`)
# instead of going through `packages/opencues-cli/src/lib/fork-paths.cjs`.
#
# WHY
#
# Patched host forks moved from `~/<host>-cues` (scattered at the top of $HOME)
# to `~/.opencues/forks/<host>/`. The path used to be re-hardcoded in ~9 code
# files with no central helper, so a missed site would silently point a command
# at the wrong (old) place → "fork not found". This gate makes that class
# impossible: fork-paths.cjs is the ONLY file allowed to name the legacy layout
# (it needs the names for the transition fallback); every other code path uses
# forkDir() / resolveForkDir() / enumerateForkDirs(). A stray literal fails CI.
#
# Allowlist:
#   - the helper itself (fork-paths.cjs) — owns the legacy names.
#   - test files — assert both old + new layouts.
#   - lines carrying an inline `FORK-PATH-ALLOW: <reason>` marker.
#
# Exits 0 clean, 1 on any hit. Wired into pre-pr.sh + CI.

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Legacy fork-dir basenames — banned as string literals in shipping code.
BANNED='claude-code-cues|opencode-cues|gemini-cli-cues'

# Search shipping code only (JS/TS). Docs legitimately narrate the old paths.
FILES=$(grep -rIlE "$BANNED" \
  --include='*.ts' --include='*.cjs' --include='*.js' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude-dir=.claude \
  . 2>/dev/null || true)

hits=0
for f in $FILES; do
  # Allowlisted files: the helper + any test file.
  case "$f" in
    */lib/fork-paths.cjs) continue ;;
    *.test.cjs|*.test.ts|*.test.js) continue ;;
  esac
  # Report offending lines that CONSTRUCT a path — skip comment-only lines
  # (doc-comments legitimately narrate the old paths; they aren't load-bearing)
  # and lines with an inline allow marker.
  while IFS= read -r line; do
    echo "$line" | grep -q 'FORK-PATH-ALLOW' && continue
    # strip the leading "<lineno>:" then test for a comment-only line
    body=$(echo "$line" | sed -E 's/^[0-9]+://')
    echo "$body" | grep -qE '^[[:space:]]*(//|\*|#)' && continue
    echo "  $f: $line"
    hits=$((hits + 1))
  done < <(grep -nIE "$BANNED" "$f" 2>/dev/null || true)
done

if [ "$hits" -gt 0 ]; then
  echo ""
  echo "✗ fork-paths lint: $hits legacy fork-path reference(s) in shipping code."
  echo "  Use packages/opencues-cli/src/lib/fork-paths.cjs (forkDir / resolveForkDir /"
  echo "  enumerateForkDirs) instead of hardcoding ~/<host>-cues. If a line legitimately"
  echo "  needs the legacy name, add an inline 'FORK-PATH-ALLOW: <reason>' marker."
  exit 1
fi

echo "● fork-paths lint clean — no hardcoded legacy fork paths in shipping code"
exit 0
