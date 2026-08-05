---
last_updated: 2026-05-10
---

# Adding a New Integration

Concrete file-by-file recipe for adding OpenCues support to a new editor or platform. Distilled from the May 2026 Gemini CLI reintegration — every file listed here was either created or extended for that work.

The shape:

- `@opencues/runtime` already owns navigation, cycling, dim-render, blank-fill, statusline, etc. **You do not reimplement these.**
- A new integration is just **two thin layers**: a per-version *adapter band* inside the runtime package, and a host-specific *bootstrap glue* inside `integrations/<host>/`.
- Plus the standard supporting files: pin, package.json, installer, README, REPAIR.md, and references in shared CLI/config code.

If your host can't follow this shape (e.g. a new browser environment with no Node), use this guide as a starting checklist and mark deviations explicitly.

---

## General guidance

Read this before starting any work on a new integration. The principles below set the boundaries within which the file checklist makes sense.

### Mental model

OpenCues' architecture splits into three layers. Keep them in your head:

1. **`@opencues/core`** — the brain. Pure TypeScript, no I/O. Given text + cue config, answers "what alternatives exist for this word?" Knows nothing about editors, key events, or rendering.
2. **`@opencues/runtime`** — the nervous system. Host-agnostic. Owns Navigation, Cycling, DimRender, BlankFill, Statusline, the `HostAdapter` contract, render-directive ANSI, state classes. Knows nothing about LLMs.
3. **Integration** — the spinal cord. Per-host glue. Implements the `HostAdapter` contract by routing to the host's primitives (its TextBuffer, its key bus, its render loop).

**Your job is layer 3.** If you find yourself reaching into layers 1 or 2 to add host-specific logic, stop. The right move is almost always to find the existing seam in the runtime and route through it. Touching shared modules is reserved for genuine gaps that benefit every host — see the "Shared-module gaps" section below.

### Adapter contract — the only interface

The runtime talks to your host through one interface: `HostAdapter`. Your adapter's job is to implement these methods by calling into the host's actual primitives:

- `getText()` / `setText(text)` / `getCursorOffset()` / `setCursorOffset(offset)` — the host's prompt buffer
- `pushText(text, cursor?)` — async write (the host may batch)
- `forceRender()` — trigger a render cycle
- `onKey(filter, handler)` / `onTextChange(handler)` / `onCursorChange(handler)` — subscribe to host events
- `onRender(handler)` — the runtime emits dim/highlight directives; you apply them
- `readFile` / `readDir` / `writeFile` — only if the host has filesystem access
- `spawnProcess` — only if the host can spawn subprocesses
- `blankInvoke` — bridge to your blanks registry
- `log(level, msg, data?)` — debug + error reporting

If the host can't do something (browser hosts can't spawn subprocesses), leave the field unset. The runtime's `capabilities` array reflects what's actually wired and modules degrade gracefully.

### Choose your patch strategy with eyes open

Your decision here drives the next year of maintenance:

- **Source patches** (preferred when the host ships source). Survives minor version bumps if your anchors are well-chosen substrings of stable upstream lines (e.g. import lines, unique destructure landmarks). The cost: re-verify anchors on every host release.
- **Built-artifact patches** (when only minified output is shipped). Far more fragile — minifier-mangled identifiers (`$wA`, `$xB`) shift between releases. Use only when there's no source-shipping alternative. CC needs this; aim to avoid it.
- **Inline runtime** (when you control the build). Chrome bundles `@opencues/runtime` into the extension at build time. No fork, no patches. Use when the host is your own build artifact.

### Learn from what hurt other integrations

Every existing host has a `REPAIR.md` documenting bugs that surfaced during its initial integration. **Skim them first** — many of those bugs are class-of-problem things that recur:

- `packages/opencues-runtime/adapters/cc/REPAIR.md` — built-artifact patching, S1/S2/S3/S6 seams, ANSI rendering, statusline IPC.
- `packages/opencues-runtime/adapters/oc/REPAIR.md` — keypress filter wrapping, fork dependency installation, bootstrap subscription order.
- `packages/opencues-runtime/adapters/gemini/REPAIR.md` — React render-kick, ZWS source-classification, cwd settings hijack.

If your host shares a host family (React/Ink, raw-string ANSI, Bubble Tea TUI, browser DOM), the corresponding REPAIR.md will save you days.

### Pull-model vs push-model writes

