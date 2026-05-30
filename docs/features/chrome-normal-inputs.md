# Chrome — normal `<input>` / `<textarea>` mode

OpenCues attaches to two kinds of focused element in the browser:

1. **Contenteditable surfaces** — Gmail compose, Reddit's Lexical editor,
   ChatGPT, LinkedIn, etc. These render the editor's text from DOM text
   nodes, which CSS Custom Highlight ranges can paint. Cues + blanks
   both work here. This is the original chrome integration target.
2. **Normal `<input>` and `<textarea>`** — search boxes, single-line
   form fields, multi-line plain textareas. The browser lays out the
   `.value` internally; CSS Custom Highlight ranges can't paint on
   that internal text. So **cues are off**, **blanks still work**.

This page is the canonical reference for what works on the normal-input
path and what doesn't.

## Supported elements

The integration treats the following as normal-input mode:

- `<textarea>`
- `<input type="text">`
- `<input type="email">`
- `<input type="search">`
- `<input type="url">`

Everything else (`type="number"`, `type="date"`, `type="tel"`,
`type="password"`, `type="hidden"`, `<input>` without a `type` mapped
above, structured pickers, …) is ignored. Password and hidden inputs
should never receive fills; structured inputs have semantics that
silent text substitution would break.

The detector is `isNormalInput()` in
`integrations/chrome/src/opencues-bootstrap.ts`.

## Sensitive inputs — never attached

Even when the input passes the type allowlist above, OpenCues
refuses to attach when the field looks like credentials, payment,
or sensitive PII. Reading + writing those through the LLM pipeline
is a clear no.

The detector is `isSensitiveField()` in `opencues-bootstrap.ts`.
Triggers on any of:

**Formal autocomplete signal** (page conforms to web standards):

- `autocomplete="current-password"` / `"new-password"` — password fields
- `autocomplete="one-time-code"` — OTP / 2FA codes
- `autocomplete="cc-number"`, `"cc-exp"`, `"cc-exp-month"`, `"cc-exp-year"`, `"cc-csc"`, `"cc-name"`, `"cc-given-name"`, `"cc-family-name"` — payment fields
- `autocomplete="off"` only when nearby field/form metadata also matches `SENSITIVE_AUTOCOMPLETE_OFF_CONTEXT_PATTERN`; ordinary search boxes often use `off` and remain attachable

**Name/id heuristic** (fallback for pages that don't bother with
autocomplete): case-insensitive word-boundary match on the
field's `name` or `id` against the canonical
`SENSITIVE_FIELD_NAME_PATTERN` exported from
`integrations/chrome/src/opencues-bootstrap.ts`. See
`docs/architecture/chrome-security.md` § Sensitive-field gate for
the current token list.

False positives (a legitimate search box named `search-token`)
silently lose OpenCues. Acceptable trade — the alternative is
feeding the user's credentials through an LLM. To confirm a
specific field was excluded: in DevTools console, the
`[OpenCues] Attaching to` log will NOT fire on focus.

## What works

**Every blank kind except cycleable ones.** "Cycleable" =
presents alternatives the user picks between with Ctrl+Alt+arrow.
Normal inputs have no key intercepts AND no visual surface for
the cycling band, so cycleable blanks/cues are pruned at
registration. Single-answer blanks survive.

| Blank kind                          | Works on normal inputs? | Notes |
|---|---|---|
| Compute → text (weather, stocks, crypto, hackernews, dictionary, countries, claude-status, answer) | ✅ | First match fills, single-shot. |
| Transform (prompt-improver, "make it louder _", …)                  | ✅ | Rewrites the whole `.value`. On single-line inputs the substitution still happens — surprise factor is on the user. |
| Fluid blank (free-form `_` lookup)                                  | ✅ | Single substitution at the `_`. |
| List blank (affirmations, stepValues)                               | ❌ | Pruned — cycleable. The list shape means the user has multiple choices to step between; without a cycling surface there's nothing to step. |
| Selector / satellite (`opencues settings _`)                        | ❌ | Pruned — `blankSatellite: true` means cycling-required. |
| Script-backed cycling blanks (`volume _`, `brightness _`)           | ❌ | Pruned — `blankScript:` defaults to cycleable. Opt back in via `blankReadOnly: true` if the script truly is one-shot. |
| Word-cues (alternatives, spelling, tips)                            | ❌ | Pruned at source-build time — cues are alternatives-by-definition. Zero LLM token spend in normal-input mode. |
| Cue-blanks via `blankScript:` that are single-shot                  | ⚠ Opt-in   | Add `blankReadOnly: true` to the blank's frontmatter to mark it universal-compatible. Default-deny since scripts are opaque. |

