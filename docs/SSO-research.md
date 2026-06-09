# SSO research — enterprise tier scoping for OpenCues

Forward-looking design notes on what an enterprise tier for OpenCues would actually contain, what the real customer asks are versus what marketing calls "Enterprise", and how to structure the open-source / paid split without falling into the SSO-tax trap.

This is a planning artifact, not a build spec. Decisions here unblock later concrete work (a `docs/architecture/enterprise.md` once we commit, an admin-dashboard repo, etc.).

---

## Today's state — what's missing

OpenCues currently has **no server-side identity layer at all**:

- LLM keys live in `~/.cues/OPENCUES.md` or env vars (`GROQ_API_KEY`, `OPENAI_API_KEY`, etc.).
- Configs (`CUES.md`, `BLANK.md`, folder cues / blanks) load from `$OPENCUES_HOME` → `<cwd>/.cues/` → `~/.cues/`.
- Every host (CC patch, OC patch, gemini-cli, chrome extension, shell) runs as the local user. OS process trust is the only auth gate.
- There is no user account, no session token, no audit log, no centrally-pushed config. The chrome native-messaging host watches `~/.cues/` locally; nothing remote.

Any "Enterprise tier" is therefore greenfield product work. The work is not adapting an existing identity layer; it is building one.

---

## What enterprise customers actually ask for

SSO is the visible part. The four asks that close the deal are usually:

### (a) Seat licensing

"Who's allowed to run OpenCues, paid by which org."

- Every `opencues run <host>` calls `POST /v1/seats/check` with `{ user_id, device_id, install_signature }`; service replies `{ valid: true, expires_at, features: [...] }`. Cached locally for ~24h so flights / offline work; refused after the grace period.
- Backend is a Postgres row `seats(user_id, org_id, status, expires_at)` plus a webhook from billing that flips seats inactive when subscription lapses.
- **Hard part:** offline-grace policy. Cursor uses 7d, Linear uses 30d. Too tight, devs hate you; too loose, departed employees keep running for a month.

### (b) Centrally-managed cue / blank packs

"Only org-approved cues + blanks run."

- `ConfigLoader` adds an `org_source` ahead of `~/.cues/` and `<cwd>/.cues/`. Bundles are pulled from a config service, signed with the org's public key, and verified at load time.
- Admin dashboard is a normal CRUD app: paste a git URL or upload a `.opencues-pack`, hit Approve, every machine pulls within ~30s via long-poll or websocket. Same pattern as MDM for mobile apps, just for cue packs.
- **Hard part:** local override policy. Does user-local beat org? Lockdown shops want "no"; productivity shops want "yes". Make it a toggle in admin UI, default off (lockdown wins).

### (c) Audit log

"What did everyone do."

- Every `blank.invoked`, `transform.applied`, `cue.cycled`, plus LLM prompt + (optionally) response, gets POSTed to an audit collector.
- Wire-shape mirrors today's `/tmp/opencues.log` lines, but the collector is a customer-supplied SIEM endpoint: Splunk HEC, Datadog Logs, S3+Athena, an OTLP receiver, whatever they're paying for. Stable JSON-per-line schema.
- **Hard part:** prompt redaction. Enterprises want "Alice used OpenCues 47 times" without storing the literal prompt text (PII, trade secrets). Either redact at source (hashes only) or ship raw and let the SIEM redact. Customers will disagree; make it configurable per org.

### (d) Deprovisioning

"Alice left, kill her access today."

- SCIM 2.0 (RFC 7644) is the standard. Service exposes `/scim/v2/Users` endpoints; the customer's IdP (Okta, Azure AD, Google Workspace) calls `DELETE /scim/v2/Users/{id}` when the HR system flips Alice to terminated.
- Service marks her seat inactive, revokes refresh tokens; the next `seats/check` from her laptop returns 403.
- Combined with the 24h `seats/check` cache, removal propagates within ~24h worst-case, near-instant if her host is online.
- **Hard part:** bidirectional sync. Customers want "show me which OpenCues users don't exist in our IdP anymore" — a SCIM-pull job on a cron, not a webhook.

Note the repetition: each ask is roughly **(endpoint + Postgres table + admin UI + integration with an existing customer tool)**. The work is in the polish (offline grace, redaction policy, IdP onboarding per vendor) more than the core mechanics.

