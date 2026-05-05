# Walkthrough checklist

Manual smoke tests for the CLI work landed across many stages. Each section maps to a commit (newest first); run through top-to-bottom or jump to the section you care about.

All checks below assume **cwd = the opencues clone** unless stated otherwise. After ticking through, this file can be deleted (`git rm CHECKLIST.md`).

---

## ⓪⓪⓪ Doc updates (commits `13d8e70`, `83948f9`)

The HIGH + MEDIUM stale-doc fixes from the audit. No commands to run; just read-through. Spot-check that:

- `README.md` install section uses `pnpm exec opencues install <host>`
- `CLAUDE.md` install destination is `~/claude-code-cues/.opencues/` (not `~/.claude/node_modules/`)
- `integrations/claude-code/README.md` and `integrations/claude-code/patches/README.md` reflect the consolidated layout
- `docs/guides/quickstart.md` uses `pnpm` and `opencues install claude-code`
- Various feature/guide docs no longer reference `~/.claude/actions/` or `~/.claude/highlight-statusline.sh` directly (current paths: `~/claude-code-cues/.opencues/scripts/` and `~/claude-code-cues/.opencues/statusline.sh`)

---

## ⓪ Setup (do once)

```bash
pnpm install
pnpm build
```

`pnpm exec opencues` should now resolve via `node_modules/.bin/opencues`.

```bash
pnpm exec opencues version
# → opencues v0.1.0
# → 3 integration rows (cc/oc/chrome) + 2 library rows (core/runtime)
```

If you don't see `opencues` working: `ls node_modules/.bin/opencues` should exist; if not, re-run `pnpm install`.

---

## ① Tier 4 — `completion` (commit `1d7e257`)

```bash
pnpm exec opencues completion bash | head -5
# → bash completion script (function _opencues_completions)

pnpm exec opencues completion zsh | head -3
# → zsh completion script

pnpm exec opencues completion fish | head -3
# → fish completion script

pnpm exec opencues completion mongo
# → error: unknown shell "mongo"; exit 2

pnpm exec opencues completion --help
# → usage info
```

**Optional:** actually source it in a fresh shell and tab-complete `opencues ins<TAB>` → should expand to `install`.

---

## ② Tier 3b — `set-key` + `check-keys` + `update` + `debug` (commit `c92714f`)

### `set-key`

```bash
pnpm exec opencues set-key
# → usage error: missing args; exit 2

pnpm exec opencues set-key bogus xxx
# → unknown provider; exit 2

pnpm exec opencues set-key groq test_value_delete_me
# → "Stored GROQ_API_KEY in /home/<you>/.cues/.env"

cat ~/.cues/.env
# → contains: GROQ_API_KEY=test_value_delete_me

ls -l ~/.cues/.env
# → permission 600 (rw-------)

pnpm exec opencues set-key groq another_test
# → updates same line; cat .env again to confirm only one GROQ_API_KEY line

# CLEANUP: restore your real key or:
sed -i '/^GROQ_API_KEY=test/d; /^GROQ_API_KEY=another/d' ~/.cues/.env
```

### `check-keys`

```bash
pnpm exec opencues check-keys
# → checks groq + finnhub
# → real keys in env: ✓ with model count / AAPL price
# → no key: prints "-" (not an error)
# → bad key: ✗ with HTTP error message; exit 1
```

### `update`

```bash
pnpm exec opencues update --dry-run
# → detects what's installed (chrome at minimum since we built it)
# → shows the plan: git pull, pnpm install, pnpm build, redeploy each

pnpm exec opencues update --dry-run --no-pull
# → same but skips git pull step

pnpm exec opencues update --help
# → usage info
```

**Live update (run if you actually want to refresh):**
```bash
pnpm exec opencues update --no-pull
# → runs through plan; should succeed end-to-end if everything is healthy
```

### `debug`

