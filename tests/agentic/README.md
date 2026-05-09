# Agentic Test Harness

End-to-end test infrastructure that lets a non-human driver (a test
runner, an agent, Claude itself) drive a running OpenCues host
without a keyboard. Replaces the v1 `~/.claude/opencues-auto/`
harness, which was stranded when the runtime moved to v2.

## Architecture

The harness lives **in the runtime** (`packages/opencues-runtime/src/agentic-mode.ts`),
not in per-host patches. Every host (CC v2.1, OC v1.4, Gemini v0.41)
that mounts the runtime via `buildSharedRuntime` gets the harness
for free when `OPENCUES_AGENTIC=1` is set at launch.

```
┌─ Host running normally ───────────────────────────────────────┐
│                                                                │
│  @opencues/runtime — startAgenticHarness({adapter, dispatch,  │
│  state})                                                       │
│       └─ setInterval(100ms): poll /tmp/opencues-inject-<pid>  │
│            ├─ "text:..."   → adapter.setText                  │
│            ├─ "key:..."    → bootResult.dispatchKey            │
│            ├─ "cursor:N"   → adapter.setCursorOffset           │
│            └─ "dump"       → write /tmp/opencues-agentic-dump │
│                                                                │
└────────────────────────────────────────────────────────────────┘
       ↑ writes scripts                ↓ reads state
   tests/agentic/oc-inject       /tmp/opencues-status-<pid>.json
   tests/agentic/scenario-runner  /tmp/opencues-agentic-dump-<pid>.json
                                   /tmp/opencues.log
```

## Quick start

```bash
# 1. Launch a host with the harness armed
OPENCUES_AGENTIC=1 opencues run opencode &
sleep 3   # wait for the runtime to mount

# 2. Read the canonical pidfile — written by the harness on arm.
#    `$!` (the bash bg-job pid) is the LAUNCHER, not the host process
#    where the harness lives, so don't rely on it.
PID=$(cat /tmp/opencues-agentic.pid)
echo "host pid = $PID"

# 3. Inject + observe
tests/agentic/oc-inject $PID 'text:the lawyer filed today'
sleep 2   # let the resolver run
tests/agentic/oc-state $PID

# 4. Cycle + dump full state
tests/agentic/oc-inject $PID 'key:up:ctrl+alt'
tests/agentic/oc-dump $PID

# 5. Tail the log to see what the runtime did
tests/agentic/oc-tail --follow --grep agentic
```

The pidfile is overwritten each launch (last writer wins). For multi-host
testing — e.g. running CC and OC simultaneously — set
`OPENCUES_AGENTIC_PID_FILE` to a host-scoped path on each launch:

```bash
OPENCUES_AGENTIC=1 OPENCUES_AGENTIC_PID_FILE=/tmp/opencues-cc.pid \
  opencues run claude-code &

OPENCUES_AGENTIC=1 OPENCUES_AGENTIC_PID_FILE=/tmp/opencues-oc.pid \
  opencues run opencode &
```

## Inject protocol

`/tmp/opencues-inject-<pid>.txt` — one command per line. Consumed
atomically every 100ms (file deleted before commands run).

| Command | Effect |
|---|---|
| `text:<s>` | Replace buffer with `<s>`. Highlight clears (matches user-typing semantics). |
| `text-keep-hl:<s>` | Alias for `text:` today; documentation-only intent flag. |
| `cursor:<n>` | Move cursor to byte offset `n`. |
| `key:<name>:<mods>` | Synthesise a key event. Mods are `+`-joined: `ctrl+alt+shift+meta`. |
| `clear` | Empty buffer + cursor=0. |
| `dump` | Write full runtime state to `/tmp/opencues-agentic-dump-<pid>.json`. |
| `wait:<ms>` | No-op marker (file is consumed in one cycle). |

## State files

Read-only from the harness's perspective. Updated by the runtime as
state changes.

| File | Contents | Updated by |
|---|---|---|
| `/tmp/opencues-agentic.pid` | Plain text — the active host's PID. Override path via `OPENCUES_AGENTIC_PID_FILE`. | Agentic harness on arm; deleted on stop |
| `/tmp/opencues-status-<pid>.json` | Highlighted word, alts, tip, agent task. | `Statusline` module (every state change) |
| `/tmp/opencues-cursor-state-<pid>.json` | Buffer text + cursor offset. | `CursorStateExport` module |
| `/tmp/opencues-agentic-dump-<pid>.json` | Full state — text, cursor, highlight, dynDefs, spanFill, selectorSatellite, agentTask, capabilities, host info. | Agentic harness on `dump` command |
| `/tmp/opencues.log` | Runtime debug log (info/warn/error/debug). | Every host |

## CLI tooling (Phase B)

Five small bash wrappers in `tests/agentic/`:

- **`oc-inject`** — write a script to the inject file. Args become lines; or pipe stdin.
- **`oc-state`** — read the status JSON. `--field <jq-path>` extracts one value. `--watch` polls.
- **`oc-dump`** — issue `dump` + read the result. `--field` for jq extraction. `--no-trigger` skips the inject.
- **`oc-tail`** — tail the log. `-n <lines>`, `--grep <re>`, `--follow`.
- **`oc-pid`** — find the running host's PID (filters by host name optionally).

All accept `<pid>` as their first arg. Use `oc-pid` if you don't have it.

## Scenario runner (Phase D)

`tests/agentic/scenario-runner.ts` consumes JSON scenario files and
executes their step sequences. Each step is one of:

```jsonc
{"action": "clear"}
{"action": "inject", "text": "the lawyer filed today"}
{"action": "inject", "text": "...", "keepHighlight": true}
{"action": "cursor", "offset": 14}
{"action": "key", "key": "up", "modifiers": ["ctrl", "alt"]}
{"action": "dump"}                            // force a dump (already done by waitFor + expect with source: dump)
{"action": "sleep", "ms": 200}
{"action": "waitFor",                         // poll until predicate passes or timeout
 "path": "highlightedWord",
 "equals": "lawyer",
 "timeoutMs": 5000,
 "source": "status"}                          // or "dump" for the richer file
{"action": "expect",                          // assert state once, no polling
 "path": "alts.1",
 "equals": "attorney"}
{"action": "expect",
 "path": "tip",
 "matches": "synonym|alternative"}            // regex match
```

`path` is dot notation (`alts.1`, `dynDefs.defs.0.word`). Numeric segments
index arrays. `equals` does deep equality; `matches` is a regex against
the stringified value.

Run:

```bash
HOST_PID=$(tests/agentic/oc-pid claude-code)

# One scenario
npx tsx tests/agentic/scenario-runner.ts --pid $HOST_PID \
    --scenario tests/agentic/scenarios/01-basic-cycling.json -v

# All scenarios in a dir
npx tsx tests/agentic/scenario-runner.ts --pid $HOST_PID \
    --dir tests/agentic/scenarios
```

Exit code 0 = all passed; 1 = some failed; 2 = bad usage.

## Existing scenarios

Six demo scenarios in `tests/agentic/scenarios/` covering:

| File | What it exercises |
|---|---|
| `01-basic-cycling.json` | LLM resolves alts → cycle Up replaces text |
| `02-clear-on-new-text.json` | Highlight resets when buffer is replaced |
| `03-tip-from-tips-cue.json` | Local-lookup cue (no LLM) — `ultrathink` |
| `04-blank-fill-weather.json` | Network blank — `weather _ paris` |
| `05-numeric-step.json` | Step cue — `5f` ± 0.5 with floor at 0f |
| `06-escape-clears.json` | Escape deactivates highlight without text change |

These are templates — extend liberally. Each is ~10-20 lines of JSON.

## Porting guide — translating v1 tests to scenarios

The v1 `~/.claude/opencues-auto/claude-code/testing/` harness has 50+
shell-scripted tests across `test-cues.sh`, `test-cues-cycling.sh`,
`test-cues-transitions.sh`, `test-cursor-navigate.sh`,
`test-cues-settings.sh`, etc. Each can be ported to a JSON scenario
mechanically:

| v1 (bash) | v2 scenario step |
|---|---|
| `inject "text"` | `{"action": "inject", "text": "..."}` |
| `inject "text" 0` (highlight word 0) | injection alone — runtime resolves highlight automatically |
| `cycle.sh up 0` | `{"action": "key", "key": "up", "modifiers": ["ctrl", "alt"]}` |
| `wait_until "highlightedWord" "equals:lawyer"` | `{"action": "waitFor", "path": "highlightedWord", "equals": "lawyer", "timeoutMs": 5000}` |
| `assert_eq "$(read_field tip)" "..."` | `{"action": "expect", "path": "tip", "equals": "..."}` |
| `assert_match "$(read_text)" "pattern"` | `{"action": "expect", "path": "text", "matches": "pattern", "source": "dump"}` |

The status-file field names mostly carry over: `highlightedWord`,
`alts`, `currentAltIndex`, `cueTip`, `cueBlank`, `agentTask`. Where
the v1 tests poked into v1-only globals (`_dynDefs`, `_consumeAllAlts`,
`_cueControlTip`), the v2 dump exposes the same data through canonical
state classes — see `dynDefs`, `spanFill`, `selectorSatellite` in the
dump JSON.

## When to use this

- **CI-style regression tests** — write a scenario, commit it, runner
  fails the build if behavior changes.
- **Agentic debugging** — Claude (or any agent) reads the log,
  hypothesises a change, injects a test, confirms.
- **Reproducing user reports** — "type X, see Y" → scenario, replays
  forever.
- **Cross-host parity** — the same scenario file runs against CC, OC,
  Gemini, and any future host.

## When NOT to use this

- **Unit testing** — runtime modules have vitest unit tests + scenario
  tests (`*.scenarios.test.ts`). Those don't need a live host.
- **Performance benchmarking** — `tests/benchmarks/` has dedicated
  per-feature benchmarks that hit providers directly. Faster iteration.

## Limitations / known gaps

- **`text-keep-hl` is currently an alias for `text`.** Distinguishing
  programmatic from user writes needs the runtime's source-tagging
  pipeline (used today by OC's `notifyTextChange(source: 'runtime')`).
  A future iteration of agentic-mode could route through `pushText`
  for this.
- **No multi-host scenarios in one run** — the runner targets a single
  pid. To exercise CC + OC behaviour parity, run the same scenario
  file twice, once per host.
- **Network-dependent scenarios are flaky** — `weather`, `stocks`,
  `hackernews` all hit live APIs. Expected for end-to-end tests; mark
  the scenario file with `"flaky": true` in a future runner iteration
  if you want the suite to skip them by default.
- **No Gemini wiring yet** — the Gemini CLI integration is currently
  stashed (gemini-cli WIP commit). When the stash lands, the same
  4-line `if (process.env.OPENCUES_AGENTIC === '1') startAgenticHarness(...)`
  block needs to be added at the end of `adapters/gemini/v0.41/boot.ts`.
  Mirrors the OC pattern verbatim.
