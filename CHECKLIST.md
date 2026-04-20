# Walkthrough checklist

Manual smoke tests for the CLI + Codex integration work landed across many stages. Each section maps to a commit (newest first); run through top-to-bottom or jump to the section you care about.

All checks below assume **cwd = the opencues clone** unless stated otherwise. After ticking through, this file can be deleted (`git rm CHECKLIST.md`).

---

## ⓪⓪ Codex integration (commits `7b7e66d`, prior codex skeleton + bridge commits)

This is the BIG new piece overnight. **Status: pre-alpha** — the infrastructure is in place but the TUI patches that wire OpenCues into Codex's `ChatComposer` are not yet implemented. See `integrations/codex/HANDOFF.md` for what remains.

### Verify CLI knows about codex

```bash
pnpm exec opencues version
# → 4 integration rows including @opencues/codex v0.0.1

pnpm exec opencues install --help
# → "Hosts:" section lists 4 hosts; "Install all four" mentioned

pnpm exec opencues install codex --dry-run
# → prints plan (verify cargo / clone fork / build runtime / copy bridge /
#    add to workspace / cargo build / drop launch helper)
# → does NOT require cargo to be on PATH (the dry-run skips pre-flight)

pnpm exec opencues run codex
# → error message: "launch helper missing at $HOME/codex-cues/run-codex-cues.sh"
# → suggests `opencues install codex` first, mentions pre-alpha + HANDOFF.md

pnpm exec opencues uninstall codex --dry-run
# → prints plan (no-op since not installed); exit 0

pnpm exec opencues which | grep -A 5 "Codex"
# → new "Codex install state" section with bridge crate / launch helper /
#    daemon source paths, all marked - (not installed)

pnpm exec opencues doctor 2>&1 | grep -A 5 "## OpenAI Codex"
# → cargo on PATH check, fork-not-installed message, daemon-built check
```

### Smoke test the bridge ↔ daemon (no codex install needed)

The Rust bridge crate has a standalone smoke binary that exercises the JSON-RPC bridge:

```bash
# Requires cargo on PATH:
. "$HOME/.cargo/env" 2>/dev/null
cd integrations/codex/patches/opencues-bridge
cargo run --release --bin opencues-bridge-smoke -- \
  ../../../../packages/opencues-runtime/dist/adapters/codex/v1/daemon.js
# Expected output:
#   [smoke] spawning daemon: ".../daemon.js"
#   [smoke] sending text-change notification...
#   [smoke] dispatching key event (always returns false in scaffold)...
#   [smoke] consumed = false
#   [opencues-bridge][info] daemon started; pid=...
#   [opencues-bridge][info] daemon booted (params={...})
#   [smoke] directives: 0 dim ranges, active = None, tip = None
#   [smoke] dropping bridge → daemon should exit cleanly
#   [opencues-bridge][info] daemon shutting down (stdin closed)
```

This proves the JSON-RPC wire format works end-to-end. The remaining work (per HANDOFF.md) is hooking the bridge into Codex's TUI.

### Live install codex (long — ~5 min cargo build)

⚠️ This actually clones openai/codex (~hundreds of MB) and runs cargo build. Skip if you're just reviewing.

```bash
pnpm exec opencues install codex
# → clones $HOME/codex-cues
# → builds @opencues/runtime
# → copies bridge crate
# → adds to workspace
# → cargo build --release for the bridge crate (slow first time)
# → smoke-tests the bridge
# → drops $HOME/codex-cues/run-codex-cues.sh

pnpm exec opencues uninstall codex
# → reverts Cargo.toml workspace addition via git checkout
# → removes bridge crate dir
# → removes launch helper
# → leaves the fork dir itself (rm -rf $HOME/codex-cues to fully clean)
```

### Read the HANDOFF

`integrations/codex/HANDOFF.md` is the single source of truth for what's done vs what needs human attention. Three TODO items:
1. Wire the bridge into `chat_composer.rs` (4-8 hr Rust work)
2. Add the in-place TUI patches to setup.sh (30 min)
3. Verify end-to-end (1 hr)

`integrations/codex/docs/protocol.md` and `integrations/codex/docs/architecture.md` document the JSON-RPC wire format and the three-piece (daemon ↔ bridge ↔ TUI) design.

---

## ⓪⓪⓪ Doc updates (commits `13d8e70`, `83948f9`)

The HIGH + MEDIUM stale-doc fixes from the audit. No commands to run; just read-through. Spot-check that:

