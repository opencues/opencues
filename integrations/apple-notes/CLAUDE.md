# CLAUDE.md — Apple Notes integration

`@opencues/apple-notes` — a Node daemon that hosts the OpenCues runtime
against Notes.app via JXA polling. Self-owned host (like shell): no
upstream fork, no patching. macOS-only.

## Architecture

```
opencues run apple-notes
  └─ node integrations/apple-notes/dist/daemon.js
       ├─ NotesBridge (src/notes-bridge.ts) — osascript spawns of jxa/*.js
       ├─ tick.ts — PURE poll state machine (echo suppression, active-note
       │            selection, adaptive cadence, skip guards, line diff)
       ├─ host-support.ts — blanks registry + sandboxed spawnProcess
       │            (adapted from integrations/shell/src/bootstrap.ts)
       └─ boot() from @opencues/runtime/dist/adapters/universal/v1/boot
            (shared universal/no-cycling band; hostName: 'apple-notes')
```

Key invariants (all pinned by tests in `src/tick.test.ts` +
`adapters/apple-notes/v1/html-text.test.ts`):

- **Echo suppression is hash-based** (AN-4): `state.lastWriteHash` maps
  note id → sha256 of the plaintext we expect after our own CAS fill; a
  poll delivering matching content fires `source:'runtime'` (the
  resolver ignores non-user changes), and the note STAYS tracked even
  though its marker is gone. modificationDate can't do this (1s
  resolution + our own write bumps it).
- **Write path is splice-only + CAS**: daemon reads plaintext+body,
  verifies plaintext still equals the resolution snapshot, computes the
  new body with `spliceLinesIntoBody` (aborts on 0/>1 matches — NEVER
  rebuilds a body from plaintext), then `jxa/fill-note.js` re-reads and
  byte-compares body before writing, all inside one osascript call.
- **Active-note switches call `resetBufferState()`** — spans tracked
  against the previous note are meaningless (same contract as shell's
  keep-alive pane, see universal-integration.md § reset triggers).
- **Attachment guard**: `bodyLooksAttachmentBearing` → skip + untrack.
  A body set destroys attachments; verified during the Phase 0 spike.
- **Startup baseline** (`seedBaseline`): the first enumeration is
  recorded WITHOUT acting on it — pre-existing notes containing `_` are
  not retro-edited at daemon launch (observed live before the fix: a
  boot-time fill was attempted against a weeks-old project note). A
  stale cue becomes eligible the moment its note is edited again.
- **Virtual buffer + short-fuse flush** (daemon.ts + tick.ts
  flushDelayMs): runtime writes (blank-loading frames every ~150ms via
  setText, real commits via pushText/setText) land in an in-memory
  buffer served back through getText; flushes fire on a 50ms settle /
  150ms max-wait so the STANDARD OpenCues loading animation reaches
  the note at frame cadence (user requirement 2026-07-06: animation
  always, same as every other host). Flushes are strictly serialized —
  one CAS in flight, latest frame wins — so the effective write rate
  self-throttles to the osascript round-trip (~3-6fps) and the queue
  can never back up. The guards that make per-frame writing safe (and
  whose ABSENCE corrupted a fill in an early build): every write is a
  splice-only CAS against a fresh body read, `lastWriteHash` echo
  classification keeps frame-bearing polls tracked, and a
  `user`-sourced poll event drops the virtual buffer (their edit wins)
  while our own echo does not. Do NOT re-suppress frames to "optimize"
  — the animation is a product requirement; the cost is bounded by the
  serialized CAS chain.
- **FSEvents wake** (daemon.ts `sleepOrWake`): any file event in Notes'
  group container (`~/Library/Group Containers/group.com.apple.notes`)
  short-circuits the poll sleep for an immediate tick. Every note write
  — user autosave, iCloud sync, our own CAS fill — rewrites the
  indexer-state files within ~1ms, while our own osascript READS fire
  nothing (measured 2026-07-08), so polls can't self-wake. Detection
  lag collapses from up-to-POLL_IDLE_MS to ~enumeration+fetch cost; the
  timer cadence in tick.ts remains the ground-truth fallback (a dead
  watcher degrades to timer-only polling, never breaks correctness).
- **Render-phase lag logging** (daemon.ts): every `fill landed` line
  carries settleMs/queueMs/readMs/spliceMs/casMs/totalMs, and `fill
  echo observed` carries echoMs — same key=value Ms style as the
  resolver's totalMs= lines on the other hosts.

## Iteration loop

```bash
pnpm --filter @opencues/runtime build          # after band changes
pnpm --filter @opencues/apple-notes build      # after daemon changes
node integrations/apple-notes/dist/daemon.js   # run directly
# or: opencues run apple-notes — self-heals on @opencues/{core,runtime}
# src drift ONLY. The daemon's own src/ and the adapter band are OUTSIDE
# srcHash (BUNDLED_SOURCE_DIRS is a single global hash — adding them
# would rebuild every other host on daemon-only edits), so after editing
# tick.ts/daemon.ts, adapters/universal/v1/*, or the Notes-specific
# adapters/apple-notes/v1/html-text.ts you MUST run the
# builds above yourself; `opencues run` will happily launch stale dist.
```

Tests: `pnpm --filter @opencues/apple-notes test` (pure logic — no
osascript in CI) and `npx vitest run adapters/universal adapters/apple-notes` in
packages/opencues-runtime (band + html-text).

Spike tooling: `scripts/spike.mjs` measures real Notes round-trips;
`scripts/spike.mjs --cleanup` removes the "OpenCues Spike" folder.

## Debugging

- `tail -f /tmp/opencues.log | grep '\[apple-notes\]'`
- `DEBUG_OPENCUES=1` for debug-level lines to stderr.
- `OPENCUES_BRIDGE=1` enables the event bridge (same protocol as shell).
- Permission state: `opencues doctor` → Apple Notes section. The -1743
  silent-deny trap is documented in NOTES-PLATFORM.md § TCC.

## Manual e2e checklist (run after daemon/band changes)

1. **Permission flow**: `tccutil reset AppleEvents com.apple.Terminal` →
   `opencues install apple-notes` → prompt appears at install; deny →
   installer prints the fix path and `opencues doctor` shows a warn row;
   grant via System Settings → doctor green.
2. **Happy path**: `opencues run apple-notes`; type
   `distance to the moon in km _` in any unlocked note → the line is
   replaced within poll+LLM latency; formatting elsewhere untouched.
3. **Echo suppression**: `/tmp/opencues.log` shows exactly ONE
   resolution per query (no second fire when the fill echoes back).
4. **Guards**: note with an image + a cue → skipped with a warn line;
   locked note → invisible, no crash; delete the note mid-fill → no
   crash, tracking entry dropped.
5. **Pause**: quit Notes while the daemon runs → polling pauses and
   Notes does NOT relaunch; reopen Notes → resumes. (Sole exception:
   the wedge auto-restart, notes.md row 26 — the daemon quits and
   reopens a RUNNING Notes after ≥2 bridge timeouts in 60s, gated by a
   5-min cooldown and 2s FSEvents quiescence. A user-quit Notes is
   never relaunched: the restart path checks `pgrep -qx Notes` first.)
6. **iCloud conflict**: edit the same note on another device during a
   pending fill → fill dropped (CAS conflict logged), no corruption.
7. **Self-heal**: edit any file under packages/opencues-runtime/src,
   re-run `opencues run apple-notes` → one rebuild line, then silent on
   the next run.