---

## The SSO-tax landscape

Three patterns dominate B2B SaaS pricing:

### 1. SSO-as-enterprise-upsell (the dominant pattern)

GitHub, GitLab, Sentry, PostHog, Vercel, Linear, Notion, and most others. Team tier is $8-15/user/month with no SSO; Business / Enterprise is $20-50/user/month with SSO included.

The SSO module is typically:
- In a closed enterprise repo that you don't see, OR
- In the public repo behind a runtime license-key check the binary reads at startup.

The economic justification: SSO is the procurement requirement that unlocks the enterprise buyer. Without it the deal dies at security review. So the buyer is forced across the tier line and pays for everything bundled with it (admin dashboard, audit log, SLA, SCIM, dedicated support). For B2B SaaS, "free with SSO" → "$25 with SSO" is a 200-300% revenue lift on the same customer at the moment they need SSO.

### 2. Open-core with hard split

Mattermost CE/EE, GitLab CE/EE, Sentry self-hosted vs SaaS. Community edition is fully open-source (usually AGPL or BSL) but missing SSO entirely. Enterprise edition is a separate repo / branch; SSO is closed-source. You self-host the EE binary if you pay; the CE binary won't load the EE config.

### 3. "SSO is table stakes" — the sso.tax position

Tailscale, Plausible, Cloudflare Zero Trust (free for ≤50 users), Authentik. OIDC and/or SAML included in the free tier; SCIM, audit log shipping, advanced policy reserved for paid.

Rob Chahin's [sso.tax](https://sso.tax) list shames companies that charge extra for SSO. It's been growing since 2022 and the position is increasingly defensible in OSS-first markets. The argument: requiring people to pay extra for security primitives is what pushes startups onto unauthenticated tools, which is strictly worse for everyone.

---

## Recommended split for OpenCues — no SSO tax

OpenCues sits in the OSS-first market (CC patches, chrome extension, all self-hostable). The sso.tax pattern aligns with the project's positioning. The split below keeps security primitives free and reserves operational tooling for paid.

### Free tier (open-source, self-hosted)

- **OIDC + SAML 2.0 login.** Both protocols. Azure AD shops want SAML even though OIDC is technically cleaner; don't make them feel second-class.
- **Single-org self-hosted IdP config.** Admin pastes their issuer URL + client ID + (for SAML) IdP metadata XML. One config block per OpenCues install.
- **Local audit log to a file** (`/var/log/opencues/audit.jsonl`). They can ship it to their own SIEM with their existing tools (Vector, Fluent Bit, etc.).
- **Role-based access** (admin vs user) with a hardcoded role set.
- **Org-scoped configs** read from a local mount point (e.g. `/etc/opencues/org/`). The admin can sync this from git themselves via cron or their existing config management. No phone-home.

### Paid tier — the operational stuff

- **SCIM provisioning** (genuine engineering work: SCIM 2.0 endpoint, identity reconciliation, the bidirectional sync UX). Cloudflare charges for this even on Zero Trust.
- **Audit log shipping + retention** — managed export to Splunk / Datadog / S3, 1y retention, search UI, redaction policy editor. The local file's free; the pipeline isn't.
- **Multi-org / federated control plane** — one OpenCues admin dashboard managing N customer orgs. This is the MSP / consultancy use case and is net-new infrastructure.
- **Custom roles + policy engine** — beyond admin/user, attribute-based rules ("Engineering can use Claude; Legal can't use any external LLM").
- **Central key vault for LLM provider keys** — admin holds the GROQ_API_KEY etc. in a vault; the host fetches a short-lived per-session token. Removes the "every dev has my GROQ key in their dotfiles" problem. This is the killer paid feature for security-conscious orgs.
- **SLA + dedicated support + on-prem deployment assistance**.

### Economic reframe

> "We don't charge for security. We charge for operations at scale."

Lands with both procurement and developers. Devs respect the project for not extorting them. Procurement still has a reason to write the check, since SCIM, audit pipeline, key vault, and SLA are what their VP of IT actually cares about. The buyer-side messaging is cleaner too: "you can self-host securely; pay us when you want us to run the operational glue for you."

