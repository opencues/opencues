// OpenCues universal AX bridge.
//
// Tracks the FOCUSED text element in whatever app is frontmost and
// speaks line-delimited JSON over stdio to the Node daemon:
//
//   out: {"type":"ready","trusted":true}
//        {"type":"focus","app":"TextEdit","bundle":"…","role":"AXTextArea","value":"…","cursor":12}
//        {"type":"blur"}
//        {"type":"change","value":"…","cursor":13}            (AXValueChanged)
//        {"type":"cursor","cursor":14}                        (AXSelectedTextChanged only)
//        {"type":"writeAck","id":3,"ok":true}
//        {"type":"key","key":"up","modifiers":{"ctrl":true,"alt":true,…}}  (chord tap)
//        {"type":"tapArmed"} | {"type":"tapFailed",…} | {"type":"tapReenabled"}
//   in:  {"cmd":"replace","id":3,"start":10,"length":1,"text":"…"}
//        {"cmd":"read"}
//        {"cmd":"capture","on":true}   enable/disable chord consumption
//
// Design constraints (AX-SPIKE.md, 2026-07-12):
//  - Focused-element-only, push-driven: AXObserver per frontmost pid,
//    re-armed on app activation; no polling anywhere.
//  - SECURE FIELDS NEVER LEAVE THE PROCESS: AXSecureTextField focus
//    emits blur, not a value.
//  - Values capped at MAX_CHARS — a focused 10MB log viewer must not
//    flood the pipe (oversize emits blur).
//  - Offsets are UTF-16 code units on both sides (AX native; matches
//    JS string indexing).
//
// Panel agents (SPOTLIGHT-SPIKE.md, 2026-07-20): Spotlight-class apps
// are LSUIElement agents whose NON-ACTIVATING panel takes key focus
// without any app activation — the frontmost-app trigger above is
// structurally blind to them. Each panel agent gets a PERSISTENT
// observer armed at start (and on relaunch), listening on its app
// element. Arbitration: a text-element focus event from a panel agent
// wins (it holds real key focus); its release signal is
// AXApplicationHidden / element-destroyed (dismissal fires nothing
// else), which falls back to the primary observer — correct precisely
// because the primary observer never moved.
//
// Build: swiftc -O ax-bridge.swift -o dist/ax-bridge

import ApplicationServices
import AppKit

let MAX_CHARS = 200_000
let TEXT_ROLES: Set<String> = ["AXTextArea", "AXTextField", "AXComboBox"]

// Non-activating-panel apps that need a persistent observer. Extend
// via env (mirrors the daemon's OPENCUES_AX_DENY), e.g. for Raycast /
// Alfred once probed: OPENCUES_AX_PANEL_AGENTS=com.raycast.macos
let PANEL_AGENT_BUNDLES: Set<String> = {
    var s: Set<String> = ["com.apple.Spotlight"]
    if let extra = ProcessInfo.processInfo.environment["OPENCUES_AX_PANEL_AGENTS"] {
        for b in extra.split(separator: ",") {
            let t = b.trimmingCharacters(in: .whitespaces)
            if !t.isEmpty { s.insert(t) }
        }
    }
    return s
}()

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func cursorOf(_ el: AXUIElement) -> Int {
    guard let v = attr(el, kAXSelectedTextRangeAttribute), CFGetTypeID(v) == AXValueGetTypeID()
    else { return 0 }
    var range = CFRange()
    AXValueGetValue(v as! AXValue, .cfRange, &range)
    // Caret = end of the selection: after typing, loc is already the
    // caret; after a selection, end is where typing would land.
    return range.location + range.length
}

