<!-- Brand assets: placeholder art served via jsDelivr from THIS repo's
     assets/ at a pinned commit (jsDelivr tested faster/more reliable than
     repo-relative paths on GitHub — keep the CDN, don't switch to relative).
     The ART is still placeholder: when final artwork lands, replace the SVG
     file CONTENTS (same filenames), commit, and bump the @<sha> in these
     URLs to that new commit. -->

<div align="right">
  <a href="#"><img width="180" alt="OpenCues" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/OpenCues_logo.svg"></a>
</div>

<br><br>

<div align="center">
  <a href="#"><img width="600" alt="OpenCues" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/Hero.svg"></a>
</div>

<br><br>

#

<p align="left"><a href="#"><img width="120" alt="Associations:" src="assets/associations.svg"></a><a href="https://www.reddit.com/user/inventor_black/" target="_blank" rel="noopener noreferrer"><img width="177" alt="Mod of r/ClaudeAI" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/Associations-02.svg"></a><img width="24" alt="" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/spacer.svg"><a href="https://www.reddit.com/user/ClaudeAI-mod-bot/" target="_blank" rel="noopener noreferrer"><img width="168" alt="Bot at r/ClaudeAI" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/Associations-02.1.svg"></a><img width="24" alt="" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/spacer.svg"><a href="https://luma.com/OpenSourceIRL" target="_blank" rel="noopener noreferrer"><img width="161" alt="OpenSourceIRL" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/Associations-03.svg"></a></p>

<br><br><br>

<!-- TODO: add once live — npm version badge (after the BETA-INSTALL.md → real
publish cutover) and Discord badge (once DISCORD_ID/INVITE are real):
[![npm](https://img.shields.io/npm/v/opencues)](https://npmjs.com/package/opencues)
[![Discord](https://img.shields.io/discord/DISCORD_ID?label=Discord)](https://discord.gg/INVITE) -->

**OpenCues enables native AI integration anywhere you type.** Model agnostic and fully open source. Inline agents and prompting.

Rather than navigating to a chat interface or AI-enabled input box, define a query in plain text: an LLM discovers your query and answers it inline, right where you wrote it.

<!-- VIDEO: hero demo (~30-60s), replace this comment with the real embed.
     GitHub-hosted asset (renders inline): ![demo](https://github.com/opencues/opencues/assets/.../demo.mp4)
     YouTube (GitHub won't inline-embed it — link a thumbnail instead):
     [![Demo](assets/hero-thumb.png)](https://youtu.be/VIDEO_ID) -->
<a href="#"><img width="100%" alt="Video placeholder — hero demo" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/Video_placeholder_1200x300.svg"></a>

OpenCues is platform, model, and provider agnostic, engineered from the ground up to enable native inline AI.

| You type | You get |
|---|---|
| hey can u send me that report when u get a sec make this formal _ | Could you please send me that report at your earliest convenience? |
| 4 + 4 = _ | 4 + 4 = 8 |
| hello world translate to japanese _ | こんにちは世界 |
| draft an email to my landlord asking for a rent reduction _ | (the email, written) |
| ffmpeg command to convert a video to web-ready mp4 _ | ffmpeg -i input.mov -c:v libx264 -preset slow -crf 23 -c:a aac -b:a 128k -movflags +faststart output.mp4 |

#

<p align="left"><a href="LICENSE"><img width="216" alt="Apache-2.0 License" src="assets/license.svg"></a><a href="spec/README.md"><img width="157" alt="Open Standard" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/Ownership-05.svg"></a><img width="24" alt="" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/spacer.svg"><a href="spec/blank-spec.md"><img width="121" alt="Blanks.md" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/Ownership-06.svg"></a><img width="24" alt="" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/spacer.svg"><a href="spec/cue-spec.md"><img width="112" alt="Cues.md" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/Ownership-07.svg"></a></p>

<br><br><br><br>

# Quickstart

```bash
npm install -g opencues              # needs Node 22+ and git
opencues set-key cerebras csk-...    # cerebras.ai — free tier, lowest latency
opencues install claude-code         # or: opencode | gemini-cli | chrome | shell
claude-cues                          # launch — native `claude` is untouched
```

Full walkthrough, prerequisites, and per-host detail: [`docs/install.md`](docs/install.md). `opencues doctor` diagnoses anything that looks wrong.

<!-- VIDEO: quickstart walkthrough (~30-45s), replace this comment with the
     real embed once available. -->
<a href="#"><img width="100%" alt="Video placeholder — quickstart walkthrough" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/Video_placeholder_1200x300.svg"></a>

#

<p align="left"><a href="docs/guides/cli-reference.md#the-5-youll-actually-use"><img width="178" alt="OpenCues CLI" src="assets/opencues-cli.svg"></a><a href="docs/features/README.md"><img width="109" alt="Features" src="assets/features.svg"></a></p>

<br><br><br><br>

# Integrations

| Host | Status | Install |
|---|---|---|
| Claude Code | Available | `opencues install claude-code` |
| OpenCode | Available | `opencues install opencode` |
| Gemini CLI | Beta | `opencues install gemini-cli` |
| Chrome | Beta | `opencues install chrome` |
| Shell | Beta | `opencues install shell` |

Each pins its own upstream fork and never touches your native host install.

> ⚠️ **Windows**: not supported natively, run inside WSL2 (see [`docs/install.md`](docs/install.md)).

#

<p align="left"><a href="#integrations"><img width="91" alt="Supports:" src="assets/supports.svg"></a><a href="integrations/opencode/README.md"><img width="129" alt="OpenCode" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/Supports-09.svg"></a><img width="24" alt="" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/spacer.svg"><a href="integrations/claude-code/README.md"><img width="144" alt="Claude Code" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/Supports-10.svg"></a><img width="24" alt="" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/spacer.svg"><a href="integrations/gemini-cli/README.md"><img width="126" alt="Gemini CLI" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/Supports-11.svg"></a><img width="24" alt="" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/spacer.svg"><a href="integrations/chrome/README.md"><img width="130" alt="Chrome" src="assets/chrome.svg"></a><a href="integrations/shell/README.md"><img width="82" alt="Shell" src="assets/shell.svg"></a></p>

<br><br><br><br>

# What you get

| Feature | What it does |
|---|---|
| **Blanks** | Type `_` for free-form generation, translation, formatting, full rewrites, or keyword-bound system actions (`volume _`, `weather _`). |
| **Sentence rewrites** | Cycle a whole sentence to a different register (formal, concise, ...) seamlessly, no `_` needed. |
| **Word cues** | Navigate to a single word and cycle a smaller LLM-suggested alternative. |
| **Personal + ambient context** (opt-in) | `my email _` substitutes your real address; fluid lookups can read the page you're on. |
| **Hot-reload** | Every `.md` config picks up edits in ~2s, no restart. |

Full feature catalogue (44 concepts): [`docs/features/README.md`](docs/features/README.md).

<!-- VIDEO: feature tour (~30s of cues + blanks in action), replace this
     comment with the real embed once available. -->
<a href="#"><img width="100%" alt="Video placeholder — feature tour" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/Video_placeholder_1200x300.svg"></a>

<br><br><br><br>

# Configuration & LLM providers

<div align="center">
  <a href="#"><img width="600" alt="OpenCues" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/Hero-2.svg"></a>
</div>

<br>

Config lives at `~/.cues/` — one `OPENCUES.md` for runtime settings, plus per-surface source folders. Seven providers supported; set an env key or `opencues set-key` and you're done.

Full reference: [`docs/configuration.md`](docs/configuration.md) · [`docs/guides/llm-providers.md`](docs/guides/llm-providers.md) (switching provider/model, free mode, failover).

#

<img width="92" alt="Providers:" src="assets/providers.svg"><a href="https://cloud.cerebras.ai" target="_blank" rel="noopener noreferrer"><img width="200" alt="Cerebras Systems" src="assets/cerebras-systems.svg"></a><a href="https://groq.com" target="_blank" rel="noopener noreferrer"><img width="107" alt="Groq" src="assets/groq.svg"></a><a href="https://ai.google.dev" target="_blank" rel="noopener noreferrer"><img width="122" alt="Gemini" src="assets/gemini.svg"></a><a href="https://www.anthropic.com" target="_blank" rel="noopener noreferrer"><img width="141" alt="Anthropic" src="assets/anthropic.svg"></a><a href="https://openai.com" target="_blank" rel="noopener noreferrer"><img width="102" alt="OpenAI" src="assets/openai.svg"></a>

<br><br><br><br>

# Security

OpenCues has no tool handlers or exec layer for LLM output — no MCP-tool execution, no agentic actions, no side-effect channel. Worst-case, an LLM response lands as user-visible text in the buffer you review before submitting. That single invariant is what keeps prompt injection a UX failure instead of a data-exfiltration channel, across every surface below.

23 of 27 tracked attack classes closed, 3 closed-with-caveat, 1 tracked for the future pack registry ([full audit table](docs/architecture/security-audit.md)).

| Defense | What it covers |
|---|---|
| Sandbox isolation | Third-party blank JS runs in a real V8 isolate (`isolated-vm`) — its own realm, own intrinsics, no sandbox-escape via constructor-chain pivots |
| Capability gates | A blank only gets `network`/`llm`/`storage`/`secrets` access if declared; secrets without a matching host binding are refused at load time |
| Resource quotas | Sliding-window caps on fetches, LLM calls, and storage writes — no polling hammer, no runaway LLM burn |
| Output sanitization | Blank output is stripped of HTML/script tags, zero-width chars, and bidi overrides before it reaches the buffer |

Check a pack before trusting it:

```bash
opencues review ./untrusted-pack/
```

Full threat model: [`docs/architecture/security-audit.md`](docs/architecture/security-audit.md). Reporting a vulnerability: [`SECURITY.md`](SECURITY.md).

<br><br><br><br>

# Contributing

<div align="center">
  <a href="#"><img width="600" alt="OpenCues" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/Hero-3.svg"></a>
</div>

<br>

| What | Where |
|---|---|
| New host integration | [`docs/guides/adding-an-integration.md`](docs/guides/adding-an-integration.md) |
| New cue/blank | [`docs/guides/adding-a-cue-blank.md`](docs/guides/adding-a-cue-blank.md) |
| Working on the reference runtime | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| New to the terms | [`docs/glossary.md`](docs/glossary.md) |

Join the community — questions, feedback, and the people building alongside you. We're also part of [OpenSourceIRL](https://luma.com/OpenSourceIRL), a community for people building in the open.

#

<p align="left"><img width="85" alt="Community:" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/Community-12.svg"><img width="24" alt="" src="https://cdn.jsdelivr.net/gh/opencues/opencues@43ac7ab68de968a183aa0340593aac926f26587a/assets/spacer.svg"><a href="https://github.com/opencues/opencues/graphs/contributors"><img width="161" alt="Contributors" src="assets/contributors.svg"></a><a href="https://x.com/openCues_" target="_blank" rel="noopener noreferrer"><img width="142" alt="X / Twitter" src="assets/x-twitter.svg"></a><a href="https://www.reddit.com/r/OpenCues/" target="_blank" rel="noopener noreferrer"><img width="118" alt="Reddit" src="assets/reddit.svg"></a><a href="https://www.instagram.com/opencues/" target="_blank" rel="noopener noreferrer"><img width="117" alt="Instagram" src="assets/instagram.svg"></a></p>

<!-- TODO[community]: add Discord + GitHub Discussions once live (tracked in .internal/pre-launch-readme.md) -->

<br><br><br><br>

# License

[Apache License 2.0](LICENSE).

<br><br><br><br>

#

<p align="left"><img width="75" alt="Design" src="assets/design.svg"><a href="https://jbrandford.com" target="_blank" rel="noopener noreferrer"><img width="128" alt="Author" src="assets/j-brandford.svg"></a></p>
