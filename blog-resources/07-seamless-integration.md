# 07 — Seamless Integration

For blog post #16: "Seamlessly integration".

## The claim

OpenCues runs in **four very different hosts** (Claude Code, OpenCode, Chrome,
Codex), each with completely different rendering, IPC, and install models —
but the same `.md` config files work in all of them, the same runtime
features ship to all of them, and the same `opencues install <host>`
command sets each one up.

That's the seamlessness story. Read [`02-why-the-structure-is-magical.md`](02-why-the-structure-is-magical.md)
for the architectural underpinning; this file focuses on the integration
mechanics specifically.

## The four hosts (and how different they are)

| Host | Rendering | IPC | Install |
|---|---|---|---|
| **Claude Code** | ANSI escape sequences in a TTY | Direct in-process (Node.js) | `tweakcc` patches injected into `cli.js` |
| **OpenCode** | TUI in a terminal | Direct in-process (Bun) | Patched fork at a pinned SHA |
| **Chrome** | CSS Custom Highlight API in `<textarea>` / `contenteditable` | Web extension messaging | Manifest V3 unpacked extension |
| **Codex** | Rust TUI | Rust ↔ Node JSON-RPC bridge | Rust crate + TUI patches |

These are about as different as host environments get. Two terminals, one
browser, one Rust TUI. Two Node-based, one Bun, one Rust. Two patch-injection
models, one fork, one extension manifest.

## The single API that connects them all

Every host implements the same `HostAdapter` contract. From `damon.md`:

```
            (single API)
                  ▼
┌──────────────────────────────────────────────────┐
│  @opencues/runtime  (host-agnostic — nervous     │
│                       system)                    │
│  Navigation · Cycling · BlankFill · DimRender ·  │
│  ConfigLoader · DynDefs · SpanFillState · TS     │
│  blanks (HN, Stocks, Weather, …)                 │
└──────────────────────────────────────────────────┘
```

The `HostAdapter` contract is the seam. Every host implements:
- `setText(newText)` — replace the buffer
- `getCursorOffset()` / `setCursorOffset()` — cursor position
- `pushText(text, cursor)` — atomic text-and-cursor update where supported
- `forceRender()` — explicit re-render trigger (for hosts where text-change
  doesn't auto-render)
- `blankInvoke({ blankName, action, args })` — dispatch a blank operation
  (registry first, subprocess fallback)
- `log(level, msg)` — debug logging in the host's preferred channel
- text-change subscription — fires on every keystroke

That's basically it. Host-specific behaviour (ANSI vs CSS Highlight API vs
Rust IPC) is hidden behind these methods.

## Per-host adapter "bands"

The runtime keeps adapter-specific code in versioned bands:

```
packages/opencues-runtime/adapters/
├── cc/v2.1/      # Claude Code 2.1.x adapter
├── oc/v1.4/      # OpenCode 1.4.x adapter
├── chrome/v1/    # Chrome extension adapter
└── codex/...     # Codex adapter (alpha)
```

Each band can pin to a specific host version. When CC bumps from 2.1 to 2.2,
a new `cc/v2.2/` band is added; the v2.1 band stays for users on the old
version.

## The same config, four hosts

Every cue / blank is defined in a `.md` file. The same file works in any host
(modulo `host-compat` filtering — see below).

```yaml
# defaults/cues/legal/cue.md
---
name: legal
match: \b(liability|tort|defendant|plaintiff)\b
priority: 80
---
Provide 3 alternative legal terms for each word: synonym, formal, informal.
```

This file is identical for CC, OC, Chrome, and Codex. The runtime parses it,
builds a `ConfigSource`, plugs it into `RoutedWordSourceGroup`, and the host
inherits the cue automatically.

## Host-compat: per-entry portability

Not every cue / blank works in every host. Chrome can't spawn subprocesses, so
shell-script blanks (volume, brightness) don't work there. From
`docs/features/host-compat.md`:

```yaml
on-host: [chrome, claude-code, codex, opencode]   # allow-list
not-on-host: [chrome]                              # deny-list
```

Resolution: `on-host` (if set) wins over auto-detect, then `not-on-host`
filters. Auto-detect: `.sh` / `.ps1` / `.bat` / etc. → not chrome.

Surfaced by `opencues list` (per-entry marker), validated by `opencues
validate` (typos + contradictions), used by `opencues sync chrome` to filter
the bundle.

## TS-class blanks: write once, run everywhere

The hoist from shell scripts to TypeScript classes (HackerNews, Stocks,
Weather, etc.) is the single biggest seamlessness win. From
`docs/features/cue-blanks.md`:

> Several blanks were hoisted from per-host shell scripts into TypeScript
> classes living in `packages/opencues-runtime/src/blanks/`:
>
> Why hoist them: chrome can't spawn subprocesses, so the shell-script model
> excluded chrome from these blanks entirely. A TS class lives in the runtime
> that ships with every host — same code, every host.

