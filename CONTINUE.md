# Continue here

> **Read this first when you come back.** Captures where we left off
> + the one open decision + what's actually left to do.

## Where we are (2026-04-25)

- Working tree is **clean** — every codex change is committed.
- `git log master` shows **140 commits ahead of origin/master** (none pushed).
- The codex integration shipped to **alpha** in 27 commits this session
  (`d6d6671` → `4fb7710`).
- All 463 runtime tests green; full install pipeline green
  (9/9 steps including the new TUI-patch step).

## The open decision (this is what you came back to answer)

You asked **"can we stack the codex changes?"** — I asked whether
"stack" meant:

- **A. Squash for cleaner history** — collapse the 27 codex commits
  into fewer logical units. Two granularities I offered:
  - **A1 (per-Tier)**: ~6-7 commits — `Tier 1+2`, `Tier 3`, `Tier 4`,
    `Tier 5`, `Tier 6/7`
  - **A2 (per-feature)**: ~14 commits — squash each feature commit
    with its immediate checklist-update follow-up
- **B. Stack as a PR series** (Graphite/jj-style) — each Tier
  becomes its own branch rebased on master
- **C. Something else** you had in mind

You switched contexts before answering. **Tell me which when you
come back and I'll do it in ~2 min** (it's a `git rebase -i` —
non-trivial but mechanical).

If you don't care, my recommendation is **A1 (per-Tier)** — gives
you a clean review surface (one commit per architectural change)
without losing the granular commit messages (those become the body
of the squash commit).

## The one thing actually left to do (Tier 6)

Interactive verification of the codex TUI. **Needs you on a real
terminal** — I can't drive a TUI session from here.

Prereq + run:
```bash
sudo apt install -y libcap-dev pkg-config   # ~30 sec, Linux-only
pnpm exec opencues install codex             # ~5-10 min first build
pnpm exec opencues run codex                 # launches the patched TUI
```

Then walk T1–T10 in
[`integrations/codex/reintegration/tier-6-verification.md`](integrations/codex/reintegration/tier-6-verification.md).

If T1–T8 pass cleanly, **flip alpha → beta** in:
- `integrations/codex/README.md` (header table + STATUS callout)
- `integrations/codex/HANDOFF.md` (banner at top)
- `damon.md`, `README.md`
- Remove the last unchecked item from
  `integrations/codex/reintegration/parity-review.md` § "Beta-readiness"

## What's already done — quick map

| Doc | Read when you want to |
|---|---|
| [`CODEX-CHECKLIST.md`](CODEX-CHECKLIST.md) | See the full 7-tier breakdown with sub-item status |
| [`integrations/codex/reintegration/parity-review.md`](integrations/codex/reintegration/parity-review.md) | OC-vs-codex feature matrix (7-section table) |
| [`integrations/codex/reintegration/tier-6-verification.md`](integrations/codex/reintegration/tier-6-verification.md) | The T1-T10 walkthrough you'll run after libcap-dev |
| [`packages/opencues-runtime/adapters/codex/REPAIR.md`](packages/opencues-runtime/adapters/codex/REPAIR.md) | 6 live-fixes from this session + 5 environmental gotchas |
| [`integrations/codex/HANDOFF.md`](integrations/codex/HANDOFF.md) | Original handoff doc, now with a "what's done" banner at top |
| [`integrations/codex/patches/tui-bridge-wiring.diff`](integrations/codex/patches/tui-bridge-wiring.diff) | The 230-line unified diff applied to chat_composer.rs by setup.sh |

## Skip-with-rationale items (don't re-open these without reason)

These were intentionally NOT done; rationale lives in commit
messages + `CODEX-CHECKLIST.md`:

- **Tier 3.H** Cursor state export — codex doesn't need it
- **Tier 4.D** Heartbeat — BrokenPipe gives us the death signal
- **Tier 4.G** Directives double-buffer — premature at this scale
- **Tier 7.B** `reintegration/steps.md` — the commit log IS the steps
- **Tier 7.E** `advance.sh` — `git apply` IS the advance step

## State of the codex fork

- Cloned at `~/codex-cues/`, pinned to codex-rs SHA `d58d3cc`
- Bridge crate at `~/codex-cues/codex-rs/opencues-bridge/` (built clean)
- TUI patches applied to `~/codex-cues/codex-rs/tui/{Cargo.toml,src/bottom_pane/chat_composer.rs}`
  (14 OPENCUES_BRIDGE markers in chat_composer.rs)
- Daemon at `packages/opencues-runtime/dist/adapters/codex/v1/daemon.js` (built)
- Launch helper at `~/codex-cues/launch.sh`
- Cargo at `~/.cargo/bin/cargo` (rustup-managed, 1.95.0; the apt-installed
  `/usr/bin/cargo` 1.75 is shadowed by `install.cjs`'s rustup-cargo preference)

## When everything's truly done

`git rm CONTINUE.md` and commit. Same self-deleting pattern
`CLEANUP.md` follows.
