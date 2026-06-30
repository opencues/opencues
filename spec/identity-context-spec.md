# identity-context-spec — the `IDENTITY.md` file format & sentinel token contract

> **Status:** `0.4-alpha`. Expect changes.

`IDENTITY.md` is the **user's personal-data catalog**. Each frontmatter
field derives a canonical bracket-token (a *sentinel*) the LLM can
emit to refer to that field without the value reaching the prompt. A
post-processor substitutes resolved tokens back to values before the
LLM output reaches the user's buffer. Opt-in via the
`identity-context-mode` scalar in `OPENCUES.md`.

This document specifies the file format, the token derivation rules
(canonical across implementations), and what a conformant runtime
MUST do when consuming the catalog.

---

## The format

A single file at the user-level root: `~/.cues/IDENTITY.md` (or
`$OPENCUES_HOME/IDENTITY.md` when set). Frontmatter is the catalog;
the markdown body is reserved for a future free-text-context phase
and is currently ignored by conformant readers.

### Anatomy

```
~/.cues/IDENTITY.md
├── YAML frontmatter        (required when the file exists)
│   ├── <key>: <value>      (zero or more catalog entries)
│   └── (inline description optional — see below)
└── Markdown body           (reserved; readers ignore in 0.1-alpha)
```

There is **no per-project overlay**. Identity context is user-level
only — a project-level `.cues/IDENTITY.md` MUST be ignored. Readers
that follow the standard search-path (`core.md`) skip the file when
walking project roots.

---

## Configuration spec

### Frontmatter — catalog entries

Each YAML key/value pair is one catalog entry. The key is freeform
identifier-shaped; the value is the resolved string.

| Field shape | Type | Notes |
|---|---|---|
| `<key>` | string identifier matching `[A-Za-z][A-Za-z0-9_-]*` | Becomes the field's identifier. Other shapes (path-traversal, shell metas, unicode tricks) MUST be rejected at write time. |
| `<value>` | string | Resolved value. Control characters (`\x00-\x08`, `\x0B`, `\x0C`, `\x0E-\x1F`, `\x7F`) MUST be rejected. Length cap defaults to 256 chars. |

Empty values are skipped — the catalog never includes a token that
resolves to nothing.

### Inline descriptions (optional)

An inline comment `# description: <text>` after a value sets the
LLM-facing description for the field's catalog entry. Without it,
the description is auto-derived from the key.

```yaml
---
workCity: London     # description: where I work
phoneE164: +447...
---
```

### Capacity caps

Conformant readers MUST refuse writes that would exceed:

- **Field count**: 64 (default)
- **Value length**: 256 characters (default)

These caps are defence-in-depth bounds (`DEFAULT_SENTINEL_CAPS` in the
reference implementation). Implementations MAY raise the cap per
call site but MUST NOT lower it below sane minima.

---

## Token derivation

The derivation algorithm is **canonical** — two independent readers
consuming the same `IDENTITY.md` MUST derive the same tokens for the
same keys. Without this guarantee, the post-processor wouldn't be
able to resolve tokens emitted by an LLM that an alternate reader
trained against.

### Algorithm

1. Insert a space between lowercase→uppercase transitions
   (`firstName` → `first Name`).
2. Insert a space between uppercase→[uppercase+lowercase] transitions
   (`phoneE164` → `phone E164`, not `phone E 164`).
3. Replace `_` and `-` separators with single spaces.
4. Collapse consecutive whitespace to a single space.
5. Trim leading/trailing whitespace.
6. Uppercase.
7. Wrap in `[ ]`.

```
firstName        → [FIRST NAME]
first_name       → [FIRST NAME]
first-name       → [FIRST NAME]
FIRST_NAME       → [FIRST NAME]
workCityHome     → [WORK CITY HOME]
phoneE164        → [PHONE E164]
homePostcode     → [HOME POSTCODE]
```

Reference: `packages/opencues-core/src/identity-context.ts:deriveToken`.

### Token collision

