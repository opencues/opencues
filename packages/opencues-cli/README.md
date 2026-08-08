# OpenCues

**Native AI integration anywhere you type.** Model-agnostic, fully open source, inline agents and prompting.

Rather than switching to a chat window, write your query in plain text and end it with `_`. An LLM discovers it and answers **inline, right where you wrote it** — across your terminal AI CLIs, your shell, and the browser.

`opencues` is the front-door CLI: one command to install, configure, and run OpenCues across every editor integration.

## What it does

| You type | You get |
|---|---|
| `hey can u send me that report when u get a sec make this formal _` | Could you please send me that report at your earliest convenience? |
| `4 + 4 = _` | `4 + 4 = 8` |
| `hello world translate to japanese _` | こんにちは世界 |
| `draft an email to my landlord asking for a rent reduction _` | *(the email, written)* |
| `ffmpeg command to convert a video to web-ready mp4 _` | `ffmpeg -i input.mov -c:v libx264 -preset slow -crf 23 -c:a aac -b:a 128k -movflags +faststart output.mp4` |

## Quickstart

Requires **Node 22+** and **git**.

```bash
npm install -g opencues
opencues set-key cerebras csk-...     # cerebras.ai — free tier, lowest latency
opencues install claude-code          # or: opencode | gemini-cli | chrome | shell
opencues run claude-code              # launch — your native install is untouched
```

`opencues doctor` diagnoses anything that looks off. Full walkthrough and prerequisites: **[install guide](https://github.com/opencues/opencues/blob/master/docs/install.md)**.

> **Windows** is not supported natively — run inside WSL2.

## Integrations

| Host | Status | Install |
|---|---|---|
| Claude Code | Available | `opencues install claude-code` |
| OpenCode | Available | `opencues install opencode` |
| Gemini CLI | Beta | `opencues install gemini-cli` |
| Chrome | Beta | `opencues install chrome` |
| Shell | Beta | `opencues install shell` |

Each integration pins its own upstream fork and never touches your native host install.

## What you get

| Feature | What it does |
|---|---|
| **Blanks** | Type `_` for free-form generation, translation, formatting, full rewrites, or keyword actions (`volume _`, `weather _`). |
| **Sentence rewrites** | Cycle a whole sentence to a different register (formal, concise, …) — no `_` needed. |
| **Word cues** | Navigate to a word and cycle a smaller LLM-suggested alternative. |
| **Live actuators** | `volume _` reads the real level and leaves a knob: `Ctrl+Alt+↑/↓` or a bare `_` turns it, and the device follows. |
| **Session-contradiction cues** *(opt-in)* | Flags a draft that goes against a decision you made earlier in the same coding session. |
| **Ask-cues** *(opt-in)* | Turns a vague sentence into an inline question with cyclable answers. |
| **Personal + ambient context** *(opt-in)* | `my email _` substitutes your real address; fluid lookups can read the page you're on. |
| **Hot-reload** | Every `.md` config picks up edits in ~2s — no restart. |

Full feature catalogue: **[docs/features](https://github.com/opencues/opencues/blob/master/docs/features/README.md)**.

## Providers

Seven providers supported — **Cerebras, Groq, Gemini, Anthropic, OpenAI**, and more. Set an environment key or run `opencues set-key <provider> <key>` and you're done. Switch provider and model per feature; auto-failover is built in. See **[LLM providers](https://github.com/opencues/opencues/blob/master/docs/guides/llm-providers.md)**.

## CLI commands

```
opencues install <host>       install an integration (claude-code, opencode, gemini-cli, chrome, shell)
opencues uninstall <host>     roll it back
opencues run <host>           launch a patched host
opencues set-key <p> <key>    store a provider key
opencues seed-configs         copy default cues into ~/.cues/
opencues doctor               diagnose install / config issues
opencues usage                what your LLM calls cost, across every running host
opencues which                show every relevant path
opencues review <pack>        vet an untrusted cue/blank pack before trusting it
opencues version              versions + host compatibility
opencues help [command]       discoverable help
```

Also shipped: `models`, `identity`, `calendar`, `sync`, `import`, `init`, `new`, `validate`, `list`, `show`, `edit`, `logs`, `update`, `config`, `completion`, and `extract-commitments` (the background producer behind session-contradiction cues — kicked automatically by each host, rarely run by hand).

## Security

OpenCues has **no tool handlers and no exec layer** for LLM output — no MCP-tool execution, no agentic actions, no side-effect channel. Worst case, a response lands as user-visible text in the buffer you review before submitting. Third-party blank JS runs in a real V8 isolate (`isolated-vm`) with capability gates and resource quotas, and output is sanitized before it reaches your buffer. Vet a pack before trusting it with `opencues review ./pack/`. Full threat model: **[security audit](https://github.com/opencues/opencues/blob/master/docs/architecture/security-audit.md)**.

## Links

- **GitHub** — https://github.com/opencues/opencues
- **Open standard (the spec)** — https://github.com/opencues/opencues/blob/master/spec/README.md
- **Docs** — https://github.com/opencues/opencues/tree/master/docs
- **Community** — [r/OpenCues](https://www.reddit.com/r/OpenCues/) · [@openCues_](https://x.com/openCues_)

## License

[Apache-2.0](https://github.com/opencues/opencues/blob/master/LICENSE)
