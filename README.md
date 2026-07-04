<!-- TODO[logo]: centered logo block once assets/logo-{light,dark}.svg exist.
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/logo-light.svg">
    <img alt="OpenCues" src="assets/logo-light.svg" width="280">
  </picture>
</p>
-->

# OpenCues

[![License](https://img.shields.io/badge/license-proprietary-lightgrey.svg)](LICENSE)
[![Build](https://github.com/opencues/opencues/actions/workflows/ci.yml/badge.svg)](https://github.com/opencues/opencues/actions)
<!-- TODO: add once live — npm version badge (after the BETA-INSTALL.md → real
publish cutover) and Discord badge (once DISCORD_ID/INVITE are real):
[![npm](https://img.shields.io/npm/v/opencues)](https://npmjs.com/package/opencues)
[![Discord](https://img.shields.io/discord/DISCORD_ID?label=Discord)](https://discord.gg/INVITE)
TODO[license-flip]: swap the badge above to license-MIT-blue.svg at the same
time LICENSE flips — see the License section's TODO at the bottom of this file. -->

**Real-time guidance as you type.** Cues offer alternatives for words you've already typed; blanks fill in whatever you summon with `_`; auditors keep one background concern (grammar, tone, ...) continuously applied. All three are just `.md` config files — no code. Works in Claude Code, OpenCode, Gemini CLI, Chrome, and a standalone shell wrapper.

> ⚠️ **Private beta.** `npm install -g opencues` isn't live yet. Install from a clone instead — see **[BETA-INSTALL.md](BETA-INSTALL.md)**. Everything past the install step below is accurate today.

<!-- VIDEO: hero demo (~30-60s), replace this comment with the real embed.
     GitHub-hosted asset (renders inline): ![demo](https://github.com/opencues/opencues/assets/.../demo.mp4)
     YouTube (GitHub won't inline-embed it — link a thumbnail instead):
     [![Demo](assets/hero-thumb.png)](https://youtu.be/VIDEO_ID) -->

```
the boy ran fast          →  cycle "boy" (Ctrl+Alt+Up)  →  the kid ran fast
draft an email to my landlord asking for a rent reduction _  →  (the email, written)
```

📖 [Docs](docs/README.md) · 📐 [Spec](spec/README.md) · 🐛 [Issues](https://github.com/opencues/opencues/issues) · 📄 [License](LICENSE)

## Quickstart

```bash
npm install -g opencues              # see BETA-INSTALL.md until this is live
opencues set-key cerebras csk-...    # cerebras.ai — free tier, lowest latency
opencues install claude-code         # or: opencode | gemini-cli | chrome | shell
claude-cues                          # launch — native `claude` is untouched
```

Full walkthrough, prerequisites, and per-host detail: [`docs/install.md`](docs/install.md). `opencues doctor` diagnoses anything that looks wrong.

## Supported editors

| Editor | Status | Install |
|---|---|---|
| Claude Code | Available | `opencues install claude-code` |
| OpenCode | Available | `opencues install opencode` |
| Gemini CLI | Beta | `opencues install gemini-cli` |
| Chrome | Beta | `opencues install chrome` |
| Shell (`oc-shell`) | Beta | `opencues install shell` |
| VS Code | Planned | — |

Each pins its own upstream fork and never touches your native editor install. Per-host detail: [Claude Code](integrations/claude-code/README.md) · [OpenCode](integrations/opencode/README.md) · [Gemini CLI](integrations/gemini-cli/README.md) · [Chrome](integrations/chrome/README.md) · [Shell](integrations/shell/README.md). Windows: not supported natively, run inside WSL2 (see [`docs/install.md`](docs/install.md)).

## What you get

- **Cues** — navigate to a word, cycle LLM-suggested alternatives, keep typing.
- **Blanks** — type `_` for free-form generation, translation, formatting, prompt rewrites, or keyword-bound system actions (`volume _`, `weather _`).
- **Auditors** — declare a concern (grammar, clarity, tone) once; it applies continuously, shown as revertable dimmed text.
- **Personal + ambient context** (opt-in) — `my email _` substitutes your real address; fluid lookups can read the page you're on.
- **Hot-reload** — every `.md` config picks up edits in ~2s, no restart.

Full feature catalogue (42 concepts): [`docs/features/README.md`](docs/features/README.md).

## How it works

Two directions of intent — see [`concept.md`](concept.md):

| Direction | Surface | Trigger |
|---|---|---|
| LLM → you | **Cues** | plain text |
| you → system | **Blanks** | text containing `_` |

**Auditors** are a continuous, whole-buffer variant of the Cues direction. All three are open file formats — `CUE.md` / `BLANK.md` / `AUDITOR.md` — so another runtime could implement them independently; the standard lives at [`spec/`](spec/README.md), this repo ships the reference implementation.

Authoring your own: `opencues new cue <name>` / `opencues new blank <name>` scaffolds a starting file. Guide: [`docs/guides/adding-a-cue-blank.md`](docs/guides/adding-a-cue-blank.md).

## Configuration & LLM providers

Config lives at `~/.cues/` — one `OPENCUES.md` for runtime settings, plus per-surface source folders. Seven providers supported (Cerebras recommended default, plus Groq/OpenAI/Anthropic/Gemini/OpenRouter/OpenCode Zen); set an env key or `opencues set-key` and you're done.

Full reference: [`docs/configuration.md`](docs/configuration.md) · [`docs/guides/llm-providers.md`](docs/guides/llm-providers.md) (switching provider/model, free mode, failover).

## Security

Third-party blanks run under a capability contract — a JS blank only gets `network`/`llm`/`storage`/`secrets` access if declared, and secrets without a matching host binding are refused at load time. Check a pack before trusting it:

```bash
opencues review ./untrusted-pack/
```

Full threat model: [`docs/architecture/security-audit.md`](docs/architecture/security-audit.md). Reporting a vulnerability: [`SECURITY.md`](SECURITY.md).

## Contributing

New editor integration → [`docs/guides/adding-an-integration.md`](docs/guides/adding-an-integration.md). New cue/blank/auditor → [`docs/guides/adding-a-cue-blank.md`](docs/guides/adding-a-cue-blank.md). Working on the reference runtime itself → [`CONTRIBUTING.md`](CONTRIBUTING.md). New to the terms → [`docs/glossary.md`](docs/glossary.md).

## Community

[Twitter/X — @openCues_](https://x.com/openCues_) · [GitHub Issues](https://github.com/opencues/opencues/issues) · `hello@opencues.com`

<!-- TODO[community]: add Discord + GitHub Discussions once live (tracked in .internal/pre-launch-readme.md) -->

## License

Proprietary. All rights reserved. See [LICENSE](LICENSE).

<!-- TODO[license-flip]: switch to MIT at private-beta-end — update this line, the badge above, and LICENSE itself. -->
