# 12 — Pitfalls and Trade-offs (Cross-Cutting)

A catalog of design pitfalls, trade-offs, and "we chose X over Y because
…" moments from across the codebase. Useful for posts that want to show
that good design is *deliberately giving things up*.

Reach for these when a blog needs concrete "the project considered this
alternative and rejected it" examples — those are gold for design content.

## Non-extension points (deliberately removed)

This is the most concentrated source. From `concept.md`:

- ❌ **Word-cycling without `_`** — "typing 'volume' and pressing Up to
  call a script. **All external state is `_`-gated.**"
- ❌ **Numeric stepping on plain words** — "15.5f" → "16.0f"
- ❌ **Catch-everything default word-cues** — every cue source must
  declare `match:` or `keywords:`
- ❌ **Classifier-routed blanks** — fluid-blank covers the territory; the
  legacy `ClassifiedSourceGroup` was removed entirely

From `openstandard-notes.md`:

- ❌ `opencues.md` as a separate file at user level. Settings consolidated
  into `.opencuesrc`.
- ❌ `blanks.md` as a separate file. Folder-based blanks under
  `blanks/<name>/`.
- ❌ `## Tips`, `## Blanks`, `## Ignore` body sections in cues.md. Frontmatter
  + folders only.
- ❌ `type: tips` / `type: prompt` discriminators. Parser infers from data
  shape.
- ❌ `output-format` / `display mode` settings. Had no consumer.

The pattern: **invention by removal.** Each "no" forces a cleaner shape
elsewhere.

## Architecture trade-offs

### Per-word routing vs combined-prompt

From `CLAUDE.md`:
> Routing per word: highest-priority domain whose match/keyword hits the
> word wins; otherwise highest-priority default; otherwise no cue.

The old design: combine all `### alternatives` source bodies into one
giant LLM call. Replaced because:

> A hijacking prompt in one source can no longer poison every word.
> Sync-demo's "always output bundled, deployed, shipped" used to swap
> `happy → bundled`. With routing, that prompt only affects words its
> source is called for.

Trade-off: more LLM calls (one per source group with hits, in parallel)
but isolation guarantees and predictable per-word source attribution.

### TS-class blanks vs shell scripts

From `docs/features/cue-blanks.md`:
> Why hoist them: chrome can't spawn subprocesses, so the shell-script
> model excluded chrome from these blanks entirely. A TS class lives in
> the runtime that ships with every host — same code, every host.

Trade-off: TS classes are harder to author than a shell script for OS-
bound work, but they portably reach Chrome.

### Always-claim vs heuristic gating (transform-blank)

> We tried a regex/keyword heuristic in `supports()` to avoid extra LLM
> calls. It was brittle (missed "full caps", "fullcaps", `make me a
> website` was wrongly classified). Always claiming + letting EXTRACT
> decide via NONE bail is cleaner — the cost is one extra ~400ms call
> per non-transform `_`.

Trade-off: 400ms per non-transform `_` for cleaner classifier behaviour.

### EDITS vs DECISIONS format (agent-task)

From `docs/architecture/agent-task.md`:
> EDITS won on every dimension: 97-100% pass vs 93-97%, 30% lower latency,
> 5× faster on 200-word docs at 100% recall vs 25%.

DECISIONS preserved for future experiments (opt-in via `promptFormat`
flag) but EDITS is default.

### Single growing prompt vs parallel tasks (agent-task)

> Per the design discussion: ONE prompt that the user can grow. NOT
> multiple parallel tasks.

Trade-off: simplicity (one prompt, no coordination) over expressiveness.
Parallel tasks would create the "task A and task B edit the same word
differently" problem.

### Project overrides content but not settings

From `openstandard-notes.md`:
> Settings are user-level only — projects do **not** override
> `~/.opencuesrc`. Reasoning: cd'ing into a project should not silently
> change whether TTS speaks, whether the spell-checker fires, etc. Those
> are user prefs.

Trade-off: less project portability (can't ship `voice-mode: on` with a
repo) for stronger user-control invariants.

### Chrome user-level only by default

From `CLAUDE.md`:
> Chrome has NO runtime filesystem access, so its "search path" is
> whatever `sync chrome` wrote last. By default that's `~/.cues/`
> only — project dirs are opted in explicitly.
>
> Why this matters — `sync chrome --watch` is a long-running process.
> Under the old cwd-default model, starting the watcher from `~/scratch`
> would bind it to `~/scratch/.cues` forever, silently missing edits in
> the project the user actually cares about.

Trade-off: more setup (explicit `--include`) for fewer "watcher silently
binds to wrong dir" surprises.

## Pitfalls in implementation

### The ownership lock for blank-bound words

From `docs/features/cue-blanks.md`:
> **What goes wrong if you get this wrong:**
> - If LLM can overwrite blank-bound words: The auto-populated volume
>   value (e.g., "64") gets replaced by grammar alternatives ("sixty-four",
>   "numerous"). The position loses its blank behaviour. Cycling no longer
>   changes the actual volume.
> - If user edits can't clear blank-bound words: The position is
>   permanently stuck.

