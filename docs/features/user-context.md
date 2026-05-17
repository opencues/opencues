# User context

Stop typing your name, email, work city, and other personal facts
into every form. Tell OpenCues once via `~/.cues/USER.md`; from then
on the `_` blank uses your real data when it's relevant.

**Off by default.** Opt in via `user-context-mode: safe` in
`~/.cues/OPENCUES.md`. Phase 1 wires fluid-blank only.

## The 30-second example

Edit `~/.cues/USER.md`:

```yaml
---
firstName:    Wilfred
email:        wilfred@example.com
workCity:     London
github:       https://github.com/wkasekende
---
```

In `~/.cues/OPENCUES.md` flip the mode:

```yaml
user-context-mode: safe
```

Now on any web form, type `my email _` → fluid-blank substitutes
`wilfred@example.com`. Type `my github _` → substitutes the URL.
Type `i work in _` → substitutes `London`.

The LLM never sees the actual values in `safe` mode — it sees a
catalog of tokens like `[EMAIL]` and emits the right one; a runtime
post-processor swaps in the real value before it lands in your
buffer.

## Two modes

**`safe` (recommended)** — Send token names + descriptions only
(`[EMAIL] — user's email`). The LLM emits sentinel tokens; the
runtime substitutes values **after** the response. Your PII never
reaches the LLM provider's logs.

**`raw`** — Inline actual values into the prompt
(`[EMAIL] — user's email (value: wilfred@example.com)`). The LLM
sees real data so it can pick a register that matches your name
(e.g. "Dear Robert" vs "Hey Bob"). PII reaches the provider. Opt-in
when prose quality matters more than provider-log privacy.

**`off` (default)** — `USER.md` is never read.

## Field naming

Frontmatter keys auto-derive to sentinel tokens:

| Key | Token |
|---|---|
| `firstName` | `[FIRST NAME]` |
| `first_name` | `[FIRST NAME]` (same) |
| `first-name` | `[FIRST NAME]` (same) |
| `workCity` | `[WORK CITY]` |
| `homePostcode` | `[HOME POSTCODE]` |
| `phoneE164` | `[PHONE E164]` |

Pick whichever style you prefer. Per-field description override via
an inline `# description: ...` comment:

```yaml
workCity: London  # description: city I work in (not where I live)
```

## What's protected

| Threat | Protection |
|---|---|
| LLM provider sees my PII | `safe` mode keeps values on the host. `raw` mode opts you out — that's the trade-off. |
| OpenCues sends USER.md to a network | No. Only the focused field's catalog reaches FluidBlankSource, then the FluidBlank LLM endpoint you configured. |
| A pack reads USER.md | Not in Phase 1. FluidBlankSource (core, built-in) is the only consumer. Pack consumption arrives in Phase 2 with a per-pack `requires-user: [...]` declaration. |
| LLM hallucinates `[DATE OF BIRTH]` | Post-processor strips any token not in your catalog. Pinned by tests. |
| LLM emits `[WORK_CITY]` underscore instead of `[WORK CITY]` space | Post-processor tolerant-matches case + space/underscore variants. |
| I write `[FIRST NAME]` in a doc; LLM rewrites it | The post-processor checks your original buffer text. Anything you typed yourself is preserved as-is. |

Full threat model + design:
[`docs/architecture/user-context.md`](../architecture/user-context.md).

## What's NOT supported in Phase 1

- **Body text in USER.md.** The body (free prose after the
  frontmatter's closing `---`) is ignored. Reserved for Phase 3.
- **Other pipelines.** Transform-blank, word-cues, agent-rewrite,
  auditors all explicitly skip user-context. Fluid-blank only.
- **Per-project USER.md.** Global only. User data isn't
  project data.
- **Per-pack field requests.** Until packs can declare
  `requires-user: [...]`, only built-in fluid-blank sees the
  catalog.

## Where the data lives

`~/.cues/USER.md`. Same directory as `OPENCUES.md`. Shipped as a
commented-out template (run `opencues seed-configs` to drop it in
place). Re-edit any time — changes hot-reload on the next keystroke.

## See also

- [`docs/architecture/user-context.md`](../architecture/user-context.md) — design + threat model
- [`docs/architecture/ambient-context.md`](../architecture/ambient-context.md) — the related feature
- [`tests/benchmarks/user-context/FINDINGS.md`](../../tests/benchmarks/user-context/FINDINGS.md) — bench evidence that shaped the design
