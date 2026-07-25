# kata-spec — the `KATA.md` file format & guided-scenario contract

> **Status:** `0.9-alpha`. Expect changes.

A **kata** is a guided, in-editor scenario: an ordered script a user
works through in their real editor while a runtime observes their
activity and coaches the next micro-action. `KATA.md` is the on-disk
format for one such scenario.

This document specifies the **file format** — the frontmatter keys, the
step-section structure, and the curriculum link. The coaching *runtime*
(how a runtime observes activity, drives an LLM coach, renders guidance,
and enforces safety floors) is **reference-impl territory, not wire
contract** — a second runtime is free to coach differently, or not at
all, and still be conformant for the format. This mirrors the standard's
existing boundary: `BLANK.md` is spec, the `CueSource` classes that act
on it are not.

---

## The format

A folder per kata under the standard `.cues/` search path
(`core.md` § Search path):

```
<root>/.cues/katas/<name>/KATA.md
```

`<root>` is any search-path root — **project-level
(`<cwd>/.cues/katas/`) and user-level (`~/.cues/katas/`) are both
valid**, resolved by the normal precedence (project shadows user on a
name collision). This differs from `IDENTITY.md`, which is user-level
only; katas are ordinary project content.

### Anatomy

```
katas/<name>/KATA.md
├── YAML-ish frontmatter        (optional)
│   ├── name:  <identifier>     (defaults to the folder <name>)
│   ├── id:    <id>             (optional — invocation shorthand)
│   ├── title: <text>           (optional — defaults to name)
│   └── next:  <name|id>        (optional — curriculum link)
│
├── Preamble prose              (optional; ignored by the parser)
│
└── ## <step title>             (one or more; at least one REQUIRED)
    <step body — instruction prose + optional `coach:` notes>
```

A file with **zero step sections is not a usable kata** and MUST be
treated as absent (the reference parser returns `null`).

---

## Configuration spec

### Frontmatter

Frontmatter is delimited by a leading `---\n … \n---` block. Each line
is a `key: value` pair where the key matches `[A-Za-z][A-Za-z0-9_-]*`
and the value is a non-empty single-line string. Unknown keys are
ignored (forward-compatibility). All four keys are OPTIONAL — a
`KATA.md` with no frontmatter at all is valid, deriving `name`/`title`
from the folder name.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `name` | identifier string | folder name | Stable identifier. Used for `start kata <name> _` and as a `next:` target. |
| `id` | string | none | Invocation shorthand (`start kata 3 _`). A leading `#` is stripped (`id: #3` ≡ `id: 3`). Numeric or string; no ordering is implied. |
| `title` | string | `name` | Human-readable lesson title shown to the user. |
| `next` | string | none | Curriculum link — the `name` or `id` of the kata to suggest on completion. |

### Preamble

Prose between the frontmatter and the first `## ` heading is an
optional human-readable description of the kata. Conformant parsers
**ignore it** — it is documentation for a human reading the file, not
input to the runtime.

### Step sections

Every `## ` heading begins a step. A step is:

| Field | Source |
|---|---|
| `title` | the heading text after `## ` (e.g. `Step 1 — enter plan mode`) |
| `body` | everything from the line after the heading up to the next `## ` (or EOF), trimmed |

Steps appear in file order and are advanced in that order. A heading
with empty text is skipped.

