---
last_updated: 2026-05-08
---

# Adding an Auditor

An **auditor** is a one-concern inline-rewrite contributor. Each auditor declares one thing the agent should care about (grammar, clarity, jargon, tone, PII, …). Multiple auditors **compose into a single LLM call** per agent tick — they don't fan out into separate calls. Drop a folder, ship a prompt fragment, done.

> Auditors fire only when an agent task is armed (`agentically X _`) AND `transform-blank-mode: on` in your `OPENCUES.md`. They're the third surface of the OpenStandard, alongside cues and blanks. See [`spec/auditor-spec.md`](../../spec/auditor-spec.md) for the standard contract.

## 1. The minimum viable auditor

```
~/.cues/auditors/<name>/AUDITOR.md
```

Folder shape only — no flat-file alternative, same as cues and blanks.

```markdown
---
name: british-english
description: Enforce British English spelling and idiom
priority: 50
enabled: true
---

You are checking for non-British spellings and Americanisms. Rewrite ONLY clear cases:

- -ize → -ise (organize → organise; emphasize → emphasise). Exceptions: "size", "prize" — those aren't from -ise.
- -or → -our (color → colour; favorite → favourite).
- Date format: "March 5, 2026" → "5 March 2026".
- "gotten" → "got".

Preserve quoted text, technical terms (e.g. "stylize" in CSS contexts), and proper nouns. If the buffer is already British, return it unchanged.
```

That's it. No code, no registration, no integration changes. The runtime auto-discovers it on the next keystroke, and the next agent tick composes the body into the rewrite system prompt under `## british-english`.

## 2. What the frontmatter does

| Field | Required | Purpose |
|---|---|---|
| `name` | yes | Source id. Should match the folder name. The validator warns on mismatch. |
| `description` | recommended | Used by `opencues list`, validators, and human readers. NOT read by the LLM. |
| `priority` | no (default 50) | Concat ordering: higher number → appears earlier in the composed prompt. Ties broken by alphabetical folder name. |
| `enabled` | no (default true) | Set to `false` to keep the file but skip composition. |
| `on-host` / `not-on-host` | no | Host-compat allow/deny lists. Same shape as cues and blanks. |

Notably **absent**: `match:`, `keywords:`, `parser:`. Auditors operate on the whole buffer, not per-word — there's nothing to gate at runtime. Express any "only fire when X" logic in the prompt body itself ("Rewrite ONLY clear cases…").

Also absent: per-auditor `provider:` / `model:`. Composition is a single LLM call, so the LLM choice lives at the feature level (`auditors-provider:` / `auditors-model:` in `OPENCUES.md` if you want to override the global default).

## 3. What the body should look like

The body is the prompt fragment that gets concatenated into the agent's system prompt. Each auditor contributes its concern-specific slice; the runtime supplies the wrapping (role description, buffer placeholder, output spec). So your body should:

- **Declare one concern.** Grammar OR clarity OR tone — not all three.
- **Be specific about what to rewrite and what to preserve.** "Rewrite ONLY clear errors. Preserve voice and intentional fragments."
- **Express gating in prose.** "If the buffer is already grammatically clean, return it unchanged."
- **Not include preamble.** No "you are an editor" — the runtime adds that. Don't restate the rewrite contract.
- **Not include output-format instructions.** "Return the corrected buffer" / "output as JSON" — the runtime owns the output contract.

Compare the two shipped defaults for shape:
- [`defaults/auditors/grammar/AUDITOR.md`](../../defaults/auditors/grammar/AUDITOR.md)
- [`defaults/auditors/clarity/AUDITOR.md`](../../defaults/auditors/clarity/AUDITOR.md) (disabled by default; opt in)

## 4. Composition — what the LLM actually sees

When grammar (priority 50) and your british-english (priority 50) and clarity (priority 40, enabled) are all on, the agent's system prompt becomes roughly:

```
[runtime preamble: "You are an inline editor reviewing a buffer.
Apply each auditor below to the buffer. Return the corrected buffer."]

## british-english
You are checking for non-British spellings and Americanisms…

## grammar
You are checking for grammar and basic style errors…

## clarity
You are checking for verbosity and buried meaning…

[runtime appends the buffer + cursor sentinel + output-format spec]
```

Order: priority desc, alphabetical for ties (so `british-english` lands before `grammar` because of alphabetical tiebreak — both at priority 50).

One LLM call. All concerns applied together. The model decides per-buffer which to act on; if the buffer is already british + grammatically clean, all the auditors return the buffer unchanged.

## 5. Per-project disable

To skip an auditor in a specific project without removing the file (e.g. you have a british-english auditor at user level but this project is American):

`<project>/.cues/AUDITORS.md`:
```yaml
---
name: my-project-auditors
disable: [british-english]
---
```

The auditor is filtered out at this layer's composition. cd out of the project, it fires again. Same `disable:` mechanic cues and blanks have, scoped per-surface.

## 6. Test it

1. Drop your `AUDITOR.md` in `~/.cues/auditors/<name>/AUDITOR.md`.
2. Make sure your `~/.cues/OPENCUES.md` has `transform-blank-mode: on`.
3. In a patched host, type `agentically rewrite this nicely _`.
4. Watch `/tmp/opencues.log` for `AgentRewrite: round start` and the system prompt content (only when `debug-mode: on`). Confirm your `## <name>` section is in the prompt.
5. Type some text that exercises your concern. Pause for the agent-debounce window (default 1000ms; set in OPENCUES.md). Verify the rewrite reflects your auditor.
6. To temporarily disable: flip `enabled: false` in your AUDITOR.md, save. Hot-reloads on next keystroke.

## 7. Common pitfalls

- **Putting role preamble in the body.** "You are a helpful editor…" — duplicates the runtime preamble; can confuse the model into ignoring concern-specific instructions.
- **Putting output-format instructions in the body.** "Output as JSON" — overrides the runtime contract; the merge layer can't parse it. Just write the rewrite concern in prose.
- **Using `match:` or `keywords:`.** Inert — auditors don't have triggers; remove these fields if you copied a CUE.md template by accident.
- **Per-auditor `provider:`.** Inert. Composition is one LLM call; per-auditor LLM routing isn't supported. Use `auditors-provider:` / `auditors-model:` in OPENCUES.md if you want a non-default model for the agent.
- **Forgetting `transform-blank-mode: on`.** Without it, `agentically X _` falls through fluid-blank as a lookup query and your auditor never gets composed. Default `on` in fresh `defaults/OPENCUES.md`, but existing user installs may not have it (seed-configs is first-time-only).

## 8. Spec references

- [`spec/auditor-spec.md`](../../spec/auditor-spec.md) — full standard for the `AUDITOR.md` file format and runtime contract
- [`spec/core.md`](../../spec/core.md) §Master files — `AUDITORS.md` master file, `disable:` semantics
- [`spec/opencues-runtime.md`](../../spec/opencues-runtime.md) §Agent-task lifecycle keywords — how `agentically X _` arms and triggers the agent that consumes auditors
- [`docs/features/agent-task.md`](../features/agent-task.md) — agent-task UX and behaviour (debounce, atomic span delete, statusline indicator)

## 9. Examples worth writing

These don't ship as defaults (too opinionated), but are common starter auditors users build for themselves:

| Name | What it does |
|---|---|
| `british-english` | Enforce -ise, -our, -re spellings |
| `tone-formal` | Bump register up — "gonna" → "going to", contractions → expansions |
| `tone-casual` | Bump register down — strict prose → friendlier |
| `no-emdashes` | Replace em dashes with commas, parens, or sentence breaks |
| `pii-redact` | Flag emails, phone numbers, addresses with `[REDACTED]` |
| `house-style` | Project-specific terminology enforcement (e.g. "Anthropic" not "anthropic", canonical product names) |
| `inclusive-lang` | Replace gendered defaults, ableist idioms |

Drop the folder, ship the prompt fragment, done. Let the runtime do the composition work.
