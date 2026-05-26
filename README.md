<!-- TODO[logo]: drop a centered logo block. opencode pattern:
<p align="center">
  <a href="https://opencues.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="assets/logo-light.svg">
      <img alt="OpenCues" src="assets/logo-light.svg" width="320">
    </picture>
  </a>
</p>
-->

# OpenCues

<!-- TODO[badges]: uncomment + fill DISCORD_ID + INVITE once those exist.
The license badge text needs to match LICENSE (currently Proprietary → flip
to MIT/Apache-2.0 at private-beta-end). The npm badge depends on
where we publish — packages currently target GitHub Packages
(restricted), NOT npmjs.com, so the standard `shields.io/npm/v/...`
URL would 404. Either swap to a GitHub Packages badge, or wait until
the publish target broadens. Star + Build are wireable today.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Build](https://github.com/opencues/opencues/actions/workflows/ci.yml/badge.svg)](https://github.com/opencues/opencues/actions)
[![Discord](https://img.shields.io/discord/DISCORD_ID?label=Discord)](https://discord.gg/INVITE)
[![GitHub stars](https://img.shields.io/github/stars/opencues/opencues?style=social)](https://github.com/opencues/opencues)
-->

**Real-time guidance as you type.** Define cues, blanks, and auditors in `.md` config files; the runtime turns them into inline alternatives, `_`-gated substitutions, and live rewrites. Install today in Claude Code, OpenCode, Gemini CLI, Chrome, and a standalone terminal app (`oc-edit`).

The three file formats (Cues / Blanks / Auditors) are open standards — designed so a non-JS port or alternative runtime *could* ship — and the spec at [`spec/`](spec/) is the field reference for anyone authoring those files. Today only the reference runtime in this repo implements them, powering all five integrations as thin host adapters over a shared core.

<!-- TODO[hero]: pick ONE of these three (or ship all three over time):

(a) Animated demo gif. ~10s loop of: type "the happy dog" → cycle "happy",
    then type "volume _" → see "70%", then type "enable debug logging _" → see
    "debug-mode on". Drop at assets/demo.gif and uncomment:
    ![Demo](assets/demo.gif)

(b) Static hero screenshot of a patched Claude Code session mid-cycle.
    Less visceral than a gif but lighter for slow connections + readable
    on GitHub mobile. Drop at assets/hero.png and uncomment:
    ![OpenCues in Claude Code](assets/hero.png)

(c) YouTube embed of a 60-90s walkthrough (intro + the three smoke-test
    prompts + one auditor demo). Best for shareable launch posts.
    Drop a thumbnail at assets/hero.png linking to the YT URL:
    [![Demo video](assets/hero.png)](https://youtu.be/VIDEO_ID)
-->

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
| **Terminal (`oc-edit`)** | Beta | `opencues install terminal` | [`integrations/terminal/README.md`](integrations/terminal/README.md) |
| **VS Code** | Planned | — | — |

Each install pins a specific upstream version (e.g. Claude Code 2.1.110 or 2.1.150, OpenCode 1.14.17), clones it into its own dir (`~/claude-code-cues/`, `~/opencode-cues/`), and patches that copy. **Your native editor installs are never touched.** Uninstall is `opencues uninstall <host>`.

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

## The three file formats

OpenCues defines three surface formats. Each has its own spec file. Most users only interact with one or two — pick what you need; you don't have to use all three.

| Surface | Direction | Operates on | Spec | Trigger |
|---|---|---|---|---|
| **Cues** | LLM → user | one word | [`spec/cue-spec.md`](spec/cue-spec.md) | regex `match:` / `keywords:` list |
| **Blanks** | user → system | one `_` slot | [`spec/blank-spec.md`](spec/blank-spec.md) | `_` adjacent to `blankKeywords` |
| **Auditors** | LLM → buffer | whole buffer | [`spec/auditor-spec.md`](spec/auditor-spec.md) | every rewrite cycle |

Each surface ships as a folder under `<root>/{cues,blanks,auditors}/<name>/` with an uppercase entry file (`CUE.md`, `BLANK.md`, `AUDITOR.md`). Master files (`CUES.md`, `BLANKS.md`, `AUDITORS.md`) configure the surface as a whole. All behaviour lives in `.md` files, never in integration code.

**Authoring your own cues / blanks / auditors?** The spec docs above are the field reference for what every frontmatter field does. [`spec/conformance/`](spec/conformance/) ships an executable fixture tree — valid examples your authored files should look like, invalid examples for the gotchas. The reference runtime in this repo uses it as its own regression net (`packages/opencues-core/src/conformance.test.ts`). A non-JS port could exercise the same fixtures someday; none exists today.

Spec status: `0.1-alpha`; changes tracked in [`spec/CHANGELOG.md`](spec/CHANGELOG.md).

## Configuration

Your user-level config lives at `~/.cues/` — one `OPENCUES.md` (runtime settings) plus the three master files and their per-source folders. Project-level overrides at `<cwd>/.cues/` merge on top for native hosts. Hot-reload picks up edits in ~2s.

Seed from the shipped defaults the first time:

```bash
pnpm exec opencues seed-configs
```

Cycleable runtime settings (voice-mode, debug-mode, fluid-blank-mode, sentence-cues-mode, agent-debounce-ms, …) flip live via `opencues settings _` or by editing `~/.cues/OPENCUES.md` directly.

Full config reference, scalar table, and authoring guide: [`docs/configuration.md`](docs/configuration.md).

## LLM providers

OpenCues supports **seven providers** out of the box: Groq (default — free tier), Cerebras, OpenAI, Anthropic, OpenRouter, Gemini, and OpenCode Zen. Set the env key for whichever you want; pick different providers per feature (word-cues vs fluid-blank vs transform-blank vs agent-rewrite) in `~/.cues/OPENCUES.md`.

Setting both `GROQ_API_KEY` and `CEREBRAS_API_KEY` enables automatic 429/5xx failover between them — same `gpt-oss-120b` weights mean no quality shift when one provider rate-limits.

### Free mode (no API key)

Add `blank-llm-provider: free` to `~/.cues/OPENCUES.md` and **blanks** (FluidBlank / TransformBlank / ConfigIntent) route through [OpenCode Zen](https://opencode.ai/zen)'s free model pool — anonymously, no key required. The runtime walks the pool on transient failures and surfaces the resolved model in the status line.

> ⚠️ **Data warning.** OpenCode Zen's free tier ToS says **your inputs may be used to train the underlying models**. Free mode is **blank-only by design** — cues, auditors, agent-rewrite (which run automatically on prose) never use this path, and `llm-provider: free` (the cue path) is refused at startup. Only `_` triggers go through the free pool, and only the surrounding context window — but treat anything you type next to a `_` in free mode as public.

> ⚠️ **The pool changes.** Free models on OpenCode Zen rotate in and out — promotions end, models move behind paid tiers, new ones arrive. As of May 2026 the working set is `big-pickle` + `deepseek-v4-flash-free` + `nemotron-3-super-free`; the other two we benched (`qwen3.6-plus-free`, `minimax-m2.5-free`) have already moved to the paid OpenCode Go tier. The runtime health-caches dead entries for 30s and walks the rest, but the **canonical live list** is `GET https://opencode.ai/zen/v1/models` — re-check before relying on any specific model.

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
| Claude Code integration | Available | Tested on Claude Code 2.1.110 (cli.js) and 2.1.150 (native bun-binary). |
| OpenCode integration | Available | Pinned at OpenCode 1.14.17. |
| Gemini CLI integration | Beta | Pinned at Gemini CLI 0.41.2. |
| Chrome integration | Beta | MV3 extension, Chrome 121+. |
| Cues skill (`install skill cues`) | Experimental / WIP | Claude skill that asks the chat model to write `.cues/CUES.md` ambiently. Fire reliability varies per chat model — see [`docs/features/cues-skill-and-plugin.md`](docs/features/cues-skill-and-plugin.md). |
| Cues plugin (`install plugin cues`) | Experimental / WIP | OpenCode plugin that fires the same idea on `chat.message` deterministically (uses Haiku for the cues call). |

Version-bump runbooks for each integration: [`integrations/<host>/UPGRADING.md`](integrations).

## Community

<!-- TODO[community]: fill in Discord invite, Reddit go-live, and Discussions
once enabled. The pre-launch checklist (.internal/pre-launch-readme.md)
tracks state.

- [Discord](https://discord.gg/INVITE) — questions, feedback, feature requests
- [GitHub Discussions](https://github.com/opencues/opencues/discussions) — long-form Q&A
- [Reddit r/OpenCues](https://www.reddit.com/r/OpenCues/) — private until launch
-->

- [Twitter/X — @openCues_](https://x.com/openCues_) — announcements
- [GitHub Issues](https://github.com/opencues/opencues/issues) — bug reports + feature requests
- Email — `hello@opencues.com` (security disclosures: see [`SECURITY.md`](SECURITY.md))

<!-- TODO[star-history]: enable once the repo is public + has accumulated
some stars. The widget polls api.star-history.com and renders without a
GitHub API key. Place under Community, above License.

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=opencues/opencues&type=Date)](https://star-history.com/#opencues/opencues&Date)
-->

<!-- TODO[sponsors]: enable once .github/FUNDING.yml has a real account
configured (currently a stub). One-line shape if GitHub Sponsors only;
expand to a logo wall if you take corporate sponsors later.

## Sponsors

If OpenCues helps you, consider [sponsoring development](https://github.com/sponsors/opencues).
-->

<!-- TODO[contributors]: once there are >5 external contributors, enable
the all-contributors bot OR drop in the simpler GitHub avatar wall:

## Contributors

<a href="https://github.com/opencues/opencues/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=opencues/opencues" />
</a>

(`contrib.rocks` updates daily; no bot needed.)
-->

<!-- TODO[used-by]: if any company / project adopts OpenCues publicly,
add a "Used by" logo wall under Community. Standard OSS social-proof
shape. Skip until at least 3 logos exist.
-->

## License

Proprietary. All rights reserved. See [LICENSE](LICENSE).

<!-- TODO[license-flip]: switch to MIT/Apache-2.0 at private-beta-end.
Update this section text + the badge above + LICENSE itself.
-->

<!-- TODO[translations]: opencode ships 22 README translations as a
"global community" signal. Optional but high-effort. If you go for it,
the standard shape is a centered `<p align="center">` row of links to
README.<lang>.md files right under the badges. Don't bother until the
content stabilises — every translation has to re-sync on each change.
-->
