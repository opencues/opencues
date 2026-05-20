# 08 — In RAM / Local-First

For blog post #15: "In Ram".

The user's title is short on context, but the angle is the in-memory,
local-first nature of OpenCues' runtime. Tips load instantly. No server.
No cloud database. ConfigLoader holds everything in RAM. Hot-reload is a
file-watch, not a network round-trip.

## The "in RAM" story

### Local cues: ~0ms response

From `docs/glossary.md`:
> **Local Cues** — Alternatives computed locally on your machine, returning
> near-instantly (~0ms). The tips file is a local cue source — it provides
> both alternatives and cue-tips. In code: `LocalCueSource`.

Static cue data (the `tips` source, the `extended-thinking` group, every
shipped folder) is parsed once at boot, held in memory, and looked up via
direct hash access on every keystroke. There's no async, no I/O, no LLM
call — just `data[word]`.

Compare to remote cues:
> **Remote Cues** — Alternatives computed externally using an LLM
> (~200-500ms).

Three orders of magnitude difference. Local-first is *visibly* fast.

### ConfigLoader: file → RAM → keystroke

The runtime's `ConfigLoader` reads every `.md` file in the search paths at
boot, parses them, and hands the parsed result to the resolver. From
`CLAUDE.md`:

> Hot-reload polls every search path on every keystroke (same `maybeReload`
> mechanism as before).

That's the local-first loop:
1. User types a key
2. ConfigLoader's `maybeReload` checks file mtimes
3. If anything changed, re-parse and rebuild
4. Resolver uses the new config

No network. No daemon. No IPC to a separate process. The whole thing lives
in the host process.

### No server, no cloud anything

OpenCues has no backend. It is:

- **A local Node/Bun/Rust runtime** depending on host.
- **A local API key for the LLM provider** (`GROQ_API_KEY` etc. — the user's
  own key, used directly).
- **Local config files in `~/.cues/`** — the user's data, on the user's
  disk.
- **Local scripts** (volume, brightness) — running on the user's machine.

The only outbound traffic is to:
- The configured LLM provider (Groq by default)
- Free public APIs the user opted into (Finnhub, Open-Meteo, HN RSS,
  CoinGecko, REST Countries, Dictionary API)

There is no `opencues.com` backend. There is no telemetry. Cues + blanks
work without any account. The Chrome extension's bake-time defaults mean a
user who installs but never edits a config still gets grammar/legal/medical
synonyms.

## Hot-reload — files as the API

From `CLAUDE.md`:
> `.md` config files (`CUES.md`, `BLANKS.md`, `cues/`, `blanks/`) hot-reload
> within ~2 seconds on the next keystroke — no restart needed.

Implementation: `ConfigLoader` polls file mtimes on every text-change event
(debounced). Cheap. Works on every filesystem.

Implication for HCI: editing a config and seeing the change happen on the
*next keystroke* is its own form of flow. You're tuning the system while
using it. There's no compile-restart-test loop.

The race-condition guard documented in `CLAUDE.md` § "Hoisted-blank writes
vs ConfigLoader hot-reload" is worth reading if the blog wants depth — it
shows the system actually had to deal with "what if the file write
finishes after the next reload?" Solution: a 2.5s suppression window after
mutating writes.

## The Chrome edge case (and what it teaches)

Chrome can't read the filesystem at runtime. Solution: the extension
*bundles* the configs at build time, and `opencues sync chrome` re-bundles
when configs change. Hot-reload is then "polling a `.version` hash."

This is interesting because the *user model* is the same — edit the file,
see the change soon — but the implementation is fundamentally different
(no live filesystem). The local-first promise survived a host that doesn't
even have a filesystem in the runtime.

## Shipped defaults and bake-time bundling

From `CLAUDE.md`:
> The repo's `defaults/` directory ships the seed configs — the same files
> get baked into the Chrome extension at build time and copied to `~/.cues/`
> by `opencues seed-configs`. The repo no longer self-dogfoods via an
> in-tree `.cues/`.