// ─── Cycling chord capture (CGEventTap) ──────────────────────────────
//
// AX is push-driven for focus/value/cursor but delivers NO keystrokes, so
// cycling (Ctrl+Option+↑/↓) and word navigation (←/→) have no channel on
// native apps — which is why the universal band advertised
// supportsCycling: false and every cycleable cue was pruned. A session-level
// CGEventTap supplies that channel. Measured on macOS 15 arm64 (2026-07-26,
// scripts/hotkey-probe.swift): the tap arms under the Accessibility grant the
// bridge ALREADY requires — no Input Monitoring prompt — and an active tap can
// return nil to consume the chord so the focused app never sees it.
//
// Consumption is GATED by the daemon, not decided here: `{"cmd":"capture",
// "on":…}` toggles it on focus of an attachable field and off on blur. The
// deny list (terminals, per OPENCUES_AX_DENY) lives daemon-side, so a tap that
// swallowed chords whenever any text element was focused would eat the user's
// own Ctrl+Alt+arrow bindings in iTerm. Off ⇒ every chord passes through
// untouched, exactly as before this feature existed.
let CHORD_KEYCODES: [Int64: String] = [126: "up", 125: "down", 123: "left", 124: "right"]
var captureEnabled = false
var eventTap: CFMachPort?

let chordTapCallback: CGEventTapCallBack = { _, type, event, _ in
    // The system disables a tap that runs too long or floods; re-enable rather
    // than silently losing every subsequent chord.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let t = eventTap { CGEvent.tapEnable(tap: t, enable: true) }
        emit(["type": "tapReenabled"])
        return Unmanaged.passUnretained(event)
    }
    let code = event.getIntegerValueField(.keyboardEventKeycode)
    let flags = event.flags
    guard let key = CHORD_KEYCODES[code], flags.contains(.maskControl), flags.contains(.maskAlternate) else {
        return Unmanaged.passUnretained(event)
    }
    // Diagnostic worth its bytes: "the tap never saw the chord" and "the gate
    // was shut" look identical from the daemon's side otherwise, and that
    // ambiguity cost a debugging round on 2026-07-26.
    guard captureEnabled else {
        emit(["type": "chordIgnored", "key": key])
        return Unmanaged.passUnretained(event)
    }
    emit([
        "type": "key",
        "key": key,
        "modifiers": [
            "ctrl": true, "alt": true,
            "shift": flags.contains(.maskShift),
            "meta": flags.contains(.maskCommand),
        ],
    ])
    return nil   // consumed — the focused app must not also act on it
}

/// Arm the chord tap. Non-fatal: without it the daemon simply keeps the
/// pre-cycling behaviour (blank fills still work), so a tap failure must never
/// take the bridge down.
func installChordTap() {
    // HID level, not session level. A session tap sits AFTER WindowServer's
    // own hotkey processing, so a chord the system claims (Ctrl+↑ is Mission
    // Control by default) never reaches it — and synthetic CGEventPost events
    // DO reach it, which is how a session tap passed a synthetic-key test on
    // 2026-07-26 while real keypresses were still being swallowed upstream.
    // kCGHIDEventTap is closest to the hardware, ahead of that processing.
    guard let tap = CGEvent.tapCreate(
        tap: .cghidEventTap,
        place: .headInsertEventTap,
        options: .defaultTap,
        eventsOfInterest: CGEventMask(1 << CGEventType.keyDown.rawValue),
        callback: chordTapCallback,
        userInfo: nil
    ) else {
        emit(["type": "tapFailed", "reason": "tapCreate returned nil (Accessibility grant missing?)"])
        return
    }
    eventTap = tap
    CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0), .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    emit(["type": "tapArmed"])
}

// Shared C-function-pointer callback for every observer (primary and
// panel); the element's own pid disambiguates in handle().
let axCallback: AXObserverCallback = { _, element, notification, refcon in
    let bridge = Unmanaged<Bridge>.fromOpaque(refcon!).takeUnretainedValue()
    bridge.handle(notification as String, element)
}

final class Bridge {
    // Primary observer — follows app ACTIVATIONS (the frontmost app).
    var observer: AXObserver?
    var observedPid: pid_t = 0
    // Panel agents — persistent observers keyed by pid, never re-armed
    // by activations (none ever fire for these apps).
    var panelObservers: [pid_t: AXObserver] = [:]
    // The one focused element the daemon sees, and which pid owns it.
    var focusedElement: AXUIElement?
    var focusedPid: pid_t = 0

    func isPanelPid(_ pid: pid_t) -> Bool { panelObservers[pid] != nil }

    func obsFor(_ pid: pid_t) -> AXObserver? {
        pid == observedPid ? observer : panelObservers[pid]
    }