The shared `createBlankInvoke` factory in
`@opencues/runtime/src/boot-common.ts` keeps the registry-then-spawn fallback
consistent across hosts. The host's bootstrap registers the TS classes; if
`blankInvoke` doesn't find a registered class, it falls through to
`spawnProcess` for OS-bound blanks.

## The single CLI: `opencues`

From `damon.md`:

> Single front-door for managing every host integration. OpenCues spans four
> hosts with very different install models — CC patches `cli.js` via
> `tweakcc`, OpenCode patches a forked source tree, Chrome bundles configs
> into the extension, Codex patches a Rust TUI. The `opencues` CLI normalizes
> "install / update / debug" so you don't have to remember each
> integration's quirks.

```
opencues install claude-code     # or: opencode | chrome | codex | --all
opencues update                  # pull, rebuild, redeploy installed integrations
opencues seed-configs            # copy repo defaults to ~/.cues/
opencues which                   # print every relevant path (installs, configs, logs)
opencues doctor                  # cross-host diagnostics + suggested fixes
```

`opencues install --all` then `opencues update` keeps everything fresh in one
command.

## Hot-reload across hosts

`.md` config changes hot-reload within ~2 seconds on the next keystroke for
native hosts (CC, OC, Codex). Chrome polls a content-addressable `.version`
hash so `opencues sync chrome --watch` propagates edits into already-open
tabs. **No restart needed in any host.**

Implementation difference, same UX.

## Chrome-specific: bundle-via-sync

Chrome can't read the filesystem at runtime, so `opencues sync chrome`
bundles `.cues/` into the extension's `dist/configs/`. Defaults to user-level
only:

```bash
opencues sync chrome --wsl                              # user-level only (default)
opencues sync chrome --include ~/work/proj/.cues --wsl  # + one project
```

The watch mode (`--watch`) propagates edits live. The runtime polls a
content hash for invalidation.

## Real-world seamless behaviour: sync demo

Type `volume _` in:
- **Claude Code** — `volume 50%` appears in your prompt; Up/Down changes
  system volume, dimmed.
- **OpenCode** — same.
- **Chrome** in Gmail — same.
- **Codex** — same.

Same script (`volume-blank.sh`) runs in CC / OC / Codex (subprocess capable).
TS class would run in Chrome (can't spawn) — but volume specifically is OS-
bound, so it's filtered out via `not-on-host: [chrome]`. Where TS-class
versions exist (stocks, weather, HN, etc.), Chrome gets full functionality.

## The HCI angle (for blog #16)

1. **Seamlessness is structural.** Not a marketing claim — a *property of
   the architecture*. Same runtime + same config = same behaviour, modulo
   host capabilities.

2. **Host adapters are thin precisely because the runtime is thick.** The
   default tendency in cross-platform code is to make each platform layer
   handle as much as possible. OpenCues inverts that: cross-cutting
   behaviour goes in the runtime. The host adapter only handles the
   *irreducibly host-specific* operations (rendering primitives, IPC).

3. **The single CLI is part of the seamlessness story.** `opencues install
   --all` is a UX statement: "you don't have to know how each host installs
   itself." That uniformity matters as much as the runtime uniformity.

4. **Hot-reload everywhere.** No restart needed in any host. Edit a `.md`,
   the next keystroke (or watch tick) picks it up. That's a flow-state
   property — see [`11-flow-state-mechanisms.md`](11-flow-state-mechanisms.md).

5. **Capability-aware portability.** `host-compat` lets a cue / blank
   declare which hosts it's compatible with. The system gracefully filters
   incompatible entries instead of failing silently.

## Pitfalls and trade-offs

- **Per-host adapter bands have to be maintained.** A CC bump from 2.1.x to
  2.2.x might break a patch; a new band is added. The adapter version pin
  is real maintenance work.
- **Chrome's bundle-via-sync model means edit propagation isn't truly
  realtime.** ~1-2s polling. For most cases imperceptible; for rapid
  iteration it's noticeable.
- **Codex (Rust) is hardest to port.** The Rust ↔ Node JSON-RPC bridge is
  thicker than the other adapters. Worth highlighting if the post wants to
  show the "structure pays off when you push it" angle.
- **Some shell scripts are intrinsically OS-bound** (volume, brightness). No
  amount of hoisting fixes that — they need the OS audio API. The `host-
  compat` system honestly surfaces the limit.

## Where this material lives

- `damon.md` — system overview with the architecture diagram
- `CLAUDE.md` — repo overview, host install paths, hot-reload notes
- `README.md` — public-facing pitch
- `docs/features/host-compat.md` — full host-compat spec
- `docs/features/chrome-sync.md` — chrome bundling spec
- `docs/features/cue-blanks.md` § "Blanks Architecture" — TS classes vs
  scripts
- `integrations/{claude-code,opencode,chrome,codex}/docs/*.md` — per-host
  implementation notes

## Quotable lines

- "Same runtime, four host adapters."
- "Same code, every host."
- "A few hundred lines of bridge code, not thousands."
- "Hot-reload picks up changes — no restart needed in any host."
- "`opencues install --all`."
- "The directory IS the scope."
