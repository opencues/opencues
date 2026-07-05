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

**Real-time guidance as you type.** Define cues, blanks, and auditors in `.md` config files; the runtime turns them into inline alternatives, `_`-gated substitutions, and live rewrites. Install today in Claude Code, OpenCode, Gemini CLI, Chrome, and a standalone shell wrapper (`oc-shell`).

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
> - **Blank** — a `_` you type. The runtime auto-fills it (`draft an email to my landlord _` → the email body, `hello world translate to french _` → `bonjour le monde`, `a b c format as bullet points _` → bullets). Each blank is gated by a keyword or by free-form lookup.
> - **Auditor** — an inline rewriter that composes with other auditors (grammar, clarity, tone, ...) into one LLM call per agent tick.
>
> Everything else in this README assumes these three.

## Quickstart (beta)

> ⚠️ **Beta install — this section will shrink post-launch.**
> Right now OpenCues isn't on npm, so you install from a clone of this
> repo (steps 1-3 below). When `npm install -g opencues` ships, steps
> 1 and 3 become one command and step 2 becomes a `set-key` subcommand.
> Step 4 (the per-integration install) stays the same shape.

### 1. System prerequisites (one-time per machine)

OpenCues needs **Node.js 22+** and **pnpm 8+**. The installers are bash +
POSIX coreutils, so platform support is:

- **macOS** (Intel + Apple Silicon) — supported natively.
- **Linux** — supported natively (the primary dev platform).
- **Windows** — **not** supported natively; run everything inside **WSL2**.
  `package.json` declares `"os": ["darwin", "linux"]`, so `pnpm install`
  refuses up front on native Windows rather than failing mid-install.

Pick your platform and run the matching block. Each ends by verifying
`node --version` (v22+) and `pnpm --version` (8+).

**macOS** — default shell is zsh, so the API-key + alias steps below write to `~/.zshrc`:

```bash
brew install node            # Node.js 22+ — or: brew install fnm && fnm install --lts
corepack enable pnpm         # pnpm 8+ — ships with Node 16+; or: npm install -g pnpm

node --version && pnpm --version
```

**Linux** — distro Node packages are often stale, so fnm (or nodesource) is safer:

```bash
curl -fsSL https://fnm.vercel.app/install | bash && exec $SHELL -l
fnm install --lts && fnm use lts-latest    # Node.js 22+
# OR (Debian/Ubuntu, if new enough): sudo apt install nodejs npm

corepack enable pnpm         # pnpm 8+ — or: npm install -g pnpm

node --version && pnpm --version
```

**Windows** — install WSL2 once, then run **every** OpenCues command inside the Linux shell (Ubuntu terminal), **not** PowerShell or CMD:

```powershell
# In an elevated PowerShell (Windows side), then reboot when prompted:
wsl --install -d Ubuntu
```