    func start() {
        emit(["type": "ready", "trusted": AXIsProcessTrusted()])
        guard AXIsProcessTrusted() else { return }
        let nc = NSWorkspace.shared.notificationCenter
        nc.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.attachTo(pid: app.processIdentifier)
        }
        // Panel agents can be killed/respawned (killall Spotlight) —
        // re-arm on relaunch, drop on termination.
        nc.addObserver(
            forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  PANEL_AGENT_BUNDLES.contains(app.bundleIdentifier ?? "") else { return }
            self?.attachPanel(pid: app.processIdentifier)
        }
        nc.addObserver(
            forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  PANEL_AGENT_BUNDLES.contains(app.bundleIdentifier ?? "") else { return }
            self?.detachPanel(pid: app.processIdentifier)
        }
        if let front = NSWorkspace.shared.frontmostApplication {
            attachTo(pid: front.processIdentifier)
        }
        for bundle in PANEL_AGENT_BUNDLES {
            for app in NSRunningApplication.runningApplications(withBundleIdentifier: bundle) {
                attachPanel(pid: app.processIdentifier)
            }
        }
    }

    func attachTo(pid: pid_t) {
        guard pid != getpid(), !isPanelPid(pid) else { return }
        if let obs = observer {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
            observer = nil
        }
        observedPid = pid
        var obs: AXObserver?
        guard AXObserverCreate(pid, axCallback, &obs) == .success, let o = obs else { return }
        observer = o
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        let appEl = AXUIElementCreateApplication(pid)
        AXObserverAddNotification(o, appEl, kAXFocusedUIElementChangedNotification as CFString, refcon)
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(o), .defaultMode)
        refocus(pid)
    }

    func attachPanel(pid: pid_t) {
        guard pid != getpid(), panelObservers[pid] == nil else { return }
        var obs: AXObserver?
        guard AXObserverCreate(pid, axCallback, &obs) == .success, let o = obs else { return }
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        let appEl = AXUIElementCreateApplication(pid)
        // Panel lifecycle rides the APP element: the field alone gives
        // NO dismissal signal (verified — SPOTLIGHT-SPIKE.md).
        for n in [kAXFocusedUIElementChangedNotification,
                  kAXApplicationHiddenNotification,
                  kAXUIElementDestroyedNotification] {
            AXObserverAddNotification(o, appEl, n as CFString, refcon)
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(o), .defaultMode)
        panelObservers[pid] = o
        // Bridge started while the panel is already open + focused → adopt.
        if let el = attr(appEl, kAXFocusedUIElementAttribute),
           TEXT_ROLES.contains((attr(el as! AXUIElement, kAXRoleAttribute) as? String) ?? "") {
            refocus(pid)
        }
    }

    func detachPanel(pid: pid_t) {
        guard let obs = panelObservers.removeValue(forKey: pid) else { return }
        CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
        if focusedPid == pid { refocus(observedPid) }
    }

    /// Drop element-level observers from the current focused element
    /// (via whichever observer owns its process).
    func detachElement() {
        if let old = focusedElement, let obs = obsFor(focusedPid) {
            AXObserverRemoveNotification(obs, old, kAXValueChangedNotification as CFString)
            AXObserverRemoveNotification(obs, old, kAXSelectedTextChangedNotification as CFString)
            AXObserverRemoveNotification(obs, old, kAXUIElementDestroyedNotification as CFString)
        }
        focusedElement = nil
    }

    /// Re-resolve pid's focused element and re-arm element observers.
    func refocus(_ pid: pid_t) {
        guard let obs = obsFor(pid) else { return }
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        detachElement()
        let appEl = AXUIElementCreateApplication(pid)
        guard let el = attr(appEl, kAXFocusedUIElementAttribute) else {
            focusedPid = 0
            emit(["type": "blur", "reason": "no-focused-element"])
            return
        }
        let element = el as! AXUIElement
        let role = (attr(element, kAXRoleAttribute) as? String) ?? ""
        let subrole = (attr(element, kAXSubroleAttribute) as? String) ?? ""
        guard TEXT_ROLES.contains(role), subrole != "AXSecureTextField" else {
            focusedPid = 0
            emit(["type": "blur", "reason": "non-text-or-secure-role"])
            return
        }
        guard let value = attr(element, kAXValueAttribute) as? String, value.utf16.count <= MAX_CHARS else {
            focusedPid = 0
            emit(["type": "blur", "reason": "unreadable-or-oversized-value"])
            return
        }
        focusedElement = element
        focusedPid = pid
        replaceAttrWorks = nil // re-learn the write path per focused element
        AXObserverAddNotification(obs, element, kAXValueChangedNotification as CFString, refcon)
        AXObserverAddNotification(obs, element, kAXSelectedTextChangedNotification as CFString, refcon)
        AXObserverAddNotification(obs, element, kAXUIElementDestroyedNotification as CFString, refcon)
        let app = NSRunningApplication(processIdentifier: pid)
        emit([
            "type": "focus",
            "app": app?.localizedName ?? "?",
            "bundle": app?.bundleIdentifier ?? "?",
            "role": role,
            "value": value,
            "cursor": cursorOf(element),
            // Stable-per-element id for SAME-FIELD RESUME (the mac analogue of
            // the windows shim's fieldId). Some apps re-fire focus for the
            // element you are already editing — TextEdit does it mid-typing —
            // and treating that as a buffer switch resets runtime state, which
            // destroys the cue spans cycling needs. With an id the daemon can
            // tell "same field, keep the spans" from "different field, reset".
            "fieldId": String(CFHash(element)),
        ])
    }

    func handle(_ notification: String, _ element: AXUIElement) {
        var pid: pid_t = 0
        AXUIElementGetPid(element, &pid)
        switch notification {
        case kAXFocusedUIElementChangedNotification as String:
            // While a panel agent owns focus, primary-app focus churn
            // must not steal it — the panel's release signal is
            // AXApplicationHidden / destroyed, not a primary event.
            if isPanelPid(focusedPid), !isPanelPid(pid) { return }
            refocus(pid)
        case kAXApplicationHiddenNotification as String:
            // Panel dismissed — hand focus back to the primary app
            // (no activation fires for this transition either).
            if pid == focusedPid { refocus(observedPid) }
        case kAXUIElementDestroyedNotification as String:
            guard pid == focusedPid, focusedElement != nil else { return }
            if isPanelPid(pid) {
                refocus(observedPid)
            } else {
                focusedElement = nil
                focusedPid = 0
                emit(["type": "blur", "reason": "element-destroyed"])
            }
        case kAXValueChangedNotification as String:
            guard let el = focusedElement,
                  let value = attr(el, kAXValueAttribute) as? String, value.utf16.count <= MAX_CHARS
            else { return }
            emit(["type": "change", "value": value, "cursor": cursorOf(el)])
        case kAXSelectedTextChangedNotification as String:
            guard let el = focusedElement else { return }
            emit(["type": "cursor", "cursor": cursorOf(el)])
        default: break
        }
    }

    /// Whether the FOCUSED element honours AXReplaceRangeWithText —
    /// the atomic, selection-free replace. Cannot be detected from the
    /// return value: AppKit's NSObject default returns YES without
    /// editing (reverse-engineered 2026-07-12 — only apps that
    /// implement accessibilityReplaceRange:withText: themselves, e.g.
    /// WebKit/Electron views, actually edit). Learned per focus by
    /// verifying the first replace with a re-read; reset on refocus.
    var replaceAttrWorks: Bool? = nil

    func selectionRange(_ el: AXUIElement) -> CFRange {
        guard let v = attr(el, kAXSelectedTextRangeAttribute), CFGetTypeID(v) == AXValueGetTypeID()
        else { return CFRange(location: 0, length: 0) }
        var r = CFRange()
        AXValueGetValue(v as! AXValue, .cfRange, &r)
        return r
    }

    /// Slice [start, start+len) of the element's value, UTF-16 offsets.
    func valueSlice(_ el: AXUIElement, _ start: Int, _ len: Int) -> String? {
        guard let value = attr(el, kAXValueAttribute) as? String else { return nil }
        let u = Array(value.utf16)
        guard start >= 0, start + len <= u.count else { return nil }
        return String(utf16CodeUnits: Array(u[start..<(start + len)]), count: len)
    }

    func replace(id: Int, start: Int, length: Int, text: String) {
        guard let el = focusedElement else { emit(["type": "writeAck", "id": id, "ok": false, "err": "no focus"]); return }
        var range = CFRange(location: start, length: length)
        guard let axRange = AXValueCreate(.cfRange, &range) else {
            emit(["type": "writeAck", "id": id, "ok": false, "err": "range create"]); return
        }

        // Path 1 — atomic + selection-free (never touches the caret).
        if replaceAttrWorks != false {
            var res: CFTypeRef?
            let err = AXUIElementCopyParameterizedAttributeValue(
                el, "AXReplaceRangeWithText" as CFString,
                ["AXReplacementRange": axRange, "AXReplacementText": text as CFString] as CFDictionary,
                &res)
            // Trust nothing but a verifying re-read (the YES-no-op trap).
            if err == .success, valueSlice(el, start, text.utf16.count) == text {
                replaceAttrWorks = true
                emit(["type": "writeAck", "id": id, "ok": true, "method": "replace-attr", "cursor": cursorOf(el)])
                return
            }
            replaceAttrWorks = false
        }

        // Path 2 — selection transaction: select → replace → RESTORE the
        // user's selection, all synchronous on the app's main thread, so
        // the intermediate selection is never painted (rendering needs a
        // runloop turn) and the insertion point is handed straight back.
        let selBefore = selectionRange(el)
        guard AXUIElementSetAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, axRange) == .success,
              AXUIElementSetAttributeValue(el, kAXSelectedTextAttribute as CFString, text as CFTypeRef) == .success
        else { emit(["type": "writeAck", "id": id, "ok": false, "err": "set failed"]); return }
        let delta = text.utf16.count - length
        var restore: CFRange
        if selBefore.location >= start + length {
            // Selection was after the region — shift it by the edit delta.
            restore = CFRange(location: selBefore.location + delta, length: selBefore.length)
        } else if selBefore.location + selBefore.length <= start {
            // Entirely before the region — untouched.
            restore = selBefore
        } else {
            // Overlapped the region (e.g. caret at the animated `_`) —
            // caret lands after the inserted text, the natural spot.
            restore = CFRange(location: start + text.utf16.count, length: 0)
        }
        if var r = Optional(restore), let restoreRange = AXValueCreate(.cfRange, &r) {
            AXUIElementSetAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, restoreRange)
        }
        emit(["type": "writeAck", "id": id, "ok": true, "method": "selection", "cursor": cursorOf(el)])
    }

    func snapshot() {
        guard let el = focusedElement, let value = attr(el, kAXValueAttribute) as? String else {
            emit(["type": "blur", "reason": "snapshot-unreadable"]); return
        }
        emit(["type": "change", "value": value, "cursor": cursorOf(el)])
    }
}