```bash
pnpm exec opencues debug
# → prints current state from ~/.opencuesrc

pnpm exec opencues debug on
# → "Set debug-mode: on in /home/<you>/.cues/opencues.md"

cat ~/.opencuesrc
# → frontmatter contains "debug-mode: on"

pnpm exec opencues debug off
# → frontmatter now "debug-mode: off"

pnpm exec opencues debug on --project
# → writes to <cwd>/.cues/opencues.md instead

cat .opencuesrc | head
# → check the project file got the update

# CLEANUP: revert
git checkout -- .opencuesrc
```

---

## ③ Tier 3a — `doctor` + `edit` + `logs` + `list` + `show` (commit `d69e5a6`)

### `doctor`

```bash
pnpm exec opencues doctor
# → prints sections: Workspace, Configs, CC, OC, Chrome, Environment, Runtime IPC
# → ✓ for healthy items, ✗ for missing
# → "Suggested fixes" section at the bottom listing what's missing
# → exit 0 if no warnings, 1 if any warnings

pnpm exec opencues doctor --help
# → usage
```

### `edit`

```bash
EDITOR=cat pnpm exec opencues edit cues
# → cats ~/.cues/cues.md (or auto-creates a stub if missing then cats)

pnpm exec opencues edit garbage
# → unknown <file> error; exit 2

pnpm exec opencues edit opencues --project
# → opens <cwd>/.cues/opencues.md (the repo's own one)
```

### `logs`

```bash
pnpm exec opencues logs
# → shows last 50 lines of /tmp/opencues.log
# → if file missing: error "No log file at /tmp/opencues.log" (expected on a fresh box)

pnpm exec opencues logs --lines 5
# → last 5 lines

# Tail mode (requires Ctrl+C to stop):
pnpm exec opencues logs --tail
# → follows the log; press Ctrl+C
```

### `list`

```bash
pnpm exec opencues list
# → CUES section with names + source files (from <repo>/defaults + ~/.cues if seeded)
# → BLANKS / CONTROLS sections similarly

pnpm exec opencues list --cues
# → only CUES section

pnpm exec opencues list --blanks
# → only CONTROLS section
```

### `show`

```bash
pnpm exec opencues show grammar
# → if grammar exists: prints "Matches for 'grammar'" with each occurrence
#   in priority order. May show TWO entries if it appears in both
#   cues.md AND cues/grammar/CUE.md (folder wins).

pnpm exec opencues show nonsense-name-xyz
# → "no cue/blank/control named ... found"; exit 1
```

---

## ④ Tier 2 chunk 2 — `validate` + `import` (commit `2022ab8`)

### `validate`

```bash
pnpm exec opencues validate
# → checks both project (<cwd>/.cues) and user (~/.cues)
# → prints "Checking ..." per path, then errors/warnings, then summary
# → 0 errors should be expected on a clean checkout
# → exit 0 if no errors

pnpm exec opencues validate --project
# → only project path

pnpm exec opencues validate --strict
# → treats warnings as errors (e.g. "user dir does not exist" becomes fatal)

# Force a parse error to verify error reporting works:
echo "INVALID YAML\n---broken" > /tmp/test.cues
mkdir -p /tmp/test/.cues
cp /tmp/test.cues /tmp/test/cues.md
( cd /tmp/test && pnpm exec --dir=/home/wilfred/opencues opencues validate --project )
# → Should report parse error for /tmp/test/cues.md
# (use `node /home/wilfred/opencues/packages/opencues-cli/bin/cli.cjs validate --project` from /tmp/test if pnpm exec --dir doesn't work)

# CLEANUP:
rm -rf /tmp/test /tmp/test.cues
```

### `import`

```bash
pnpm exec opencues import --help
# → usage with all source forms

pnpm exec opencues import ./.cues --dry-run
# → shows source/target/install plan; exits without changes

# Test local-pack import (the safest source — your own dir):
pnpm exec opencues import ./.cues --name test-pack-delete-me
# → downloads (just copies for local), validates, installs
# → expected: refused if any blank's cue.md has "script: ./X.sh" — that's
#   relative-but-valid; if test fails check the validation logic.
# → if it succeeds: ls ~/.cues/packs/test-pack-delete-me/

# Test --force and --unsafe-allow-scripts behaviour with controlled inputs:
pnpm exec opencues import ./.cues --name test-pack-delete-me
# → "already installed" error; exit 1

pnpm exec opencues import ./.cues --name test-pack-delete-me --force
# → overwrites

# CLEANUP:
rm -rf ~/.cues/packs/test-pack-delete-me

# Live test (requires network) — skip if you'd rather not:
# pnpm exec opencues import gist:<some-real-gist-id-with-cues> --dry-run
```

