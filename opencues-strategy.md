# OpenCues Strategy — Internal Notes

> **Status:** Pre-launch internal doc. Listed in `CLAUDE.md` "Pre-launch" section
> for removal before the repo goes public. Working strategy, not marketing copy.
> If you're reading this and the repo is public, something went wrong.

---

## Thesis

OpenCues is **an open-standard play, not a pure end-product.** The reference is
OpenClaw's scaling path: ship the spec, let others implement against it, become
the steward. The codebase is already shaped for that play, often more cleanly
than OpenClaw was at the same stage. The remaining work is distribution-shaped,
not architecture-shaped.

---

## What OpenClaw actually did

OpenClaw (Peter Steinberger, Nov 2025) went from 9k → 60k GitHub stars in days
and sits at ~247k stars / 47.7k forks with ~1.2M weekly active users by March
2026. The growth wasn't a feature, it was the **shape**:

1. Permissive license (MIT) + self-hosted. Users own their state.
2. Adapter pattern over ~22 messaging channels (WhatsApp, Telegram, Slack,
   Discord, Signal, Matrix, IRC, …). Meets users where they already are.
3. Multi-model LLM backends. Provider-agnostic.
4. Third-party ecosystem of tools, deployment services, content packs grew on
   top of the open core.
5. Bundled capability surface out of the box. Low cold-start.

Each of these is a **structural property of the codebase**, not a marketing
position. Growth was earned by being copy-able, extensible, and
platform-spanning by design.

Sources for the OpenClaw narrative:
- https://en.wikipedia.org/wiki/OpenClaw
- https://www.digitalocean.com/resources/articles/what-is-openclaw
- https://dev.to/alifar/why-openclaw-breaks-at-scale-a-technical-perspective-6o5
- https://stack.convex.dev/optimizing-openclaw
- https://www.sitepoint.com/openclaw-production-lessons-4-weeks-self-hosted-ai/

---

## How OpenCues maps onto that shape

| OpenClaw lever | OpenCues equivalent | Evidence in this repo |
|---|---|---|
| 22 messaging-channel adapters | 3 editor integrations (CC, OC, Chrome) under a shared runtime contract | `integrations/{claude-code,opencode,chrome}/`; `CLAUDE.md:9-27` ("brain / nervous system / spinal-cord bridges") |
| Multi-model LLM backends | 6 providers, fully swappable via frontmatter precedence chain | `packages/opencues-core/src/llm-provider.ts:23-25, 526-588` |
| Self-hosted, user-owned data | `~/.cues/` directory; uninstall is `rm -rf` | `CLAUDE.md` "Compact footprint" section; `OPENCUES.md` user-scoped |
| Portable, copy-able formats | Markdown + YAML frontmatter. No proprietary binary, no DB | `packages/opencues-core/src/cues-md.ts`; `openstandard-notes.md:185-196` ("the one format") |
| Bundled capability surface | 38 tip groups + 10+ blanks shipped in `defaults/` | `defaults/cues/`, `defaults/blanks/` |
| Hot-reload extensibility | Drop a file, live on next keystroke | `CLAUDE.md` "hot-reload within ~2 seconds" |

The structural alignment is high. The lever count (3 editors vs 22 platforms)
is smaller, but the lever **shape** is identical: each integration is an
adapter that delegates to a host-agnostic core.

---

## Where OpenCues is ahead of OpenClaw at the same stage

