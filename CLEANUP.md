# Post-test-arc cleanup

> **When to do this:** after Chrome + OpenCode are fully green on every
> verification phase (1–6), and before extending verification to Claude
> Code. This file gets deleted once the cleanup is done.

The April 2026 simplification + bug-fix arc shipped a lot of useful
fixes but also left scaffolding behind: test fixtures embedded in
production configs, dead-code paths kept for backwards-compat,
historical commentary in code comments that should live in the
architecture doc instead. Walk this list before launch.

---

## Test fixtures embedded in shipped configs

| Item | Where | Decision needed |
|---|---|---|
| `spantest` static tip (`one word`, `two words`, etc.) | `defaults/cues.md` ## Tips block | **Keep but mark.** It's a deterministic span fixture useful for re-verification by anyone who picks up the project later. Wrap with a comment line like `(test fixture — safe to remove for production seed)`, OR move to `defaults/cues/test/cue.md` where it's clearly a folder-isolated fixture. |
| `spantest` static tip | `~/.cues/cues.md` (user-level) | **Local-only — no action.** Not in the repo; lives on Wilfred's machine only. |
| `cues/sync-demo/` folder | `~/.cues/words/sync-demo/` | **Local-only — no action.** Same — left over from earlier sync testing, doesn't ship. |

---

## Dead code from option B + the legacy paths it replaced

| Item | File | Action |
|---|---|---|
| `SpanFillEntry.kind: 'blank-fill' \| 'static-alt'` field | `src/state/span-fill.ts` | The `'static-alt'` path is dead — no current code writes it. Drop the field, drop the `kind: 'blank-fill'` writes (default), drop the `kind === 'static-alt'` branch in `BlankFill.maybePreserveSpanFill` (never fires). ~30 LOC removable. |
| `BlankFill.maybePreserveSpanFill` static-alt branch | `src/modules/blank-fill.ts` | Dead after option B. Remove. |
| `combineWordSources` no-op shim | `src/sources/build-sources.ts` | Kept for "external callers" during migration. Grep the workspace + npm registry — if no callers, delete. |
| Claude Code patch `_dynSpans` hand-rolled span tracking | `integrations/claude-code/patches/{wordHighlight,dynamicHighlight}.ts` | Redundant after option B (DynDefs in shared runtime owns static-alt spans). ~100 LOC delete in the patches; CC then inherits everything from the runtime. **Verify CC tests still pass after.** |
| Legacy `tips.json` references in patches | `integrations/claude-code/patches/{wordHighlight,dynamicHighlight}.ts` lines mentioning `~/.claude/claude-code-tips.json` | Tips moved to `cues.md` ## Tips block. The patches reading the JSON file are pre-runtime-refactor code that may be unreachable; if so, remove. |

---

## Code comments that should live in `docs/architecture/spans-and-cycling.md`

The architecture doc is now the canonical reference. These inline
comments duplicate it and should shrink to one-liners pointing at the
doc:

| File | Sections |
|---|---|
| `src/state/dyn-defs.ts` | The big JSDoc on `pruneStale`, `shiftAfter`, `findSpanContaining` repeats algorithm details that live in the doc. Trim to "see docs/architecture/spans-and-cycling.md § <section>". |
| `src/modules/cycling.ts` | The "Why the order matters" / "Multi-word static-alt spans live in DynDefs..." comments duplicate doc content. Trim. |
| `src/modules/blank-fill.ts` | The `maybePreserveSpanFill` JSDoc — once the static-alt path is removed (above), shrink to a one-liner. |
| `src/modules/resolver.ts` | The four-condition filter comment in `resolveAndApply` is helpful — KEEP this one (close to the code that needs it). Just point at the doc for the WHY. |

Rule: comments explain WHY the local code is shaped the way it is.
Architecture docs explain HOW the system fits together. If a comment
is repeating doc content, prune the comment.

---

## "April 2026" / "post-refactor" / dated commentary

Comments like `// After Apr 2026 (the multi-span refactor) ...` make
sense in the moment but rot fast. Sweep:

```bash
grep -rn "April 2026\|Apr 2026\|post-refactor\|refactor arc\|option B" \
  packages/opencues-runtime/src \
  packages/opencues-core/src \
  integrations/
```

For each hit:
- If it's a load-bearing rationale for the current code: **rewrite** as
  "this is required because <reason>" without the date.
- If it's just historical context: **delete**, the doc + git log have it.

---

## Doc organization tidy-ups

| Doc | Issue |
|---|---|
| `CHECKLIST.md` | Says "After ticking through, this file can be deleted." — do it. The 6-phase chrome verification + the cleanup tracking should ride in the chrome-progress doc + this file, not in CHECKLIST. |
| `integrations/chrome/docs/chrome-extension-progress.md` | Once phases 1–6 are all ✅, collapse the per-phase verification details into a brief "all phases verified 2026-04-XX" block. Detailed history can move to a dated archive section or be left in commit messages. |
| `docs/features/multi-word-spans.md` | Was written assuming the old `_dynSpans` model. After option B it's mostly accurate but has a few `_dynSpans`-specific lines that should reference DynDefs / SpanFillState directly. |
| `CLAUDE.md` § "Re-integration step size" feedback | This was written for the CC re-integration arc which is now mostly done. Either remove or move to `integrations/claude-code/reintegration/`. |

---

## Test consolidation

| Issue | Action |
|---|---|
| `cycling.test.ts` "static-alt multi-word spans" describe block + `cycling.scenarios.test.ts` cover overlapping ground | Move the multi-word-span tests from cycling.test.ts into the scenarios file (more discoverable as scenarios). Keep cycling.test.ts focused on unit-level path tests (single key dispatch, single function behavior). |
| Several test files have rich JSDoc explaining "the bug this fixes" | Keep the brief bug name; move the historical detail to the architecture doc's "Bugs we've fixed" table. |
| `wrapTipsAsCuesMd` helper in `testing/mock-adapter.ts` is great but only documented in tests that use it | Brief usage note in `testing/README.md` (create if missing). |

---

## Cross-host re-verification (after this cleanup)

After everything above is done:

1. Run `pnpm test` from the repo root — must pass.
2. Run the 6-phase chrome verification once more (should be a quick re-pass).
3. Run the equivalent for OpenCode (no formal phase plan yet — basically: install, type, cycle, verify dim/nav/cycling all work).
4. **Then** extend verification to Claude Code per
   `chrome-extension-progress.md` § "Cross-host runtime fixes verified".

---

## Discovery

This file is referenced from:
- `CLAUDE.md` § "Pre-launch cleanup" pointer (add)
- `CHECKLIST.md` (when present)

When everything in this list is done: `git rm CLEANUP.md` + commit
`chore: cleanup arc complete, post-test scaffolding removed`.
