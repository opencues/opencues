# auditor-spec — the Auditor file format & runtime contract

> **Status:** `0.1-alpha`. Expect changes.

An **auditor** is the third surface of the standard. Where a cue operates on one word and a blank operates on one `_` slot, an auditor operates on the **whole buffer**: it declares one concern (grammar, clarity, jargon flagging, PII redaction, tone) that an inline rewrite agent should attend to as the user types.

A runtime concatenates the active auditor prompts into a single LLM call that rewrites the buffer in place. Auditors compose — three auditors don't mean three LLM calls, they mean one prompt with three concern-specific sections. This document specifies the `AUDITOR.md` file format and what a conformant runtime MUST do with one.

---

## The format

An auditor is a folder at `<root>/auditors/<name>/` containing an `AUDITOR.md` entry file plus optional bundled resources (`scripts/`, `references/`, `assets/`). The folder name is the source id.

Every auditor is folder-shaped — there is no flat-file alternative. The folder *is* the unit; a helper script can be dropped in later without restructuring. Uppercase entry filenames (`AUDITOR.md`, `CUE.md`, `BLANK.md`) follow the same convention as `OPENCUES.md`, `CLAUDE.md`, `README.md`.

### Anatomy

```
<root>/auditors/<name>/
├── AUDITOR.md                  (required)
│   ├── YAML frontmatter        (required)
│   │   ├── name                (required)
│   │   ├── description         (recommended)
│   │   ├── priority            (optional — concat ordering; default 50)
│   │   ├── enabled             (optional — default true)
│   │   ├── on-host             (optional — host compat allow-list)
│   │   └── not-on-host         (optional — host compat deny-list)
│   └── Markdown body           (required — the prompt fragment)
│
└── scripts/, references/, assets/   (optional bundled resources — see core.md)
```

The body is the **prompt fragment** that gets concatenated into the runtime's rewrite prompt. It declares one concern. The body should NOT include preamble ("you are an editor", "rewrite the buffer") or output-format instructions ("return the corrected text") — those are runtime-owned and apply to the composed prompt as a whole. Each auditor only contributes its concern-specific slice.

---

## Trigger model

**Auditors are not gated.** Every enabled auditor fires on every rewrite. There is no `match:` or `keywords:` field — auditors operate on the whole buffer, not on per-word triggers, so a buffer-level filter would be a category mistake.

Instead, the *prompt body itself* is the gate: a grammar auditor's prompt instructs the rewrite agent to "rewrite ONLY clear grammatical errors; if the buffer is grammatically clean, return it unchanged." The agent decides per-buffer whether the auditor's concern applies. This pushes the gating decision into the same LLM call that does the rewrite, eliminating a second roundtrip.

Runtimes MUST NOT add an automatic `match:` or `keywords:` filter to auditors. Authors who want gating express it in prose inside the prompt body.

---

## Composition

Multiple auditors compose into one rewrite prompt. The runtime:

1. Collects all enabled auditors (across user-level and project-level libraries — see § Composition rules below).
2. Sorts them by `priority:` descending; alphabetical-by-folder-name for ties.
3. Concatenates each auditor's body into one prompt, separated by a runtime-defined delimiter (typically a heading like `## <auditor name>`).
4. Wraps the concatenated body with a runtime-owned preamble (role description, buffer placeholder, output-format spec).
5. Sends one LLM call.
6. Three-way merges the rewritten buffer back against the user's typed buffer (preserving in-flight edits).

The merge mechanism is a runtime concern (the OpenCues runtime uses `AgentRewrite` — see [`opencues-runtime.md`](./opencues-runtime.md)). The standard only specifies the auditor file format and the composition rules; it does NOT specify the merge algorithm.

### Composition rules

User-level (`~/.cues/auditors/`) and project-level (`<cwd>/.cues/auditors/`) libraries compose with these rules:

1. **ADD by default.** User auditors + project auditors all enter the composition. The project does not replace the user's library wholesale.
2. **Name-collision: project wins.** If both layers define `auditors/grammar/AUDITOR.md`, the project's file replaces the user's. Same `name:`, project version takes the slot.
3. **`disable:` is a SUBTRACT.** A project's `AUDITORS.md` master file MAY declare `disable: [<name>, ...]` in frontmatter; named auditors are excluded from this project's composition without modifying the user's `~/.cues/`. cd out of the project, the auditor fires again.
4. **Hot-reload polls every layer.** Edits to either master file or any per-auditor file are picked up on the next text-change event, same as cues and blanks.