⚠️ **Known limitation flagged in commit message:** ConfigLoader doesn't yet walk `packs/<name>/` subdirs, so installed packs aren't auto-discovered. The CLI prints a note about this. Symlink the contents into the parent `.cues/` to test runtime behaviour.

---

## ⑤ Tier 2 chunk 1 — `init` + `new` + `run` (commit `c8f1886`)

### `init`

```bash
mkdir /tmp/opencues-init-test && cd /tmp/opencues-init-test
node /home/wilfred/opencues/packages/opencues-cli/bin/cli.cjs init --dry-run
# → plan: 5 CREATE rows for cues.md, blanks.md, opencues.md, README.md
# → "[dry-run] Nothing executed."

node /home/wilfred/opencues/packages/opencues-cli/bin/cli.cjs init
# → creates all 5 files

ls .cues
# → 5 files present

node /home/wilfred/opencues/packages/opencues-cli/bin/cli.cjs init
# → all 5 SKIP (idempotent — never overwrites)

cat cues.md
# → comment-heavy template explaining frontmatter shape

# Test --minimal:
rm -rf .cues
node /home/wilfred/opencues/packages/opencues-cli/bin/cli.cjs init --minimal
cat cues.md
# → empty (just the README is templated)

# CLEANUP:
cd /home/wilfred/opencues
rm -rf /tmp/opencues-init-test
```

### `new`

```bash
pnpm exec opencues new cue test-cue --dry-run
# → "CREATE /home/<you>/.cues/words/test-cue/CUE.md"

pnpm exec opencues new cue test-cue
# → file created with {{NAME}} → "test-cue" substituted

cat ~/.cues/words/test-cue/CUE.md
# → frontmatter + prompt body, references "test-cue"

pnpm exec opencues new cue test-cue
# → refuses to overwrite; exit 1

pnpm exec opencues new garbage foo
# → unknown kind error; exit 2

pnpm exec opencues new cue Bad_Name
# → name validation error (must match /^[a-z][a-z0-9-]*$/); exit 2

pnpm exec opencues new blank my-control --project
# → creates <cwd>/.cues/blanks/my-control/BLANK.md (in repo)

# CLEANUP:
rm -rf ~/.cues/words/test-cue
rm -rf .cues/blanks/my-control
```

### `run`

```bash
pnpm exec opencues run --help
# → usage with per-host details

pnpm exec opencues run claude-code --help
# → forwards to subcommand help (or runs claude-cues with --help arg —
#   depends on shell semantics; either is fine)

# Live: launches claude-cues in the same terminal
pnpm exec opencues run claude-code
# → if claude-cues / claude is on PATH: launches it (Ctrl+D to exit)
# → if not: clear error message + suggestion to install

pnpm exec opencues run opencode --target /tmp/no-such-dir
# → error: "doesn't look like an opencode checkout"; exit 1

pnpm exec opencues run chrome
# → prints chrome://extensions instructions; exit 0
```

---

## ⑥ Tier 1 + bin link — `install`/`uninstall`/`seed-configs`/`which`/`version`/`help` (commits `92a8361`, `3535f7c`)

### `version`

```bash
pnpm exec opencues version
# → opencues v0.1.0 + integration table + library table

pnpm exec opencues -v
# → same (alias)
```

### `help`

```bash
pnpm exec opencues
# → top-level help (since no command = default to help)

pnpm exec opencues help
# → same

pnpm exec opencues help install
# → defers to `opencues install --help`

pnpm exec opencues --help
# → top-level help
```

### `install` / `uninstall`

