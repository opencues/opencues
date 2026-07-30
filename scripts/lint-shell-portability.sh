#!/usr/bin/env bash
# lint-shell-portability.sh — bash -n + banned-construct check for every
# .sh file we ship under defaults/ and integrations/.
#
# The rules live in CLAUDE.md § "Cross-platform shell scripts". Repeated
# here so a new contributor adding a script can grep what's banned:
#
#   - shebang `#!/bin/bash` (macOS only ships bash 3.2 at that path)
#   - mapfile, declare -A, declare -n, ${var^^}, ${var,,}
#   - readlink -f, stat -c, sed -i '' / sed -i without the sedi() shim,
#     find -printf, xargs -r, /proc/ without a [ -d /proc ] gate
#
# Exits 0 if clean, 1 if any check fails. CI wires it into ci.yml as
# the `shell-portability` job. Run locally: `bash scripts/lint-shell-portability.sh`.

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

FAIL=0
COUNT=0

# Find every .sh under defaults/ and integrations/ — skip vendored tree
# (tweakcc clone, node_modules, dist/).
SCRIPTS=$(find defaults integrations -name '*.sh' \
  -not -path '*/node_modules/*' \
  -not -path '*/tweakcc/*' \
  -not -path '*/dist/*' \
  | sort)
# Root-level user-facing installers (curl | bash targets) are the MOST
# portability-critical scripts in the repo — they run on machines we know
# nothing about. Explicit list (find at depth 1 would sweep worktrees).
for root_sh in install.sh; do
  [ -f "$root_sh" ] && SCRIPTS="$SCRIPTS
$root_sh"
done