// `ax-bridge probe` — install-time permission check. Fires the system
// Accessibility prompt (once) when untrusted, prints the state, exits.
// `ax-bridge status` — the same check WITHOUT the prompt (doctor uses
// this: diagnostics must never pop system dialogs).
if CommandLine.arguments.count > 1 && (CommandLine.arguments[1] == "probe" || CommandLine.arguments[1] == "status") {
    let prompt = CommandLine.arguments[1] == "probe"
    let opts = ["AXTrustedCheckOptionPrompt": prompt] as CFDictionary
    let trusted = AXIsProcessTrustedWithOptions(opts)
    print(trusted ? "trusted" : "untrusted")
    exit(trusted ? 0 : 1)
}

let bridge = Bridge()

// stdin command reader (background thread → main runloop).
DispatchQueue.global().async {
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cmd = obj["cmd"] as? String else { continue }
        DispatchQueue.main.async {
            switch cmd {
            case "replace":
                bridge.replace(
                    id: obj["id"] as? Int ?? 0,
                    start: obj["start"] as? Int ?? 0,
                    length: obj["length"] as? Int ?? 0,
                    text: obj["text"] as? String ?? ""
                )
            case "read": bridge.snapshot()
            case "capture":
                // Daemon-gated chord consumption — see installChordTap.
                captureEnabled = (obj["on"] as? Bool) ?? false
            default: break
            }
        }
    }
    // stdin closed — daemon is gone.
    exit(0)
}

DispatchQueue.main.async { bridge.start(); installChordTap() }
RunLoop.main.run()
