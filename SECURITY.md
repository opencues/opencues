# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in OpenCues, please report it responsibly.

**Do not open a public issue.** Instead, email **hello@opencues.com** with:

- A description of the vulnerability
- Steps to reproduce
- The potential impact
- Any suggested fix (if you have one)

We will acknowledge your report within 48 hours and aim to provide a fix or mitigation within 7 days for critical issues.

## Scope

OpenCues runs locally on your machine. The main security-relevant areas are:

- **Shell script execution** — cue-controls execute bash scripts via `execFileSync`. Scripts are defined in config files authored by the repo owner, not by end users or external input.
- **LLM API calls** — requests are sent to the configured provider (Groq by default) with your API key. No data is sent to OpenCues servers (there are none).
- **Config file parsing** — `.md` config files are parsed by cues-core. The `compute` parser uses `Function()` for arithmetic — this is documented and opt-in per blank mode.

## Supported Versions

OpenCues does not yet have formal releases. Security fixes are applied to the `master` branch.

| Version | Supported |
|---------|-----------|
| master  | Yes       |