The invariant: **only the user can clear `metadata.blankName`. The LLM
cannot.** This is one of the most important contracts in the runtime —
any new code path that mutates word state has to respect it.

### The hot-reload / write-race

From `CLAUDE.md`:
> Selector/satellite cycling (e.g. `opencues settings` flipping
> `voice-mode: active ↔ inactive`) goes through this sequence:
> 1. `Cycling.cycleSelectorSatellite` → `applyOpenCuesScalar(key, value)` —
>    updates `opencuesState` in-memory **synchronously**.
> 2. `blankInvoke({action: 'set', args: [setting, value]})` — kicks off
>    the host's **async** file/storage write.
> 3. `setText(newText)` fires the host's text-change pipeline →
>    `ConfigLoader.maybeReload`.
>
> **Race**: step 3's reload can fire *before* step 2's async write lands.
> The reload reads the still-stale file, parses the old `opencuesState`,
> and overwrites the in-memory update from step 1.

Fix pattern: `applyOpenCuesScalar` arms `_suppressReloadUntil = Date.now() +
2500`. `maybeReload` short-circuits while inside that window.

This is a great "we discovered this the hard way" story.

### Single-line field parsers should use `[ \t]*` not `\s*`

From transform-blank lessons:
> `\s*` matches newlines, which lets a lazy `.*?` accidentally capture
> the next field's label as the current field's value.

A specific regex bug that mangled VERIFY parsing until fixed.

### Cursor-adjacency mock bug

From agent-task implementation outcomes:
> Experiment 3 caught a benchmark-author bug that masked agent accuracy:
> the mock adapter defaulted `cursorPos` to `text.length`, which falls
> within the last word's `[start, end]` span … Symptom: agent appeared
> to "miss the last item" in 5+ test categories.

The bug was in the test setup, not the production code. Worth mentioning
because it shows how easily benchmark infrastructure can mask real
behaviour.

### Multi-word phrases in keyword matching

From `cue-blanks.md`:
> Multiple occurrences — with `blankKeywords: weather` and
> `blankProximity: 0`:
> - `spanish weather 15°C is warmer than london weather _` — matches
>   (the second `weather` is adjacent to `_`)

The naive implementation would match the *first* "weather" and miss
the user's intent. The keyword nearest the `_` wins.

### 0-byte cues.md self-heal

From `CLAUDE.md`:
> A 0-byte `cues.md` is treated as missing — `OpenCuesSettingsBlank`
> silently no-ops on null/empty content, which would otherwise break
> `opencues ___` / `config ___` blank-fills on every native host.

Defensive: if a write fails partway and leaves a 0-byte file, treat it
as missing. Re-seed.

## Trade-offs with users / authoring

### "Every source must declare match: or keywords:"

Strict rule. From `CLAUDE.md`:
> Every cue source must declare `match:` or `keywords:` (no implicit
> catch-all)

Convenient for safety, surprising for newcomers. The validator surfaces
violations.

### Tip authoring quality

From [`04-inline-cues.md`](04-inline-cues.md):
> Tip authoring quality is the constraint. Bad tips train users to
> ignore the status line. Good tips reward the navigation gesture.

Not strictly a code trade-off, but an authoring one — and the system can't
fix it on the user's behalf.

### No streaming for transform-blank or agent-task

From `docs/architecture/transform-blank.md`:
> Known limits: No streaming. The rewrite arrives all at once after ~1.4s.

Trade-off: simpler implementation, worse perceived latency. Future work.

## The HCI angle

For "What is Invention" / "What is Design" blogs (#6, #7) and "Principles
of HCI" (#18):

1. **Invention is what you remove.** The non-extension-points list is
   the most compressed statement of the system's *taste*.
2. **Design is boundary-setting.** The brand/standard split, the
   ownership lock, the "settings are user-level only" rule — each draws
   a clean line that simplifies everything downstream.
3. **Trade-offs are real, not free choices.** TS-class blanks cost
   authoring complexity for portability. Always-claim costs latency for
   classifier cleanliness. Hot-reload costs poll overhead for restart-
   free editing. The system is honest about what it gives up.
4. **Some pitfalls are only visible in hindsight.** The hot-reload race,
   the regex `\s*` bug, the mock cursor-adjacency bug — these landed
   *as bugs* and are now documented invariants. Good design captures
   the rules from each post-mortem.

## Where this material lives

- `concept.md` — non-extension-points list
- `openstandard-notes.md` § 7 — what's deliberately removed
- `CLAUDE.md` — hot-reload race, 0-byte heal, word-routing rationale
- `docs/architecture/transform-blank.md` § "Lessons learned"
- `docs/architecture/agent-task.md` § "Implementation outcomes" + "Open
  questions — answers"
- `docs/features/cue-blanks.md` § "Ownership Model"

## Quotable lines

- "All external state is `_`-gated. Plain text is LLM-only. Nothing else."
- "The brand is replaceable; the standard isn't."
- "Inference > declaration."
- "Same code, every host."
- "Don't auto-revert — that would be surprising."
- "Only the user can clear `metadata.blankName`."
- "Narrow jobs are easier than wide jobs."
