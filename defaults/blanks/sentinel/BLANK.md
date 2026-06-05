---
name: sentinel
type: blank
blankKeywords: set sentinel, remove sentinel
# Allow up to 16 words between the keyword and `_` so multi-word
# values land correctly (e.g. `set sentinel signOff Best from sunny
# London _`). 16 covers any realistic sentinel value (~80 chars of
# prose) while keeping false-positive matches narrow — without it,
# the proximity-0 default makes the blank silently miss every
# non-single-word value (TransformBlank wins the slot instead). A
# user with an unusually long value (>16 words / ~80 chars) falls
# back to `opencues identity set` from the CLI, which has no
# proximity limit. The 256-char value cap (validateSentinelWrite)
# still gates the actual content of any matched write.
blankProximity: 16
blankFormat: string
blankScript: ./sentinel-blank.sh
blankClearKeywords: true
blankClearOnEdit: true
# Sandbox: off because sentinel-blank.sh writes to ~/.cues/IDENTITY.md
# (identity-context personal data) which is outside the sandbox's tmpfs
# and would be refused by the read-only CUES root bind. Chrome routes
# this through SentinelBlank (impl: class, no spawn) so the sandbox
# declaration only affects native hosts.
sandbox: off
# Hosts that get the SentinelBlank built-in. Native hosts also fall
# back to the shell script if blankInvoke fails.
on-host: chrome, claude-code, gemini-cli, opencode, shell
# Blank-as-context: deliberately OFF. SentinelBlank is the WRITE
# surface for ~/.cues/IDENTITY.md — identity-context is a separate
# READ surface served by IDENTITY.md frontmatter directly. Surfacing
# the write-blank as ambient would be a meaningless self-reference.
as-context: off
---

# Sentinel — write to ~/.cues/IDENTITY.md from inside the editor

Triggered by `set sentinel <key> <value> _` (add/update) or
`remove sentinel <key> _`. Every write goes through the single
validator chokepoint at `@opencues/core`'s `validateSentinelWrite`.

## Examples

```
set sentinel jobTitle Founder _
set sentinel signOff Best wishes _
remove sentinel jobTitle _
```

## What the validator enforces

- **Key shape** — `[A-Za-z][A-Za-z0-9_-]*`. Refuses path traversal
  (`../etc/passwd`), shell metacharacters (`foo;rm`, `foo|cat`),
  Unicode tricks.
- **Value shape** — refuses NUL + C0/C1 control chars (defence-in-
  depth against YAML / `identity-context-mode: raw` prompt smuggling).
- **Value length** — 256-char cap.
- **Capacity** — 64-field cap. Refuses unbounded growth.
- **Token collision** — `firstName` and `first_name` both derive to
  `[FIRST NAME]`. Validator refuses the second so the first isn't
  silently shadowed.

## Errors

Errors paint visibly into the buffer as `[err] <detail>`. Never
silent, never throws. Examples:

- `[err] IDENTITY.md is full — 64/64 fields defined. Remove unused ones …`
- `[err] key "../foo" must match [A-Za-z][A-Za-z0-9_-]* — letters/…`
- `[err] value for "note" contains forbidden control characters`
- `[err] key "first_name" derives to [FIRST NAME] — same token as existing "firstName"`

## Security

See `docs/architecture/security-audit.md` row #24 for the full threat
model. Key invariants:

1. **Keyword-bound only.** No LLM classification routes here.
2. **Trust-gate protected.** The `_` keystroke is policed by the
   credit-based trust gate (row #13); a hostile page can't
   synthesise the trigger.
3. **No ambient context.** Ignores page placeholder/aria/title.
4. **Pack-shadow defended.** Built-in `sentinel` wins over any
   user-pack with the same name (row #12, first-wins).
5. **Validator is the only write path.** The shell-script fallback
   routes back to `opencues identity set`, which uses the same
   validator.
