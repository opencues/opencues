#!/usr/bin/env bash
# lint-legacy-names.sh — fail if banned legacy identifiers appear in
# shipping code outside an explicit allowlist.
#
# WHY
#
# When a feature is renamed (`USER.md` → `SENTINELS.md` → `IDENTITY.md`,    # LEGACY-NAME-ALLOW: lint header
# `user-context-mode` → `sentinels-mode` → `identity-context-mode`,           # LEGACY-NAME-ALLOW: lint header
# `opencues sentinels` → `opencues identity`), grep-and-replace               # LEGACY-NAME-ALLOW: lint header
# misses comments, doc strings, and odd corners. Pinned by-eye on
# each rename, drift creeps in over the next few PRs as new code is
# written using whatever-name-the-author-remembered. By the next
# rename, the codebase has three names co-existing.
#
# Structural fix: codify the rename via deny-list. The old name is
# banned in shipping code; sites that legitimately reference the
# old name (migration code, historical narrative comments) declare
# themselves via an allowlist (file-level) or an inline marker
# (`LEGACY-NAME-ALLOW`).
#
# WHEN A NEW RENAME LANDS
#
# 1. Add the old name(s) to the BANNED list below.
# 2. Update every shipping site to the new name (this lint will tell you
#    which sites you missed).
# 3. Files whose job IS to migrate the legacy name (seed-configs,
#    doctor, migration tests) go on FILE_ALLOWLIST.
# 4. Individual lines that legitimately reference the old name for
#    historical context get a `LEGACY-NAME-ALLOW: <reason>` comment
#    on the same line.
#
# That's the whole discipline. The deny-list is the source of truth
# for "what got renamed"; nothing else can drift.
#
# Exits 0 if clean, 1 if any hit. CI wires it via the
# `legacy-names` job; pre-pr.sh runs it before push.

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Banned identifiers. Each entry is an ERE. Renames append here.
#
# Two flavours live here:
#   - RENAMES — the old name has a current replacement (USER.md → IDENTITY.md).  # LEGACY-NAME-ALLOW: lint header
#   - REMOVALS — the identifier was deleted outright with no successor
#     (the June 2026 blank-API slim-down). Banning them stops a deleted,
#     now-inert key/scalar from creeping back into shipping code where it
#     would silently no-op. Historical narrative comments that EXPLAIN the
#     removal carry a `LEGACY-NAME-ALLOW` marker.
BANNED_PATTERNS=(
  # tutorials → kata rename (July 2026; feature was unreleased, no aliases)
  'Tutorial[C]oach'
  'TUTORIAL\.md'
  '\btutorials-mode\b'
  '\btutorial-debounce-ms\b'
  '\btutorial-nudge-ms\b'
  '\btutorial-voice\b'
  'tutorial-progress\.json'
  'start[ ]tutorial'
  'opencues[T]utorial'

  'SENTINELS\.md'
  'USER\.md'
  '\bsentinels-mode\b'
  '\buser-context-mode\b'
  '\bopencues sentinels\b'
  # ── June 2026 blank-API slim-down — removed scalar + gate identifiers ──
  # These are clean code-level removals with no successor and no
  # legitimate remaining reference in shipping code.
  '\bblank-intent-mode\b'
  '\bblankIntentMode\b'
  '\bbuildBlankIntentClassifier\b'
  '\bblankIntentHttpAdapter\b'
  '\bBlankIntentDecision\b'
  # ── June 2026 param-safe → ai-callable rename ──            # LEGACY-NAME-ALLOW: lint header
  # Back-compat reads (cli alias, cues-md case, config-loader fallback,
  # ai-callable.cjs read/migrate) carry per-line LEGACY-NAME-ALLOW markers.
  '\bparam-safe\b'
  '\bparamSafe\b'
  '\bParamSafe\b'
  '\bPARAM_SAFE\b'
  # NOTE: the removed BLANK.md frontmatter keys (blankReplace,
  # blankConsumeAll/Context, blankProximity, blankAutoPopulate,
  # blankReadOnly, blankFormat, blankTip, blankKeywordExpansions) are
  # deliberately NOT banned. They are gracefully ignored if present and
  # still appear (inert) in the shipped defaults/blanks/*/BLANK.md
  # templates, which are intentionally left untouched. Banning them would
  # force a large allowlist for no behavioural benefit.
)

