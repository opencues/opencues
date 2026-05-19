# Claude Code adapter — repair & version-bump guide

When `claude-cues` ships a new version and the v2 patch breaks, this is the
playbook. Read top-to-bottom the first time; after that, jump to the
scenario that matches your symptom.

> **The runtime package is intentionally never in this loop.** If you find
> yourself editing `packages/opencues-runtime/src/**` or
> `packages/opencues-runtime/src/render-directives.ts` to fix a CC version
> bump, stop and ask why. Those modules don't know what host they're
> running in. Repairs live in the adapter band only.

---

## Host quirks (Claude Code v2.1) — read this before debugging anything

Quirks surfaced during live testing. These shape several non-obvious
decisions in `boot.ts` and the patch.

### 1. `bindings.getText` / `bindings.getCursorOffset` are stale closures

The patch supplies these as `function() { return m.text; }` where `m` is
the `InputZone` local in the `InputStateHandler` (Dy8) closure. Each
React re-render produces a NEW `Dy8` invocation with a NEW `m`. The
callback we passed to `boot()` was created during the very first
invocation — it forever points at that long-gone `m`.

**Consequence:** `host.getText()` returns whatever was on screen at boot
time — typically empty or one-character.

**Mitigation in v2 boot.ts (commit `e5d26f3`):** the boot
keeps a `lastSeenText` / `lastSeenCursor` pair that's updated on every
dispatch + render via `checkTextDrift`. `bindings.getText` /
`bindings.getCursorOffset` now route through these freshness-tracked
locals, falling back to the host closure only before the first
observation.

So `adapter.getText()` IS reliable for code paths that run after at
least one dispatch — which means **all async paths** (Resolver,
BlankFill async fill, Statusline) get fresh text.

The old guidance (pass text/cursor as args to `dispatchKey` /
`consumePendingRender` / `applyRender`) still applies for the
dispatch-time path because `lastSeenText` lags by one event there.

`setCursorOffset` STILL doesn't clamp via getText (it can't easily reach
boot's locals from the adapter), so callers clamp themselves.

### 2. `m.render(...)` output may diverge from `m.text`

`renderedValue` is `m.render(X,H,M,j6,G)`. It produces the visible
string for the terminal. That visible string is NOT always equal to
`m.text` (the underlying buffer): the host can pad, insert a cursor
character, wrap by columns, etc.

**Convention:** `applyRender` derives `ctx.text` from
`rendered.replace(/\x1b\[[0-9;]*m/g, '')` — the visible content of the
rendered string itself. That guarantees `DimRender`'s positions and
`applyDirectives`'s ANSI insertions live in the same coordinate space.

### 3. The TUI swallows stderr — log to a file