- `README.md` install section uses `pnpm exec opencues install <host>`
- `CLAUDE.md` install destination is `~/.claude/opencues/` (not `~/.claude/node_modules/`)
- `integrations/claude-code/README.md` and `integrations/claude-code/patches/README.md` reflect the consolidated layout
- `docs/guides/quickstart.md` uses `pnpm` and `opencues install claude-code`
- Various feature/guide docs no longer reference `~/.claude/actions/` or `~/.claude/highlight-statusline.sh` directly

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
# → "Stored GROQ_API_KEY in /home/<you>/.opencues/.env"

cat ~/.opencues/.env
# → contains: GROQ_API_KEY=test_value_delete_me

ls -l ~/.opencues/.env
# → permission 600 (rw-------)

pnpm exec opencues set-key groq another_test
# → updates same line; cat .env again to confirm only one GROQ_API_KEY line

# CLEANUP: restore your real key or:
sed -i '/^GROQ_API_KEY=test/d; /^GROQ_API_KEY=another/d' ~/.opencues/.env
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
# → prints current state from ~/.opencues/opencues.md

pnpm exec opencues debug on
# → "Set debug-mode: on in /home/<you>/.opencues/opencues.md"

cat ~/.opencues/opencues.md
# → frontmatter contains "debug-mode: on"

pnpm exec opencues debug off
# → frontmatter now "debug-mode: off"

pnpm exec opencues debug on --project
# → writes to <cwd>/.opencues/opencues.md instead

cat .opencues/opencues.md | head
# → check the project file got the update

# CLEANUP: revert
git checkout -- .opencues/opencues.md
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
# → cats ~/.opencues/cues.md (or auto-creates a stub if missing then cats)

pnpm exec opencues edit garbage
# → unknown <file> error; exit 2

pnpm exec opencues edit opencues --project
# → opens <cwd>/.opencues/opencues.md (the repo's own one)
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
# → CUES section with names + source files (from <repo>/.opencues + ~/.opencues if seeded)
# → BLANKS / CONTROLS sections similarly

pnpm exec opencues list --cues
# → only CUES section

pnpm exec opencues list --controls
# → only CONTROLS section
```

### `show`

```bash
pnpm exec opencues show grammar
# → if grammar exists: prints "Matches for 'grammar'" with each occurrence
#   in priority order. May show TWO entries if it appears in both
#   cues.md AND cues/grammar/cue.md (folder wins).

pnpm exec opencues show nonsense-name-xyz
# → "no cue/blank/control named ... found"; exit 1
```

---

## ④ Tier 2 chunk 2 — `validate` + `import` (commit `2022ab8`)

### `validate`

```bash
pnpm exec opencues validate
# → checks both project (<cwd>/.opencues) and user (~/.opencues)
# → prints "Checking ..." per path, then errors/warnings, then summary
# → 0 errors should be expected on a clean checkout
# → exit 0 if no errors

pnpm exec opencues validate --project
# → only project path

pnpm exec opencues validate --strict
# → treats warnings as errors (e.g. "user dir does not exist" becomes fatal)

# Force a parse error to verify error reporting works:
echo "INVALID YAML\n---broken" > /tmp/test.opencues
mkdir -p /tmp/test/.opencues
cp /tmp/test.opencues /tmp/test/.opencues/cues.md
( cd /tmp/test && pnpm exec --dir=/home/wilfred/opencues opencues validate --project )
# → Should report parse error for /tmp/test/.opencues/cues.md
# (use `node /home/wilfred/opencues/packages/opencues-cli/bin/cli.cjs validate --project` from /tmp/test if pnpm exec --dir doesn't work)

# CLEANUP:
rm -rf /tmp/test /tmp/test.opencues
```

### `import`

```bash
pnpm exec opencues import --help
# → usage with all source forms

pnpm exec opencues import ./.opencues --dry-run
# → shows source/target/install plan; exits without changes

# Test local-pack import (the safest source — your own dir):
pnpm exec opencues import ./.opencues --name test-pack-delete-me
# → downloads (just copies for local), validates, installs
# → expected: refused if any control's cue.md has "script: ./X.sh" — that's
#   relative-but-valid; if test fails check the validation logic.
# → if it succeeds: ls ~/.opencues/packs/test-pack-delete-me/

# Test --force and --unsafe-allow-scripts behaviour with controlled inputs:
pnpm exec opencues import ./.opencues --name test-pack-delete-me
# → "already installed" error; exit 1