For Chrome specifically:
> The extension also carries bake-time defaults inlined from `<repo>/defaults/`
> at esbuild time, so a user who installs but never syncs still gets
> grammar/legal/medical etc.

So the local-first promise has a "useful out of the box" guarantee even when
the user hasn't synced yet. RAM holds the bundled defaults; the user
overrides selectively via sync.

## TS-class blanks live in the runtime, not over the network

From `docs/features/cue-blanks.md`:

> Several blanks were hoisted from per-host shell scripts into TypeScript
> classes living in `packages/opencues-runtime/src/blanks/`.

`HackerNewsBlank`, `StocksBlank`, etc. live as regular TS classes the host
loads at startup. They make HTTP calls when invoked, but the *blank logic*
is in-process.

The shared `createBlankInvoke` factory keeps the registry lookup → spawn
fallback consistent. Registry hits are in-process function calls (~0ms);
only the fallback path spawns subprocesses.

## The HCI angle (for blog #15)

1. **Latency is the dominant flow killer.** Local-first means the
   keystroke → indication loop is microseconds, not milliseconds. That
   matters.

2. **Files as the API is a UX choice.** Editing `CUES.md` directly is the
   "API" — hot-reloaded into the running runtime. Compare to apps where
   "settings" require a GUI dialog.

3. **No account, no telemetry, no cloud.** The user's data stays in
   `~/.cues/`. The user's API key is theirs. The system doesn't gate on
   external services. (Apart from the LLM call itself, which is opt-in to
   whatever provider you configure.)

4. **The runtime *is* the deployment.** No backend means nothing to
   deploy, nothing to rate-limit, nothing to keep running. The thing you
   install IS the thing.

5. **Caching that fits the user model.** Resolver Skip Filter (don't re-ask
   the LLM about a word the user already cycled to). Per-word cycling state
   that survives edits. Both are in-RAM optimizations the user feels as
   "the system remembers what I just chose."

## Concrete latency targets (from the docs)

- Local cue lookup: **<1ms** (hash access)
- Hot-reload propagation: **<2s** (file-mtime poll + parse + rebuild)
- Remote cue (LLM): **~200-500ms** (Groq)
- Blank fill (fluid blank, two-pass): **~600-1200ms**
- Transform blank (3-pass): **~1.4-1.6s**
- Agent task (one debounce cycle): **~365ms** (EDITS format)

## Pitfalls and trade-offs

- **Per-keystroke polling has a non-zero cost.** Cheap on modern systems
  but not free; deep `.cues/` trees scale linearly. Mitigation: debounce.
- **No telemetry means no usage analytics.** Means harder to know "do
  people actually navigate to dimmed words?" Trade-off the project
  accepts.
- **In-RAM means "until the host process dies."** Cycling state, blank
  state, settings — all in process memory. Restart loses the in-progress
  state, though the persisted `.cues/` + `~/.opencuesrc` mean the
  configuration survives.
- **Chrome's bake-time defaults are a security boundary issue.** The
  extension currently inlines `__GROQ_API_KEY__` from `.env` at esbuild
  time — anyone who installs the unpacked extension can grep the API key
  out of the bundle. Pre-launch fix is documented in CLAUDE.md.

## Where this material lives

- `CLAUDE.md` — hot-reload semantics, defaults, hoisted-blank race guard
- `damon.md` — local cues vs remote cues, blank registry/spawn fallback
- `docs/glossary.md` — Local Cues / Remote Cues / Hot-Reload entries
- `docs/features/local-cues.md`, `hot-reload-config.md`,
  `shipped-defaults.md`
- `docs/architecture/transform-blank.md` — latency budget per pipeline
  stage
- `docs/architecture/agent-task.md` — debounce cadence

## Quotable lines

- "Local cues return near-instantly (~0ms)."
- "Hot-reload within ~2 seconds — no restart needed."
- "Same code, every host."
- "There is no `opencues.com` backend."
- "Files as the API."