Two keys that derive to the same token (`firstName` and `first_name`
both produce `[FIRST NAME]`) MUST be rejected at write time. The
parser's first-wins behaviour at read time silently drops collisions;
the validator surfaces them so a stale write looks like it
succeeded but didn't never happens.

---

## Modes — the `identity-context-mode` scalar

The OPENCUES.md scalar `identity-context-mode` gates how the
catalog reaches the LLM:

| Value | Behaviour |
|---|---|
| `off` (default) | Catalog never read. Conformant readers MUST NOT load `IDENTITY.md` into runtime state. |
| `safe` | Token names + descriptions reach the LLM (no values). LLM emits tokens; runtime post-processor substitutes values locally. PII stays on the host. |
| `raw` | Token names, descriptions, AND values reach the LLM. PII is in the provider's logs. |

`raw` is implementation-complete but MUST be hidden from interactive
cycling menus (the reference impl sets `exposeInMenu: false` on the
value) — flipping it should be a deliberate file edit, not a
keystroke.

---

## Runtime contract

A conformant runtime MAY adopt the catalog-injection model below. A
runtime that chooses not to use sentinel tokens at all still meets
the format spec — the catalog file format and token derivation
rules are the wire contract; injection + post-processing are
implementation choices a reader can omit.

### Catalog emission

In `safe` mode, the LLM-bound prompt receives a block listing each
field's `token` + `description` (no value). In `raw` mode, the block
also includes the value:

```
safe:    [FIRST NAME] — first name
         [EMAIL]      — email
raw:     [FIRST NAME] — first name (value: Wilfred)
         [EMAIL]      — email      (value: wilfred@example.com)
```

The exact prompt shape is implementation-defined — the standard
fixes the catalog being injected, not the prose around it.

### Post-processing

When the LLM emits text containing bracket-tokens, a conformant
runtime MUST:

1. **Resolve verbatim** any token present in the catalog →
   substitute its value into the output.
2. **Strip unknown tokens** (hallucinated by the model — `[BLOOD
   TYPE]` for a field not in the catalog). These MUST NOT reach the
   user's buffer.
3. **Preserve user-typed bracket strings** in the original input —
   if the user already typed `[FIRST NAME]` literally (writing
   docs about the identity API), the post-processor MUST NOT
   substitute it; only tokens emitted by the LLM in fresh output
   are substituted.

### Tolerant matching

Implementations MAY apply tolerant matching for tokens with minor
deviations (`[WORK_CITY]` underscore drift, `[FIRST  NAME]` extra
whitespace) — collapse separators + whitespace before lookup. This
recovers LLM transcription noise. Implementations that skip tolerant
matching are still conformant; they just lose recall on noisy LLMs.

### Mode-gate composition with blank-context

Blank-as-context (`blank-context-mode`) shares the same sentinel
machinery for ambient blank tokens (`[STOCKS]`, `[WEATHER]`). The
per-blank opt-in lives in [`blank-spec.md`](./blank-spec.md) §
Sentinel aspects (`as-context: off | safe | raw` frontmatter +
`contextTtl`). When both modes are on, the two catalogs MUST be
merged without token collision (the validator's collision check
prevents user fields from shadowing blank tokens at write time).
When `blank-context-mode: raw` is requested but
`identity-context-mode` is NOT `raw`, conformant runtimes MUST
downgrade `blank-context-mode` to `safe` — flipping one without
the other is a footgun the spec closes deliberately.

---

## Security claims

- **Default-off.** Conformant readers MUST default the scalar to
  `off`. Users opt in.
- **Validator chokepoint.** Every code path that mutates
  `IDENTITY.md` MUST go through a single write-validator. Adding a
  second site that bypasses the validator is a regression — see
  `spec/SECURITY.md` and the reference's
  `docs/architecture/security-audit.md` row #24.
- **No ambient-context influence.** The sentinel-write blank MUST
  ignore page placeholder / aria / field-label metadata. A hostile
  page cannot influence what gets written.
- **One field, one answer.** In `safe` mode the catalog prompt MUST
  instruct the LLM to emit at most one catalog token per response
  — defends against multi-field exfiltration attacks. See
  security-audit.md row #22.
