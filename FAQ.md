# FAQ

Common questions about installing, running, and uninstalling OpenCues.
For conceptual docs see [README.md](README.md) and [docs/](docs/); for
per-integration detail see `integrations/<host>/README.md`.

---

## Install

### Is install really one command per integration?

Yes. From a fresh OpenCues clone:

```bash
pnpm install
opencues install <host>   # claude-code | opencode | chrome | --all
```

That covers everything the host needs. Specifically:

| Host | What the installer does |
|---|---|
| `claude-code` | `opencues seed-configs` (shared `~/.cues/`) → nuke prior CC state + reinstall pinned `@anthropic-ai/claude-code@2.1.110` → clone tweakcc into `<CC_FORK>/.opencues/tweakcc/` → patch tweakcc (every stock patch disabled, only OpenCues v2 wiring) → build `@opencues/{core,runtime}` into `<CC_FORK>/node_modules/@opencues/` → install statusline.sh into `<CC_FORK>/.opencues/` → apply tweakcc to cli.js + verify v2 boot landed. ~1m warm. tweakcc is just our patcher tool. |
| `opencode` | Clone `sst/opencode` fork → `bun install` the fork's deps → build `@opencues/{core,runtime}` → install into `<fork>/node_modules/@opencues/` → patch 3 TSX files in place |
| `chrome` | Build MV3 extension → copy `dist/` to `--target` if provided |

After install, launch with `opencues run <host>` (except Chrome, which you load manually in `chrome://extensions`).

### What do I need installed first?

