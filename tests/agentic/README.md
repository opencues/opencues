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

### Option A — fully headless (no visible UI, no terminal needed)

For agentic / CI / no-human-in-the-loop testing:

```bash
PID=$(tests/agentic/oc-launch-headless opencode)
echo "host pid = $PID"
```

The host runs detached in a fake pty. The wrapper waits up to 30s for
the harness to arm + writes the pid to stdout. Use the returned PID
just like any interactive launch. Tear down with `kill $PID`.

To run multiple hosts in parallel (e.g. CC + OC for parity tests):

```bash
CC_PID=$(tests/agentic/oc-launch-headless claude-code --pid-file /tmp/oc-cc.pid)
OC_PID=$(tests/agentic/oc-launch-headless opencode    --pid-file /tmp/oc-oc.pid)
```

### Option B — interactive, harness armed

Use this when you want to also see / type into the TUI yourself:

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
| `/tmp/opencues-status-<pid>.json` | Highlighted word, alts, tip, agent task. **Read this for alts** — see "Where to look for alts" below. | `Statusline` module (every highlight state change) |
| `/tmp/opencues-cursor-state-<pid>.json` | Buffer text + cursor offset. | `CursorStateExport` module |
| `/tmp/opencues-agentic-dump-<pid>.json` | Full state — text, cursor, highlight, dynDefs, spanFill, selectorSatellite, agentTask, capabilities, host info. | Agentic harness on `dump` command |
| `/tmp/opencues.log` | Runtime debug log (info/warn/error/debug). | Every host |

### Where to look for alts (gotcha)

**Alts live in two different places depending on where they came from:**

- **Local-lookup alts** (tips/CUE.md entries like `ultrathink`, spelling, etc.) — appear in
  `/tmp/opencues-status-<pid>.json` `.alts` + `.altCueTips` ONLY AFTER the highlight
  is active (Navigation has activated a word). They do NOT populate `dynDefs`.
  Resolution is synchronous on lookup at cycle/nav time.

- **LLM-resolved alts** (word-cues sources, fluid-blank, transform-blank — anything that
  needs an HTTP round-trip) — populate `dynDefs.defs` in the agentic dump
  AS SOON AS the resolver finishes (no need to navigate first). 500ms debounce
  after the textChange event.

If `dump.dynDefs.defs` is empty after an inject, that doesn't mean nothing resolved —
it might just be a tips lookup. Activate the highlight (`key:right:ctrl+alt`) and
read `oc-state $PID` to see the local alts.

Inject sequence to verify a tips cue:

```bash
~/opencues/tests/agentic/oc-inject $PID 'text:we should ultrathink this approach'
sleep 1
~/opencues/tests/agentic/oc-inject $PID 'key:right:ctrl+alt'   # navigate to a word
sleep 1
~/opencues/tests/agentic/oc-state $PID --field '.alts'         # ← alts surface here
~/opencues/tests/agentic/oc-state $PID --field '.altCueTips'   # ← all alts + tips
~/opencues/tests/agentic/oc-inject $PID 'key:up:ctrl+alt'      # cycle to next alt
sleep 1
~/opencues/tests/agentic/oc-dump $PID --field '.text'          # buffer now reflects cycle
```

## CLI tooling

Bash wrappers in `tests/agentic/`:

- **`oc-launch-headless <host>`** — boot a host fully detached, no UI. Returns PID on stdout.
- **`oc-inject <pid> <cmds…>`** — write commands to the inject file. Args become lines; or pipe stdin.
- **`oc-state <pid>`** — read the status JSON. `--field <jq-path>`, `--watch`.
- **`oc-dump <pid>`** — issue `dump` + read the result. `--field`, `--no-trigger`.
- **`oc-events <pid>`** — read or tail the event stream. `--type <name>[,<name>]`, `--follow`, `--since <ts>`.
- **`oc-tail`** — tail the runtime log. `-n <lines>`, `--grep <re>`, `--follow`.
- **`oc-pid [host]`** — find the running host's PID (uses pidfile fast path).

All accept `<pid>` as their first arg. Use `oc-pid` or `cat /tmp/opencues-agentic.pid` if you don't have it.

## Event stream — first-class observability

The harness emits a structured event for every observable transition
to `/tmp/opencues-events-<pid>.jsonl`. One JSON object per line:

```json
{"ts": 1778341567049, "v": 1, "pid": 21748, "body": {"type": "text.changed", "text": "we should ultrathink", "cursor": 0, "source": "user", "previousText": ""}}
```

**Event types** (tagged-union — see `agentic-mode.ts` for the full type):

| Category | Event types |
|---|---|
| Lifecycle | `harness.armed`, `harness.stopped` |
| Inject command flow | `command`, `command.error`, `command.unknown`, `text.injected`, `cursor.injected`, `cleared`, `key.dispatched`, `dump.written` |
| Adapter-observed | `text.changed`, `cursor.changed` |
| Highlight transitions | `highlight.activated`, `highlight.deactivated`, `highlight.word-changed` |
| Agent task | `agent-task.armed`, `agent-task.stopped` |
| Span fill | `span-fill.started`, `span-fill.completed` |
| Selector/satellite | `selector-satellite.started`, `selector-satellite.completed` |
| DynDefs | `dyn-defs.size-changed` |
| Resolver (LLM cues) | `resolver.started`, `resolver.completed` (with text, cleanWords, resultCount, latencyMs) |
| BlankFill | `blank.invoked`, `blank.substituted` (with input/output/altCount/latencyMs) |
| AgentRewrite | `agent-rewrite.round-started`, `agent-rewrite.round-completed` (with applied/dropped/latencyMs) |
| TransformBlank pipeline | `transform-blank.started`, `transform-blank.pass-completed` (P1/P2/P3 with verdict + instruction + per-pass latency), `transform-blank.completed`, `transform-blank.bailed` |
| Custom modules | Any string `<module>.<verb>` — modules call `adapter.emitEvent(type, body)` |

