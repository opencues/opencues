# CLAUDE.md — Terminal integration

A standalone Bun + OpenTUI + SolidJS app that hosts the OpenCues
runtime. Unlike CC / OC / Gemini there is no upstream fork to patch —
we own the entire app. Invoked as `oc-edit` from a shell.

## Why this exists

Native CLI hosts (CC, OC, Gemini) all already have their own editor
loops, and OpenCues plugs into theirs. A user who isn't running any
of those still has a terminal — but a raw bash/zsh prompt can't
host the runtime (no persistent buffer, no `onRender` surface). The
terminal integration plugs that gap by being itself the host:
launched as `oc-edit`, it owns a TextareaRenderable, runs OpenCues
against it, and prints the buffer on submit.

## Where things live

| File | Role |
|---|---|
| `pin.json` | OpenTUI version pin (no upstream fork — what's pinned is the renderer stack) |
| `compat.json` | Declared compatibility (`host-kind: self`) |
| `patches/setup.sh` | One-command installer (Bun, build runtime, optional symlink) |
| `bin/oc-edit` | Bun entrypoint — chooses dist/ if built, else src/ |
| `src/app.tsx` | The Solid app — single `<textarea>` + statusline |
| `src/bootstrap.ts` | OpenCues wiring (analog of `integrations/opencode/patches/opencuesBootstrap.ts`, but without the holder/publish dance) |
| `../../packages/opencues-runtime/adapters/terminal/v1/` | Adapter band |

## Differences vs the OC band

OpenTUI is identical between OC and terminal, so the adapter band is
a near-clone of `adapters/oc/v1.14/` with:

- `hostName: 'terminal'`, `hostVersion: '0.1.0'`
- No SolidJS reactive holder (`__ocPromptHolder`) — app.tsx hands the
  textarea + syntax refs straight to `startOpenCues()` on mount.
- No CC/OC-fork plugin lifecycle hooks (`promptAccess.write`, etc.).
- No statusline-to-footer SolidJS signal — the statusline tip lands
  in a plain Solid signal owned by `App` and rendered in `<text>`.

Everything else (extmark applier, spawn sandbox, audit log, user
blanks loader, multi-provider key bag, agent-rewrite wiring) is a
direct port.

## OpenTUI extmark contract (read before touching `triggerOpenCuesRender`)

Same trap as OC. `editBuffer.setText` / `replaceText` / `clear`
nuke every extmark; insert/delete/newline/undo only adjust. Our
runtime-driven writes (cycling, agent edits, BlankFill substitute)
funnel through `textarea.setText` → all extmarks gone → next render
must rebuild from scratch. `setText`/`pushText` in `bootstrap.ts`
reset `ownedExtmarks = new Map()` to force the rebuild. See
`packages/opencues-runtime/adapters/oc/REPAIR.md` § "OpenTUI extmark
contract" for the full ADJUSTS-vs-CLEARS table — same applies here.

## Repair guide

Terminal-specific quirks (separate from the OpenTUI-shared OC ones)
are catalogued in `packages/opencues-runtime/adapters/terminal/REPAIR.md`
— LT-1 through LT-4 today. Check both REPAIR files after any version
bump of `@opentui/core` or `@opentui/solid`: the OC catalogue is
authoritative for OpenTUI bugs that bite both bands; the terminal
catalogue covers the install-boundary quirks unique to a self-owned
host (bunfig discovery, JSX preload, etc.).

## Iteration loop

```bash
bun --cwd integrations/terminal install
bun --cwd integrations/terminal src/app.tsx   # dev run
# or after a runtime change:
pnpm --filter @opencues/runtime build && bun --cwd integrations/terminal src/app.tsx
```

## Debugging

- **`tail -f /tmp/opencues.log | grep '\[term\]'`** — runtime logs.
- Set `DEBUG_OPENCUES=1` for verbose user-blank load tracing.
- Set `OPENCUES_BRIDGE=1` to enable the event-bridge for off-process
  inspection (same protocol as OC).
