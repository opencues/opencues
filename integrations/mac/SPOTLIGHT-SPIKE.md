# Spotlight AX spike — findings (2026-07-20)

Question: can the universal mac host attach to Spotlight's search
field, and what would the bridge need to change?

## Verdict: GO — every channel works; the only gap is the ATTACH TRIGGER

Probe: `scripts/spotlight-probe.swift` (build: `swiftc -O
spotlight-probe.swift -o /tmp/spotlight-probe`; modes: `activation` /
`watch` / `focus` / `write` / `auto` — `auto` is fully self-contained:
opens the panel itself via CGEvent, writes, verifies, types,
dismisses). All measurements live on macOS 15.1 (24B2083), Spotlight
pid persistent since boot.

## Why the bridge is blind to Spotlight today

Spotlight.app is `LSUIElement = 1` and presents a NON-ACTIVATING
panel: Cmd+Space moves key focus to the Spotlight process **without an
app activation**. Verified live: the panel opened, gained focus, and
accepted typing while `NSWorkspace.didActivateApplicationNotification`
fired ZERO times for it and `frontmostApplication` kept reporting the
previous app throughout. The bridge's only attach trigger
(`ax-bridge.swift start()`) is that notification — `attachTo(pid:)` is
never called with Spotlight's pid, no AXObserver lands on the process,
and the daemon never hears about the field. Silent no-op.

Secondary effect: the previously-frontmost app keeps its first
responder while Spotlight is open, so not even a `blur` fires.

## Measurements (all verified live)

| Capability | Result |
|---|---|
| Search field role | `AXTextField` / subrole `AXSearchField` — passes `TEXT_ROLES`, not secure |
| Settability | `AXValue`, `AXSelectedText`, `AXSelectedTextRange` all settable |
| Pre-attached AXObserver on Spotlight pid | Receives everything: focus-changed on panel open, per-keystroke `AXValueChanged` + `AXSelectedTextChanged` |
| **Atomic write** | `AXReplaceRangeWithText` err=0 AND **verified by re-read** — whole-value replace landed byte-perfect, caret sane after. The bridge's preferred path works as-is |
| Panel-open signal | `AXApplicationShown` + `AXWindowCreated` + `AXFocusedWindowChanged` + focus-changed, on the **app element** |
| Panel-close signal | `AXUIElementDestroyed` + `AXApplicationHidden`, on the **app element** — the field element alone gives NO dismissal signal (verified: watching only the field = silent dismissal) |
| Focus event ordering | Panel open delivers focus-changed for the AXWindow (`AXSystemDialog`) FIRST, then the search field — handlers must tolerate a non-text element arriving first (bridge's `refocus` re-query already does) |
| Restore-on-open | The panel reopens with the PREVIOUS query fully selected (`sel=(0,len)`) — pre-existing content, exactly what the daemon's focus baseline (source `'runtime'`) already guards against |
| Duplicate notifications | Every keystroke fires `AXValueChanged` 2–3× with identical value — harmless to the daemon (`freshMarkerAtCursor` compares marker COUNTS vs prev, so a dup can't re-arm) |
| Esc semantics | First Esc CLEARS the query (panel stays open, value → `""`), second Esc dismisses |
| Inline autocompletion | NOT observed in this spike (typed `saf` → no selected-suffix completion). The restore-selection on open is the only non-empty-selection case seen. If a completion-as-selected-suffix ever shows up, caret-at-selection-END would point past the typed text — re-probe before trusting the cursor there |

## What the fix needs (bridge-only; no daemon/runtime changes)

1. **Persistent secondary observer** on the Spotlight pid (a
   "panel agents" set — Raycast/Alfred share this app shape), armed at
   bridge start, listening on the APP element for: focus-changed,
   `AXApplicationShown`, `AXApplicationHidden`, `AXUIElementDestroyed`.
2. **Arbitration**: a text-role focus event from a panel agent wins
   over the frontmost-app observer (it has real key focus);
   `AXApplicationHidden`/destroy falls back to `refocus(frontmost)` —
   which recovers correctly precisely BECAUSE the primary observer
   never moved (no activation fires on dismissal either).
3. **Re-attach on relaunch**: Spotlight can be killed/respawned;
   re-resolve the pid via `NSWorkspace.didLaunchApplicationNotification`
   or on `AXUIElementDestroyed` of the app element.

Preserves the push-only/no-polling design constraint.

**Implemented same day** (`@opencues/mac` 0.2.0): `ax-bridge.swift`
panel-agent observers exactly as sketched above — persistent per-pid
observers (`PANEL_AGENT_BUNDLES`, extensible via
`OPENCUES_AX_PANEL_AGENTS`), pid-aware `refocus` (the focus event must
carry the PANEL's bundle — the daemon's deny-list keys on it),
launch/terminate re-arm, and the AXApplicationHidden/destroyed →
`refocus(observedPid)` fallback. Contract-tested against live
Spotlight: focus event, whole-value `replace-attr` write verified,
echo change events, dismissal fallback.

## UX caveats (inherent, not bugs)

- Every write re-runs the search — the spliced answer becomes the
  query. Fine for lookup-style blanks (`btc price _`), and the
  blank-loading animation frames will each trigger a search repaint
  (consider suppressing frames for panel agents).
- Esc mid-resolve destroys the element; the write fails safely
  (`writeAck ok:false` → daemon logs + drops).
- Return launches a result — answers are read/copy material.

## Probe-methodology notes

- Shell-orchestrated runs (background watcher + `keypost` steps) are
  RACY when a human is at the machine — the panel toggles under you.
  The `auto` mode exists because of this; use it.
- Synthetic typing via `CGEvent` + `keyboardSetUnicodeString` reaches
  Spotlight fine (Accessibility grant covers posting).
- The TCC-responsible app for any probe run from a dev shell is the
  hosting app (VS Code / terminal), not the shell or the binary.
