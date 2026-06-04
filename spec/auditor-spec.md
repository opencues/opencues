# auditor-spec — the Auditor file format & runtime contract

> **Status:** `0.2-alpha`. Expect changes.

An **auditor** is the third surface of the standard. Where a cue operates on one word and a blank operates on one `_` slot, an auditor operates on the **whole buffer**: it declares one concern (grammar, clarity, jargon flagging, PII redaction, tone) that an inline rewrite agent should attend to as the user types.

A runtime applies enabled auditors to the buffer and merges their rewrites back into the user's text. Per § Composition below, runtimes SHOULD apply auditors in **isolation** (one LLM call per auditor, results merged by `priority:` order) to preserve the per-item dispatch property cues and blanks already enjoy. A runtime MAY use a single composed prompt instead, but only when every auditor in scope is first-party-trusted — see § Trust model.

This document specifies the `AUDITOR.md` file format, the trust model, and what a conformant runtime MUST do with one.

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

The body is the **prompt fragment** that gets dispatched to the LLM by the runtime — either as its own prompt (isolated mode) or concatenated into a shared prompt (composed mode). It declares one concern. The body should NOT include preamble ("you are an editor", "rewrite the buffer") or output-format instructions ("return the corrected text") — those are runtime-owned and apply to whatever prompt the runtime constructs. Each auditor only contributes its concern-specific slice.

---

## Trigger model

**Auditors are not gated.** Every enabled auditor fires on every rewrite. There is no `match:` or `keywords:` field — auditors operate on the whole buffer, not on per-word triggers, so a buffer-level filter would be a category mistake.

Instead, the *prompt body itself* is the gate: a grammar auditor's prompt instructs the rewrite agent to "rewrite ONLY clear grammatical errors; if the buffer is grammatically clean, return it unchanged." The agent decides per-buffer whether the auditor's concern applies. This pushes the gating decision into the same LLM call that does the rewrite, eliminating a second roundtrip.

Runtimes MUST NOT add an automatic `match:` or `keywords:` filter to auditors. Authors who want gating express it in prose inside the prompt body.

---

## Composition

The standard defines two valid composition models. A conformant runtime MUST implement at least one and MAY implement both.

### Isolated mode (RECOMMENDED)

One LLM call per auditor. Per-item dispatch — same isolation property cues and blanks have via `RoutedWordSourceGroup` / `BlankSource`. The runtime:

1. Collects all enabled auditors (across user-level and project-level libraries — see § Composition rules below).
2. For each auditor, fires one LLM call with the auditor's body as the prompt fragment + the buffer + runtime-owned wrapping (role description, output-format spec). Calls SHOULD run in parallel; total latency is `max(N)`, not `sum(N)`.
3. Collects the N candidate rewrites.
4. Computes a diff per auditor: `(input buffer → its rewrite)`.
5. Merges diffs in `priority:` ascending order (lowest priority applied first; highest priority resolves overlapping spans last). Alphabetical-by-folder-name for ties. Non-overlapping diffs from all auditors apply together; overlapping spans defer to the higher-priority auditor.
6. Three-way merges the merged rewrite back against the user's typed buffer (preserving in-flight edits).

Why this model is RECOMMENDED: a malicious or buggy auditor's prompt body cannot steer the LLM during *another* auditor's call — they're separate calls with separate prompts. The injection surface that exists in composed mode (one auditor's body overriding instructions for sibling auditors in the same call) is structurally absent here. This matches the per-word dispatch property already proven for cues.

Cost: N× the LLM calls of composed mode. Runtimes MAY enforce a `max-concurrent-auditors:` limit (configured outside the standard).

### Composed mode (PERMITTED, NOT RECOMMENDED)

One LLM call total, all auditor bodies concatenated into the system prompt. The runtime:

1. Collects all enabled auditors.
2. Sorts them by `priority:` descending; alphabetical-by-folder-name for ties.
3. Concatenates each auditor's body into one prompt, separated by a runtime-defined delimiter (typically a heading like `## <auditor name>`).
4. Wraps the concatenated body with a runtime-owned preamble.
5. Sends one LLM call.
6. Three-way merges the rewritten buffer back.

Trade-off: cheaper (one call instead of N), but loses the structural injection isolation between auditors. A conformant runtime SHOULD only use composed mode when every auditor in scope is first-party-trusted (shipped in `defaults/` or authored by the user themselves). See § Trust model.

### Standard's coverage

