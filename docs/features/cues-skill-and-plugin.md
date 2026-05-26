# Cues skill + plugin (experimental, WIP)

Two ways to side-effect-write `.cues/CUES.md` while the user is in a
chat conversation with their AI assistant:

1. **The cues skill** — a Claude skill the chat model invokes itself
   when it judges the conversation is "domain engagement". Works with
   any Claude-driven host (Claude Code, OpenCode, etc.).
2. **The cues plugin** — an OpenCode plugin that hooks
   `chat.message` and runs deterministically on every user turn. No
   model judgment in the loop.

Both write the same `.cues/CUES.md` file format (frontmatter +
`## Prompt` word-cue / sentence-cue sources + `## Tips` JSON block).
The OpenCues runtime reads it the same way regardless of which one
produced it.

**Status: experimental / WIP.** Behaviour, file layout, and CLI
shapes may change. Not recommended for production reliance yet.

---

## Install

```bash
# Skill — works on Claude Code and OpenCode
opencues install skill cues
opencues install skill cues --project        # scope to <cwd>/.claude/skills/
opencues install skill cues --force          # overwrite, .bak the old

# Plugin — OpenCode only (uses opencode's chat.message hook)
opencues install plugin cues
opencues install plugin cues --force         # overwrite, .bak the old

# Uninstall
opencues uninstall skill cues
opencues uninstall plugin cues
```

`opencues install skill cues` writes to BOTH `~/.claude/skills/cues/SKILL.md`
AND `~/.config/opencode/skills/cues/SKILL.md` (the latter only if the
opencode config dir exists).

`opencues install plugin cues` writes to
`~/.config/opencode/plugins/cues.ts` AND copies the prompt source to
`~/.config/opencode/plugins/cues.SKILL.md` AND registers the plugin
in `~/.config/opencode/config.json`'s `plugin: [...]` array.

Run only one at a time — installing both means both fire and the
second-finishing one overwrites the first's file each turn.

---

## When the skill fires vs the plugin

**The skill** relies on the chat model recognising the domain and
choosing to invoke the skill. Skill text instructs it to fire on
"every substantive turn", but fire reliability varies:

- Sonnet 4.6 — fires reliably (bench: ~95%+ on substantive turns)
- Sonnet 4.5 — fires less reliably; sometimes engages in the user's
  task without writing CUES.md until explicitly asked
- Haiku 4.5 — frequently silent (bench: 16 of 19 turns no-fire)

**The plugin** fires on every `chat.message` event with no model
judgment. The plugin then spawns a throwaway session and makes its
own LLM call using a dedicated cues model (default Haiku for
latency; override with `OPENCUES_CUES_MODEL=anthropic/claude-sonnet-4-6`).
This decouples cues quality from the chat model — the user can chat
with Sonnet/Opus while cues stay snappy on Haiku.

| Trait | Skill | Plugin |
|---|---|---|
| Fire on every turn | depends on model judgment | yes, deterministic |
| Model latency | uses the chat model | dedicated (Haiku by default) |
| Cost | uses the chat model's token budget | separate, small LLM call per turn |
| Host support | Claude Code, OpenCode | OpenCode only |
| Setup | one file in skills dir | plugin file + config entry |

The plugin is the right primitive when you need ambient reliability.
The skill is fine when you only want cues on "the model thinks this
is a domain turn" — useful for narrow domains where you don't want
cues on every off-topic exchange.

---

## How the plugin works (current implementation)

The plugin lives at `integrations/opencode/plugin/cues.ts` and is
copied to `~/.config/opencode/plugins/cues.ts` at install time.

On every `chat.message` hook fire:

1. Read the prompt source (the same skill text users install for
   the skill path — bundled with the plugin so it's self-contained).
2. Pull the last 5 session turns as conversation context
   (configurable via `OPENCUES_CONTEXT_TURNS`).
3. Read the existing `.cues/CUES.md` if present (so the LLM extends
   rather than rewrites from scratch).
4. Create a throwaway opencode session with the cues prompt:
   - `system` = the skill text
   - User content = context + new message + existing-CUES + "override
     directives" telling the LLM to output ONLY the file content (no
     tool calls, no chat preamble).
   - `model` = Haiku (or `$OPENCUES_CUES_MODEL`).
   - `tools: {}` = all tools disabled (no Write tool, no Read, etc.).
5. Wait for the response, extract the text part, write to
   `<cwd>/.cues/CUES.md`.
6. Delete the throwaway session.

A recursion guard tracks throwaway session IDs in a Set; the
`chat.message` hook short-circuits if `hookInput.sessionID` is one
of ours (otherwise `session.prompt` would fire `chat.message` back
into the plugin infinitely).

Failure mode: hook failures never break the main chat. Errors
log to `/tmp/opencues.log` under `[oc-cues-plugin]`.

Bench (fresh project, "Building a Go rate-limiter middleware..." prompt):

- Sonnet 4.6 cues model: ~61s, ~11K CUES.md
- Haiku 4.5 cues model: ~34s, ~13K CUES.md (default)

---

## Known limitations

1. **Skill engagement on smaller models.** Haiku rarely fires the
   skill on its own. Use the plugin if you want cues on Haiku-only
   sessions.
2. **Plugin uses opencode's session API.** That's an internal-ish
   API surface; the shape we depend on (`session.prompt` with
   `tools: {}` to disable tools, `model: { providerID, modelID }`
   to override) may change between opencode versions. Pinned to
   OpenCode 1.14.17.
3. **Both can be installed simultaneously** with no warning, and
   both will fire each turn. Uninstall one before installing the
   other.
4. **Per-turn cost.** The plugin adds a Haiku call per chat turn.
   On a long session this adds up. For ambient writing this is
   the design — but watch your bills.

---

## Open questions for future iteration

- Should the plugin uninstall the skill automatically when
  installed (and vice versa)?
- Should we ship a faster prompt template specifically for the
  plugin's deterministic path (the current text was written for
  the skill's chat-tool-call path and includes "override" prefixes
  to disable that behaviour)?
- Plugin support for other hosts — Claude Code has its own hook
  system (`UserPromptSubmit`) that could mirror this. Not
  implemented today.
- Cost-aware skipping: plugin currently fires on every message,
  including "ok", "thanks", "yes" follow-ups. Could short-circuit
  on messages below N tokens or with no content words.

See `tests/agentic/bench/predict-future-cues/FINDINGS.md` for the
skill iteration history (v3.0c → v3.0f) and bench results across
domains and models.