---

## Implementation sizing (rough)

Order-of-magnitude estimates. Numbers are person-weeks for a focused contributor familiar with the codebase.

### Phase 1 — OIDC + SAML at the launch chokepoint (free tier)

- 2-3 weeks. `opencues run <host>` is the single gate for every CLI host; plant the auth check there.
- Chrome extension uses `chrome.identity.launchWebAuthFlow` (well-documented, all major IdPs have working examples).
- CLI hosts use a device-code flow (`gh auth login`-style) or localhost-callback flow. Both work; device code is simpler for headless contexts.
- Role gate (admin / user) is one column on a local SQLite-or-equivalent + a runtime check in the resolver.
- Local audit log writer is a `tail -F`-able JSON-lines file.

### Phase 2 — Paid tier MVP

- 6-8 weeks. SCIM endpoint, central seat-licensing service (Postgres + a thin HTTP API), admin dashboard (Next.js or similar), one IdP onboarded end-to-end (pick Okta).
- Plus the on-call rotation and runbook the moment customers depend on it.

### Phase 3 — Paid tier maturity

- 4-6 weeks. Additional IdPs (Azure AD, Google Workspace, OneLogin), audit log shipping to 2-3 SIEM destinations, key vault integration, multi-org dashboard.

Total to a sellable enterprise product: roughly **3 months of focused work** plus the surrounding infrastructure (billing, customer support, marketing pages). Most of that is not OpenCues code; it's the surrounding business plumbing.

---

## Precedent: what to copy

- **Tailscale** — generous free-tier user count + SSO + SCIM at paid. Their docs and onboarding flow are the gold standard for an OSS-first SSO experience. Worth a full read before committing.
- **Cloudflare Zero Trust** — free for ≤50 users; SCIM + advanced policy paid. The cap is a clean way to differentiate without taxing security.
- **Plausible** — OIDC in free, audit log in paid. Their pricing page is concise and avoids the "Contact Sales" anti-pattern.
- **Authentik** — the OSS IdP itself. Their split (open-source product + hosted + support) is the cleanest example of "we don't charge for security, we charge for ops".

## Anti-precedent: what not to do

- **Sentry** — SSO behind the Business tier. Frequently cited as the canonical SSO-tax example. They've defended the choice publicly and it's worked commercially, but the developer-community reputation cost is real.
- **GitHub** — SSO requires GitHub Enterprise. Functional but the upgrade gap (Team to Enterprise) is large enough that small orgs without procurement budget run unprotected.
- **Atlassian** — historically the worst offender; their reputation for SSO-tax is so entrenched it shows up in unrelated procurement conversations.

---

## Open questions

1. **Hosted control plane vs fully self-host for paid tier.** Self-hosted enterprise is more work to support but unlocks regulated industries (gov, finance, healthcare) that won't ship audit logs to a third-party cloud. The Mattermost / GitLab pattern (CE self-host free, EE self-host paid) is one model; Tailscale's hosted-only is another. Pick before building the admin dashboard, since the deployment story differs significantly.
2. **Open-source license for the SSO module.** AGPL would prevent competitors from shipping a closed fork with the SSO module; MIT keeps it maximally permissive. AGPL is the safer choice if we want to keep paid tier defensible.
3. **Billing model.** Per-seat is conventional but punishes large orgs. Flat-rate-per-org-tier is friendlier but caps revenue. Per-active-LLM-call is novel and aligns with cost but is hard to forecast for the buyer. Cursor uses per-seat; Codeium uses flat-rate-per-tier; Aider is OSS-only with no paid tier.
4. **First IdP to onboard.** Okta vs Azure AD vs Google Workspace. Okta has the cleanest dev experience and the most documented SCIM flows; Azure AD has the largest enterprise install base. Start with Okta if optimizing for "ship the demo"; Azure AD if optimizing for "land the first big customer".

---

## Status

This document is research, not a commitment. No code changes follow from it directly. Next gating decision: do we want an enterprise tier at all in 2026, or focus on the OSS individual / small-team market first?

If yes, the next artifact is `docs/architecture/enterprise.md` with concrete wire formats, endpoint specs, and a build plan keyed to the four asks (a-d) above.

---

*Drafted June 2026.*
