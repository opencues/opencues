# Repo structure (target)

This document describes where the repo is going, not where it is. The
re-org happens in stages — each stage is one commit, leaves the repo
buildable, and is independently revertable. See [Stage tracker](#stage-tracker)
for current status.

The target conventions are grounded in three reference projects we
surveyed: `shadcn-ui/ui` (the closest analogue — one library + multiple
consumer-facing artefacts), `sst/opencode` (multi-package CLI distributed
via curl-installer + npm), and `BloopAI/vibe-kanban` (`npx`-driven
installer that fetches per-OS binaries). The throughline:
**`pnpm + turbo + Changesets + npx @scope/<pkg>`** is the mainstream stack
for TypeScript monorepos in 2026, and `npm i -g` has been demoted to a
fallback (Anthropic explicitly marks it deprecated in their CLI README).

---

## Naming convention

OpenCues integrates *with* third-party editors but doesn't own their
trademarks. To keep the repo namespace clean and avoid accidental
trademark coupling, we use **opaque short codes for repo internals** and
**descriptive prose in user-facing docs**.

| Internal code | Refers to | Use in |
|---|---|---|
| `cc` | Claude Code | folder names, package names, adapter band paths |
| `oc` | OpenCode | folder names, package names, adapter band paths |
| `chrome` | Chrome MV3 extension | folder names, package names |

Casing: lowercase on the filesystem (`cc/`, `oc/`, `chrome/`), uppercase
in prose (`CC`, `OC`, `Chrome`). User-facing READMEs are free to say
"OpenCues for Claude Code (`npx @opencues/cc`)" — describing what the
package does without naming-coupling.

---

## Target layout

```
opencues/
├── packages/                    # Reusable libraries (lockstep versioned)
│   ├── opencues-core/           # was: cues-core (rename in Stage 4)
│   │                            # publishes as @opencues/core
│   └── opencues-runtime/        # publishes as @opencues/runtime
│       └── adapters/
│           ├── cc/v2.1/         # was: claude-code/v2.1/
│           └── oc/v1.4/         # was: opencode/v1.4/
│
├── integrations/                # Host glue — each is its own release unit
│   ├── cc/                      # was: claude-code/
│   │   ├── package.json         # @opencues/cc, version + compat
│   │   ├── src/                 # patch sources
│   │   ├── bin/install.js       # npx entry — end-user installer
│   │   ├── scripts/dev-install.sh   # was: patches/setup.sh — for contributors
│   │   ├── README.md            # version, compat matrix, install paths
│   │   └── CHANGELOG.md
│   ├── oc/                      # was: opencode/
│   │   └── ...
│   └── chrome/                  # was: chrome-extension/
│       └── ...
│
├── configs/                     # Shipped default configs (was: at repo root)
│   ├── cues.md
│   ├── blanks.md
│   ├── opencues.md
│   ├── cues/
│   └── controls/
│
├── docs/
│   ├── architecture/            # THIS FILE lives here
│   ├── guides/
│   └── features/
│
├── scripts/                     # Cross-cutting (release, version-bump)
└── .github/workflows/           # CI per integration
```

### What each top-level dir is for

- **`packages/`** — internal libraries used by the integrations. Versioned
  in lockstep with each other (they're tightly coupled internals); not
  intended for direct end-user install.
- **`integrations/<host>/`** — one release unit per host. Each has its
  own `package.json` with its own `version` field and a `compatibility`
  string declaring which host versions it supports. Independently
  versioned and released.
- **`configs/`** — default `.md` configs shipped with releases. Users
  often edit these in place, so they stay accessible.
- **`docs/`** — narrative documentation. Architecture decisions live in
  `architecture/`, how-tos in `guides/`, feature reference in `features/`.

---

## Versioning model

**Independent per-integration versioning.** Each `integrations/<host>/`
ships separately with its own version. The `packages/` libraries are
internal — versioned in lockstep with each other but not exposed to end
users as discrete versions.

Each integration's `package.json`:

```json
{
  "name": "@opencues/cc",
  "version": "0.5.2",
  "compatibility": {
    "claude-code": "2.1.110 - 2.1.x"
  }
}
```

The `compatibility` field is a custom (non-standard) field the installer
reads at runtime. Mismatch → installer prints a clear error and exits
(does not silently install against an unsupported host).

Release tags are scoped: `cc-v0.5.2`, `oc-v0.3.1`, `chrome-v0.1.0`.

---

## Install paths per integration

The shape we're building toward, ordered by user expectation:

| Integration | Primary (end-user) | Alternative | Dev (contributor) |
|---|---|---|---|
| **CC** | `npx @opencues/cc` | `curl -fsSL opencues.dev/install/cc \| sh` | `pnpm --filter @opencues/cc dev-install` |
| **OC** | `npx @opencues/oc` | tarball from GitHub Release | `pnpm --filter @opencues/oc dev-install` |
| **Chrome** | Chrome Web Store | unpacked-extension `.zip` from GitHub Release | `pnpm --filter @opencues/chrome dev` |

`npx` is the primary install front-door because it works on every OS,
needs no global state, and matches the pattern users already know from
`npx shadcn`, `npx vibe-kanban`, `npx create-react-app`. The `npx`
installer for CC/OC works the same way as today's `setup.sh`: detect a
host install, check version, build/apply patches, install runtime to the
right node_modules location.

The dev install (running from a clone) is for contributors who want
hot-reload + the ability to edit patch source. It's roughly today's
`setup.sh` workflow with a clearer name.

---

## Tooling stack

| Layer | Choice | Why |
|---|---|---|
| Package manager | **pnpm** | Native workspaces, fast, used by shadcn/ui + vibe-kanban |
| Workspace orchestration | **Turborepo** | Caches builds across packages; mainstream for pnpm monorepos |
| Versioning + changelog | **Changesets** | Per-package version bumps; mainstream; also used by shadcn/ui |
| Build per package | **tsc** for libraries, **esbuild** for chrome bundle | Already what we use; no churn |
| Release pipeline | **GitHub Actions** with OIDC publish to npm | Standard since 2024; no token management |

bun is the credible alternative when one team owns the whole stack
(`sst/opencode` uses it). For a project where users come in via `npx`
expecting a normal Node setup, pnpm is the safer default.

---

## Stage tracker

| Stage | Goal | Status | Commit |
|---|---|---|---|
| 1 | Document target architecture; reconcile top-level docs | in progress | (this commit) |
| 2 | Per-integration `package.json` with version + compat metadata | pending | — |
| 3 | Adopt pnpm workspaces | pending | — |
| 4 | Rename packages + integrations to `@opencues/*` scope, opaque codes | pending | — |
| 5 | Add Turborepo build orchestration | pending | — |
| 6 | `npx @opencues/cc` installer | pending | — |
| 7 | Same for OC + Chrome | pending | — |
| 8 | Changesets + GitHub Actions release pipeline | pending | — |

Each stage is committed separately. To roll back any stage: `git revert
<commit>`. The intermediate stages all leave the repo in a buildable
state — no big-bang migration.