The runtime's wrapped setters queue pending state, not write directly. The host then "pulls" pending state during its render cycle via `consumePendingRender`. This shape:

- **Push-model hosts** (CC's cli.js with its own render loop): just call `applyRender` per cycle. No pending state queueing in the host's path.
- **Pull-model hosts** (React/Ink: gemini, future Chrome React variants): React only re-renders when state changes. Every wrapped setter MUST also trigger a re-render kick (`host.forceRender?.()` from the band, which routes to a `useState` bumper in the host).

If your host is React/Ink, read the gemini REPAIR.md sections LF-1 and LF-2 in detail. Those bugs are the structural consequence of pull-model + React reconciliation, and they took the longest to diagnose.

### Don't over-fit early

Your first patch attempt will be wrong in some way. Plan for iteration:

- Start with the simplest possible patch that boots the runtime in the host. Don't worry about cycling/blanks/statusline yet.
- Verify keys flow through `dispatchKey` end-to-end via temporary `fs.appendFile('/tmp/opencues-keys.log', ...)` logging. Strip after.
- Add visual decoration (`decorateLine`) once keys work.
- Add the statusline / footer integration last.

Each phase should produce something visibly working before adding the next.

### When to write tests vs run manual passes

- **Pin host-specific contracts in `boot.test.ts`** — render-kick is invoked, source-reclassifier marks runtime writes, `consumePendingRender` returns null when nothing is queued. These catch regressions the agentic harness can't see (because headless bypasses the render path).
- **The agentic harness's shared `"host": "any"` scenarios** cover state-level invariants for free. No new scenarios needed unless you add genuinely new behaviour.
- **Manual test pass after every iteration**. Keep the checklist in your integration's CLAUDE.md so future-you doesn't have to remember it.

### Naming, conventions, consistency

OpenCues has 4 hosts; consistency makes them all easier to reason about:

- Fork directory: `~/<host>-cues/` (e.g. `~/.opencues/forks/gemini-cli`)
- Status file: `/tmp/opencues-status-<pid>.json`
- Cursor state file: `/tmp/opencues-cursor-state-<pid>.json`
- Log file (shared): `/tmp/opencues.log`
- Adapter band path: `packages/opencues-runtime/adapters/<short>/<version>/`
- Bootstrap drop-in name: `opencues.ts` (in whatever the host's UI source dir is)

Don't invent new conventions. If you find yourself wanting to, the answer is usually "no — match what CC/OC/gemini do."

### Effort budget — be honest about it

The first iteration of a new integration costs **2-5 days** for someone fresh to OpenCues, **1 day** for someone who's done it before. The variance is almost entirely in the host-specific quirks (the things the REPAIR.md captures). If you're past day 3 and not booting, step back — you're probably fighting the host's render model and need to understand it before patching it.

A second band for an existing host (e.g. opencode's v1.4 → v1.14 jump) is **1-2 hours** because the bootstrap + setup.sh structure is already proven; you're just retargeting anchors and the adapter shape.

---

## Decide three things first

Before touching code:

1. **Host name.** Pick the canonical name (e.g. `gemini-cli`, `vscode`, `helix`). Use that consistently — directory names, alias maps, schema enums, doc tables.
2. **Adapter band path.** `packages/opencues-runtime/adapters/<short>/<version>/` (e.g. `gemini/v0.41/`, `cc/v2.1/`, `oc/v1.14/`). The short name is the directory key; major upstream rewrites get a new band, minor versions reuse one.
3. **Patch strategy.** Four patterns are in use:
   - **Source patches** (gemini, opencode): host ships `.tsx`/`.ts` source. Apply `str.replace` patches against unique anchor strings, then build the host.
   - **Built-artifact patches** (claude-code via tweakcc): host ships minified `cli.js`. Use regex anchors against the minified structure.
   - **Inline runtime** (chrome): we own the build — runtime is bundled into the extension at build time, no host fork.
   - **Self-owned app** (terminal): there is no upstream host to patch. The integration ships its own TUI app (Bun + OpenTUI + SolidJS, invoked as `oc-edit`). Adapter band lives in the runtime as usual; the integration directory holds the Solid app + a bootstrap that hands the textarea ref directly to `boot()`. See `integrations/shell/` for the worked example.

The Gemini recipe below is the **source-patch** flavour. CC's REPAIR.md covers the built-artifact flavour.

---

## File checklist

### 1. Pin file — `integrations/<host>/pin.json`

Records the upstream version + sha that this integration targets.

```json
{
  "version": "0.41.2",
  "sha": "abc123def456...",
  "repo": "google-gemini/gemini-cli"
}
```

`opencues update <host> --to <version>` rewrites this file. Setup script reads it via `node -p "require('./pin.json').version"` — never inline the version in a shell variable.

### 2. Compatibility manifest — `integrations/<host>/compat.json`

Declares which host versions this integration supports. Read by `opencues install` to refuse installs against unsupported versions.

```json
{
  "compatibility": {
    "gemini-cli": "0.41.x"
  }
}
```

### 3. Package metadata — `integrations/<host>/package.json`

Workspace-published package. Mirror the shape of an existing host's `package.json` (e.g. `integrations/opencode/package.json`):

```json
{
  "name": "@opencues/<host>",
  "version": "0.1.0",
  "private": true,
  "description": "OpenCues for <Host> — patches a <Host> fork to add real-time word alternatives, blanks, and cue-controls.",
  "compatibility": { "<host>": "<range>" },
  "bin": { "opencues-<host>": "./bin/install.cjs" },
  "scripts": {
    "dev-install": "node bin/install.cjs install",
    "dev-uninstall": "node bin/install.cjs uninstall",
    "seed-configs": "node bin/install.cjs seed-configs",
    "prepublishOnly": "node ../../scripts/prepublish-guard.cjs"
  },
  "files": ["bin/", "patches/", "README.md"],
  "repository": { "type": "git", "url": "https://github.com/opencues/opencues", "directory": "integrations/<host>" },
  "publishConfig": { "registry": "https://npm.pkg.github.com", "access": "restricted" }
}
```

The pnpm workspace glob `integrations/*` picks this up automatically.

### 4. Installer entry — `integrations/<host>/bin/install.cjs`

The npx entry point. Wraps `patches/setup.sh` with install/uninstall sub-commands and `--target` / `--dry-run` / `--help` flags. Mirror `integrations/gemini-cli/bin/install.cjs` — single source of truth for the install's blast radius (paths it touches, files it removes on uninstall). Shape:

```js
// --target <path>   Path to <host> fork dir (default: $HOME/<host>-cues)
// --dry-run         Print the plan, don't execute
const HOME = os.homedir();
const DEFAULT_FORK = path.join(HOME, '<host>-cues');

function pathsForFork(fork) { /* every path this install touches or removes */ }
function doInstall() { /* clone/patch/build, or print the plan under --dry-run */ }
function doUninstall() { /* revert patches, optionally rm -rf the fork */ }
```

### 5. Setup script — `integrations/<host>/patches/setup.sh`

Idempotent install pipeline. Steps from the Gemini recipe:

1. **Clone the fork** at the pinned sha into `~/<host>-cues` (skip if present).
2. **Install fork deps** (`npm install` / `bun install` / etc.) so the fork's build can resolve its own deps.
3. **Build `@opencues/{runtime,core}`** from this repo via pnpm.
4. **Install built packages** into `<fork>/node_modules/@opencues/{runtime,core}/` by `cp -r dist/` + `package.json`. Each install starts with `rm -rf` so a stale layout can't shadow.
5. **Copy bootstrap** to `<fork>/<host-source-path>/opencues.ts` (or equivalent).
6. **Patch host source files** via Python heredocs using `src.replace(anchor, new, 1)`. Each patch checks for a marker substring of its own injection (`if 'startOpenCues' in src: sys.exit(0)`) to be **idempotent**.
7. **Build the fork** so the host's bin runs the patched code.

Use `OPENCUES_INSTALL_VERBOSE=1` for streaming output, otherwise log to `/tmp/opencues-install-<host>.log` and tail-30 on failure.

### 6. Bootstrap glue — `integrations/<host>/patches/opencuesBootstrap.ts`

The TypeScript glue that gets copied into the fork. Owns:

- Importing `boot` from the adapter band (`@opencues/runtime/dist/adapters/<short>/<version>/boot.js`).
- Constructing the `host` object: `getText`, `getCursorOffset`, `setText`, `setCursorOffset`, `forceRender`, `pushText`, `readFile`, `readDir`, `writeFile`, `spawnProcess`, `log`, `blankInvoke`, `statusFilePath`, `cursorStatePath`, `statusSnapshotHook`, `ttsScriptPath`, `llmApiKeys`.
- Per-host `PromptInputAccess` holder (see `__gcPromptHolder` in the gemini bootstrap).
- Blanks registry (`createBlankInvoke(new Map([...]))` with the runtime-class blanks the host can use).
- Public functions the patched host code calls: `startOpenCues`, `dispatchOpenCuesKey`, `publishPromptAccess`, `notifyOpenCues{Text,Cursor}Change`, `decorateOpenCuesLine`, `consumePendingOpenCues`, `useOpenCuesTip`, `useOpenCuesRenderTick` (React hosts only).

Mirror `integrations/gemini-cli/patches/opencuesBootstrap.ts`.

### 7. Adapter band — `packages/opencues-runtime/adapters/<short>/<version>/`

Four files:

- **`adapter.ts`** — `class <Host><Version>Adapter` implementing the runtime's `HostAdapter` contract by routing to host-supplied bindings.
- **`boot.ts`** — `boot(host)` entry. Wires the adapter, mounts the universal modules via `buildSharedRuntime`, returns `BootResult` (`dispatchKey`, `notifyTextChange`, `notifyCursorChange`, `decorateLine`, `consumePendingRender`, `dispose`, …).
- **`boot.test.ts`** — unit pins for boot contracts AND any host-specific quirks (e.g. the gemini render-kick test pins `host.forceRender?.()` is invoked from every wrapped setter).
- **`holder.test.ts`** — pins the lazy-binding pattern that bridges the host's prompt component (mounted later) to boot()-time host bindings.

Critical for React/Ink hosts: **every wrapped setter must call `host.forceRender?.()`** so React schedules a re-render. Without it, pending state queues forever in interactive mode. See `feedback_react_render_kick.md` in memory.

**Critical for hosts where the buffer lifecycle is non-trivial**
(multiple focusable buffers, session boundaries in a keep-alive
process, host-side buffer clears, paste / undo / IME): wire
`BootResult.resetBufferState()` at every boundary. The failure
mode is silent — a stale `DynDef` from a prior substitution
blocks the next blank with no log line. Shell missed this on
launch (2026-05-28) — a blank's span state (the then-shipped
prompt-improver's, since retired) leaked across keep-alive
sessions and silently broke every subsequent blank.

Full trigger catalogue + symptom table + pre-ship checklist:
[`docs/architecture/universal-integration.md`](../architecture/universal-integration.md)
§ "When to call `resetBufferState()` — the full trigger list".
Single-buffer CLI hosts (CC / OC / gemini-cli) don't need it —
the runtime restarts per session.

### 8. Repair guide — `packages/opencues-runtime/adapters/<short>/REPAIR.md`

Document host-specific known-fixes baked into the adapter. Entries should be: file, symptom, why, fix. Mirror `adapters/oc/REPAIR.md` or `adapters/gemini/REPAIR.md`. This is the page someone reads after an upstream version bump breaks something. Open with the same load-bearing disclaimer every existing one carries — it's the single most useful sentence in the file:

```markdown
# <Host> adapter — repair & version-bump guide

> **The runtime package is intentionally never in this loop.** If you
> find yourself editing `packages/opencues-runtime/src/**` to fix a
> <Host> version bump, stop and ask why — those modules don't know
> what host they're running in. Repairs live in the adapter band only.

## Host quirks (<Host> vX.Y) — read this before debugging anything

### 1. `bindings.getText` is a stale closure after <event>
**Symptom:** ...  **Why:** ...  **Fix:** ...
```

### 9. Integration CLAUDE.md — `integrations/<host>/CLAUDE.md`

User-facing dev notes for the integration. Cover:

- How patching works for this host
- Per-host quirks (e.g. for Gemini: cwd-loaded `.gemini/settings.json` hijacks the render mode if `runGemini` cd's into the fork)
- Things-that-look-like-bugs-but-aren't
- Debug paths
- Manual test pass
- **Buffer-state reset call sites** — list every place this integration calls `resetBufferState()` and the trigger. Future maintainers should be able to grep `resetBufferState` and find them documented. Even if the host calls it zero times (single-buffer CLI), say so explicitly so the next contributor doesn't think it was forgotten.

Mirror `integrations/gemini-cli/CLAUDE.md`.

### 10. Integration README — `integrations/<host>/README.md`

User-facing install + usage docs. Mirror `integrations/gemini-cli/README.md`'s section order — every existing integration README follows it, so a user who's read one can navigate any other:

```markdown
# OpenCues for <Host>

## Install
### Prerequisites
### Install command
### Custom fork location
### Verbose output
## Run
## Uninstall
## Verify
## Configuration
## Where things live (blast radius)
## Update workflow
## See also
```

"Where things live (blast radius)" is the section users read before
trusting the installer with their real editor config — list every
path it touches (fork location, patched files, config dirs) and what
`uninstall` reverts vs. leaves alone.

---

## Wire the new host into shared code

These are scattered — easy to miss. Grep for an existing host (e.g. `gemini-cli`) and add the new one anywhere it appears.

### Code

| File | What to add |
|---|---|
| `packages/opencues-core/src/host-compat.ts` | `HOSTS` array + `NATIVE_HOSTS` array (if subprocess-capable) + doc-string examples |
| `packages/opencues-cli/src/commands/install.cjs` | `HOST_ALIASES`, `HOSTS`, `HOST_FOLDERS`, help text |
| `packages/opencues-cli/src/commands/uninstall.cjs` | `HOST_ALIASES`, `HOSTS`, `HOST_FOLDERS` |
| `packages/opencues-cli/src/commands/run.cjs` | `HOST_ALIASES`, `HOSTS`, `runHost()` function, help text |
| `packages/opencues-cli/src/commands/update.cjs` | `HOST_ALIASES`, `ALL_HOSTS`, `detectInstalled` branch |
| `packages/opencues-cli/src/commands/version.cjs` | `HOSTS` |
| `packages/opencues-cli/src/commands/help.cjs` | install/run/per-host help lines |
| `packages/opencues-cli/src/commands/completion.cjs` | `HOSTS` (include all aliases) |
| `packages/opencues-cli/src/commands/which.cjs` | new "Install state" section + "Shared user-level" + IPC heading |
| `packages/opencues-cli/src/commands/doctor.cjs` | new `## <Host>` section with fork/runtime/core/bootstrap/built-artifact existence checks |
| `packages/opencues-cli/src/commands/set-key.cjs` | host list in the env-var note |

### JSON schemas

| File | What to add |
|---|---|
| `spec/schemas/cue.schema.json` | `on-host` + `not-on-host` enum |
| `spec/schemas/blank.schema.json` | `on-host` + `not-on-host` enum |
| `spec/schemas/auditor.schema.json` | `on-host` + `not-on-host` enum |

**Don't skip schema updates** — any cue/blank/auditor declaring `on-host: [<your-host>]` will fail validation otherwise. This bit us during the gemini reintegration.

### Docs / specs

| File | Update |
|---|---|
| `README.md` | Editor table, install command list, run command list, install steps table, paths table, prerequisites table, package list |
| `CLAUDE.md` (root) | Current Integrations list, config-search-paths table, host-compat sections (3 places) |
| `docs/architecture/repo-structure.md` | adapter band entry, integration dir entry, install-paths row |
| `docs/architecture/spans-and-cycling.md` | adapter list, render-directives note |
| `docs/glossary.md` | Host glossary entry |
| `docs/features/host-compat.md` | Valid host names + API examples + constants table |
| `docs/overview.md` | Install command line |
| `docs/guides/cli-reference.md` | Install/run examples + per-host details row |
| `docs/guides/llm-providers.md` | New host integration note |
| `docs/guides/quickstart.md` | Install alternatives line |
| `docs/guides/adding-a-cue-blank.md` | Bootstrap registration list |
| `spec/core.md` | Known-host names + on-host examples |
| `spec/cue-spec.md` + `spec/blank-spec.md` | on-host examples |
| `spec/auditor-spec.md` | Host-name parenthetical |

### Templates + defaults

| File | Update |
|---|---|
| `packages/opencues-cli/src/templates/CUES.md` | Hot-reload host list |
| `packages/opencues-cli/src/templates/new/cue.md` | Host-compat docstrings + example values |
| `packages/opencues-cli/src/templates/new/blank.md` | Host-compat docstrings + example values |
| `defaults/blanks/opencues/BLANK.md` | `on-host` allow-list (since this blank uses `.sh` but ships a TS implementation for non-script hosts too) |

### Runtime comments

| File | Update |
|---|---|
| `packages/opencues-runtime/src/blanks/types.ts` | "across hosts (...)" comment |
| `packages/opencues-runtime/src/blanks/index.ts` | host-list comment |
| `packages/opencues-core/src/cues-md.ts` | "canonical host names" comment |

### Issue templates

| File | Update |
|---|---|
| `.github/ISSUE_TEMPLATE/bug_report.md` | Host field + version line |
| `.github/ISSUE_TEMPLATE/feature_request.md` | Integration checkbox |

### Test harness

| File | Update |
|---|---|
| `tests/agentic/oc-launch-headless` (header comment) | Hosts list |
| `tests/agentic/oc-pid` (header comment) | Hosts list |
| `tests/agentic/README.md` | Parallel-launch example |

### Memory / feedback

If the integration surfaces a class of bug new to OpenCues (like the React render-kick), capture it in `~/.claude/projects/.../memory/feedback_*.md`. The next session's Claude reads these on every load.

---

## Shared-module gaps you may discover

Adding a new host often surfaces gaps in the shared runtime that weren't visible when only one or two hosts existed. During the Gemini reintegration we found:

- `packages/opencues-runtime/src/modules/navigation.ts` — needed an Escape handler (no host had wired it via the runtime before; CC handled it externally) and a tweak to the right-past-end deactivation rule.
- `packages/opencues-runtime/src/modules/statusline.ts` — `active` payload didn't include span-fill state, so post-substitution scenarios in the agentic harness timed out waiting for `active=true`.

These are **shared improvements**, not host-specific. Commit them as separate prep work before the integration lands so other hosts immediately benefit. Run the full runtime test suite to confirm no regressions.

## Testing strategy

The agentic harness runs hosts in **headless mode** (`OPENCUES_BRIDGE=1`). Headless drains pending state synchronously via `headlessTrigger`, **bypassing the host's render path entirely**. So:

- Existing `"host": "any"` scenarios cover state-level invariants for free — no new scenarios needed for shared behaviour.
- Host-specific render bugs (React kick, ZWS toggle, ANSI cursor preservation) **don't show up in headless**. Pin them with **unit tests in `boot.test.ts`** that assert the contract structurally.
- Manual test pass after any change touching the integration. Document the checklist in the integration's CLAUDE.md.

---

## Bumping the host pin

For a minor version bump within the same adapter band:

1. Update `pin.json` (version + sha).
2. `rm -rf ~/<host>-cues` (full clean clone).
3. Re-run setup. Watch for `WARN: ... anchor not found` — that means an upstream source change moved a patch anchor.
4. If anchors moved, update the `str.replace` calls in `setup.sh` to match the new upstream text.
5. Re-grep the patched files to confirm injections landed.
6. Run the manual test pass.

For a major rewrite (different component layout / API surface), create a new band: `adapters/<short>/v<NEW>/`. Copy the existing band, retarget imports + anchors, leave the old band intact for users on the old major.

---

## Things to NOT do

- **Don't reimplement Navigation/Cycling/DimRender/BlankFill/Statusline.** They live in `@opencues/runtime` and are host-agnostic. Your adapter wires them up via `buildSharedRuntime`, that's it.
- **Don't introduce code paths that concatenate multiple `### alternatives` bodies into one `ConfigSource`.** Per-word dispatch via `RoutedWordSourceGroup` is what gives us prompt-injection isolation.
- **Don't write to the buffer directly from a runtime module.** Always go through `host.setText` (which becomes `wrappedSetText` in the band) so the source reclassifier marks runtime writes — otherwise text-change notifications fire as `'user'` and Navigation deactivates the highlight.
- **Don't hardcode shared-config paths.** Use `host.cwd` + `~/.cues/` resolution from `ConfigLoader` — the search-paths model is unified across hosts.

---

## Rough effort estimate (Gemini precedent)

- Pin/package/installer/README scaffolding: ~30 min
- Adapter band (adapter.ts + boot.ts): ~2 hours, mostly mirroring an existing band
- Bootstrap glue: ~1 hour
- Setup.sh + patch anchors: ~1 hour for a well-structured host source
- Wiring shared code (CLI, schemas, docs): ~30 min
- First end-to-end smoke test: instant if everything else lines up
- **Host-specific quirks**: variable. Gemini took ~1 day because it was the first React/Ink host (render-kick + ZWS source-classification). A second TUI host similar to OpenCode would be much faster.