Three structural properties that OpenClaw didn't have on day one and had to
retrofit (or still hasn't):

### 1. Cleaner brand/standard split from day one

OpenClaw is one MIT project that grew an ecosystem informally. OpenCues
codified the split before launch. From `openstandard-notes.md:25-43`:

| Term | What it is |
|---|---|
| **Cues** (the standard) | Defines data shapes, file layout, scopes, parsers |
| **OpenCues** (the brand) | Reference implementation: runtime, CLI, integrations |

That's the CommonMark-vs-Markdown lesson learned upfront. If a "FastCues" or a
vendor implementation appears, the namespace already accommodates it without
retconning. Spec field on master files (`spec:` frontmatter) signals
conformance from the format itself.

### 2. Per-word dispatch isolation

`RoutedWordSourceGroup` (`packages/opencues-core/src/sources/routed-word-source-group.ts`)
enforces structural prompt isolation: a third-party cue pack with a hijacking
prompt can only affect the words it claims via `match:` / `keywords:`. It
cannot poison words routed to other sources.

This is the same problem OpenClaw hit late: persistent context bleeding across
plugins, leading to incorrect responses and unpredictable behavior (cf. the
"context contamination" notes in the scaling postmortem). OpenCues has the
isolation property baked into the routing layer, not bolted on.

### 3. Two scopes of content authorship

`~/.cues/` (user-level, follows the user) and `<project>/.cues/` (project-level,
travels with the repo). OpenClaw is single-scope. The two-scope shape is what
lets project authors ship cue/blank packs to teammates the same way
`.editorconfig` or `package.json` does. That's a strong **organic** distribution
vector: every project repo that adopts cues becomes a billboard for the
standard.

Resolution order (`openstandard-notes.md:173-179`): `$OPENCUES_HOME` → project →
user. Project beats user on conflicts; settings stay user-only (cd'ing into a
project shouldn't silently change which LLM is in use).

---

## Current-state audit (May 2026)

Benchmarked against OpenClaw's winning levers + known weak points. Each
dimension scored STRONG (already at OpenClaw-level), MEDIUM (scaffolded but
incomplete), or WEAK (essentially absent).

### Dimensions

| Dim | Lever / risk | Status | Evidence |
|---|---|---|---|
| A | Permissive license + ownership | STRONG (ready to flip) | `LICENSE` is "Proprietary. All rights reserved." pre-launch; flip to MIT/Apache-2.0 per `CLAUDE.md` "Pre-launch" section |
| B | Install ergonomics (the "Docker run" test) | STRONG | `README.md:47-64` — 3-line paste, ~1m warm install, `rm -rf ~/claude-code-cues` to undo |
| C | Multi-host adapter pattern | STRONG | CC v2.1: 1.2k LOC; OC v1.4 + v1.14: ~500 LOC each; Chrome v1: ~480 LOC. Clean `HostAdapter` boundary; shape consistent across hosts |
| D | Multi-model LLM, swappable | STRONG | 6 providers in `llm-provider.ts:23-25`; per-provider adapter pattern; no hardcoded Groq paths in core |
| E | Bundled capability surface | STRONG | 5 cue groups (38 tip groups), 13 blanks, 2 auditors. Substantive content (not stubs); `volume-blank.sh` handles WSL/Windows fallback; `grammar/AUDITOR.md` ships concrete rules |
| F | Third-party plugin ergonomics | MEDIUM | `CONTRIBUTING.md:6-41` — folder-based, hot-reload, zero-code entry. **No registry, no npm-publishable pack format, no `opencues add <pack>` mechanism.** |
| G | README quality / viral discoverability | STRONG structure / WEAK motion | `README.md` structure is good (value prop, 5-min quickstart, diagrams, tables). **No demo GIF/video** — `README.md:12` has commented placeholder. Highest-leverage pre-launch gap. |
| H | Community / governance scaffolding | MEDIUM | `CONTRIBUTING.md` + `CODE_OF_CONDUCT.md` exist. **No `GOVERNANCE.md`, no RFC folder, no ADR folder.** Spec change process undocumented. |
| I | Distribution channels (npm/registry, semver) | MEDIUM (ready, not live) | All three packages at `0.1.0`, `private: true`, `publishConfig` routes to GitHub npm. `CHANGELOG.md` exists in Keep-a-Changelog format. Flip `private: false` at launch. |
| J | Plugin sandboxing / isolation | MEDIUM (mixed) | Word-cues isolated structurally (`RoutedWordSourceGroup` per-word dispatch). **Auditors compose into ONE LLM call — malicious auditor poisons every other auditor in the same call.** **Blank scripts (`blankScript:`) run uncontained shell — third-party `rm -rf /` is reachable via a registry.** |
| K | Strategic anticipation of standards play | MEDIUM | Brand/standard split codified (`openstandard-notes.md:25-43`). `spec:` field on master files. **`spec-version` not pinned** ("living spec", line 3). Four moves planned, not executed. |

### Three layers

The dimensions cluster into three strategic layers with different urgency:

**Layer 1 — Already OpenClaw-shaped (A, B, C, D, E).**
The structural foundation OpenClaw won on, in place today. Don't undersell
this publicly: "scaffolded but not load-bearing" is true for the standards
play, but the *runtime* is load-bearing now.

**Layer 2 — OpenClaw-shaped traps lying in wait (J).**
OpenClaw scaled to 1.2M weekly users and *then* hit persistent context
contamination across plugins plus plugin runtime contention. Two analogous
surfaces in OpenCues are unmitigated:

| Surface | Isolation | Risk at scale |
|---|---|---|
| Word-cues | `RoutedWordSourceGroup` per-word dispatch | Solved structurally |
| Auditors | Concatenated into ONE LLM call per agent tick | Prompt-injection risk: a malicious auditor poisons every other auditor in the same call |
| Blank scripts | `volume-blank.sh`-style, runs uncontained shell | Code-execution risk: third-party `blankScript:` shipped via a registry could be `rm -rf /`-capable |

Right now nobody ships third-party packs, so the risk is theoretical. The
exact moment it stops being theoretical is the moment it most needs not to
be: the viral week, when packs proliferate faster than they can be reviewed.
OpenClaw hit this at 1M users. OpenCues would hit it on Day 3 of an HN front
page.

**Layer 3 — Viral-moment gaps (F, G, H, I, K).**
OpenClaw's 9k → 60k stars in days happened because the README had motion,
third-party packs could ship via existing channels, and the community had a
place to land. OpenCues has the equivalents structurally but not viscerally:

- README structure is good; motion asset (demo GIF) is missing.
- `CONTRIBUTING.md` tells third parties how to *write* a pack; there's no
  path to *ship* one (no `npm install -g cues-pack-rust-coding`, no
  `opencues add <pack>`).
- `GOVERNANCE.md`, RFC process, spec version pin all anticipated, none live.

---

## The honest reality check: latent vs load-bearing moat

Authoring a standard is not the same as owning one. Owning happens when the
format outlives any single implementation.

| Property | Markdown (2004 → 2010) | OpenCues (today) |
|---|---|---|
| Spec authored | ✓ | ✓ (`openstandard-notes.md`) |
| Reference implementation | ✓ | ✓ (this repo) |
| Second implementation | ✗ until ~2008 | ✗ |
| Third-party readers (non-renderer tools) | ✗ until ~2010 | ✗ |
| Pinned spec version | ✗ until CommonMark 2014 | ✗ ("living spec", `openstandard-notes.md:3`) |
| Governance / RFC process | ✗ until CommonMark | ✗ |

Today, "owning the standard" is **scaffolded but not load-bearing**. That's
fine for a pre-launch project. The strategic question is whether subsequent
work converts the scaffolding into adoption.

---

## Pre-launch sequencing

Order matters. Skipping J before F is the OpenClaw-shaped failure mode: if
distribution lands before isolation, a single malicious pack on launch day
kills the standards play before it starts.

### 1. Sandbox the trap surfaces (J) — must be decided before public launch

Two distinct threats, two distinct mitigations.

#### Auditors — DECIDED: Option Z (asymmetric registry)

Auditors compose into ONE LLM call per agent tick today (`CLAUDE.md:204`),
which lets a malicious auditor's body text override sibling auditors'
instructions. Three trust models considered:

- **X — Single-vendor.** Only `defaults/` auditors ship. Users author their
  own. No registry. Loses the network-effect ambition for the auditor
  surface.
- **Y — Symmetric registry.** Cues, blanks, and auditors all distribute via
  registry. Wins network effects everywhere; pays for it in registry-side
  trust infrastructure (signed packs, output validation, layer-1 install
  gating).
- **Z — Asymmetric registry (DECIDED).** Cues and blanks may grow registry
  distribution; auditors do not in v1.0. Auditor packs come only from
  `defaults/` (shipped) or `~/.cues/auditors/<name>/` (user-authored).
  Sharing happens out-of-band — publish the AUDITOR.md as documentation,
  users copy it manually after reading the prompt body.

**Why Z wins for launch:** auditors are the smallest of the three surfaces
(2 shipped vs 38 cue groups + 13 blanks), so dropping registry support for
them costs the least growth. The decision is reversible — if auditor-pack
demand emerges post-launch, we can design a registry channel for them
without breaking anything. v1.0 punts the question by ducking it.

**Implementation under Z, in priority order:**

1. **Isolation B in the runtime — DONE.** Per-auditor LLM calls, run in
   parallel, diff-merged by `priority:` (highest priority resolves
   overlapping spans last). Closes cross-auditor injection structurally.
   Mirrors the per-word dispatch property `RoutedWordSourceGroup` already
   proves for cues. Implementation lives in `agent-rewrite.ts` —
   `callLLMOnce` (single call with optional auditor) +
   `callLLMWithAuditors` (parallel orchestrator) +
   `mergeAuditorRewrites` (priority diff-merge). The four boots
   (`adapters/{cc/v2.1, oc/v1.4, oc/v1.14, chrome/v1}/boot.ts`) now wire
   `maxConcurrentAuditors` from the `max-concurrent-auditors:` setting in
   `OPENCUES.md`. Tests: `agent-rewrite.auditors.scenarios.test.ts`
   (15 tests covering parallel dispatch, overlap resolution, alphabetical
   tiebreak, per-auditor failure tolerance, cap enforcement, and cache
   invalidation on auditor toggle).
2. **Trust model in spec + docs — DONE.** `spec/auditor-spec.md` § Trust
   model + `openstandard-notes.md` § Distribution asymmetry +
   `docs/guides/adding-an-auditor.md` § 5. v1.0 mandates user-trusted-only
   provenance; runtimes MUST NOT auto-install from network sources without
   explicit per-pack user confirmation including prompt-body display.
3. **Layer 2 output validation — PENDING (Phase 3).** Length-delta cap
   (1.5× default), character-class drift detection (zero-width Unicode,
   control chars), unexpected-content emergence (URLs, markdown images,
   code fences, redaction markers — suppressed via `expected-changes:`
   frontmatter, already added to the spec). Catches the single-bad-auditor
   case that isolation alone doesn't (a bad auditor can still produce
   malicious output within its own slice). Smaller blast radius than
   Phase 2 — additive, rejected rewrites just no-op.

#### Blank scripts — DECIDED: extend Z to script-bearing blanks

`blankScript:` runs uncontained shell with the user's privileges
(`defaults/blanks/volume/volume-blank.sh`). Same trust-model space as
auditors but with code-execution rather than prompt-injection as the failure
mode.

Decision: extend Z to cover `blankScript:` blanks. Other blank profiles
(`stepValues`, `impl`) remain registry-safe — `stepValues` is a static list
(no execution), `impl` references a runtime-resident class (third-party
`BLANK.md` cannot ship a new class). The carve-out is for shell/code
execution, not for blanks generally.

**Launch position: safe by being narrow.** Cues ship registry-ready (per-word
dispatch is structural isolation), `stepValues` and `impl` blanks ship
registry-ready (no code surface), `blankScript:` blanks and the entire
auditor surface ship user-trusted-only. Sharing these happens out-of-band:
publish the file as documentation, users copy after review.

**Note for the launch announcement:** call out that the registry channel
exists only for the genuinely-safe profiles in v1.0, with script-bearing
blanks and auditors deferred until trust infrastructure is mature (signed
packs, sandboxed execution, output-validation libraries — none of which
v1.0 wants on the critical path). Frame it as a known-conservative starting
point rather than an oversight.

**Spec changes**: documented in `spec/blank-spec.md` § Trust model and
`openstandard-notes.md` § Distribution asymmetry — both updated to cover the
two carve-outs (auditors as a whole surface; `blankScript:` blanks as a
within-surface profile carve-out).

**Future revision arc**: as trust infrastructure matures, the carve-outs
shrink. Likely order: script-bearing blanks first (better-understood threat
model — mirrors npm/cargo's existing supply-chain practice with signed
packs + lockfiles), auditors later (the prompt-injection threat model is
less mature in the wider ecosystem; output-validation needs more research).

### 2. Pin spec v1.0 + flip license (A + K)

1-day moves that unlock everything downstream:
- Add `spec-version: "1.0"` to every master file (`CUES.md`, `BLANKS.md`,
  `AUDITORS.md`, `OPENCUES.md`).
- Update `openstandard-notes.md:3` from "Living spec" to "Spec v1.0 — frozen
  YYYY-MM-DD."
- Replace `LICENSE` body with MIT or Apache-2.0.

### 3. Demo asset (G)

One animated GIF in `README.md`, ~30s, showing the cycle-and-fill loop.
Highest viral leverage per hour spent. `README.md:12` already has the
placeholder slot. Without this, the README structure is good but the
GitHub-stars vector is muted.

### 4. Distribution path (F + I)

Flip `private: false` on `@opencues/core`, `@opencues/runtime`,
`@opencues/cli` (all currently at 0.1.0). Ship a minimal `opencues add
<pack>` mechanism that pulls from npm or GitHub and extracts into
`~/.cues/`. Even "download + extract + verify checksum" is enough to flip
the format from copy-paste to versioned/dependable.

### 5. GOVERNANCE.md + RFC folder (H)

Light touch. One markdown file documenting how spec changes happen (who
proposes, who decides, what the deprecation window is). Not Day-1 critical,
but should land before the first external contributor proposes a spec
change. Goes hand-in-hand with Move 1 below (the post-launch arc).

### The single biggest priority

**Item 1 (sandboxing the auditor + blank-script surfaces).** Everything else
in this list is reversible. A security incident in week one of a viral
launch isn't. OpenClaw earned its scaling postmortem by already being at 1M
users when contamination bit; OpenCues doesn't have that buffer — the same
problem at 1k users kills the standards play before it starts.

If one file gets read carefully before launch, it's the auditor composition
path in the rewrite call (see `docs/guides/adding-an-auditor.md` plus the
auditor merge logic in `@opencues/core`). That's where the OpenClaw-shaped
failure mode is hiding.

---

## Four moves to convert latent → load-bearing (post-launch arc)

These are the longer-arc moves, over ~6 months post-launch, that convert
*standard authorship* into *standard ownership*. Pre-launch sequencing above
is what gets to the starting line; these are what cross it. Item 1 here
overlaps with pre-launch item 2 — pin the spec once, it serves both arcs.

In rising order of effort. Each is a concrete codebase or distribution change.

### 1. Pin `spec: 1.0` and freeze it

A "living spec" with no version pin can't be conformed to. Anyone trying to
write a second implementation has to track a moving target. CommonMark won
over Gruber's Markdown precisely because it pinned.

**Concrete change:** add `spec-version: "1.0"` to every master file
(`CUES.md`, `BLANKS.md`, `AUDITORS.md`, `OPENCUES.md`). Update
`openstandard-notes.md` header from "Living spec" to "Spec v1.0 — frozen
2026-XX-XX." Future changes go to v1.1 with a deprecation period.

### 2. Ship `@opencues/spec-parser` as a runtime-free reference parser

A 200-line package that does `parse(.cues/) → JSON` with no runtime
dependency. Gives second-implementation authors a starting point. Proves the
spec is implementable independent of the OpenCues runtime.

**Concrete change:** extract `packages/opencues-core/src/cues-md.ts` +
`discover.ts` into a separate `packages/opencues-spec-parser/` with no
dependency on the runtime. Publish as `@opencues/spec-parser`. Document the
output JSON shape so other-language ports (Rust, Python) have a target.

### 3. Get one external tool reading `.cues/` for a non-OpenCues purpose

The inflection signal that flips perception from "their format" to "a format."
Could be:
- A `cues lint` GitHub Action that validates `.cues/` on PRs.
- A VSCode extension that previews `CUE.md` / `BLANK.md` files.
- A doc generator that emits a project's cue catalog as a static site.

**Why it works:** the moment a tool that *isn't* OpenCues reads `.cues/`,
the format has independent value. Users can't assume the format will
disappear if OpenCues does. That's the durability shift.

### 4. Sponsor or seed a second implementation

Even unofficial. Even partial. A 500-line Rust port that handles cues only
(no blanks, no auditors) is enough. The mere existence is the network signal:
"this format has more than one implementation."

**Concrete options:**
- Bounty a port via a public RFC.
- Build the Chrome content-script as a "second implementation" by
  intentionally not sharing code with `@opencues/runtime` (right now
  `integrations/chrome/` already imports from `@opencues/runtime` per
  `CLAUDE.md:9-27`, which is fine for the reference impl but doesn't
  count as a second implementation).

---

## Pre-launch checklist alignment

This document is listed for deletion in `CLAUDE.md` "Pre-launch" alongside:
- `damon.md`, `verify.md`, `todos.md`, `pre-launch-readme.md`, `CONTINUE.md`.

After launch, the **public** version of this strategy goes into one of:
- A blog post (the "Cues vs OpenCues" post in the existing `blog-resources/`
  series — see `blog-resources/03-open-standard.md` which already drafts the
  brand/standard framing).
- A `GOVERNANCE.md` at repo root, scoped to the standard's evolution rules.
- The `openstandard-notes.md` itself, promoted from "living notes" to a
  versioned spec with explicit governance.

What goes in the public version: the brand/standard split, the four moves
(reframed as "how to contribute a second implementation"), the per-word
dispatch isolation property.

What stays internal (and dies with this file): the OpenClaw comparison framing,
the "latent vs load-bearing" honesty about today's adoption gap, the
pre-launch self-assessment.

---

## Open questions / risks

1. **Does the "standard" thesis survive contact with reality?** If after
   launch nobody implements a second runtime, the standards play is just a
   pretentious framing for a one-vendor format. The four moves are designed
   to force a real test of the thesis within ~6 months of launch.

2. **What if Anthropic ships native cue/blank semantics into Claude Code?**
   That's the tail risk. Mitigation: be the spec they reach for. Brand/standard
   split helps here — Anthropic could ship a "Claude Cues" runtime that reads
   the same `.cues/` as OpenCues, and the format wins regardless of which
   runtime users pick.

3. **Cold-start in browsers is harder than in editors.** Chrome extension
   needs `opencues sync chrome` to bundle configs at build time
   (`CLAUDE.md:500-554`). Native hosts read `.cues/` live. The "live edit"
   ergonomic isn't there in Chrome, which weakens the format-as-vehicle story
   on that surface. Worth thinking about.

4. **The 38 shipped tip-groups are curation moat, not architecture moat.** If
   the strategy is "the format is the moat," shipping good content matters
   less than making third-party content easy to publish. There's a tension:
   curation drives Day-1 value (and Day-1 stars), but ecosystem drives Day-100
   durability. Both matter; allocate accordingly.

5. **Trap surfaces are the single concrete launch blocker.** The auditor
   composition + uncontained blank-script paths are OpenClaw-shaped failure
   modes that don't need users to *manifest* — they need only a registry
   that ships untrusted packs. Until pre-launch sequencing item 1 is
   resolved, distribution (item 4) is unsafe to land. The temptation will
   be to ship distribution first because it's the more visible move; resist
   it.

6. **Demo asset is the single concrete viral blocker.** Every other
   improvement (governance, RFCs, registry) compounds slowly. A 30s GIF in
   the README is a non-linear move — it's the difference between a tweet
   that gets 200 likes and 20k. If pre-launch capacity is tight, the
   priority order is: (1) sandbox traps, (2) pin spec + flip license, (3)
   record demo. Everything else can land post-launch.

---

*Last updated: 2026-05-10. Delete before public launch.*