# File-level allowlist — paths whose job is to handle the rename.
# Adding a file here is a deliberate choice; prefer LEGACY-NAME-ALLOW
# markers for one-off references.
FILE_ALLOWLIST=(
  'packages/opencues-cli/src/commands/seed-configs.cjs'
  'packages/opencues-cli/src/commands/doctor.cjs'
  'packages/opencues-cli/src/commands/identity-migration.test.cjs'
  'packages/opencues-runtime/src/modules/config-loader.ts'
)

# Files this lint scans. Limit to shipping code + shipped config
# templates (no docs/, no dist/, no node_modules/, no vendored
# trees). Markdown is scanned ONLY under defaults/ because those
# files seed every user's ~/.cues/ via seed-configs — they're
# templates, not tutorials. docs/**/*.md drifts slower and carries
# legitimate historical narrative; the editorial overhead of
# marking every reference is higher than the value there.
SEARCH_DIRS=(packages integrations defaults scripts)
FILE_GLOBS=('*.ts' '*.cjs' '*.js' '*.sh')
DEFAULTS_MD_GLOB='defaults/**/*.md'

# Inline marker: any line containing this string is exempt.
MARKER='LEGACY-NAME-ALLOW'

FAIL=0
HIT_COUNT=0

is_allowlisted_file() {
  local file="$1"
  for allowed in "${FILE_ALLOWLIST[@]}"; do
    [ "$file" = "$allowed" ] && return 0
  done
  return 1
}

# Build the find pattern.
FIND_ARGS=()
for d in "${SEARCH_DIRS[@]}"; do
  [ -d "$d" ] && FIND_ARGS+=("$d")
done

# Build name filter (one -name per glob, OR'd with -o).
NAME_FILTER=()
first=1
for g in "${FILE_GLOBS[@]}"; do
  if [ $first -eq 1 ]; then
    NAME_FILTER+=(-name "$g")
    first=0
  else
    NAME_FILTER+=(-o -name "$g")
  fi
done

# Enumerate candidate files; exclude vendored / build output.
FILES=$(find "${FIND_ARGS[@]}" \
  \( "${NAME_FILTER[@]}" \) \
  -not -path '*/node_modules/*' \
  -not -path '*/dist/*' \
  -not -path '*/.cache/*' \
  -not -path '*/tweakcc/*' \
  | sort)

# Add shipped config templates (defaults/**/*.md) — these seed
# every user's ~/.cues/ so a stale rename ships to every user.
DEFAULTS_MD=$(find defaults -name '*.md' 2>/dev/null \
  -not -path '*/node_modules/*' \
  -not -path '*/dist/*' \
  | sort)
FILES="$FILES"$'\n'"$DEFAULTS_MD"

# Combine all banned patterns into one ERE for a single grep pass per file.
COMBINED=$(IFS='|'; echo "${BANNED_PATTERNS[*]}")

for f in $FILES; do
  if is_allowlisted_file "$f"; then
    continue
  fi
  # grep -nE: line numbers + extended regex. Filter out marker lines.
  hits=$(grep -nE "$COMBINED" "$f" 2>/dev/null | grep -v "$MARKER" || true)
  if [ -n "$hits" ]; then
    while IFS= read -r line; do
      echo "✗ $f:$line"
      HIT_COUNT=$((HIT_COUNT + 1))
    done <<< "$hits"
    FAIL=1
  fi
done

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "✓ legacy-names lint clean — no banned identifiers outside allowlist"
  exit 0
else
  echo "✗ legacy-names lint: $HIT_COUNT hit(s) above"
  echo ""
  echo "Each hit is a reference to a renamed identifier. Options:"
  echo "  1. Rename it to the current name (preferred — fixes the drift)."
  echo "  2. Append \`// $MARKER: <reason>\` on the same line if the"
  echo "     reference is intentional (historical narrative, migration"
  echo "     reference, etc.)."
  echo "  3. Add the file to FILE_ALLOWLIST in this script if its entire"
  echo "     purpose is handling the legacy name (migration code)."
  echo ""
  echo "Banned identifiers + the rename history live at the top of this"
  echo "script. When a new rename lands, append to BANNED_PATTERNS."
  exit 1
fi
