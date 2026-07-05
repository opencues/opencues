# README TODO — ideas not yet implemented

Notes from comparing our README against two reference READMEs
([openclaw/openclaw](https://github.com/openclaw/openclaw) and
[santifer/career-ops](https://github.com/santifer/career-ops)). Video/demo
embeds are tracked separately (inline `<!-- VIDEO -->` comments already in
`README.md`) — this file is everything else that came up but wasn't
implemented yet.

## Worth adding

- **Star History chart** — a `star-history.com` embed. Already flagged as a
  commented-out TODO in an earlier README draft, never wired up. Cheap,
  needs the repo to be public + have accumulated some stars first.

- **"Docs by goal"** — a compact "I want to do X → read Y" quick-nav table,
  distinct from the doc links already scattered contextually through each
  section. OpenClaw does this well as a single table near the bottom.

- **Two-tier security framing** — OpenClaw splits "security defaults" (what's
  safe out of the box, opt-in features listed as off-by-default) from
  "security model" (how the sandbox actually works — the defense-category
  table we already have). Ours is currently one merged section.

- **Tech Stack** — a one-line list of core dependencies (TypeScript,
  `isolated-vm`, esbuild, tweakcc). Quick credibility signal for anyone
  evaluating the project technically. From career-ops.

- **Disclaimer** — a short note about AI-generated output, data handling,
  liability. Given OpenCues touches personal data (identity-context) and
  runs third-party packs, this feels more warranted for us than a typical
  project. From career-ops.

- **Project structure (mini)** — a short directory tree (5-8 lines, NOT the
  full CLAUDE.md tree) showing `packages/`, `integrations/`, `defaults/`,
  `docs/`. From career-ops.

## Considered, not worth adding

- **Sponsors** — no sponsors yet; revisit once/if that changes.
- **Separate "Apps" section** — our Integrations section already covers
  this ground (per-host table + badges).
- **Author bio** — OpenCues is an org project, not a personal dev brand;
  career-ops's "About the Author" doesn't map cleanly.

## If picking just 1-2

Star History (basically free, already half-planned) and Tech Stack
(highest credibility-per-line) were the two recommended first.
