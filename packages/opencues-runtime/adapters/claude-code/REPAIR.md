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

Lessons learned the hard way during Phase 1–3 live testing. These shape
several non-obvious decisions in `boot.ts` and the patch.

### 1. `bindings.getText` / `bindings.getCursorOffset` are stale closures

The patch supplies these as `function() { return m.text; }` where `m` is
the `InputZone` local in the `InputStateHandler` (Dy8) closure. Each
React re-render produces a NEW `Dy8` invocation with a NEW `m`. The
callback we passed to `boot()` was created during the very first
invocation — it forever points at that long-gone `m`.

**Consequence:** the runtime cannot read the live host text via these
bindings. In practice they return whatever was on screen at boot time —
typically empty or one-character.

**Convention:**
- `consumePendingRender(currentText, currentCursor)` takes them as args.
  The patch reads them at the dispatch site (e.g. `${iz}.text`) where
  `m` is fresh.
- `dispatchKey(rawEvent, text, offset)` takes them as args.
- `applyRender(rendered, text, offset)` takes them as args.
- `setCursorOffset` does NOT clamp via `getText` (the spec invariant
  is violated on this host); callers (e.g. Cycling) clamp themselves
  against the text they're about to apply.

If you add a new module that needs the current text or cursor outside a
key-event or render context, **plumb it through the dispatch path** —
don't reach for `bindings.getText`.

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

### 4. The host may keep the `value` prop in lock-step with our InputZone

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
`adapters/claude-code/<VERSION>/boot.js` — passing in tiny callbacks that
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
`packages/opencues-runtime/adapters/claude-code/v2.1/seams.ts`. The patch
inlines a vendored copy — keep both in sync.

---

## Diagnostic flow

When a v2 install fails or behaves wrong:

1. **Apply with stderr captured:**
   ```bash
   TWEAKCC_CC_INSTALLATION_PATH=$(find ~/local-claude-code -name cli.js | head -1) \
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
   `packages/opencues-runtime/adapters/claude-code/<VERSION>/seams.ts` and
   the inlined copy in
   `integrations/claude-code/patches/opencuesRuntime.ts`. Run
   `npx vitest run adapters/claude-code/<VERSION>/seams.test.ts` to verify.
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
cp -r packages/opencues-runtime/adapters/claude-code/v2.1 \
      packages/opencues-runtime/adapters/claude-code/v3.0
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
| New CC major version               | New `adapters/claude-code/<version>/` band: `seams.ts`, `boot.ts`, mirror inlined regex into `opencuesRuntime.ts`           | full `vitest run` + live install              |

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