```bash
pnpm exec opencues install --help
# → usage with all hosts + flags

pnpm exec opencues install
# → missing <host> error; exit 2

pnpm exec opencues install foobar
# → unknown host error; exit 2

# All four CC aliases:
pnpm exec opencues install claude-code --dry-run | head -3
pnpm exec opencues install claudecode  --dry-run | head -3
pnpm exec opencues install claude      --dry-run | head -3
pnpm exec opencues install cc          --dry-run | head -3
# → all four print the same banner + dry-run plan

pnpm exec opencues install --all --dry-run
# → runs install for cc, oc, chrome in sequence (each --dry-run)

pnpm exec opencues uninstall claude-code --dry-run
# → uninstall plan

pnpm exec opencues uninstall --all --dry-run
# → uninstall plan for all three
```

**Live install (only if you actually want to install):**
```bash
pnpm exec opencues install claude-code --target ~/claude-code-cues/node_modules/@anthropic-ai/claude-code/cli.js
# → goes through full install pipeline
# → at the end: ~/claude-code-cues/.opencues/ should exist with core/, runtime/,
#   statusline.sh, scripts/, patch-state/ (tips ship inside cues.md ## Tips)

pnpm exec opencues which | grep -E '✓|-'
# → many ✓ marks for what just got installed
```

### `seed-configs`

```bash
pnpm exec opencues seed-configs --dry-run
# → plan: copies everything from <repo>/defaults to ~/.cues
# → if ~/.cues exists: shows SKIP for each existing file

pnpm exec opencues seed-configs --project --dry-run
# → would write to <cwd>/.cues — should mostly SKIP (we're in the repo)

pnpm exec opencues seed-configs
# → real run; populates ~/.cues if not already there

ls ~/.cues
# → cues.md, blanks.md, opencues.md, cues/, controls/

pnpm exec opencues seed-configs
# → re-run: all SKIP (idempotent)
```

### `which`

```bash
pnpm exec opencues which
# → prints 5 sections (configs, CC, OC, Chrome, runtime IPC) with ✓/- per path
# → if you just installed CC: most CC paths should show ✓
```

---

## ⑦ Earlier landed work (commits `a96853e`, `848bcec`, `c37512b`)

### Shipped defaults (repo dir, formerly `.cues/`, now `defaults/`)

```bash
ls defaults
# → cues.md, blanks.md, opencues.md, cues/, controls/
#   (these are the seed source — NOT an ambient project config anymore)

ls .cues 2>&1
# → "No such file or directory" (repo no longer ships a project config)

ls cues.md 2>&1
# → "No such file or directory" (correctly absent)

# Confirm chrome esbuild reads from the new path:
pnpm --filter @opencues/chrome build 2>&1 | grep -E 'Loaded (cue|control) folders'
# → "Loaded cue folders: ..." and "Loaded control folders: ..."

# Confirm seed-configs sources from defaults/:
pnpm exec opencues seed-configs --dry-run 2>&1 | grep source
# → source: /home/<you>/opencues/defaults
```

### `.cues/` convention (`c37512b`)

```bash
# Verify the search-paths model: drop a project-level config that overrides
# user-level on a name conflict. (Only meaningful if you've run seed-configs.)

pnpm exec opencues list --cues
# → grammar shows up multiple times if both ~/.cues and <cwd>/.cues
#   have it. Folder cue.md wins over monolithic .md within each scope;
#   project wins over user across scopes.

# Verify ConfigLoader sees the new convention by running tests:
pnpm --filter @opencues/runtime test 2>&1 | tail -5
# → 350 tests pass
```

### `seed-configs` per-host scripts (`848bcec`)

```bash
# Per-integration seed (works the same as the umbrella `opencues seed-configs`):
pnpm --filter @opencues/claude-code seed-configs --dry-run
pnpm --filter @opencues/opencode seed-configs --dry-run
# → both show source / target / plan
```

---

## When you're done

```bash
git rm CHECKLIST.md
git commit -m "docs: drop walkthrough checklist (verified)"
```

If anything failed: leave it in place + let me know the section + the failure output.