**The step body is opaque.** It is instruction prose plus, by
convention, `coach:` notes — but the format does **not** schematise the
body. A conformant runtime treats the entire body as a single opaque
string handed to whatever coaching mechanism it implements (in the
reference impl, verbatim into the coach's system prompt). This is
deliberate: fidelity lives in the file, not in a schema. One loose line
or keystroke-by-keystroke choreography are both valid.

### The `coach:` convention (non-normative)

By convention, authors append a `coach:` block to a step body listing
the observable states and the desired coaching response, ending a
completed state with a `STEP_DONE` marker:

```markdown
## Step 1 — check the working tree
Run `git status` before anything else.
coach:
  - Nothing typed → suggest typing: git status
  - They typed it but haven't submitted → tell them to press Enter
  - They submitted "git status" → STEP_DONE
```

This block is **part of the opaque body** — the parser does not
interpret it. It is documented here so authors across implementations
write recognisably similar katas, and so a runtime that *does* drive an
LLM coach has a common idiom to lean on. A runtime is free to ignore it.

### Curriculum (`next:`)

`next:` names the follow-on kata. On completing the last step, a
conformant runtime MAY surface `start kata <next> _` (or its
equivalent) to chain lessons. Resolution matches a kata whose `name`
OR `id` equals the `next:` value. A dangling `next:` (no matching
kata installed) MUST degrade silently — completion still succeeds.

---

## Runtime contract

A conformant runtime that implements the kata surface MUST:

1. **Discover** `katas/<name>/KATA.md` files across the search-path
   roots (`core.md` § Search path), applying the usual project-shadows-
   user precedence on `name` collision.
2. **Parse** the frontmatter + step sections as above, treating step
   bodies as opaque.
3. Provide an **invocation** mechanism keyed by `name` or `id`, and an
   **exit** mechanism that is deterministic and model-independent (a
   user must be able to leave a kata with no LLM and no network).

A conformant runtime MAY additionally adopt the reference coaching
model — observe user activity, drive a per-pause LLM coach, render one
line of guidance, detect progress — but none of that is wire contract.
The reference implementation's invocation phrases (`start kata <id> _`,
`stop kata _`), trace model, coach tick, escape ladder, idle nudges,
lesson journal, progress persistence, and statusline block are
documented in
[`@opencues/runtime`'s `SPEC.md`](../packages/opencues-runtime/SPEC.md)
and `docs/architecture/kata.md` — reference-impl detail, not the
standard.

### Enablement

Whether a runtime enables the kata surface by default or gates it
behind a feature toggle is a **runtime choice** (the reference impl
uses a `katas-mode` scalar in `OPENCUES.md`, default on). Feature
enable/disable toggles are runtime knobs, not spec-mandated scalars —
consistent with `word-cues-mode`, `transform-blank-mode`, etc. There is no
spec-mandated kata scalar.

---

## Security claims

Katas ship as content a user installs (a pack, a project's `.cues/`).
A `KATA.md` step body is therefore **attacker-authorable prose that
rides into an LLM coach**. The format is safe only because the runtime
contract fences what a kata can do:

- **Consent to start.** A kata MUST NOT self-start; it runs only on an
  explicit user invocation. (The reference impl gates on the same `_`
  keystroke trust class as blanks.)
- **Deterministic exit.** Every kata MUST have an exit path that works
  with no LLM and no network — a malicious or broken coach can never
  trap the user.
- **Display-only coaching.** A runtime that drives a coach from step
  bodies MUST NOT let coach output write the user's buffer, execute
  anything, perform network side-effects, or change settings. Coaching
  is advisory text plus, at most, a bounded step counter (never
  backward, at most one step per observation). The structural backstop
  is the same one the whole standard leans on: OpenCues has no tool /
  exec / agent channel for LLM output, so worst-case injection lands as
  user-visible text the user reads before acting.
- **No page-content ingestion.** In a browser runtime, the coach reads
  the user's own typed activity, never the host page's DOM / field
  metadata — and `KATA.md` itself loads only from trusted config
  sources (bundled defaults, the user's `.cues/`), never a web page.

A runtime that wires coach output into any side-effect channel (tool
execution, clipboard, fetch, buffer mutation) violates these claims and
MUST re-review the threat model first. Reference analysis:
`docs/architecture/security-audit.md` row #27.

---

## Conformance

Fixtures live under [`conformance/valid/kata/`](./conformance/valid/kata/)
and [`conformance/invalid/kata/`](./conformance/invalid/kata/):

- `valid/kata/` — `KATA.md` files a conformant parser MUST accept.
- `invalid/kata/` — files that MUST be rejected, each with a sibling
  `.expected.json` naming the rule (`kata-no-steps` for a file with no
  `## ` step section).

The reference runner exercises them via
`packages/opencues-runtime/src/modules/kata.test.ts` (`parseKataMd`);
the fixture tree is discovered structurally. Coverage is seed, not
exhaustive — see
[`conformance/README.md`](./conformance/README.md#kata-fixtures).

---

## Examples

### Minimal — no frontmatter

```markdown
## Step 1 — say hello
Type a greeting and press Enter.
```

`name`/`title` derive from the folder; one step; valid.

### Typical — with curriculum link

```markdown
---
name: git-basics
id: 3
next: cc-first-session
title: Git basics — status, branch, commit
---

A safe first git workflow: check state, branch, commit.

## Step 1 — check the working tree
Run `git status` before anything else.
coach:
  - Nothing typed → suggest typing: git status
  - They submitted "git status" → STEP_DONE

## Step 2 — create a branch
Never work directly on main. Create a branch with `git checkout -b`.
coach:
  - They submitted a create-branch command → STEP_DONE
```

### What gets rejected

```markdown
---
name: broken
---

This kata has a description but no `## ` step headings.
```

→ rejected (`kata-no-steps`): a kata with zero steps is not usable and
MUST be treated as absent.

---

## In scope

- The on-disk layout (`katas/<name>/KATA.md`) and search-path
  resolution.
- The frontmatter keys (`name` / `id` / `title` / `next`) and their
  defaults.
- The step-section delimiting rule (`## ` headings) and the
  opaque-body contract.
- The curriculum-link (`next:`) resolution + dangling-link degradation.
- The consent / deterministic-exit / display-only security floors a
  kata-consuming runtime MUST honour.

## Out of scope

- The coaching mechanism — trace model, coach tick, LLM prompt prose,
  progress detection, idle nudges, lesson journal. Reference-impl
  detail in `@opencues/runtime`'s `SPEC.md`.
- The invocation / exit *phrasing* (`start kata _`, Esc ×3, …) — the
  standard mandates that a mechanism exists and that exit is
  deterministic, not the exact keys/words.
- Rendering — status line, footer, in-page bar. Each integration owns
  its surface.
- Progress persistence, voice, and any other runtime convenience.

---

## Relationship to OpenCues runtime

The reference implementation:

- Parser: `packages/opencues-runtime/src/modules/kata.ts`
  (`parseKataMd`).
- Coaching runtime: the `KataCoach` module in the same file, wired into
  every host adapter band (`adapters/*/boot.ts`).
- User-facing summary: `docs/features/kata.md`.
- Architecture + safety analysis: `docs/architecture/kata.md`.

A second runtime needs only to match this spec's file format + the
security floors to be conformant for the kata surface. The reference
impl's coaching prompt, trace model, and rendering are not part of the
contract.
