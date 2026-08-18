# Rules — the always-on watchlist

Every `- ` bullet below is one rule on the session-contradiction watchlist:
type a plan that goes against one and a passive ⚠ cue names the rule, with a
reconciled rewrite on Ctrl+Alt+↑. Everything that is not a bullet — headings,
this prose — is ignored, so the file can read as a policy document.

These nine ship as defaults because each was benchmarked to a perfect score
before shipping (28/28 caught citing the exact right rule, 0 false alarms on
drafts that mention a rule's topic while complying with it — see
tests/benchmarks/session-contradiction/company-rules-bench.mjs, the
shipped-defaults domain). They flag, they never block: each cue is dismissible
with `_` like any other, and CI remains the real gate.

Make it yours: edit or remove bullets freely, add your team's own. A
project-level `.cues/RULES.md` beats this user-level file. To opt out
entirely, delete the bullets but KEEP the file — an edited file is never
touched by `opencues seed-configs`, but a deleted one is reseeded on the next
install. Keep the list curated: the watchlist caps at 24 entries and matcher
precision degrades as it bloats.

## Secrets

- Secrets, API keys, and tokens never go in code, config files, or logs.
- Never paste a real credential into a chat, ticket, or AI prompt — rotate any that leaks.
- Never commit .env or credential files — use a secret manager.

## Production

- Never run destructive commands (rm -rf, DROP TABLE, force-delete) against production.
- Never edit production data by hand — go through a reviewed script or migration.
- Confirm a backup exists before any irreversible operation.
- Never use production data in tests or local dev without anonymizing it.

## Discipline

- Never disable, skip, or delete a failing test to make CI pass — fix it or quarantine it with a ticket.
- Never give an agent blanket permission to run destructive commands unattended.