The merge mechanism is a runtime concern (the OpenCues runtime uses `AgentRewrite` — see [`@opencues/runtime`'s `SPEC.md`](../packages/opencues-runtime/SPEC.md)). The standard specifies the auditor file format, the composition rules, and the requirement that *some* mode preserves user in-flight edits via three-way merge. The standard does NOT specify the diff/merge algorithm under isolated mode, nor the exact text wrapping under either mode.

### Composition rules

User-level (`~/.cues/auditors/`) and project-level (`<cwd>/.cues/auditors/`) libraries compose with these rules:

1. **ADD by default.** User auditors + project auditors all enter the composition. The project does not replace the user's library wholesale.
2. **Name-collision: project wins.** If both layers define `auditors/grammar/AUDITOR.md`, the project's file replaces the user's. Same `name:`, project version takes the slot.
3. **`disable:` is a SUBTRACT.** A project's `AUDITORS.md` master file MAY declare `disable: [<name>, ...]` in frontmatter; named auditors are excluded from this project's composition without modifying the user's `~/.cues/`. cd out of the project, the auditor fires again.
4. **Hot-reload polls every layer.** Edits to either master file or any per-auditor file are picked up on the next text-change event, same as cues and blanks.

The reason: cd-ing into a project should *extend* what the user has, never silently *remove* anything they didn't ask to remove. `disable:` is opt-in subtraction, never silent.

---

## Trust model

Auditors are **user-trusted only**. The standard does NOT define a registry, marketplace, or `add <pack>` mechanism for auditors. Cues and blanks may grow such mechanisms as the standard evolves; auditors deliberately do not.

### Why the asymmetry

Cues use per-word dispatch (`RoutedWordSourceGroup`): one word goes to one source, with no cross-source prompt influence. Blanks use per-`_` dispatch (`BlankSource`): one slot goes to one blank, same isolation. Auditors, when applied in composed mode (§ Composition), do NOT have this property — bodies share a single LLM call and can influence each other through the prompt.

Even in isolated mode, the auditor's *own* call still trusts whatever the LLM returns (a malicious body can make the LLM exfiltrate the buffer, inject downstream-targeting payloads, or semantically tamper with the user's text within its own concern's slice). Per-item dispatch closes the cross-auditor injection vector but not the single-auditor output vector. A registry would amplify both.

### What the standard requires

A conformant runtime:

1. MUST source auditors only from `<root>/auditors/` directories (user-level `~/.cues/auditors/` and project-level `<cwd>/.cues/auditors/`) or shipped defaults (`defaults/auditors/` in the runtime's distribution).
2. MUST NOT auto-install auditors from a network source without explicit user confirmation per-pack, including a display of the auditor's body (the prompt fragment) for inspection.
3. MUST NOT treat any frontmatter field (`trusted:`, `signed:`, `verified:`, etc.) as a substitute for user inspection. Trust attestations in the file itself are not authoritative — the *provenance* of the file is.
4. SHOULD log auditor activations in a way that makes the source path visible (which directory the file came from), so users can audit what's running.

### Sharing auditors

Authors who want to share an auditor SHOULD publish the `AUDITOR.md` file as documentation (a gist, a blog post, a repository README). Users who want to install it copy the file manually after reading the prompt body. This is by design: there is no shortcut around user inspection in v1.0 of the standard.

A future revision MAY introduce a registry mechanism with cryptographic provenance and structural output validation. v1.0 deliberately doesn't.

### Output validation

Independent of trust, runtimes SHOULD apply lightweight output validation to every auditor's rewrite (regardless of provenance):

- Length-delta cap: reject rewrites where `|output| / |input|` exceeds a runtime-configured threshold (the OpenCues runtime uses `1.5` by default).
- Character-class drift: flag rewrites that introduce zero-width Unicode, control characters, or unexpected character classes not present in the input.
- Unexpected-content emergence: flag rewrites that introduce URLs, markdown images, or code fences when the input contained none, unless the auditor's `expected-changes:` declares them.

These checks catch the "single bad auditor" failure mode that isolation alone doesn't. The runtime MAY surface flagged rewrites for user review or silently drop them; the standard does not specify the user-facing behaviour.

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
| `priority` | number | `50` | Merge precedence. In isolated mode, higher priority resolves overlapping spans last (its rewrite wins on conflicts). In composed mode, higher priority appears earlier in the concatenated prompt. Ties broken by alphabetical folder name. |
| `enabled` | boolean | `true` | Set `false` to keep the file but skip composition. |
| `on-host` | array of strings | (auto-detected) | Host-compat allow-list (`chrome`, `claude-code`, `gemini-cli`, `opencode`). See [`core.md` § Host compatibility](./core.md#host-compatibility). |
| `not-on-host` | array of strings | `[]` | Host-compat deny-list. |
| `expected-changes` | array of strings | `[]` | Optional declaration of content classes this auditor expects to introduce (`url`, `markdown-image`, `redaction-marker`, `code-fence`). Used by output-validation to suppress false positives — e.g. a `pii-redact` auditor declares `[redaction-marker]` so its `[REDACTED]` insertions don't trip the unexpected-content-emergence check. See § Trust model. |

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
4. Implement at least one of the two composition modes (§ Composition): isolated (RECOMMENDED) or composed (PERMITTED only when all auditors in scope are first-party-trusted).
5. Apply `priority:` ordering to the merge: isolated mode merges diffs in priority ascending order (highest priority resolves overlapping spans last); composed mode concatenates bodies in priority descending order in the prompt. Alphabetical-by-folder-name for ties in both modes.
6. Three-way merge the rewritten output back into the user's buffer (user's typed text vs LLM rewrite vs the buffer-at-prompt-time baseline) so in-flight edits are preserved.
7. Honour the trust model (§ Trust model): source auditors only from local directories or shipped defaults; never auto-install from a network source.
8. Honour `AUDITORS.md` `disable:` at the layer the master file appears.
9. Honour user→project composition rules (§ Composition rules).
10. Hot-reload on file changes — next rewrite picks up edits without restart.

A conformant runtime SHOULD:

- Use isolated mode by default. Reserve composed mode for environments where every auditor is provably first-party (e.g. a single-tenant deployment with auditor authoring locked to the operator).
- Apply lightweight output validation per § Trust model (length-delta cap, character-class drift, unexpected-content emergence) regardless of composition mode.
- Run isolated-mode calls in parallel — total latency = `max(N)`, not `sum(N)`.

A conformant runtime MUST NOT:

- Add automatic `match:` or `keywords:` gating (auditors are not per-word).
- Replace the user library when a project library is present (composition is ADD, not REPLACE).
- Apply `disable:` from one layer to another layer.
- Auto-install auditors from a network source without explicit per-pack user confirmation including display of the prompt body.
- Treat in-file trust attestations (`trusted: true`, `signed: ...`) as authoritative; trust derives from file *provenance*, not file content.

---

## LLM routing

A runtime MAY support per-feature LLM routing for auditors. The OpenCues runtime reads three optional settings from `OPENCUES.md`:

- `auditors-provider:` — which LLM provider to use (`groq`, `openai`, `anthropic`, …)
- `auditors-model:` — which model id to use
- `auditors-endpoint:` — override URL (rare; CI / local proxy)

These mirror `word-cues-provider`, `fluid-blank-provider`, `transform-blank-provider` — the same per-feature LLM routing pattern used by every other surface. See [`@opencues/runtime`'s `SPEC.md`](../packages/opencues-runtime/SPEC.md) § Multi-provider routing.

Per-auditor `provider:` / `model:` is currently NOT specified. Under composed mode it is structurally impossible (one prompt → one provider). Under isolated mode it is structurally possible (each auditor is its own call), but the standard does not yet require runtimes to support it. Future revisions MAY add per-auditor LLM choice as an optional capability.

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
- The two composition modes (isolated, composed), priority semantics, and which is RECOMMENDED.
- The trust model: user-trusted only, no registry distribution in v1.0.
- Composition rules: user→project ADD-by-default, name-collision rules, `disable:` SUBTRACT.
- The runtime contract: discovery, mode requirements, three-way merge, output validation.
- The master `AUDITORS.md` file's `disable:` list semantics.

## What this spec does NOT cover

- The exact diff/merge algorithm under isolated mode. Runtimes own this; the standard only requires that priority resolves overlapping spans and that user in-flight edits are preserved.
- The exact wrapping prompt the runtime adds (preamble + output-format spec). Each runtime owns its own wrapping; the standard only specifies that auditor bodies do NOT include such wrapping.
- Per-auditor LLM choice as a capability. Currently unspecified; future revisions MAY add it under isolated mode.
- The output-validation thresholds (length-delta cap, character-class drift sensitivity). Runtimes set their own; the standard only requires that *some* validation is applied.
- Trigger gating on the buffer level. Express gating in prose inside the body.
- A registry / marketplace / `add <pack>` mechanism for auditors. v1.0 deliberately omits this.