Universal: Node.js 18+, [pnpm](https://pnpm.io), a Groq API key (or any OpenAI-compatible provider).

Per-integration (the HOST's requirements, not OpenCues's):

| Host | Extra |
|---|---|
| `claude-code` | Claude Code CLI on PATH |
| `opencode` | [bun](https://bun.sh) (OpenCode itself is a bun app) |
| `chrome` | Chrome 121+ |

A claude-code-only user never needs bun. See `README.md § Requirements` for the full table.

### Can I use `opencues` directly instead of `pnpm exec opencues`?

Yes, once the binary is on PATH. Options:

- **From a clone** (today): `pnpm exec opencues <cmd>` always works. Add a shim if you want the short form:
  ```sh
  ln -s "$(realpath node_modules/.bin/opencues)" ~/.local/bin/opencues
  ```
  (Actually: pnpm's shim breaks through symlinks — use a wrapper script at `~/.local/bin/opencues` that `exec`s the real binary by absolute path.)
- **Post-publish (Stage 8)**: `npx @opencues/<host> install` will be the user-facing entry point; no clone required.

Installer hints automatically print whichever form works in your shell.

### Does `opencues init` scaffold `OPENCUES.md`?

**No.** `OPENCUES.md` holds system-wide settings (voice-mode, tips-mode, debug-mode, cursor-navigate) whose schema is defined by the OpenCues runtime — not by users or projects. One value applies across every integration. It's runtime-owned:

- Lives at user-level only: `~/.cues/OPENCUES.md`
- Seeded from `defaults/OPENCUES.md` by `opencues seed-configs` (and re-seeded automatically if the file is 0-bytes — the `OpenCuesSettingsBlank` silently no-ops on empty content, so a 0-byte file would silently break `opencues ___` / `config ___` blank-fills)
- `setup.sh` self-heals an empty `OPENCUES.md` on every install (section 7a-bis)
- `opencues init` scaffolds only `CUES.md`, `BLANKS.md`, `README.md` in a project

### Can I have project-level `OPENCUES.md`?

No — it's intentionally user-level only. A project-level override would violate the "one value across every integration" invariant. `CUES.md`, `BLANKS.md` can all be project-level overrides; `OPENCUES.md` cannot.

### The install output is too verbose / too quiet — can I change it?

Default is compact:
```
  ▸ Cloning sst/opencode (~250MB) ✓
  ▸ Installing fork dependencies (bun install) ✓
  ▸ Building @opencues/{runtime,core} ✓
  ▸ Installing runtime + core into fork ✓
  ▸ Patching fork (3 files + bootstrap) ✓
```

Set `OPENCUES_INSTALL_VERBOSE=1` to stream every command's output live. The quiet-mode log is always saved to `/tmp/opencues-install-<host>.log` (so if a step fails, you get the last 30 lines + a log-path pointer).

---

## Uninstall

### Is uninstall really one command?

Yes: `opencues uninstall <host>` (or `--all`). Each integration reverts its patches + removes its install dir:

| Host | What uninstall does |
|---|---|
| `claude-code` | Revert `cli.js` from backup → `rm -rf ~/claude-code-cues/.opencues/` |
| `opencode` | `git checkout --` on 3 patched TSX files → remove `<fork>/node_modules/@opencues/` → remove bootstrap |
| `chrome` | Remove the Chrome extension's `dist/` in the repo; remove the `--target` deploy if one was used |

### What does uninstall NOT remove?

By design:
- **User configs** (`~/.cues/`) — your cues/blanks survive so re-install doesn't lose settings
- **The OpenCues clone** (`~/opencues/`) — that's your repo, not an installer artefact
- **Cloned forks** (`~/opencode-cues/`) — that's your host checkout, not OpenCues's to manage
- **`claude-code-cues`** (your optional local Claude Code install) — same reasoning

### How do I fully remove OpenCues from my machine?

See `README.md § Removing § Fully removing OpenCues`. Four steps:

```bash
opencues uninstall --all
rm -rf ~/.cues          # user configs
rm -rf ~/opencues           # the repo
rm -rf ~/opencode-cues ~/claude-code-cues    # cloned forks (only what you have)
```

### Uninstall failed partway — what now?

The main failure mode is OpenCode's uninstall refusing to `git checkout` a dirty working tree (you edited one of the three patched files). Stash/commit your changes and re-run. CC and Chrome are idempotent — safe to re-run.

---

## Where things live

### Where does each host store its install state?

| Path | Owner | Purpose |
|---|---|---|
| `~/claude-code-cues/.opencues/` | `@opencues/claude-code` | Everything CC needs — `core/`, `runtime/`, `scripts/`, `patch-state/`, `tips.json`, `statusline.sh`. Uninstall = `rm -rf` this dir + revert `cli.js`. |
| `~/claude-code-cues/` | Your local Claude Code install (optional) | Where the `claude-cues` alias points. The auto-detect in `opencues install claude-code` looks here and at the standard native install path. |
| `~/opencode-cues/` | OpenCode fork (cloned on install) | Patched fork; `~/opencode-cues/node_modules/@opencues/` contains our built libs; three TSX files are patched in place. |
| `~/.cues/` | You (user configs) | Your cues/blanks + user-level `OPENCUES.md`. Shared by every host. |
| `<cwd>/.cues/` | Your project | Project-level overrides for cues/blanks. |
| `/tmp/opencues.log` | Runtime | Debug log from whichever host is actively running. |
| `/tmp/opencues-install-<host>.log` | Installer | Most recent install output (kept on success too for re-inspection). |
| `/tmp/opencues-cursor-state.json`, `/tmp/opencues-highlight-state-<pid>.json` | Runtime | Host-agnostic IPC files; created while a patched host runs. |

For a live view: `opencues which` prints every path with ✓ / − markers showing what actually exists.

### Why isn't `~/.cues/` the one install dir for everything?

Two reasons:

1. **Host integrations need to touch host-specific spots** — CC patches a `cli.js` sitting under `~/.claude/` or wherever Claude Code was installed; OpenCode patches TSX files inside a fork directory; Chrome builds into the repo's own `integrations/chrome/dist/`. None of those are "user config" — they're patched-host artefacts.
2. **`~/.cues/` is purely config**. Cues, blanks, and settings you edit. Conceptually separate from compiled runtime and patched binaries.

### Where are the OpenCode bits specifically?

See `integrations/opencode/README.md § Where things live`:

- `~/opencode-cues/node_modules/@opencues/core/` — built `@opencues/core`
- `~/opencode-cues/node_modules/@opencues/runtime/` — built `@opencues/runtime`
- `~/opencode-cues/packages/opencode/src/cli/cmd/tui/opencues.ts` — bootstrap
- `app.tsx`, `component/prompt/index.tsx`, `feature-plugins/home/footer.tsx` — patched in place (revertable via `git checkout`)

---

## Running / using

### Why does `opencues run opencode` say "Done. Launch with: pnpm exec opencues run opencode" vs just "opencues run opencode"?

The installer probes whether `opencues` is on PATH and picks the form that works in your shell. If you see the `pnpm exec` form, add a shim (see above) or use it as-is — both work from inside the OpenCues clone.

### Where do I see runtime logs?

`/tmp/opencues.log`. Tail it with:

```bash
opencues logs --tail
```

### How do I toggle debug mode?

```bash
opencues debug on    # or: off
```

That rewrites `~/.cues/OPENCUES.md`'s `debug-mode:` scalar. Hot-reload picks it up within ~2s on the next keystroke.

### Something's broken — what do I run first?

```bash
opencues doctor
```

Cross-host diagnostics with suggested fixes. Then `opencues which` for the live path layout, then `opencues logs --tail` for the runtime log.

---

## Configuration

### What's the difference between `~/.cues/CUES.md` and `<cwd>/.cues/CUES.md`?

User-level (`~/.cues/`) is your global default — applies everywhere. Project-level (`<cwd>/.cues/`) applies only when you run a host from inside that project. Project wins on name conflicts (cue source name, blank mode name, blank name).

The load precedence is `$OPENCUES_HOME` → project → user, in that order.

### Can I edit `OPENCUES.md` by hand?

You can edit the *scalar values* (`voice-mode: active ↔ inactive`, etc.) if you prefer — they hot-reload. The *settings block* shape (the nested `settings:` with `tip:` and `values:` entries) is runtime-defined; the runtime will overwrite additions during settings writes.

### How do I scaffold a new cue / blank?

```bash
opencues new cue my-synonyms            # → ~/.cues/cues/my-synonyms/CUE.md
opencues new blank my-answer --project   # → ./.cues/blanks/my-answer/BLANK.md
```

The scaffolded `cue.md` is a thorough schema reference — every frontmatter field documented with examples. Validate after editing:

```bash
opencues validate --project
```

---

## Troubleshooting

### `opencues install opencode` exits with setup.sh non-zero

The installer's quiet mode shows the last 30 lines of `/tmp/opencues-install-oc.log` on failure + a log path. Common causes:

- **bun not on PATH** — the installer pre-flights this; install bun from https://bun.sh/
- **pnpm not on PATH** — same, install pnpm from https://pnpm.io
- **Fork path points at a non-opencode dir** — pass `--target /path/to/real/opencode/checkout` or delete `~/opencode-cues/` and re-run

Re-run with `OPENCUES_INSTALL_VERBOSE=1` to stream live.

### `opencues run opencode` says "preload not found @opentui/solid/preload"

Means the fork's `bun install` hasn't run. Re-run `opencues install opencode` — the installer runs `bun install` inside the fork as part of the install flow.

### `opencues run opencode` silently exits 0 with no output

Shouldn't happen anymore — the runtime detects spawn failures and reports exit 127 with a reason (missing bun, binary unfindable, etc.). If you're still seeing silent exits, you're likely on a stale checkout; `git pull && pnpm install`.

### A transform-blank produced a half-translated / bilingual buffer (e.g. Japanese first half, English second half)

Symptom: you typed something like `translate to japanese _` on a long letter and got back a buffer that's Japanese for the first few paragraphs and English for the rest, often with the original `translate to japanese _` trigger phrase still visible at the end.

Cause: the LLM hit its `max_tokens` cap mid-output. Dense scripts (Japanese / Chinese / Korean / Arabic) take ~3 BPE tokens per character. Combined with the FUSED prompt's reasoning overhead (`reasoning_effort: medium` typically costs 500-1500 tokens before any output) and the model's tendency to verbatim-echo the TARGET section (~700 tokens for a long letter), the cumulative output can exceed the budget on long letters. The runtime's three-way merge then preserves the English tail of the live buffer — which produces the bilingual result rather than silently dropping content.

What's already done: as of May 2026 the FUSED budget is `floor=4096, ceiling=16384` (was `2048/4096`). The probe in `tests/benchmarks/transform-blank/budget-translate-probe.ts` measured latency + cost as flat across budgets — providers bill on emitted tokens, not the cap, so a higher ceiling has no downside. This handles all typical letters.

If you still see the bilingual buffer:

- **Confirm via the log.** `/tmp/opencues.log` contains a line like `TransformBlank FUSED (...ms, max_tokens=4096, source=...): verdict=TRANSFORM, instruction="...", target="...", rewrite="<truncated>...` — if the rewrite ends mid-sentence with no closing punctuation, the LLM was truncated.
- **Workaround**: clear the bilingual content, paste the original English back, and re-trigger. Cerebras's output is non-deterministic — a re-run often completes.
- **Open an issue** with the relevant log snippet (the `TransformBlank FUSED` line + the next 10 lines). We may need to raise the ceiling further or add a parser-side truncation detector that refuses the substitute when the LLM output looks incomplete.

Note: the *runaway loop* class (LLM leaves a `_` in its rewrite → runtime re-fires the `_`-pipeline indefinitely) was structurally fixed in the same May 2026 sprint by the multi-shot source reclassifier in `boot-common.ts`. Even when the LLM mis-emits a trigger character into its output, the runtime tags the substitute as `source='runtime'` and the Resolver skips it — so this bug class no longer produces 4+ cycles per `_` like it did in chrome's Gmail compose.