Blanks fire reactively on text-change, so typing `weather london _`
fills as soon as the `_` lands.

## How the cycleability filter works

The "Universal Integration" profile (no cycling, no render) is a
formal capability — see `docs/architecture/universal-integration.md`
for the full design. The chrome content script's bootstrap
advertises `supportsCycling: () => !isNormalInput(currentTarget)`
to the runtime. Every focus change that crosses the CE / normal-
input boundary triggers a resolver rebuild on the next keystroke
— sources pruned or restored reactively.

Two parallel filter paths both consult the same
`isBlankConfigCycleable` helper:

1. **Resolver sources** (`buildSourcesFromConfig` in `@opencues/core`)
   — drops word-cues entirely and prunes cycleable BlankConfig
   entries from the blanks map BEFORE constructing BlankSource.
2. **BlankFill keyword detection** (`matchKeyword` in
   `@opencues/runtime`) — skips cycleable defs during the per-
   keystroke slot-detection walk over `configLoader.blanks`. The
   two paths exist independently; both must filter or the
   guarantee leaks.

The inference (no frontmatter needed) for each `BlankConfig`:

- `blankReadOnly: true` → not cycleable (explicit override)
- `blankSatellite: true` → cycleable
- `stepValues.length > 1` → cycleable
- `blankStep` numeric → cycleable
- `blankScript:` → cycleable (default-deny; opt out with
  `blankReadOnly: true`)
- otherwise (impl-only compute blanks) → not cycleable

## What doesn't work

- **Cues (word-alternatives, tips, spelling cues).** The resolver still
  runs and may compute cue ranges, but the renderer skips them
  (`runtimeRender` early-returns in normal-input mode). Token cost is
  the same as the contenteditable path; we just discard the output.
  TODO if this becomes wasteful: gate the resolver itself.
- **Navigation / Cycling keystrokes.** The bootstrap's document-level
  `keydown` listener (`installKeyListener`) returns early when the
  focused element is a normal input. Ctrl+Up/Down, Tab between cues,
  Escape-to-dismiss, etc. all pass through to the browser. Cue/cycling
  state has no visible representation in this mode, so dispatching
  these keys would mutate text invisibly — worse than no-op.
- **Dim render / active-pill / cycling band / multi-word span markers.**
  All CSS-Custom-Highlight-driven. None paint on input internals.
- **Status bar overlay.** Skipped — it's tied to render-time injection.
- **`selectionchange` round-trip.** Skipped — cursor-navigate
  auto-highlight has no surface to drive.
- **Markdown styling.** Same root cause — `execCommand('bold')` is a
  no-op on plain inputs, and there's no DOM to wrap `<b>` around.

## Implementation shape

The "big IF statement" lives in two files:

**`integrations/chrome/src/opencues-bootstrap.ts`**

- `isNormalInput(el)` — exported detector.
- `readTargetText(target)` — branches `el.value` vs `walkPlainText`.
- `writeNormalInputValue(el, text)` — uses the native prototype-setter
  trick so React/Vue/Svelte controlled inputs pick up the change, then
  dispatches `input` + `change`. Synthetic dispatch is `isTrusted=false`
  so the document-level input listener filters it out — no
  double-notify, but framework onChange handlers still fire (those use
  their own synthetic event systems, not `isTrusted`).
- `readCursorOffset` / `writeCursorOffset` — branched to use
  `selectionStart` / `setSelectionRange` on inputs.
- `diffWriteText` / `replaceAllText` — early-branch to
  `writeNormalInputValue`.
- `runtimeRender` — early-returns when target is a normal input.
- `installKeyListener` — early-returns when target is a normal input.

**`integrations/chrome/src/content.ts`**

- `isTextInput` now returns true for both contenteditables and normal
  inputs.
- `attachToFocused` skips `applyDerivedColours` for inputs (no
  highlight style tag needed).
- The document-level `input` forwarder uses `readTargetText` so the
  branch is transparent to the runtime.
- The `selectionchange` listener early-returns for inputs.
- Cleanup paths (`focusout`, `onConfigChange`, `prefers-color-scheme`
  change) skip the highlight-colour calls when the target is an input.

## Ambient context — off by default

For free-form lookups (`paris _`, `cheap eats _`), the answer
depends on **where the user is**: `destination` field on
`flights.example.com` vs `topic` field on `forum.example.com`
should produce different output. Buffer text alone doesn't tell
the LLM enough.

