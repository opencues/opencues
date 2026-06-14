---
name: sentinel
type: blank
blankKeywords: set sentinel, remove sentinel
# blankShapes: precision gate (June 2026). Two shapes — set captures
# the full "<key> <value>" payload; remove captures just the key.
# The proximity-16 hack (needed under the legacy gate to allow
# multi-word values) retires — shapes anchor at start of input and
# accept arbitrary content for the value, no false-positive surface
# at all. The SentinelBlank class continues to split the captured
# payload into key + value and validate via validateSentinelWrite
# (security chokepoint unchanged).
blankShapes: [{"pattern":"^set\\s+sentinel\\s+(.+?)\\s*_$","action":"get","valueGroup":1},{"pattern":"^remove\\s+sentinel\\s+(\\w+)\\s*_$","action":"get","valueGroup":1}]
blankFormat: string
blankClearKeywords: true
blankClearOnEdit: true
blankConsumeContext: true
# Runtime-only blank — served by SentinelBlank in @opencues/runtime on
# every host (chrome.storage on chrome; injected readFile/writeFile
# against ~/.cues/IDENTITY.md on every native host). The resolver tries
# blankInvoke first and never falls back to spawn for this name, so no
# blankScript: / sandbox: is needed. Every write still goes through
# validateSentinelWrite (the chokepoint enforces key shape, value cap,
# token collision, capacity — see security-audit.md row #24).
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
5. **Validator is the only write path.** Every host invokes
   `SentinelBlank.set()` via `blankInvoke`, which calls
   `validateSentinelWrite` before touching disk.
