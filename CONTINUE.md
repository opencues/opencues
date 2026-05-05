# Continue — pick up from here

> **Read this first when resuming.** Snapshot of where the open-standard
> + agent-task work was at the end of the session.

---

## State

- **Branch:** `master` (in main repo at `~/opencues`). Worktree
  `worktree-zesty-strolling-waterfall` is at the same SHA — safe to
  delete when convenient.
- **HEAD:** `a8ee997  fix(agent-loop): translate cursor offset across edit-induced length deltas`
- **Tests:** 720 green (224 `@opencues/core` + 496 `@opencues/runtime`).
- **Forks last reinstalled:** 2026-05-05 21:25 (BEFORE the last two
  agent-loop commits — `e9ba36a`, `a8ee997` — landed). **Reinstall is
  pending** before the cursor-translation fix can be verified live.

```bash
cd ~/opencues
pnpm exec opencues install opencode
pnpm exec opencues install claude-code
```

Verify the new code shipped:

```bash
grep "isOwnedByOtherSource" ~/opencode-cues/node_modules/@opencues/runtime/dist/src/modules/agent-loop.js
grep "translated" ~/opencode-cues/node_modules/@opencues/runtime/dist/src/modules/agent-loop.js
```

Both should hit. Silent = install pulled from the wrong source tree.

---

## What this session shipped (13 commits since `1e4389a`)

```
a8ee997  agent-loop: cursor offset translation across edit-induced length deltas
e9ba36a  agent-loop: only exclude DynDefs from active substitutions
8fe3b3a  docs: second-pass historical-baggage cleanup (CLAUDE.md, FAQ.md, defaults/blanks/*.md)
479a09e  docs: drop historical/experiment baggage from user-facing docs
d1e64d2  docs: refresh transform-blank + blank-fill docs against current code
b6a63fe  refactor(blanks): adopt CUE.md / BLANK.md per spec, with auto-migration
5975bf4  feat(spec): publish open standard for CUE.md and BLANK.md
1e4389a  chore: retire codex integration (came in via prior merge)
073636f  perf(agent-task): EDITS format wins A/B + new benchmark suites
725ae2a  docs(blog): stage HCI blog series
7fd91ef  fix(agent-task): "missed last item" — was a test setup bug
73d4351  test(agent-task): expand benchmark to 70 cases + apply-side fix
ab29a5d  feat(agent-task): benchmark harness + reinstall both hosts
6c63d2c  feat(agent-task): v1 continuously-running agent loop
a205686  docs(architecture): plan for the agent-task feature
```

Three thematic streams:

1. **Agent-task implementation** (a205686 → 073636f) — design, v1 loop,
   benchmark harness, 70-case suite, EDITS-format A/B.
2. **Open standard** (5975bf4, b6a63fe) — `spec/` published; per-source
   files renamed `cue.md` → `CUE.md`, `blank.md` → `BLANK.md`;
   seed-configs HEAL phase auto-migrates legacy filenames.
3. **Polish** (d1e64d2, 479a09e, 8fe3b3a) — docs synced to current code,
   historical/experiment baggage stripped from user-facing pages.
4. **Agent-loop hardening** (e9ba36a, a8ee997) — the two fixes from
   late-session live testing.

---

## What's verified

- ✅ All 720 unit tests pass.
- ✅ Spec docs at `spec/` (cue-spec, blank-spec, core, opencues-runtime,
  README, JSON schemas).
- ✅ HEAL migration: legacy `cue.md`/`blank.md` in `~/.cues/blanks/<name>/`
  rename to `BLANK.md` on next `seed-configs` run; idempotent.
- ✅ User's `~/.cues/blanks/{volume,brightness,opencues}/` migrated.
- ✅ `volume _`, `brightness _`, `hn _` work after first reinstall.
- ✅ Transform-blank pipeline observed end-to-end in CC log
  (`resignation letter _` generative branch, `change email signoff to be japanese _`
   3-pass).
- ✅ Agent-loop firing in OC log with task-id-keyed cache, edits applied
  as DynDefs.

