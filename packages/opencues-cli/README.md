# opencues — front-door CLI

Single command for installing, configuring, and inspecting OpenCues across all editor integrations. Today: a thin dispatcher over each `integrations/<host>/bin/install.cjs` plus the cross-cutting bits (`seed-configs`, `which`, `version`).

## Today (from a clone)

```bash
node packages/opencues-cli/bin/cli.cjs <command>
# or, after pnpm install at the workspace root:
pnpm exec opencues <command>
```

## Post-publish (Stage 8)

```bash
npx opencues <command>          # one-off
npm i -g opencues               # global install
```

## Commands (Tier 1, shipped)

| Command | What |
|---|---|
| `opencues install <host>` | Install. `<host>` = `cc`, `oc`, `chrome`, or `--all`. All flags pass through to the per-host installer. |
| `opencues uninstall <host>` | Roll back. Same shape as install. |
| `opencues seed-configs` | Copy `<repo>/.opencues/` defaults into `~/.opencues/`. `--project` writes to `<cwd>/.opencues/` instead. |
| `opencues which` | Show every relevant path (configs, installs, runtime IPC) with ✓/- markers for what exists. |
| `opencues version` | CLI version + per-integration version + declared host compatibility ranges. |
| `opencues help [<command>]` | Discoverable help. |

## Coming (Tier 2)

`import` (download cue packs from URL/gist/github), `init` (scaffold `<cwd>/.opencues/`), `new <kind> <name>` (scaffold a single cue/blank), `validate` (lint configs), `run <host>` (orchestrate launch).

## Coming (Tier 3+)

`doctor`, `edit`, `logs`, `list`, `show`, `set-key`, `update`, `debug`, `search`, `publish`, `benchmark`, `completion`, `self-update`.

## Architecture

```
packages/opencues-cli/
├── bin/cli.cjs               dispatcher; lazy-loads command modules
└── src/commands/
    ├── install.cjs           shells out to integrations/<host>/bin/install.cjs
    ├── uninstall.cjs         same; uninstall action
    ├── seed-configs.cjs      cross-cutting; reads <repo>/.opencues/, writes ~/.opencues/
    ├── which.cjs             pure inspection
    ├── version.cjs           pure inspection
    └── help.cjs              top-level + per-command
```

Per-integration installers stay valid as direct entry points (`pnpm --filter @opencues/claude-code dev-install ...`). The CLI is the discoverable umbrella; both layers are first-class.