The reason: cd-ing into a project should *extend* what the user has, never silently *remove* anything they didn't ask to remove. `disable:` is opt-in subtraction, never silent.

---

## Configuration spec

### Required frontmatter

| Field | Type | Notes |
|---|---|---|
| `name` | string | Source id. SHOULD match the folder name (validators warn on mismatch). |

### Recommended frontmatter

| Field | Type | Notes |
|---|---|---|
| `description` | string | Human-readable summary. Used by `opencues list`, validators, docs. NOT read by the LLM. |

### Optional frontmatter

| Field | Type | Default | Notes |
|---|---|---|---|
| `priority` | number | `50` | Higher number → appears earlier in the concatenated prompt. Ties broken by alphabetical folder name. |
| `enabled` | boolean | `true` | Set `false` to keep the file but skip composition. |
| `on-host` | array of strings | (auto-detected) | Host-compat allow-list (`chrome`, `claude-code`, `opencode`). See [`core.md` § Host compatibility](./core.md#host-compatibility). |
| `not-on-host` | array of strings | `[]` | Host-compat deny-list. |

### Body

The body is the prompt fragment. Format:

- Plain prose. Markdown headings are allowed but not required.
- Refer to "the buffer" or "the text" — do NOT assume any wrapping format. The runtime owns the wrapping.
- Express gating in prose ("rewrite ONLY clear errors"; "return the buffer unchanged if no concerns apply").
- Do NOT include role preamble ("you are an editor"); the runtime supplies this.
- Do NOT include output-format instructions ("return as JSON"); the runtime owns the output contract.

Empty bodies are an error — an auditor with no prompt has no concern to declare.

---

## Master file: `AUDITORS.md`

A surface-wide configuration file at `<root>/AUDITORS.md`. Frontmatter only — the body is documentation.

```yaml
---
name: project-auditors
description: Auditors that run on every buffer rewrite for this project
disable: [grammar, jargon]      # auditor ids to skip in this project
---
```

The master file is OPTIONAL. A project with no `AUDITORS.md` simply uses every auditor under `auditors/` (composed with user-level auditors per the rules above).

| Field | Type | Notes |
|---|---|---|
| `name` | string | Identifies the project (or user library). |
| `description` | string | Documentation. |
| `disable` | array of strings | Auditor ids to subtract from composition at this layer. |

Runtimes MUST honour the `disable:` list at the layer it appears. A project-level `disable:` does not affect other projects or the user-level library.

---

## Runtime contract

A conformant runtime MUST:

1. Discover auditors by walking `<root>/auditors/` for subdirectories containing `AUDITOR.md`.
2. Parse each `AUDITOR.md` as YAML frontmatter + Markdown body.
3. Skip files where `enabled: false` or where `on-host` / `not-on-host` excludes the current host.
4. Compose enabled auditors into one prompt: sort by `priority:` desc, alphabetical-by-folder ties; concatenate bodies with a runtime-defined delimiter; wrap with runtime preamble + buffer + output-format spec.
5. Send one LLM call per rewrite cycle — never one call per auditor.
6. Merge the rewritten output back into the user's buffer using a three-way merge (user's typed text vs LLM rewrite vs the buffer-at-prompt-time baseline).
7. Honour `AUDITORS.md` `disable:` at the layer the master file appears.
8. Honour user→project composition rules (§ Composition rules).
9. Hot-reload on file changes — next rewrite picks up edits without restart.

A conformant runtime MUST NOT:

- Run one LLM call per auditor (defeats the composition model).
- Add automatic `match:` or `keywords:` gating (auditors are not per-word).
- Replace the user library when a project library is present (composition is ADD, not REPLACE).
- Apply `disable:` from one layer to another layer.

---

## LLM routing

A runtime MAY support per-feature LLM routing for auditors. The OpenCues runtime reads three optional settings from `OPENCUES.md`:

- `auditors-provider:` — which LLM provider to use (`groq`, `openai`, `anthropic`, …)
- `auditors-model:` — which model id to use
- `auditors-endpoint:` — override URL (rare; CI / local proxy)

These mirror `word-cues-provider`, `fluid-blank-provider`, `transform-blank-provider` — the same per-feature LLM routing pattern used by every other surface. See [`opencues-runtime.md`](./opencues-runtime.md) § Multi-provider routing.

Per-auditor `provider:` / `model:` is NOT supported, because auditors compose into one LLM call. A single rewrite cannot use three different providers. Choose one per layer.

---

## Examples

### Minimal auditor

`auditors/grammar/AUDITOR.md`:

```markdown
---
name: grammar
description: Fix grammar and basic style errors inline
priority: 50
---

You are checking for grammar and basic style errors. Rewrite ONLY
clear errors (subject-verb agreement, comma splices, dropped
articles). Preserve the user's voice, intentional fragments, and
specialised terminology. If the buffer is grammatically clean,
return it unchanged.
```

### Multiple composed auditors

`auditors/grammar/AUDITOR.md` (priority 50):

```markdown
---
name: grammar
description: Fix grammar errors inline
priority: 50
---

Check for grammar errors. Fix subject-verb disagreement, comma
splices, dropped articles. Preserve voice and intentional fragments.
```

`auditors/clarity/AUDITOR.md` (priority 40):

```markdown
---
name: clarity
description: Tighten verbose or unclear sentences
priority: 40
---

Look for sentences that are unnecessarily verbose, contain redundant
hedging ("I think maybe perhaps"), or buried verbs ("make a decision
about" → "decide"). Tighten only when meaning is preserved.
```

When both are loaded, the runtime composes:

```
[runtime preamble: "You are an inline editor. Apply each auditor below
to the buffer. Return the corrected buffer."]

## grammar
Check for grammar errors. Fix subject-verb disagreement...

## clarity
Look for sentences that are unnecessarily verbose...

[buffer: <user's typed text>]

[runtime output spec: "Return the corrected buffer verbatim."]
```

One LLM call, both concerns applied.

### Project disabling user-level auditor

`<cwd>/.cues/AUDITORS.md`:

```yaml
---
name: my-project-auditors
description: Tighten the rewrite scope for this codebase
disable: [clarity]   # codebase has intentionally informal prose
---
```

User's `~/.cues/auditors/clarity/AUDITOR.md` exists but is skipped while inside this project. Other projects or the global default keep it active.

---

## Validation

An `AUDITOR.md` file is **valid** iff:

- Frontmatter parses as YAML.
- Frontmatter has `name` (string).
- `priority` if present is a number.
- `enabled` if present is a boolean.
- `on-host` / `not-on-host` if present are arrays of recognised host names.
- The body is non-empty.

For the consolidated linting matrix, see [`core.md` § Linting rules](./core.md#linting-rules). Auditor-specific rules:

| Code | Severity | Trigger |
|---|---|---|
| `auditor-missing-name` | error | `AUDITOR.md` frontmatter has no `name`. |
| `auditor-empty-body` | error | `AUDITOR.md` body is empty or whitespace-only. |
| `auditor-missing-description` | warn | `AUDITOR.md` lacks a `description`. |
| `auditor-name-mismatch` | warn | `name:` differs from the folder basename. |
| `auditor-disable-unknown` | warn | `AUDITORS.md` `disable:` lists a name with no corresponding auditor folder. |

---

## What this spec covers

- The `AUDITOR.md` file format and frontmatter schema.
- Composition rules: priority ordering, user→project ADD-by-default, name-collision rules, `disable:` SUBTRACT.
- The runtime contract: discovery, composition into one LLM call, three-way merge requirement.
- The master `AUDITORS.md` file's `disable:` list semantics.

## What this spec does NOT cover

- The merge algorithm. Three-way merging is a runtime concern; the standard only requires that the user's in-flight edits are preserved against an LLM rewrite.
- The wrapping prompt the runtime adds (preamble + output-format spec). Each runtime owns its own wrapping; the standard only specifies that auditor bodies do NOT include such wrapping.
- Per-auditor LLM choice. Composition into one call is load-bearing; per-auditor providers would defeat it.
- Trigger gating on the buffer level. Express gating in prose inside the body.