## What's NOT verified yet (pending second reinstall)

- ❌ **Cursor translation** — the `pushText` argument now adjusts for
  edit-induced length deltas. Last observed crash was OC's TextInput
  resetting cursor to 0 when the runtime passed an out-of-bounds offset.
  After reinstall, retest the agent on text where edits shrink length
  near the end (`witth` → `with` at end of line, cursor right after).
- ❌ **Candidate-set widening** — agent now overrides passive cue
  DynDefs (SpellingSource, word-cues, tip groups). Active substitutions
  (BlankFill, transform-blank, fluid-blank, agent's own current task)
  still excluded. Retest with `spelling-mode: on` AND
  `agentically correct spelling _` — agent should now auto-fix typos
  instead of being silently neutered.

---

## Test sequence after reinstall

1. **Sanity:** `volume _` → `XX%` (not `m³`). Confirms keyword-bound
   blanks fire.
2. **Agent v1:** `agentically correct spelling _ I rite some text witth typos`
   → both typos dim and replace within ~500ms.
3. **Cursor stays put:** in step 2, type a character at the end
   immediately after the agent fires. It should land where you typed.
   Watch for `[translated N→M]` in `/tmp/opencues.log` lines that say
   `AgentLoop: buffer mutated`.
4. **Cursor-adjacent protection:** park cursor inside one of the
   typos before settling. That word should stay literal until you
   move the cursor.
5. **Agent vs SpellingSource:** keep `spelling-mode: on`. Try the same
   prompt — agent should now own + auto-fix instead of deferring.
6. **Compose:** `add task make it formal _`, `current task _`,
   `stop task _`.
7. **Long doc:** ~50-word paragraph with typos under
   `agentically catch all spelling errors _`. Should land within ~2s.
8. **Folder blanks:** `brightness _`, `opencues debug-mode _`.

---

## Open follow-ups

- **Defense-in-depth at the OC host's `setCursor`** — current
  `prompt/index.tsx:1187` is `setCursor: (c) => { input.cursorOffset = c }`
  with no validation. When `c > textLength`, OpenTUI's TextInput
  invalidates `cursorOffset`, the getter's `?? 0` fallback returns 0,
  cursor jumps to start. Patch: clamp on assign:
  `setCursor: (c) => { input.cursorOffset = Math.min(Math.max(c, 0), input.textLength ?? 0) }`.
  Not urgent — the runtime's cursor-translation fix prevents
  out-of-bounds offsets in the first place. Land if you want
  belt-and-braces.
- **Tier-3 spec polish not yet done** —
  - JSON-schema-validated test fixtures
  - "Self-test checklist for `match:` regexes" — spec describes the
    discipline; an actual `opencues validate --match-test "<text>"`
    command is not implemented yet.
  - Static + LLM hybrid example in the wild — spec describes; no real
    `defaults/cues/` source uses both today.
- **`docs/features/agent-task.md`** — could gain a section on the
  cursor-translation behavior (currently lives in `docs/architecture/agent-task.md`).
  Decide whether users care.
- **Worktree cleanup** — when convenient:
  ```
  cd ~/opencues
  git worktree remove .claude/worktrees/zesty-strolling-waterfall
  git branch -d worktree-zesty-strolling-waterfall
  ```

---

## Where to read more

- `spec/README.md` — open standard entry point
- `docs/architecture/agent-task.md` — agent-task implementation reference
  (now includes the cursor-translation rule)
- `docs/architecture/transform-blank.md` — transform-blank pipeline reference
- `docs/features/agent-task.md` — user-facing usage
- `docs/features/transform-blank.md` — user-facing usage
- `tests/benchmarks/agent-task/EXPERIMENTS.md` — the benchmark journey
- `/tmp/opencues.log` — runtime debug log (with new `cursor=N@wordM` and
  `buffer mutated` AgentLoop lines once reinstalled)
- `/tmp/opencues-cursor-trace.log` — OC-side cursor-trace
  (notifyCursorChange / pushText:in/out / getCursorOffset)
