# Getting help

Different things go to different places.

## Bug reports → GitHub Issues

Stuff that's broken, regressions, install failures, unexpected
behaviour, edge cases — [open an issue](https://github.com/opencues/opencues/issues/new/choose).
Pick the right template; the `Bug report` one prompts for
reproduction steps, expected vs actual, environment.

Before filing:

1. Run `opencues doctor` and include the output. It catches the
   80% case (missing API key, stale install, OS-binding conflict).
2. Check `/tmp/opencues.log` (or your platform equivalent) for
   the boot lines + any error. Trim to the relevant window and
   attach.
3. `opencues version` output — which CLI, which integration
   versions, which install path.

## Questions → GitHub Discussions

How-to questions, design discussions, "is this supposed to work
this way?", "what's the right way to..." — [open a Discussion](https://github.com/opencues/opencues/discussions).
Discussions are the right home for things that don't have a
single right answer or that other users might also want to read.

## Security issues → SECURITY.md

Anything that could expose secrets, allow unauthorised access,
or compromise a system goes through the private disclosure path
in [SECURITY.md](SECURITY.md) — NOT GitHub Issues.

## Feature requests → GitHub Discussions first, then Issues

Float the idea in Discussions for a sanity check + community
input. Once there's a concrete design and consensus that it
belongs, convert (or open a fresh) Issue with the agreed-upon
spec.

## Code questions while contributing → CONTRIBUTING.md

Setup, build commands, the dev loop, how to add a cue source,
how to add an integration — [CONTRIBUTING.md](CONTRIBUTING.md)
covers it. The deep-dive on architecture lives in
[CLAUDE.md](CLAUDE.md) and `docs/architecture/`.

## Real-time / chat

No Discord or Slack yet. If a real-time channel becomes useful
(usually after ~50 active contributors), it'll be linked here.
Until then, asynchronous on Issues / Discussions is the
preferred medium — answers stay searchable.
