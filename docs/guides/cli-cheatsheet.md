---
last_updated: 2026-05-19
---

# `opencues` CLI cheat sheet

Every `opencues` verb in one page, sorted by how often you'll reach
for it. Each row links to the relevant guide where one exists.

> **Tip:** `opencues help <command>` prints the full help for any
> command. `opencues help` lists every command without descriptions.

---

## Day-to-day

| Command | What it does | When you reach for it |
|---|---|---|
| `opencues install <host>` | One-shot installer for `claude-code` / `opencode` / `chrome` / `chrome-host` / `gemini-cli`. Handles fork clone + build + patch end-to-end. | First-time setup; after pulling new core changes. |
| `opencues run <host>` | Launch the patched host with the right env (`OPENCUES_HOME` etc). Also exposed as bare `claude-cues`, `opencode`, `gemini-cli` once installed. | Daily — same shape as launching the editor normally. |
| `opencues new <cue\|blank> <name>` | Scaffold a folder with a pre-filled template. `--project` for `<cwd>/.cues/`, `--dry-run` to preview. | Adding a new cue or blank. See [adding-a-cue-blank.md](adding-a-cue-blank.md). |
| `opencues doctor` | Cross-host install diagnostics. Checks every integration's build-state, every shipped default's presence, every API key. | Anything looks off. **First thing to try when stuck.** |
| `opencues which` | Print every relevant path — installed CC fork, OC fork, chrome bundle, ~/.cues, /tmp logs. Blast-radius view. | "Where did my install actually go?" |

---

## Configuration

| Command | What it does | When you reach for it |
|---|---|---|
| `opencues set-key <provider> <key>` | Store an API key in `~/.cues/.env` (chmod 600). Providers: `cerebras`, `groq`, `gemini`, `anthropic`, `openai`, `openrouter`, `opencode-zen`, `finnhub`. | Shell-agnostic alternative to `export GROQ_API_KEY=...` in `~/.bashrc`. |
| `opencues check-keys` | Probe each configured provider with a tiny test call. Confirms keys actually work (vs just being present). | After `set-key` or after rotating a key. |
| `opencues init` | Scaffold `<cwd>/.cues/` with empty templated `CUES.md`, `BLANKS.md`, `AUDITORS.md`. | Starting a new project that needs project-scoped cues / blanks. |
| `opencues seed-configs` | Copy shipped `defaults/*` into `~/.cues/`. Idempotent — preserves user edits, heals 0-byte files, refreshes contract fields without clobbering user fields. | After a `git pull` that touched `defaults/`. Runs automatically as part of `opencues install`. |
| `opencues update-configs` | Pull new shipped defaults into `~/.cues/` without re-running an install. | When you want the latest shipped cues/blanks but not a runtime/core rebuild. |
| `opencues debug on \| off` | Toggle `debug-mode` in `~/.cues/OPENCUES.md`. | Verbose runtime traces in `/tmp/opencues.log`. |

---

## Inspection

| Command | What it does | When you reach for it |
|---|---|---|
| `opencues list [cues\|blanks\|auditors]` | List every source the runtime will load, across all search paths, with priority + host-compat marker. | "What's actually live in my install?" |
| `opencues show <name>` | Print the resolved config for one cue / blank / auditor — frontmatter + body + which file it came from. | Debugging a config that's not behaving as expected. |
| `opencues validate [--project]` | Lint every `.md` config — bad regex, missing required fields, unknown scope, etc. Exit code 0 if clean. | Before committing a config change. |
| `opencues logs [--tail] [--grep PATTERN]` | Read or tail `/tmp/opencues.log` with optional filter. | Tracing a single resolve cycle. |
| `opencues version` | CLI version + per-integration versions + which install of each is on PATH. | Bug reports — paste the output. |

---

## Integration maintenance

| Command | What it does | When you reach for it |
|---|---|---|
| `opencues update [<host>]` | Re-pull pinned upstream version + rebuild + re-patch. `--check` to dry-run, `--to <ver>` to override the pin. | New upstream release; the per-host `pin.json` got bumped. |
| `opencues uninstall <host>` | Reverse `install` — restore the unpatched fork or remove the patched copy + revert PATH. | Switching from `claude-cues` back to native `claude`. |
| `opencues sync <host>` | Push local `~/.cues/` configs into a sandbox that can't read the filesystem (today: chrome). `--watch` for live sync. | Iterating on chrome-extension configs without re-installing. |
| `opencues import <source>` | Download a third-party config pack from a URL or local path and install it under `~/.cues/`. | Trying someone else's curated cue set. |
| `opencues edit <file>` | Open the named config in `$EDITOR`. | Quick one-off edits without hunting the path. |

---

## Discoverability

| Command | What it does | When you reach for it |
|---|---|---|
| `opencues help [<command>]` | Print discoverable help. Without args, lists every command. | "What was the flag for `install`?" |
| `opencues completion <bash\|zsh\|fish>` | Print a shell completion script to stdout. Pipe it into your shell config. | First-time setup, once per shell. |
| `opencues review` | Security review of a third-party cue pack — shows scripts, prompts, declared capabilities before you install. | Trusting an `opencues import` source. |

---

## Common workflows

### Install + verify

```bash
opencues install claude-code
opencues doctor                # confirms every install boundary
claude-cues                    # launch
```

### Add your first cue

```bash
opencues new cue my-cue
opencues edit ~/.cues/cues/my-cue/CUE.md   # edit the prompt + match: regex
# (hot-reload picks it up within ~2.5s — no restart)
opencues list cues             # confirm it's loaded
```

### Try someone else's pack

```bash
opencues review <pack-url>     # inspect before installing
opencues import <pack-url>
opencues list                  # see what was added
```

### Debug a misbehaving cue

```bash
opencues debug on              # enable verbose runtime traces
opencues logs --tail --grep <cue-name>
opencues show <cue-name>       # what config is the runtime actually using?
opencues validate              # any syntax errors?
opencues debug off             # quiet again
```

### Upgrade after a `git pull`

```bash
git pull
pnpm install && pnpm build
opencues update-configs        # refresh shipped defaults in ~/.cues/
opencues install --all         # rebuild each integration with new core/runtime
```