The first three rows are **harness-emitted** (the agentic harness owns
them). The Resolver / BlankFill / AgentRewrite / TransformBlank rows
are **module-emitted** via `adapter.emitEvent` — modules call this at
lifecycle boundaries so the harness sees what the runtime is doing
without parsing log lines. New modules can emit any event type they
like; the harness writes them through to the stream verbatim.

Every event carries `v: 1` (`AGENTIC_EVENT_SCHEMA_VERSION`). Schema bumps on incompatible body-shape changes; new event types can be added freely (consumers tolerate unknown types).

```bash
oc-events $PID                              # full stream
oc-events $PID --type highlight.activated   # filter
oc-events $PID --follow --type text.changed,key.dispatched
oc-events $PID --since $(date +%s%3N)       # only events from now on
```

## Scenario runner

`tests/agentic/scenario-runner.ts` consumes JSON scenario files and
executes their step sequences. Each step is one of:

```jsonc
// Commands (drive the harness)
{"action": "clear"}
{"action": "inject", "text": "the lawyer filed today"}
{"action": "inject", "text": "...", "keepHighlight": true}      // source: runtime
{"action": "cursor", "offset": 14}
{"action": "key", "key": "up", "modifiers": ["ctrl", "alt"]}
{"action": "dump"}                                                // force fresh dump file
{"action": "sleep", "ms": 200}

// Assertions on derived STATE (from /tmp/opencues-status-<pid>.json or dump)
{"action": "waitFor",
 "path": "highlightedWord",
 "equals": "lawyer",
 "timeoutMs": 5000,
 "source": "status"}                           // or "dump" for richer fields
{"action": "expect",
 "path": "alts.1",
 "equals": "attorney"}

// Assertions on EVENTS (from /tmp/opencues-events-<pid>.jsonl) —
// more precise for timing-sensitive paths since events are point-in-time facts.
{"action": "waitForEvent",
 "type": "highlight.activated",
 "path": "word",                              // optional dot-path inside body
 "equals": "ultrathink",
 "timeoutMs": 3000,
 "since": "now"}                              // or "all" or a numeric ts
{"action": "expectEvent",
 "type": "text.changed",
 "path": "text",
 "matches": "Tab"}
```

`path` is dot notation (`alts.1`, `dynDefs.defs.0.word`). Numeric segments
index arrays. `equals` does deep equality; `matches` is a regex against
the stringified value.

**When to use `waitFor` vs `waitForEvent`:**
- **`waitFor`** polls *derived state* (the curated status file or full
  dump). Good for "the system has reached this state" assertions.
- **`waitForEvent`** scans the event stream for *point-in-time facts*
  (a transition fired). Better for "this transition happened" — you
  can prove highlight.activated fired even if the system has since
  moved on (e.g. user typed more text and the highlight cleared).

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

## Reference scenarios

Five scenarios in `tests/agentic/scenarios/` form the always-pass core
suite (5/5 against a clean OC + fresh `~/.cues/` seeded from defaults):

| File | What it exercises |
|---|---|
| `01-basic-cycling.json` | inject → navigate → activate → cycle. Tips alts swap in buffer. |
| `02-clear-on-new-text.json` | new buffer → highlight clears. Navigation owns deactivation on user-source text changes. |
| `03-tip-from-tips-cue.json` | local-lookup tip (no LLM round-trip). `ultrathink` resolves under 1.5 s. |
| `07-event-stream-cycling.json` | Same as 01 but uses `waitForEvent` / `expectEvent`. Demonstrates the event-stream API for state transitions. |
| `08-transform-blank-pipeline.json` | `fix typos _ this is bad righting` → P1 EXTRACT (TRANSFORM verdict), P2 APPLY, P3 VERIFY (OK), final = "this is bad writing". Demonstrates how to assert on **module-emitted events** with verdict + per-pass timings — the canonical pattern for testing LLM-pipeline features. |

Environment-dependent scenarios (network, user-config, runtime-version
specific) live in `tests/agentic/scenarios/_flaky/` — see that folder's
README for status. They aren't part of the green-checks baseline.

## OpenCode as the reference platform

The agentic harness lives in `@opencues/runtime`, so every host
adapter band that calls `buildSharedRuntime` gets it for free. **OpenCode
is the canonical reference implementation** for validating new runtime
features:

- TS + SolidJS + OpenTUI surface — least-friction redeploy via
  `opencues install opencode`.
- Full feature surface (every module, every blank, agent-rewrite, etc.).
- Headless test loop in <5 s (`oc-launch-headless opencode` → drive →
  assert → kill).

When adding a new runtime feature:
1. Add unit tests beside the module (`<module>.test.ts`).
2. Have the module emit one or more structured events at lifecycle
   boundaries via `this.adapter.emitEvent?.('<module>.<verb>', {...})`.
3. Write a scenario in `tests/agentic/scenarios/` that asserts on
   those events. Example:
   ```json
   {"action": "waitForEvent", "type": "your-feature.completed",
    "path": "result", "matches": "expected", "timeoutMs": 5000}
   ```
4. Run `opencues install opencode` to redeploy.
5. `oc-launch-headless opencode` + `scenario-runner --pid $PID
   --scenario your-feature.json -v` — green check or fix.

This is the no-human-in-the-loop development cycle. New features land
with both unit tests AND end-to-end validation through OC; regressions
in either layer block the merge.

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