Open the **Ubuntu** terminal and follow the **Linux** block above for Node +
pnpm. From there, every step in this README runs inside WSL. The Chrome
integration is the one cross-boundary case — it builds in WSL and deploys to
Windows-side Chrome via `--wsl` / `--target` (see [step 4](#4-install-an-integration)).

**That's it for prereqs.** Anything else an integration needs (bun for
opencode/shell, tmux for shell, bubblewrap/espeak-ng/brightnessctl on
Linux) the installer detects + offers to install for you with a single
prompt — `[Y]es / [n]o / [d]etails`. Contained tools (bun, tmux) land
in `~/.opencues/vendor/` so `opencues uninstall <host>` cleans them
up; system packages prompt for sudo once and stay where your package
manager put them. Pass `--no-prompts` to skip every offer (CI mode).

> **Native module fallback.** The runtime sandbox uses
> [`isolated-vm`](https://github.com/laverdet/isolated-vm), a native
> C++ binding. Prebuilt binaries cover linux/darwin x64+arm64 and
> win32 x64 — those install without any toolchain. On rarer arches
> (e.g. armv7, FreeBSD) `pnpm install` falls back to `node-gyp
> rebuild`, which needs `build-essential` + `python3` on Linux or
> `xcode-select --install` on macOS. The installer probes the binding
> on every run; if it can't load, you get one actionable line with
> the right fix for your platform before any host build starts.

### 2. Get an LLM API key

**Cerebras is the recommended default** — same `gpt-oss-120b` weights
as Groq, lower latency on the free tier:

1. Sign up at [cloud.cerebras.ai/platform/](https://cloud.cerebras.ai/platform/)
2. Click *Generate API Key*
3. Persist it in your shell rc:

```bash
echo 'export CEREBRAS_API_KEY="csk-..."' >> ~/.bashrc      # zsh → ~/.zshrc
exec $SHELL -l
```

Groq, OpenAI, Anthropic, Gemini, OpenRouter, and OpenCode Zen are all
supported too — see [LLM providers](#llm-providers) below for the env
var names and how to switch.

### 3. Bootstrap the `opencues` CLI

```bash
git clone https://github.com/opencues/opencues ~/opencues
cd ~/opencues
pnpm install
pnpm build

# Add an alias so you can type `opencues` from anywhere
echo 'alias opencues="pnpm --silent -C ~/opencues exec opencues"' >> ~/.bashrc
# zsh: ~/.zshrc instead. fish: `alias --save opencues "pnpm --silent -C ~/opencues exec opencues"`
exec $SHELL -l

# Verify
opencues --version
```

### 4. Install an integration

Pick one (or more — they share state and install order doesn't matter):

#### Claude Code

```bash
opencues install claude-code
claude-cues                  # launches the patched fork; native `claude` is untouched
```

Clones `@anthropic-ai/claude-code` (pinned) into `~/claude-code-cues/`
and patches it via tweakcc. First run ~3-4 min, re-runs ~1 min. Full
doc: [`integrations/claude-code/README.md`](integrations/claude-code/README.md).

#### Chrome

```bash
opencues install chrome
# WSL → Windows Chrome: add `-- --target /mnt/c/Users/<USERNAME>/Desktop/opencues-chrome`
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** →
**Load unpacked** → pick the dir the install command printed → hard-
refresh your test page. Optionally install the native-messaging host
for live `~/.cues/` sync + script execution:

```bash
# Copy the extension ID from chrome://extensions first
opencues install chrome-host --extension-id <id>
```

Full doc: [`integrations/chrome/README.md`](integrations/chrome/README.md).

#### Others

| Integration | Install | Doc |
|---|---|---|
| OpenCode | `opencues install opencode` (offers a contained bun install) | [`integrations/opencode/README.md`](integrations/opencode/README.md) |
| Gemini CLI | `opencues install gemini-cli` | [`integrations/gemini-cli/README.md`](integrations/gemini-cli/README.md) |
| Shell (standalone) | `opencues install shell` (offers contained bun + tmux) | [`integrations/shell/README.md`](integrations/shell/README.md) |

After install, run `opencues doctor` to verify everything's wired
(bundled-runtime versions, feature backends per platform, install
boundaries). And `opencues update` later checks npm + rebuilds every
detected integration in one command.

### Try it out

OpenCues is **cues for the prompt you're giving an AI** — scaffolds that
help you compose a better prompt without leaving the chat. The two
surfaces are:

- **Blanks** — type `_` and the runtime fills it. Use these to *write*
  the prompt: ask the AI to improve it, draft an email, translate, format
  a list, etc.
- **Cues** — words you've already typed get inline alternatives. Use
  these to *refine* the prompt: navigate to a cued word and cycle
  synonyms or domain-aware replacements.

#### Blanks — scaffolds for the prompt you're about to send

The `_` underscore is the universal trigger — the runtime fills it
with whatever the surrounding text asks for.

| Type | What you should see |
|---|---|
| `[Your prompt] improve prompt _` | The whole sentence is rewritten into a structured, well-formed prompt. Handled by the **transform blank** — any imperative (`improve prompt`, `make it more detailed`, `add a section on X`) runs on your configured LLM provider. |
| `draft an email to my landlord asking for a rent reduction _` | The `_` is replaced with a polite, structured email body. **Fluid blank** — open-ended generation from a free-form query. |
| `where is the nearest train station translate to french _` | The text is replaced with its French translation. **Transform blank** — `translate to <language>`. |
| `apples bananas oranges grapes format as bullet points _` | The list is reformatted as bullets. **Transform blank** — `format as <style>` (also: `as a table`, `as JSON`, etc.). |
| `he runs fast and jumps over the fence make past tense _` | The sentence is rewritten in past tense. Same transform-blank shape — the runtime reads the imperative, applies it, splices the result back. |
| `what is the word for "happy at someone elses misfortune" _` | The query is replaced with `schadenfreude`. The **answer** blank — vocabulary lookup (triggered by `what is the word for` / `how to say`). |
| `opencues settings _` | Slide-out **selector + satellite** view of every cycleable runtime setting (voice-mode, tips-mode, debug-mode, fluid-blank-mode, …). Ctrl+Alt+Right/Left swaps the *setting*; Ctrl+Alt+Up/Down cycles the *value*. Changes write through to `~/.cues/OPENCUES.md` live. |

The `opencues settings _` selector covers cycleable *behaviour* scalars.
It does **not** include LLM provider / model choice — those scalars have
unbounded codomains (any provider, any model id), so cycling them
through a satellite makes no sense. To change provider or model, edit
`~/.cues/OPENCUES.md` directly — see [LLM providers](#llm-providers)
below for the exact frontmatter keys.

#### Cues — feedback on words you've already typed

The shipped defaults include a "tips" pack that fires on real
Claude / OpenCode / Gemini terms with inline alternatives + an
explanatory tooltip. Try these:

| Type | What happens |
|---|---|
| `i want to ultrathink this problem` | **`ultrathink`** dims (cue marker) + the status bar shows `Add ultrathink to prompt for max reasoning`. Press **Ctrl+Alt+Right** to navigate to it, **Ctrl+Alt+Up** to cycle to `deep thinking` / `think harder` / `Tab`. |
| `i'll use --print to script this in ci` | Both **`--print`** and **`ci`** are cues (CI/CD tips). Navigate between them with Ctrl+Alt+Left/Right; cycle to see the related alternatives. |
| `let me run /compact to clear context` | **`/compact`** dims + tooltip explains the slash command. Cycle to alternatives. |
| Any sentence you've typed | The shipped **`more-formal`** sentence cue offers three formal rewrites of the whole sentence. Navigate into the sentence + cycle to swap the entire sentence with a more formal version. (Off by default — turn on with `sentence-cues-mode: on` via `opencues settings _`.) |

You can add your own word cues by editing `~/.cues/CUES.md` or
dropping a folder under `~/.cues/cues/<name>/CUE.md`. Hot-reload
picks them up within ~2 seconds. Full authoring guide:
[`docs/guides/adding-a-cue-blank.md`](docs/guides/adding-a-cue-blank.md).

### Stuck?

```bash
opencues doctor           # cross-host install diagnostics + suggested fixes
tail /tmp/opencues.log    # everything the runtime logged
```

If cycling does nothing on Linux, your desktop is probably eating Ctrl+Alt+arrow as a workspace-switch binding. Unbind it in your DE settings (one-liners for GNOME/KDE/Sway/macOS are in [`docs/install.md`](docs/install.md#linuxwayland-workspace-conflict)).

For per-host installs, deeper troubleshooting, and uninstall: [`docs/install.md`](docs/install.md).

## Supported editors

| Editor | Status | macOS | Linux | WSL | Windows native | Install |
|--------|--------|:---:|:---:|:---:|:---:|---|
| **Claude Code** | Available | ✓ | ✓ | ✓ | — | `opencues install claude-code` |
| **OpenCode** | Available | ✓ | ✓ | ✓ | — | `opencues install opencode` |
| **Gemini CLI** | Beta | ✓ | ✓ | ✓ | — | `opencues install gemini-cli` |
| **Chrome** | Beta | ✓ | ✓ | ✓ (target Windows Chrome via `--wsl`) | — (build on WSL) | `opencues install chrome` |
| **Shell (`oc-shell`)** | Beta | ✓ | ✓ | ✓ | — | `opencues install shell` |
| **VS Code** | Planned | — | — | — | — | — |

Per-host READMEs: [Claude Code](integrations/claude-code/README.md) · [OpenCode](integrations/opencode/README.md) · [Gemini CLI](integrations/gemini-cli/README.md) · [Chrome](integrations/chrome/README.md) · [Shell](integrations/shell/README.md).

**Platform notes.** Native Windows isn't supported — the installers are bash + POSIX coreutils. Windows users run via WSL2 (Chrome integration deploys to the Windows side via `--wsl`). `package.json` carries `"os": ["darwin", "linux"]` so `npm install` refuses up front on `win32` instead of failing mid-install. Per-feature platform support (volume / brightness / TTS / sandbox) is tabled in [`docs/install.md`](docs/install.md#per-feature-platform-support).

Each install pins a specific upstream version (e.g. Claude Code 2.1.110 or 2.1.150, OpenCode 1.14.17), clones it into its own dir (`~/claude-code-cues/`, `~/opencode-cues/`), and patches that copy. **Your native editor installs are never touched.** Uninstall is `opencues uninstall <host>`.

## What you get

| Keys | Action |
|------|--------|
| Ctrl+Alt+Left/Right | Navigate between words |
| Ctrl+Alt+Up/Down | Cycle alternatives, step blank values |
| Escape | Clear highlight |

- **Word cues** — navigate to any word, cycle through LLM-suggested alternatives, keep typing.
- **Sentence cues** — declare `scope: sentence` on a cue and the whole sentence becomes cyclable. The shipped `more-formal` cue rewrites informal sentences to formal register.
- **Blanks** — type `_` and get a completion: free-form generation (`draft an email about X _`), translation / formatting / past-tense / etc. (`translate to french _`, `format as bullet points _`), short factual answers (`what is the word for X _`), prompt rewrites (`improve prompt _`), and keyword-bound system actions (`volume _`, `brightness _`).
- **Script-backed blanks** — `volume _` / `brightness _` call shell scripts so cycling actually changes your OS state. Type a value to set it directly (`volume 30 _`) or nudge it (`volume up _`). Routing is deterministic: a keyword fires only when it *leads the sentence* containing `_` (the segment after the last sentence terminator or newline before `_`, so `let me check. weather in london _` fires too), so `weather in london _` triggers a fetch but `the weather was lovely today _` (prose, keyword mid-sentence) never does.
- **Selector + satellite** — `opencues settings _` becomes two linked words (the setting + its current value); cycling the selector swaps the satellite.
- **Inline agent** — `agentically correct spelling _` arms a continuous rewrite loop until you `stop task _`.
- **Auditors** — declare grammar/clarity/tone concerns in `auditors/<name>/AUDITOR.md`; they compose into one LLM call per agent tick.
- **Personal context** (opt-in) — `~/.cues/IDENTITY.md` declares your name, email, work city; `my email _` substitutes the real value. `safe` mode keeps the value off the LLM provider's logs.
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

Spec status: `0.4-alpha`; changes tracked in [`spec/CHANGELOG.md`](spec/CHANGELOG.md).

## Configuration

Your user-level config lives at `~/.cues/` — one `OPENCUES.md` (runtime settings) plus the three master files and their per-source folders. Project-level overrides at `<cwd>/.cues/` merge on top for native hosts. Hot-reload picks up edits in ~2s.

Seed from the shipped defaults the first time:

```bash
pnpm exec opencues seed-configs
```

Cycleable runtime settings (voice-mode, debug-mode, fluid-blank-mode, sentence-cues-mode, agent-debounce-ms, …) flip live via `opencues settings _` or by editing `~/.cues/OPENCUES.md` directly.

Full config reference, scalar table, and authoring guide: [`docs/configuration.md`](docs/configuration.md).

## LLM providers

OpenCues supports **seven providers** out of the box: **Cerebras** (recommended
default), Groq, OpenAI, Anthropic, OpenRouter, Gemini, and OpenCode Zen.

The recommendation rationale: Cerebras and Groq both serve `gpt-oss-120b`
(the same weights OpenCues was tuned and benched against), so output quality
is identical across them — but Cerebras's free tier currently has lower
latency for the short responses every cue/blank emits. Set the env key for
whichever you pick and you're done.

```bash
export CEREBRAS_API_KEY="csk-..."       # recommended (lowest latency)
# or
export GROQ_API_KEY="gsk-..."           # same weights, slightly slower
# or any of: OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY /
#            OPENROUTER_API_KEY / OPENCODE_ZEN_API_KEY
```

### Switching provider for the whole runtime

The active provider is a scalar in `~/.cues/OPENCUES.md` frontmatter. Open
the file with any editor and set `llm-provider`:

```yaml
---
llm-provider: cerebras   # (default) cerebras | groq | openai | anthropic |
                         #           gemini | openrouter | opencode-zen
---
```

Hot-reload picks it up in ~2 seconds — no restart. The status line shows
the resolved provider + model when a cue fires; tail `/tmp/opencues.log`
if you want the full trace.

### Switching the model within a provider

Same file, `llm-model` scalar:

```yaml
---
llm-provider: cerebras
llm-model: openai/gpt-oss-120b   # whatever model name your provider exposes
---
```

If unset, the runtime picks a sensible default per provider (cf.
[`docs/guides/llm-providers.md`](docs/guides/llm-providers.md)).

### Per-feature routing (advanced)

Pick a different provider / model just for *blanks* (the `_` surface) via
`blanks-llm-provider` + `blanks-llm-model` — one of three buckets (`cues`,
`auditors`, `blanks`), each with its own provider/model scalar pair. Useful
for routing blanks through a free or cheaper tier while keeping cues /
auditors / agent-rewrite on a higher-quality model. Full per-bucket table in
[`docs/architecture/llm-routing.md`](docs/architecture/llm-routing.md) and
the provider guide.

### Failover

Setting **both** `CEREBRAS_API_KEY` and `GROQ_API_KEY` enables automatic
429/5xx failover between them — same `gpt-oss-120b` weights mean no
quality shift when one provider rate-limits. Recommended for heavy use.

### Free mode (no API key)

Set `blanks-llm-provider: opencode-zen` + `blanks-llm-model: free` in `~/.cues/OPENCUES.md` and **blanks** (FluidBlank / TransformBlank / ConfigIntent) route through [OpenCode Zen](https://opencode.ai/zen)'s free model pool — anonymously, no key required. The runtime walks the pool on transient failures and surfaces the resolved model in the status line.

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

**Optional context features.** Ambient context (Chrome reads the focused field's label + page title for disambiguating fluid lookups) is **off by default**. Identity context (`~/.cues/IDENTITY.md` personal data sent as sentinel tokens) defaults to **`safe` mode** since 2026-06-18, and `safe` is bidirectional: only token names + descriptions reach the LLM (real values substituted post-LLM on the host), and if you type your own name, email, or any other IDENTITY.md value into the buffer, it's scrubbed to tokens before the request leaves your machine and restored in the result. Set `identity-context-mode: off` in `~/.cues/OPENCUES.md` to disable entirely. Sensitive fields (password / OTP / payment / PII heuristics) refuse to attach regardless.

Full threat model, capability tables, and per-surface boundaries:
- [`docs/architecture/security-audit.md`](docs/architecture/security-audit.md) — umbrella threat model
- [`docs/architecture/user-blanks.md`](docs/architecture/user-blanks.md) — capability contract for JS blanks
- [`docs/architecture/chrome-security.md`](docs/architecture/chrome-security.md) — Chrome's six boundaries
- [`docs/architecture/ambient-context.md`](docs/architecture/ambient-context.md), [`docs/architecture/identity-context.md`](docs/architecture/identity-context.md) — the two opt-in context features

## Contributing

- **Build an integration** — bring OpenCues to a new editor or IDE: see [`docs/guides/adding-an-integration.md`](docs/guides/adding-an-integration.md). The standards are at [`spec/`](spec/) and the conformance suite at [`spec/conformance/`](spec/conformance/).
- **Add a cue, blank, or auditor** — `opencues new cue <name>` / `opencues new blank <name>` scaffolds a starting file. Full guide: [`docs/guides/adding-a-cue-blank.md`](docs/guides/adding-a-cue-blank.md).
- **Modify the reference runtime** — [`CONTRIBUTING.md`](CONTRIBUTING.md) covers the monorepo layout, build commands, and test conventions.

New to the terminology? [`docs/glossary.md`](docs/glossary.md) covers cues, blanks, cue-blanks, sources, parsers, master files, and routing.

## Status

| Component | Version | Status |
|---|---|---|
| `spec/` | 0.5-alpha | Field names + semantics may change before 1.0. Tracked in [`spec/CHANGELOG.md`](spec/CHANGELOG.md). |
| `@opencues/core` | 0.x | Workspace dep, pre-publish. Public API may change. |
| `@opencues/runtime` | 0.x | Workspace dep, pre-publish. Public API may change. |
| Claude Code integration | Available | Pinned at Claude Code 2.1.170 (native bun-binary). Also tested: 2.1.110 (cli.js), 2.1.150, 2.1.158. |
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
