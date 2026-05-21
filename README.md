# OpenCues

<!-- Badges: uncomment when ready
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Build](https://github.com/opencues/opencues/actions/workflows/ci.yml/badge.svg)](https://github.com/opencues/opencues/actions)
[![GitHub](https://img.shields.io/github/stars/opencues/opencues?style=social)](https://github.com/opencues/opencues)
[![Discord](https://img.shields.io/discord/DISCORD_ID?label=Discord)](https://discord.gg/INVITE)
-->

**Open standards + reference implementation for real-time guidance as you type.** OpenCues defines three open standards — **Cues**, **Blanks**, and **Auditors** — that any text editor, IDE, or LLM pipeline can implement. This repo holds the standards (at [`spec/`](spec/)) plus a working reference runtime you can install today in Claude Code, OpenCode, Gemini CLI, and Chrome.

<!-- TODO: drop a demo gif at assets/demo.gif and uncomment the line below. ~10s loop of: type "the happy dog" → cycle "happy", then type "volume _" → see "70%", then type "enable debug logging _" → see "debug-mode on". -->
<!-- ![Demo](assets/demo.gif) -->

> **In 30 seconds — the vocabulary**
>
> - **Cue** — a word the runtime offers alternatives for. You navigate to it with Ctrl+Alt+arrow and cycle synonyms with Ctrl+Alt+Up/Down. The buffer stays as you typed it until you cycle.
> - **Blank** — a `_` you type. The runtime auto-fills it (`volume _` → `70%`, `capital of france _` → `Paris`, `enable debug logging _` → `debug-mode on`). Each blank is gated by a keyword or by free-form lookup.
> - **Auditor** — an inline rewriter that composes with other auditors (grammar, clarity, tone, ...) into one LLM call per agent tick.
>
> Everything else in this README assumes these three.

## Quickstart (5 minutes)

Quickest path to a patched Claude Code with cues live:

```bash
# 1. Free LLM key — Groq's free tier covers every feature.
#    https://console.groq.com/keys
export GROQ_API_KEY="your-key"

# 2. Clone + bootstrap + patch Claude Code.
git clone https://github.com/opencues/opencues ~/opencues && \
  cd ~/opencues && pnpm install && pnpm build && \
  pnpm exec opencues install claude-code

# 3. Launch the patched fork.
claude-cues
```

**Launch with `claude-cues`, not `claude`** — the patched fork runs alongside your native install at `~/claude-code-cues/`; your existing `claude` stays untouched.

### Your first three prompts

Type these into `claude-cues` to confirm the three surfaces are live. Each should give a visible result inside 1-2 seconds.

| Type | What you should see |
|---|---|
| `the happy dog` | The word **happy** dims (cue marker). Press **Ctrl+Alt+Right** to navigate to it, then **Ctrl+Alt+Up** — the word swaps to `joyful` / `cheerful` / etc. |
| `volume _` | The `_` becomes `70%` (or whatever your system volume is). Ctrl+Alt+Up steps it by 6% — and your OS volume actually changes. |
| `enable debug logging _` | The whole phrase becomes `debug-mode on`. One backspace wipes both words. This proves fluid-config flipped `~/.cues/OPENCUES.md`. |

### Stuck?

```bash
opencues doctor           # cross-host install diagnostics + suggested fixes
tail /tmp/opencues.log    # everything the runtime logged
```

If cycling does nothing on Linux, your desktop is probably eating Ctrl+Alt+arrow as a workspace-switch binding. Unbind it in your DE settings (one-liners for GNOME/KDE/Sway/macOS are in [`docs/install.md`](docs/install.md#linuxwayland-workspace-conflict)).

For per-host installs, deeper troubleshooting, and uninstall: [`docs/install.md`](docs/install.md).

## Supported editors

| Editor | Status | Install | Per-host docs |
|--------|--------|---------|----------------|
| **Claude Code** | Available | `opencues install claude-code` | [`integrations/claude-code/README.md`](integrations/claude-code/README.md) |
| **OpenCode** | Available | `opencues install opencode` | [`integrations/opencode/README.md`](integrations/opencode/README.md) |
| **Gemini CLI** | Beta | `opencues install gemini-cli` | [`integrations/gemini-cli/README.md`](integrations/gemini-cli/README.md) |
| **Chrome** | Beta | `opencues install chrome` | [`integrations/chrome/README.md`](integrations/chrome/README.md) |
| **VS Code** | Planned | — | — |

Each install pins a specific upstream version (e.g. Claude Code 2.1.110, OpenCode 1.14.17), clones it into its own dir (`~/claude-code-cues/`, `~/opencode-cues/`), and patches that copy. **Your native editor installs are never touched.** Uninstall is `opencues uninstall <host>`.

## What you get

| Keys | Action |
|------|--------|
| Ctrl+Alt+Left/Right | Navigate between words |
| Ctrl+Alt+Up/Down | Cycle alternatives, step blank values |
| Escape | Clear highlight |

- **Word cues** — navigate to any word, cycle through LLM-suggested alternatives, keep typing.
- **Sentence cues** — declare `scope: sentence` on a cue and the whole sentence becomes cyclable. The shipped `more-formal` cue rewrites informal sentences to formal register.
- **Blanks** — type `_` and get a completion: keyword-bound (`volume _` → `70%`), free-form lookup (`capital of france _` → `Paris`), or imperative transform (`fix typos _ this is bad righting`).
- **Script-backed blanks** — `volume _` / `brightness _` call shell scripts so cycling actually changes your OS state.
- **Selector + satellite** — `opencues settings _` becomes two linked words (the setting + its current value); cycling the selector swaps the satellite.
- **Inline agent** — `agentically correct spelling _` arms a continuous rewrite loop until you `stop task _`.
- **Auditors** — declare grammar/clarity/tone concerns in `auditors/<name>/AUDITOR.md`; they compose into one LLM call per agent tick.
- **Personal context** (opt-in) — `~/.cues/USER.md` declares your name, email, work city; `my email _` substitutes the real value. `safe` mode keeps the value off the LLM provider's logs.
- **Ambient context** (opt-in, Chrome) — fluid lookups receive the focused field's label + page title so `destination _` answers differently on a flight site vs Airbnb.
- **Hot-reload** — every `.md` config file picks up edits in ~2s with no restart.

Full feature catalogue: [`docs/features/`](docs/features/) (40+ feature concepts grouped into 10 chapters).

## The three open standards

OpenCues defines three surface formats. Each has its own spec file and its own conformance — a runtime can implement one surface and be conformant for that surface; you don't have to commit to all three.

| Surface | Direction | Operates on | Spec | Trigger |
|---|---|---|---|---|
| **Cues** | LLM → user | one word | [`spec/cue-spec.md`](spec/cue-spec.md) | regex `match:` / `keywords:` list |
| **Blanks** | user → system | one `_` slot | [`spec/blank-spec.md`](spec/blank-spec.md) | `_` adjacent to `blankKeywords` |
| **Auditors** | LLM → buffer | whole buffer | [`spec/auditor-spec.md`](spec/auditor-spec.md) | every rewrite cycle |

Each surface ships as a folder under `<root>/{cues,blanks,auditors}/<name>/` with an uppercase entry file (`CUE.md`, `BLANK.md`, `AUDITOR.md`). Master files (`CUES.md`, `BLANKS.md`, `AUDITORS.md`) configure the surface as a whole. All behaviour lives in `.md` files, never in integration code.

**Building a second implementation?** [`spec/`](spec/) holds six markdown docs + seven JSON schemas covering every file format and runtime contract. [`spec/conformance/`](spec/conformance/) ships an executable fixture tree (valid examples MUST be accepted, invalid examples MUST be rejected with the right rule code, wire-format parser cases, routing scenarios) — your runtime can exercise it directly. Status: `0.1-alpha`; changes tracked in [`spec/CHANGELOG.md`](spec/CHANGELOG.md).

## Configuration

Your user-level config lives at `~/.cues/` — one `OPENCUES.md` (runtime settings) plus the three master files and their per-source folders. Project-level overrides at `<cwd>/.cues/` merge on top for native hosts. Hot-reload picks up edits in ~2s.

Seed from the shipped defaults the first time:

```bash
pnpm exec opencues seed-configs
```

Cycleable runtime settings (voice-mode, debug-mode, fluid-blank-mode, sentence-cues-mode, agent-debounce-ms, …) flip live via `opencues settings _` or by editing `~/.cues/OPENCUES.md` directly.

Full config reference, scalar table, and authoring guide: [`docs/configuration.md`](docs/configuration.md).

## LLM providers

OpenCues supports **six providers** out of the box: Groq (default — free tier), Cerebras, OpenAI, Anthropic, OpenRouter, Gemini. Set the env key for whichever you want; pick different providers per feature (word-cues vs fluid-blank vs transform-blank vs agent-rewrite) in `~/.cues/OPENCUES.md`.

Setting both `GROQ_API_KEY` and `CEREBRAS_API_KEY` enables automatic 429/5xx failover between them — same `gpt-oss-120b` weights mean no quality shift when one provider rate-limits.

Per-provider setup, per-feature routing, and the bench data behind the recommendations: [`docs/guides/llm-providers.md`](docs/guides/llm-providers.md).

## Security

The runtime sandboxes third-party blanks via a Figma-style capability contract: a JS blank only gets `network`, `llm`, `storage`, or `secrets` access if its `BLANK.md` frontmatter declares it. Secrets without a matching `secret-hosts.<NAME>` binding are **refused at load time**. Output sanitization, sliding-window quotas, and an AST-based ESM rewriter (no dynamic `import()`) bound the blast radius.

Before installing a pack from a stranger:

```bash
opencues review ./untrusted-pack/         # static audit
opencues review ./untrusted-pack/ --llm   # + LLM second opinion
```

Static parse is authoritative; the LLM can downgrade a verdict but never upgrade past a hard-blocked pattern.

**Optional features (OFF by default).** Ambient context (Chrome reads the focused field's label + page title for disambiguating fluid lookups) and user context (`~/.cues/USER.md` personal data sent as sentinel tokens, real values substituted post-LLM in `safe` mode) both require explicit opt-in via `~/.cues/OPENCUES.md`. Sensitive fields (password / OTP / payment / PII heuristics) refuse to attach regardless.

Full threat model, capability tables, and per-surface boundaries:
- [`docs/architecture/security-audit.md`](docs/architecture/security-audit.md) — umbrella threat model
- [`docs/architecture/user-blanks.md`](docs/architecture/user-blanks.md) — capability contract for JS blanks
- [`docs/architecture/chrome-security.md`](docs/architecture/chrome-security.md) — Chrome's six boundaries
- [`docs/architecture/ambient-context.md`](docs/architecture/ambient-context.md), [`docs/architecture/user-context.md`](docs/architecture/user-context.md) — the two opt-in context features

## Contributing

- **Build an integration** — bring OpenCues to a new editor or IDE: see [`docs/guides/adding-an-integration.md`](docs/guides/adding-an-integration.md). The standards are at [`spec/`](spec/) and the conformance suite at [`spec/conformance/`](spec/conformance/).
- **Add a cue, blank, or auditor** — `opencues new cue <name>` / `opencues new blank <name>` scaffolds a starting file. Full guide: [`docs/guides/adding-a-cue-blank.md`](docs/guides/adding-a-cue-blank.md).
- **Modify the reference runtime** — [`CONTRIBUTING.md`](CONTRIBUTING.md) covers the monorepo layout, build commands, and test conventions.

New to the terminology? [`docs/glossary.md`](docs/glossary.md) covers cues, blanks, cue-blanks, sources, parsers, master files, and routing.

## Status

| Component | Version | Status |
|---|---|---|
| `spec/` | 0.1-alpha | Field names + semantics may change before 1.0. Tracked in [`spec/CHANGELOG.md`](spec/CHANGELOG.md). |
| `@opencues/core` | 0.x | Workspace dep, pre-publish. Public API may change. |
| `@opencues/runtime` | 0.x | Workspace dep, pre-publish. Public API may change. |
| Claude Code integration | Available | Pinned at Claude Code 2.1.110. |
| OpenCode integration | Available | Pinned at OpenCode 1.14.17. |
| Gemini CLI integration | Beta | Pinned at Gemini CLI 0.41.2. |
| Chrome integration | Beta | MV3 extension, Chrome 121+. |

Version-bump runbooks for each integration: [`integrations/<host>/UPGRADING.md`](integrations).

<!-- ## Community

- [Discord](https://discord.gg/INVITE) — questions, feedback, feature requests
- [GitHub Discussions](https://github.com/opencues/opencues/discussions) — ideas, Q&A
-->
- [Twitter/X](https://x.com/openCues_) — announcements

## License

Proprietary. All rights reserved. See [LICENSE](LICENSE).