- **Exact-person scope.** The catalog describes the user who is
  typing. Fields about other people (spouse, emergency contact,
  beneficiary, …) MUST NOT be filled with catalog values.

The structural backstop: OpenCues has no tool / exec / agent layer
for fluid-blank output. Worst-case prompt-injection lands as
user-visible buffer text the user sees before submitting. A
conformant runtime that wires identity-context tokens into a
side-effect channel (tool execution, MCP dispatch, clipboard, fetch)
violates this invariant and the threat model must be re-reviewed.

---

## Conformance

Conformance fixtures live at
[`conformance/identity/`](./conformance/identity/) (added alongside
this spec). The fixture shape:

- `valid/` — IDENTITY.md files a conformant parser MUST accept,
  paired with the expected derived-token set.
- `invalid/` — files that MUST be rejected (bad key shape, control
  chars, oversize values, token collisions, capacity overflow).
- `post-processor/` — LLM-output → post-processed-output pairs
  covering verbatim resolve, unknown-strip, originalBody preserve,
  tolerant matching.

---

## Examples

### Minimal — single field

```yaml
---
firstName: Wilfred
---
```

Derived tokens: `[FIRST NAME] → Wilfred`.

### Typical user

```yaml
---
firstName: Wilfred
lastName: Kasekende
email: wilfred@example.com
workCity: London
company: Command Stick
jobTitle: Founder
github: https://github.com/wkasekende
signOff: Best from sunny London  # description: my email sign-off
---
```

Derived tokens:

```
[FIRST NAME] → Wilfred
[LAST NAME]  → Kasekende
[EMAIL]      → wilfred@example.com
[WORK CITY]  → London
[COMPANY]    → Command Stick
[JOB TITLE]  → Founder
[GITHUB]     → https://github.com/wkasekende
[SIGN OFF]   → Best from sunny London   (description: "my email sign-off")
```

### What gets rejected

```yaml
---
"../etc/passwd": value         # invalid key — path traversal
foo;rm: value                   # invalid key — shell meta
firstName: "Wilfred\x07"        # invalid value — control char
firstName: Wilfred
first_name: Wilfred             # invalid — both derive to [FIRST NAME]
---
```

---

## In scope

- The on-disk format of `IDENTITY.md`.
- The canonical token derivation algorithm.
- The runtime contract for catalog emission + post-processing.
- The `identity-context-mode` scalar gates.
- The capacity caps that prevent runaway growth.
- The collision-prevention contract.

## Out of scope

- The exact LLM prompt prose around the catalog block (per
  pipeline; reference impl in
  `packages/opencues-core/src/sources/fluid-blank-source.ts` and
  `transform-blank-source.ts`).
- Per-pipeline internal sentinels (e.g. `CURSOR_SENTINEL` for
  TransformBlank cursor encoding) — those are implementation
  details, not wire format.
- Live mutation surfaces (CLI `opencues identity set`, the keyword-
  bound `set sentinel _` blank) — those are reference-impl
  conveniences; the spec only defines the validator contract they
  MUST go through.
- Phase-2 raw-body injection (free-text body of `IDENTITY.md`
  reaching the LLM) — reserved, not specified in 0.1-alpha.

---

## Relationship to OpenCues runtime

The reference implementation in this repo:

- Reader: `packages/opencues-core/src/identity-context.ts`
- Validator: `packages/opencues-core/src/identity-validator.ts`
- Catalog emission + post-processing in FluidBlank:
  `packages/opencues-core/src/sources/fluid-blank-source.ts`
- Catalog emission + post-processing in TransformBlank:
  `packages/opencues-core/src/sources/transform-blank-source.ts`
- Live-mutation CLI: `packages/opencues-cli/src/commands/identity.cjs`
- Live-mutation in-editor blank: `SentinelBlank` in
  `packages/opencues-runtime/src/blanks/sentinel.ts`

A second runtime implementation needs to match this spec's wire
format + validator contract. The reference impl's prompt prose,
class hierarchy, and live-mutation surfaces are not part of the
contract.
