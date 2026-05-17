# User.md — your personal data for sentinel-mode fluid-blank

This file holds **your own** personal data (first name, email, work
city, etc.) that OpenCues can offer to the LLM when you trigger a
`_` lookup. Off by default — set `user-context-mode: safe` (or `raw`)
in `OPENCUES.md` to opt in.

When you type `my email _` on any field, fluid-blank receives a
catalog of the fields below (as `[FIRST NAME]`, `[EMAIL]`, etc.) and
emits the right sentinel. In **safe** mode the catalog carries only
token names + descriptions; a runtime post-processor substitutes the
real value AFTER the LLM responds, so your PII never reaches the LLM
provider's logs. In **raw** mode actual values are inlined into the
prompt (better prose register, worse privacy).

To start: uncomment any field you want available, replace the value
with yours, and flip `user-context-mode` in `OPENCUES.md` to `safe`.

Full design + threat model: `docs/architecture/user-context.md`.

---
# Identity. Auto-derived token names shown after each key:
# firstName:    Wilfred                   # → [FIRST NAME]
# lastName:     Kasekende                 # → [LAST NAME]
# fullName:     Wilfred Kasekende         # → [FULL NAME]
# pronouns:     he/him                    # → [PRONOUNS]
#
# Contact:
# email:        wilfred@example.com       # → [EMAIL]
# phone:        +44 7700 900123           # → [PHONE]
#
# Work:
# jobTitle:     Software Engineer         # → [JOB TITLE]
# company:      Acme Corp                 # → [COMPANY]
# workCity:     London                    # → [WORK CITY]
#
# Home / location:
# homeCity:     London                    # → [HOME CITY]
# homeCountry:  United Kingdom            # → [HOME COUNTRY]
# homePostcode: SW1A 1AA                  # → [HOME POSTCODE]
#
# Online presence:
# github:       https://github.com/wkasekende    # → [GITHUB]
# linkedin:     https://linkedin.com/in/wkasekende # → [LINKEDIN]
# twitter:      "@wkasekende"             # → [TWITTER]
# website:      https://wkasekende.com    # → [WEBSITE]
---

## How sentinel mode works

Frontmatter keys auto-derive to `[UPPERCASE WORDS]` tokens. The mapping:

- `firstName` (camelCase) → `[FIRST NAME]`
- `first_name` (snake_case) → `[FIRST NAME]`
- `first-name` (kebab-case) → `[FIRST NAME]`

Pick whichever style you prefer; they all canonicalise to the same
token. Multiple keys deriving to the same token deduplicate — first
wins.

To add your own field, just add a frontmatter line. The LLM catalog
auto-includes it; you don't need to declare it anywhere else.

## Tip: add dedicated fields for derived formats

If a form asks for a FORMAT not directly in your User.md (e.g.
`Country code (ISO 3166)` when your User.md has `homeCountry:
United Kingdom`), the LLM **can't reliably derive** `GB` from
the full country name — models default to generic placeholders
(`US`) or bail empty.

For formats you care about, add a dedicated field:

```yaml
homeCountryCode: GB         # → [HOME COUNTRY CODE]
nearestAirport:  LHR        # → [NEAREST AIRPORT]
phoneAreaCode:   020        # → [PHONE AREA CODE]
```

The runtime adds these to the catalog automatically — no schema
to update.

## What does NOT happen

This file is **never** sent verbatim to any LLM. The runtime:

1. Reads the frontmatter into a structured catalog (token → value).
2. In `safe` mode, sends only token + description (e.g. *"[FIRST NAME] — user's first name"*).
3. After the LLM responds, substitutes tokens with values locally.

The body text below this file (this prose) is reserved for a future
feature (free-text body injection) and is currently ignored.

## Future: free-text body

A planned Phase 3 of this feature will let you write longer prose in
this file's body (a short bio, current focus, preferred writing
style, etc.) for transform-blank-style rewrites. Body injection will
be opt-in per-pack and only available in `raw` mode. Until then the
body is purely documentation for yourself.