Claude Code's Ink renderer captures stdout/stderr to compose the screen.
`console.error` calls written from the bootstrap won't show up where you
expect. The patch's `log` callback writes to `/tmp/opencues.log` via
`fs.appendFileSync` (synchronous so a crash doesn't lose the trail).

**To capture debug output:**
```bash
DEBUG_OPENCUES=1 claude-cues          # interactive, no redirect
# in another shell:
tail -f /tmp/opencues.log
```

Don't try to redirect `2>` from an interactive TUI session — the events
either don't make it through or corrupt the screen.

### 4. The statusLine command only re-runs on host-driven events, not input changes

CC's `statusLine` config triggers a re-run on tool calls, permission changes,
or whatever the React useEffect dependency array picks up. **Input-box state
changes (typing, navigating, cycling) do NOT trigger a re-run** by default.
So if a v2 module updates its export file but the user only typed/navigated,
the status line would stay stale until the next tool call.

**v2 fix (current):** S6 seam captures CC's debounced refresh
callback (`k=F$.useCallback(()=>{...setTimeout(...,300,Z,V)...},[V])`) and
exposes it as `globalThis.__oc_refreshHostStatusline`. The patch's host
bindings include a `refreshStatusline` closure that calls it. `Statusline`
calls `refreshHook` after each successful `writeFile`, so the status line
re-renders within ~300ms of any state change. No polling.

S6 injection uses comma-operator-in-let to preserve the original
declaration verbatim:
```
,k=F$.useCallback(...)        →   ,k=F$.useCallback(...),__oc_ts6=(globalThis.__oc_refreshHostStatusline=k)
```

**Fallback (when S6 misses):** S6 is OPTIONAL in the patch — a missing
match logs a warning and continues. Statusline still works as long as
the user adds `refreshInterval: 1` (or any value) to settings.json:
```json
{
  "statusLine": {
    "type": "command",
    "command": "/home/<user>/.claude/highlight-statusline.sh",
    "refreshInterval": 1
  }
}
```
This polls the script every second instead of event-driven. Simple
fallback for any future CC version where the S6 shape drifts.

**Apply order matters** when adding new seams: S1, S3, S6 all inject at
different positions in cli.js. The patch applies them in descending
position order (S6 → S3 → S1 for v2.1.110) so each application leaves
earlier indices valid. If you add S4 / S5 / S7 / S8, slot them into the
same descending sort.

### 5. Async modules need `pushText` (commit `e5d26f3`)

`adapter.setText` only stores `pendingText`; it surfaces on the next
`consumePendingRender` (called from the dispatch path). For async
flows — `BlankFill`'s `blankScript get` results, future `Resolver`
post-processing — there's no upcoming dispatch. The pending text would
just sit there until the user happens to press another key.

Solution: optional `HostAdapter.pushText(text, cursor?)`. The v2.1
patch implements it by calling the captured `onChange` /
`onOffsetChange` props directly — same mechanism as v1's
`globalThis._forceInputRefresh`. Per-dispatch reassignment of
`globalThis.__oc_pushHostText` keeps the captured callbacks fresh.

The text is suffixed with a ZWS toggle so React's value-equality dedup
doesn't suppress the re-render.

Modules check `if (this.adapter.pushText) ...` and fall back to
`setText + forceRender` otherwise — works on hosts where async push
isn't supported, just delayed by one keystroke.

### 6. `spawnProcess` `stdio` defaults block stdout (commit `e5d26f3`)

The first version of the patch's `spawnProcess` used
`stdio: "ignore"` for ALL spawns. Detached fire-and-forget (TTS) is
fine with that, but anything that needs stdout (BlankFill async
fills) saw `stdout: ""` on every result.

Fix: the patch now uses `["ignore", "pipe", "pipe"]` for non-detached
spawns and wires `stdout`/`stderr` `'data'` listeners + a setTimeout-
backed timeout. Detached spawns keep `stdio: "ignore"`.

If TTS or any other detached caller starts mysteriously hanging,
double-check that `spec.detached` is making it through — the stdio
mode hinges on it.

### 7. Overlapping dim ranges need coalescing in `applyDirectives`

Multiple sources can produce dim ranges for the same render: cue/control
words get individual dims, and the consume-all span gets a single
contiguous dim covering the whole prompt-improver fill. When the
two overlap (a cue word inside a consume-all span), naive insertion of
`DIM_ON`/`DIM_OFF` boundaries emits a premature `DIM_OFF` at the inner
range's end, leaving the rest of the outer range visually undimmed.

Fix: `applyDirectives` now sorts and merges overlapping/adjacent dim
ranges before generating insertion points. The same pattern would apply
to highlight ranges if we ever start producing multiple, but DimRender
currently emits at most one highlight per render.

Symptom if the merge regresses: prompt-improver dim looks "patchy" —
the active highlighted word stays bright (correct) but other random
chunks revert to undimmed at exactly the positions where cue words
appear inside the fill.

### 8. `pushText` callers need to update `lastSeenText` themselves

Surfaced while wiring selector/satellite cycling. `bindings.setText` records its
argument in `pendingText`; `consumePendingRender` then drains it and
sets `lastSeenText` so the next `applyRender → checkTextDrift` sees no
diff and doesn't fire a 'user' textChange.

`bindings.pushText` is a different path — it calls the host's
`__oc_pushHostText` directly (which calls onChange + ZWS-toggles).
There's no pendingText cycle, so checkTextDrift sees the new text
differs from lastSeenText, finds pendingText is null, and fires a
`source: 'user'` event. Navigation's onTextChange handler then
deactivates the highlight (it interprets unsolicited text changes as
typing).

Symptom: when an async runtime path uses `pushText` (e.g. selector
script-get callback updating the satellite), the highlight gets killed
right after the update lands. User sees the highlight flash off.

Fix: boot's `bindings.pushText` wraps the host call to update
`lastSeenText` (and `lastSeenCursor` when given) BEFORE invoking the
host. Then checkTextDrift sees a match → no event → highlight stays.

If you reintroduce a direct `pushText: host.pushText` shortcut in
boot.ts, expect this regression. The wrap is small but load-bearing.

### 9. Don't stack `\x1b[7m` (inverse) with `\x1b[2m` (dim) on the same chars

Surfaced while wiring multi-word span fills with dismissal. When a multi-word span fill is active
and the highlight covers the whole span, the natural temptation is to
ALSO emit a dim layer for the same range "for clarity." Some terminals
render dim-on-inverse with reduced contrast (almost invisible), others
render it with the dim showing through the inverse — neither is what
users expect.

DimRender suppresses the span dim layer when the active word is inside
the span (the inverse highlight is already covering it as one block).
If you re-introduce a dim layer there, expect inconsistent appearance
across terminals. If a future feature genuinely needs both attributes
on the same chars, test on at least: tmux + xterm, gnome-terminal,
iTerm2.

### 10. Sibling controls sharing a suffix need DynDef attribution

Volume + brightness both produce `<num>%` text after blank fill. A
naive global stepPattern keyed on `^\d+%$` routes ambiguously — first
matching control wins, so cycling `50%` from `volume _` could end up
calling `brightness-blank.sh set`.

Fix: BlankFill registers a DynDef carrying `controlName` for any
numeric+suffix fill. Cycling checks the DynDef BEFORE
matchStepPattern (path 3a) so the originating control is always
preferred over the regex match. Without the DynDef path,
volume/brightness will silently cross-fire as soon as both are filled
in the same input.

Resolver also skips DynDefs with controlName so LLM alts don't
clobber the attribution.

### 11. Script-backed control values: debounce + post-spawn refetch

Cycling a script-backed control (volume, brightness) faces two
problems: holding Up issues a key dispatch per repeat (each would
spawn the script), and `script up` doesn't echo the new value — we
have to call `script get` separately to refresh the statusline.

Pattern (mirrors v1 the original CC patch):

1. 50ms debounce on the up/down spawn — coalesces a held key into one
   write.
2. After the spawn, schedule another 200ms timer.
3. The 200ms timer fires `script get`, awaits stdout, writes to
   ControlValuesCache, then calls `forceRender()` so Statusline picks
   up the new value.

The 200ms wait is the cost of the script's OS-side settle time
(documented in volume.sh / brightness.sh). We tried optimistic update
+ reconcile but the user found the predicted value misleading when
the OS clamped (e.g. capped at 100%); waiting for the real value is
correct.

ControlValuesCache also keeps stale values visible (instead of
deleting on invalidate) so the statusline doesn't flash to the
static cueMap default in the gap between cycle and refetch.

### 12. `script get` is the source of truth for the statusline tip

Volume / brightness have a `script` (e.g. volume.sh) and a separate
`blankScript` (e.g. volume-blank.sh). Their `get` commands return
DIFFERENT shapes:

- `volume.sh get` → `volume: 50%` — formatted statusline text.
- `volume-blank.sh get` → `50` — bare number for blank fill.

Statusline must use the formatted output from `script get` (NOT
blankScript), or it would have to know the format string per control.
Cycling for the script-backed word case reads from `script`;
BlankFill reads from `blankScript`.

### 13. The host may keep the `value` prop in lock-step with our InputZone

Returning `InputZone.fromText(newText, P, cursor)` from the
`handleKeyDown` causes the host to re-render `Dy8` with `value=newText`.
We rely on this — `Cycling`'s text replacement propagates because the
InputZone we return becomes the next `value`. If a future CC version
breaks this assumption, cycling will visually flash but revert to the
previous text. Look for this if cycling stops persisting.

---

## Architecture in one paragraph

The `tweakcc` patch (`integrations/claude-code/patches/opencuesRuntime.ts`)
is the **only** file that knows Claude Code internals. It finds 3 seams in
the minified `cli.js` and injects two anchors: one bootstrap at the
key-dispatcher, one wrapper around the rendered-value expression. The
bootstrap calls a single function — `boot()` exported from
`adapters/cc/<VERSION>/boot.js` — passing in tiny callbacks that
read host state. Everything else (adapter construction, module wiring,
state, rendering, ANSI work) lives in the runtime and is host-agnostic.

```
tweakcc patch  ──require──▶  boot.js  ──uses──▶  Runtime modules
(host-specific)              (per-version       (never touched per
                              host wiring)      version bump)
```

---

## The 3 seams

| ID  | Targets behaviour                          | Captures                                                   | Why we need it                                                                  |
| --- | ------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| S1  | The key-dispatcher function (`switch(ev.key)`) | `funcName`, `eventParam`, `keyParam`                       | Inject the bootstrap before the switch, returning rebuilt InputZone on consume. |
| S2  | The input-state handler React component    | `inputZoneVar`, `inputZoneClass`, `columnsVar`, ...        | Patch needs `InputZone.fromText(...)` to force a re-render after navigation.   |
| S3  | The `renderedValue:` expression in the return object | The full expression text (e.g. `m.render(X,H,M,j6,G)`) | Wrap it with `applyRender(...)` to paint highlights on top of host output.     |

Source of truth for the seam predicates:
`packages/opencues-runtime/adapters/cc/v2.1/seams.ts`. The patch
inlines a vendored copy — keep both in sync.

---

## Diagnostic flow

When a v2 install fails or behaves wrong:

1. **Apply with stderr captured:**
   ```bash
   TWEAKCC_CC_INSTALLATION_PATH=$(find ~/claude-code-cues -name cli.js | head -1) \
     node ~/opencues/integrations/claude-code/tweakcc/dist/index.mjs --apply 2>&1 | tee /tmp/apply.log
   ```
2. **Look for the "FAILED to find N critical seam(s)" message.** It names
   exactly which seams missed. If none missed but the install still
   misbehaves, jump to the runtime-side log:
   ```bash
   DEBUG_OPENCUES=1 claude-cues 2>/tmp/cc.err
   ```
   Then `tail /tmp/cc.err`. Look for `[opencues] boot failed:` or
   `[opencues] dispatch error:`.
3. **For seam misses**, open `cli.js` and `grep` for the **behaviour** the
   seam targets (e.g. `case"escape":` for S1) — not the captured
   identifier names, which are minified per build.
4. **Update the regex** in both
   `packages/opencues-runtime/adapters/cc/<VERSION>/seams.ts` and
   the inlined copy in
   `integrations/claude-code/patches/opencuesRuntime.ts`. Run
   `npx vitest run adapters/cc/<VERSION>/seams.test.ts` to verify.
5. **Re-apply, restart claude-cues, retest.**

---

## Scenarios in increasing difficulty

### 1. Pure identifier rename — most patch bumps

**Symptom:** None. Apply succeeds.

**Why:** All seam regexes use `[$\w]+` wildcards on identifier names.
Minifier-driven renames (`t` → `q`, `O6` → `A1`) don't break us.

**Action:** Nothing.

**Time:** 0.

---

### 2. Argument count shift on a captured call

**Symptom:** `S3 RenderedValue` misses, or one specific render arity stops
matching.

**Why:** `renderedValue:m.render(...)` gained or lost an arg. We pre-cover
3/4/5-arg in the regex; new arities aren't covered.

**Action:** Add one regex variant in `seams.ts` and the patch:

```ts
const RV_6 = /renderedValue:([$\w]+)\.render\(([$\w]+,[$\w]+,[$\w]+,[$\w]+,[$\w]+,[$\w]+)\)/;
// then add it to the for-loop trying patterns
```

Add a test fixture too. Verify with `vitest`.

**Time:** 5 min.

---

### 3. One seam's surrounding structure changed

**Symptom:** Installer reports `FAILED to find 1 critical seam(s): SX`.
Same shape conceptually, different syntax.

Example: `switch(ev.key){case"escape":...}` becomes
`if(ev.key==="escape"){...}`.

**Action:**
1. Read the current shape in `cli.js` near the behaviour (the install log
   tells you which seam missed).
2. Rewrite the regex in `seams.ts` and the inlined patch copy.
3. Make sure the test fixture in `seams.test.ts` reflects both the old and
   new shape (so the test serves as a record of what's been seen).

If the seam's *bindings* changed (e.g., the captured expression has a
different shape), update `boot.ts` or the patch's substitution sites
accordingly. Most of the time only the regex changes.

**Time:** 15-30 min.

---

### 4. Method renamed on a captured object

**Symptom:** v2 applies cleanly but at runtime, the host crashes with a
`TypeError: <something>.fromText is not a function`. Or navigation no
longer triggers a visible re-render.

Example: `InputZone.fromText` becomes `InputZone.create`.

**Action:** One-line edit in `opencuesRuntime.ts` where the patch builds
the rebuilt InputZone:

```ts
`try{return ${izClass}.fromText(...);}` → `try{return ${izClass}.create(...);}`
```

Seam S2 still captures `inputZoneClass` correctly — only the method name
on it shifted.

**Time:** 5 min.

---

### 5. Captured object's whole API replaced

**Symptom:** S2 still matches the React component shape, but the locals
inside no longer follow `InputZone(...)` semantics. Maybe Ink ditched the
class for a hooks-based string state, or the `.text`/`.offset` field
names changed to something like `.value`/`.cursor`.

**Action:** Two things move:
- The `getText` / `getCursorOffset` closures in the patch's S1 bootstrap
  read from the new shape (they're 1-line lambdas).
- The `toggleRenderText` callsite in the patch (where it builds the
  re-render InputZone) adapts to whatever now stands in for InputZone.

If S2's capture set needs new names, extend `findInputStateHandler` in
`seams.ts` and the patch copy. `boot.ts` itself is **unchanged** — it
asks the host for "current text" and "force re-render," it doesn't care
how the host gets there.

**Time:** 1-2 hrs depending on how alien the new API is.

---

### 6. Whole new CC major (architectural shift)

**Symptom:** Every seam misses. Maybe `cli.js` doesn't even use React
anymore.

**Action:** New adapter band. Copy the existing band:
```
cp -r packages/opencues-runtime/adapters/cc/v2.1 \
      packages/opencues-runtime/adapters/cc/v3.0
```
Then rewrite each file against the new shape. The runtime modules
(`Navigation`, `DimRender`, `applyDirectives`) and state classes stay
**untouched** — they become your proof-of-life as you wire the new
adapter.

Update `version-compatibility` in `refactor.md` §11.3 to record which
adapter band targets which CC versions.

**Time:** A focused weekend.

---

## What's never in this loop

You should not need to read or edit these when bumping CC versions:

- `packages/opencues-runtime/src/runtime.ts`
- `packages/opencues-runtime/src/modules/navigation.ts`
- `packages/opencues-runtime/src/modules/dim-render.ts`
- `packages/opencues-runtime/src/render-directives.ts`
- `packages/opencues-runtime/src/state/*`
- `packages/opencues-runtime/src/adapter.ts` (the HostAdapter contract)

If your fix touches any of these, pause: you're either
(a) genuinely changing host-agnostic behaviour and the version bump was
just the trigger, or (b) reaching for the wrong abstraction — push the
change down into the adapter or boot.ts instead.

---

## Quick reference — files involved per repair

| Repair                             | Edit                                                                                                                       | Test                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Argument count                     | `seams.ts` + `opencuesRuntime.ts` (regex list)                                                                              | `seams.test.ts`                               |
| Seam shape change                  | `seams.ts` + `opencuesRuntime.ts` (regex)                                                                                   | `seams.test.ts`                               |
| Method rename on captured object   | `opencuesRuntime.ts` (substitution)                                                                                         | live install                                  |
| Captured object's API replaced     | `opencuesRuntime.ts` (closures) + maybe `seams.ts` (extend captures)                                                        | `seams.test.ts` + live install                |
| New CC major version               | New `adapters/cc/<version>/` band: `seams.ts`, `boot.ts`, mirror inlined regex into `opencuesRuntime.ts`           | full `vitest run` + live install              |

---

## When in doubt

- The runtime's tests run in milliseconds — `npm test` from
  `packages/opencues-runtime/` validates that you haven't broken anything
  host-agnostic while changing the adapter.
- Every seam has a test fixture in `seams.test.ts` showing the canonical
  shape. When you change a regex, **add the new shape to the fixture
  alongside the old one** — the test file becomes a record of what
  Claude Code's done over time, and lets you spot regressions if a regex
  becomes overly permissive.
- The patch's fail-loud installer message is your first line of feedback.
  If you ever find yourself debugging silently-misbehaving cli.js code,
  add a `console.error` to the patch's bootstrap — the v2 design assumes
  you'd rather see the error than swallow it.