pnpm exec opencues import ./.opencues --name test-pack-delete-me --force
# → overwrites

# CLEANUP:
rm -rf ~/.opencues/packs/test-pack-delete-me

# Live test (requires network) — skip if you'd rather not:
# pnpm exec opencues import gist:<some-real-gist-id-with-cues> --dry-run
```

⚠️ **Known limitation flagged in commit message:** ConfigLoader doesn't yet walk `packs/<name>/` subdirs, so installed packs aren't auto-discovered. The CLI prints a note about this. Symlink the contents into the parent `.opencues/` to test runtime behaviour.

---

## ⑤ Tier 2 chunk 1 — `init` + `new` + `run` (commit `c8f1886`)

### `init`

```bash
mkdir /tmp/opencues-init-test && cd /tmp/opencues-init-test
node /home/wilfred/opencues/packages/opencues-cli/bin/cli.cjs init --dry-run
# → plan: 5 CREATE rows for cues.md, blanks.md, controls.md, opencues.md, README.md
# → "[dry-run] Nothing executed."

node /home/wilfred/opencues/packages/opencues-cli/bin/cli.cjs init
# → creates all 5 files

ls .opencues
# → 5 files present

node /home/wilfred/opencues/packages/opencues-cli/bin/cli.cjs init
# → all 5 SKIP (idempotent — never overwrites)

cat .opencues/cues.md
# → comment-heavy template explaining frontmatter shape

# Test --minimal:
rm -rf .opencues
node /home/wilfred/opencues/packages/opencues-cli/bin/cli.cjs init --minimal
cat .opencues/cues.md
# → empty (just the README is templated)

# CLEANUP:
cd /home/wilfred/opencues
rm -rf /tmp/opencues-init-test
```

### `new`

```bash
pnpm exec opencues new cue test-cue --dry-run
# → "CREATE /home/<you>/.opencues/cues/test-cue/cue.md"

pnpm exec opencues new cue test-cue
# → file created with {{NAME}} → "test-cue" substituted

cat ~/.opencues/cues/test-cue/cue.md
# → frontmatter + prompt body, references "test-cue"

pnpm exec opencues new cue test-cue
# → refuses to overwrite; exit 1

pnpm exec opencues new garbage foo
# → unknown kind error; exit 2

pnpm exec opencues new cue Bad_Name
# → name validation error (must match /^[a-z][a-z0-9-]*$/); exit 2

pnpm exec opencues new control my-control --project
# → creates <cwd>/.opencues/controls/my-control/cue.md (in repo)

# CLEANUP:
rm -rf ~/.opencues/cues/test-cue
rm -rf .opencues/controls/my-control
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
pnpm exec opencues install claude-code --target ~/local-claude-code/node_modules/@anthropic-ai/claude-code/cli.js
# → goes through full install pipeline
# → at the end: ~/.claude/opencues/ should exist with core/, runtime/, tips.json,
#   statusline.sh, actions/, tweakcc-state/

pnpm exec opencues which | grep -E '✓|-'
# → many ✓ marks for what just got installed
```

### `seed-configs`

```bash
pnpm exec opencues seed-configs --dry-run
# → plan: copies everything from <repo>/.opencues to ~/.opencues
# → if ~/.opencues exists: shows SKIP for each existing file

pnpm exec opencues seed-configs --project --dry-run
# → would write to <cwd>/.opencues — should mostly SKIP (we're in the repo)

pnpm exec opencues seed-configs
# → real run; populates ~/.opencues if not already there

ls ~/.opencues
# → cues.md, blanks.md, controls.md, opencues.md, cues/, controls/

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

### Repo-self-dogfood (`a96853e`)

```bash
ls .opencues
# → cues.md, blanks.md, controls.md, opencues.md, cues/, controls/
#   (NOT at the repo root anymore — under .opencues/)

ls cues.md 2>&1
# → "No such file or directory" (correctly absent)

# Confirm chrome esbuild reads from new path:
pnpm --filter @opencues/chrome build 2>&1 | grep -E 'Loaded (cue|control) folders'
# → "Loaded cue folders: ..." and "Loaded control folders: ..."
```

### `.opencues/` convention (`c37512b`)

```bash
# Verify the search-paths model: drop a project-level config that overrides
# user-level on a name conflict. (Only meaningful if you've run seed-configs.)

pnpm exec opencues list --cues
# → grammar shows up multiple times if both ~/.opencues and <cwd>/.opencues
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