Chrome optionally forwards a sanitized snapshot of the focused
field (label, placeholder, aria-*, input type) plus page-level
metadata (title, origin+path URL, meta description) to the
fluid-blank LLM call — **only** the fluid-blank call, no other
source. **OFF by default.** Opt in via
`ambient-context-mode: on` in `~/.cues/OPENCUES.md`.

What's read:

- Field-level: `label` (from `<label for>` / wrapping `<label>` /
  `aria-labelledby`), `placeholder`, `aria-label`,
  `aria-description`, input type.
- Page-level: `document.title`, `location.origin + location.pathname`
  (query string + fragment stripped at the gatherer AND re-stripped
  at the core), `<meta name="description">`.

What's never read (independent of feature state):

- Any sibling field's value or label.
- The URL query string or fragment.
- Cookies, localStorage, sessionStorage.
- DOM outside the focused field's own attributes and the listed
  page-level fields.
- Anything from sensitive fields — passwords / CC / OTP get
  `null` regardless of the scalar.

The fluid-blank prompt is locked to: static instruction text +
the user's own buffer + sanitized ambient block. No env vars,
no cwd, no agent state — pinned by the
`no-system-data invariant` test in `fluid-blank-source.test.ts`.

The structural reason this is safe: OpenCues has no tool
handlers, no exec layer, no out-of-band action channel for
fluid-blank LLM output. A prompt injection in a malicious
page's `placeholder` can at worst cause the LLM to write
misleading text into the user's buffer, which the user sees
before submitting. There is no exfiltration channel.

Full threat model + sanitization rules: `docs/architecture/ambient-context.md`.

## Trust gate behavior

The `_` credit-based trust gate works identically on normal inputs:

- `keydown` for `_` with `isTrusted=true` adds a credit.
- `paste` / `drop` count their `_`s as credits.
- Synthetic input events from a hostile page are still
  `isTrusted=false` and filtered at the document-level listener.

There's no new attack surface — the input branch reuses the same
trust gate, just with a different read/write path.

## Caveats users should know about

1. **Enter may submit before a blank fills.** Forms typically submit
   on Enter. If the user types `weather _` followed by Enter, the form
   may submit with `weather _` in the field before the LLM round-trip
   finishes. This is an inherent property of form behavior, not a bug
   we can fix without intercepting Enter (which we don't, see the
   spec discussion below).
2. **Transform-blank on single-line inputs may be surprising.** A
   search box with `make it shorter _` would have its whole body
   rewritten in place. Working as designed but worth knowing.
3. **No visible feedback that OpenCues is active.** We deliberately
   ship no badge / toast / preview in normal-input mode (kept simple
   per the spec discussion). To verify OpenCues is on the input, flip
   `debug-mode: on` in `~/.cues/CUES.md` and watch the DevTools
   console — attach lines (`[OpenCues][normal-input] Attaching to`)
   and write lines (`[opencues][normal-input] writeValue: newLen=...`)
   surface there.

## Debugging

The two log tags to grep for in DevTools:

- `[OpenCues][normal-input] Attaching to` — fires once per focus into
  a normal input. Confirms the integration saw the element.
- `[opencues][normal-input] writeValue: newLen=N` — fires every time
  the runtime wrote a value (blank fill, transform substitution,
  fluid fill).

Both gated behind `debug-mode: on` (live-toggleable from any host's
`opencues settings _` selector, or by editing
`~/.cues/CUES.md` directly). The mirror to the native-host log file
(`/tmp/opencues.log`) is always on, so post-mortem inspection works
without needing the dev tools open at the time.

If a blank silently fails on a normal input:

1. Check the attach line fired (right element type? right `type`
   attribute?).
2. Check the keyword routes correctly — `opencues list` to see what
   the bundle has for the keyword.
3. Check the trust gate didn't drop the `_` — look for warn lines
   near the input event.
4. Check the framework didn't revert the write — sites that
   aggressively replace `.value` from React state can fight us; the
   native-setter dispatch should beat them, but if you see a flash of
   the fill before it disappears, that's the symptom.

## Why no badge / preview / toast?

Considered, deferred. The minimal IF-statement landing here is the
quickest path to "blanks work in input fields". Visual feedback would
mean either:

- A corner badge — requires a fixed-position element that survives
  iframe boundaries and doesn't conflict with the host page's z-stack.
- A ghost-text preview — requires pixel-perfect alignment with the
  input's font / line-height / padding, which is fragile across
  thousands of styled inputs in the wild.
- A toast on fill — adds a notification layer to a content script
  that previously had none.

None of these are hard, but all add scope. Revisit if user feedback
indicates discoverability is the problem.