for f in $SCRIPTS; do
  COUNT=$((COUNT + 1))

  # 1. Syntax check.
  if ! bash -n "$f" 2>/tmp/lint-shell-err; then
    echo "✗ $f — bash -n failed"
    cat /tmp/lint-shell-err
    FAIL=1
    continue
  fi

  # 2. Shebang must be #!/usr/bin/env bash, not #!/bin/bash.
  #    The exceptions are setup.sh files that have their own sedi()
  #    wrapper at the top — those run from our installer, never via
  #    user-shebang invocation, so the literal /bin/bash path is fine.
  first_line=$(head -1 "$f")
  case "$f" in
    integrations/*/patches/setup.sh) ;;  # installer-invoked
    *)
      if [ "$first_line" = "#!/bin/bash" ]; then
        echo "✗ $f — uses #!/bin/bash; macOS ships only bash 3.2 there. Use #!/usr/bin/env bash."
        FAIL=1
      fi
      ;;
  esac

  # 3. Banned bash-4+ constructs (mapfile, declare -A, ${var^^}, ${var,,}).
  #    grep -E with proper escaping for the parameter-expansion uppers.
  if grep -nE '\bmapfile\b|\bdeclare[[:space:]]+-A\b|\bdeclare[[:space:]]+-n\b' "$f" >/dev/null; then
    echo "✗ $f — bash-4 construct (mapfile / declare -A / declare -n). Use while-read / parallel arrays."
    grep -nE '\bmapfile\b|\bdeclare[[:space:]]+-A\b|\bdeclare[[:space:]]+-n\b' "$f" | sed 's/^/    /'
    FAIL=1
  fi
  # ${VAR^^} / ${VAR,,} parameter-expansion case ops — bash 4+ only.
  if grep -nE '\$\{[A-Za-z_][A-Za-z0-9_]*[\^,]{1,2}[^}]*\}' "$f" >/dev/null; then
    echo "✗ $f — bash-4 parameter-expansion case (\${var^^} / \${var,,}). Use tr '[:lower:]' '[:upper:]' instead."
    grep -nE '\$\{[A-Za-z_][A-Za-z0-9_]*[\^,]{1,2}[^}]*\}' "$f" | sed 's/^/    /'
    FAIL=1
  fi

  # 4. GNU-only coreutils invocations without a portable wrapper.
  #    `readlink -f` (GNU) — use resolve_link() pattern (see integrations/shell/bin/oc-shell).
  if grep -nE '\breadlink[[:space:]]+-f\b' "$f" >/dev/null; then
    echo "✗ $f — readlink -f is GNU-only. Use the resolve_link() shim pattern."
    grep -nE '\breadlink[[:space:]]+-f\b' "$f" | sed 's/^/    /'
    FAIL=1
  fi
  #    `stat -c %s` (GNU) vs `stat -f %z` (BSD) — use stat_size() (see oc-popup).
  if grep -nE '\bstat[[:space:]]+-c\b' "$f" >/dev/null; then
    echo "✗ $f — stat -c is GNU-only. Use the stat_size() shim pattern (GNU -c / BSD -f)."
    grep -nE '\bstat[[:space:]]+-c\b' "$f" | sed 's/^/    /'
    FAIL=1
  fi

  # 5. sed -i without the sedi() wrapper. BSD sed (macOS) needs `sed -i ''`,
  #    GNU sed (Linux/WSL) needs `sed -i`. The repo's sedi() wrapper picks
  #    the right form at runtime. A raw `sed -i ''` works on BSD but
  #    breaks GNU; a raw `sed -i ` works on GNU but breaks BSD. Both wrong.
  if grep -nE "\bsed[[:space:]]+-i\b" "$f" >/dev/null; then
    # Allow `sed -i` inside a sedi() function definition itself.
    if ! grep -B2 -E "\bsed[[:space:]]+-i\b" "$f" | grep -q "sedi()"; then
      echo "✗ $f — uses raw \`sed -i\` (BSD/GNU split). Use the sedi() wrapper."
      grep -nE "\bsed[[:space:]]+-i\b" "$f" | sed 's/^/    /'
      FAIL=1
    fi
  fi

  # 6. /proc reads without a [ -d /proc ] gate. macOS has no /proc.
  if grep -nE '/proc/' "$f" >/dev/null; then
    if ! grep -qE '\[\s*-d\s*/proc\s*\]' "$f"; then
      echo "✗ $f — reads from /proc without gating on [ -d /proc ]. macOS has no /proc."
      grep -nE '/proc/' "$f" | sed 's/^/    /'
      FAIL=1
    fi
  fi

  # NOTE: `((…))` arithmetic and `[[ =~ ]]` regex match are NOT linted.
  # Both work in bash 3.2; CLAUDE.md says "prefer POSIX when equivalent"
  # but doesn't BAN them. The lint only enforces the hard bans (bash-4
  # only constructs + GNU-only flags + ungated /proc reads).

  # 7. Strict-mode discipline for installer scripts. Catches the June
  #    2026 failure mode where `set -e` without `pipefail` let
  #    `npm install ... | tail -3` swallow a real npm failure (the
  #    pipe returns tail's status 0, set -e doesn't fire). See PR #43.
  #
  #    Scoped to scripts/ + integrations/*/patches/ + integrations/*/bin/
  #    setup-shaped scripts — they orchestrate multi-step pipelines
  #    where a silent failure cascades badly. Simple user-facing blank
  #    scripts under defaults/blanks/ are exempt; they shell out to
  #    one command and return its exit. An explicit opt-out is
  #    available via the marker `# lint: no-pipefail (<reason>)`.
  case "$f" in
    scripts/*.sh|integrations/*/patches/*.sh|integrations/shell/bin/oc-install-*)
      if ! grep -qE '^set -[a-z]*o[a-z]* pipefail|^set -o pipefail' "$f"; then
        if ! grep -qE '# lint: no-pipefail' "$f"; then
          echo "✗ $f — orchestration script missing \`set -o pipefail\`."
          echo "    Without pipefail, a failing \`x | tail -N\` returns tail's exit (0)"
          echo "    and \`set -e\` doesn't fire. See PR #43 (June 2026)."
          echo "    Fix: replace 'set -e' with 'set -eo pipefail', OR add a"
          echo "    '# lint: no-pipefail (<reason>)' marker line if the script"
          echo "    legitimately needs to keep going on pipe failures."
          FAIL=1
        fi
      fi
      ;;
  esac
done

if [ "$FAIL" = "0" ]; then
  echo "[32m●[0m $COUNT shell scripts pass portability lint."
  exit 0
else
  echo ""
  echo "FAIL — see CLAUDE.md § 'Cross-platform shell scripts' for shim patterns."
  exit 1
fi
