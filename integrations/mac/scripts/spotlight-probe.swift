// Spotlight AX probe — measures whether the universal mac host can
// attach to Spotlight's search field, and what that field exposes.
//
// Context: Spotlight.app is LSUIElement=1 and presents a NON-ACTIVATING
// panel — Cmd+Space moves key focus to the Spotlight process without an
// app activation, so ax-bridge's NSWorkspace.didActivateApplication
// attach trigger never fires for it. This probe verifies that gap and
// measures everything a fix needs to know (see the questions per mode).
//
// Build: swiftc -O spotlight-probe.swift -o /tmp/spotlight-probe
// Run from an Accessibility-trusted terminal (System Settings →
// Privacy & Security → Accessibility → your terminal).
//
// Modes:
//   activation <secs>   Log every NSWorkspace app-activation while you
//                       toggle Spotlight. Expected: Spotlight NEVER
//                       appears → the bridge's attach trigger is blind.
//   watch <secs>        Attach an AXObserver to the running Spotlight
//                       pid up front (the proposed fix), then log
//                       focus/value/selection notifications while you
//                       open Spotlight and type. Proves push events
//                       flow without any activation notification.
//   focus <delaySecs>   Sleep, then dump the SYSTEM-WIDE focused
//                       element: role/subrole, value, selection range,
//                       attribute + parameterized-attribute names,
//                       settability. Open Spotlight and type something
//                       (with a trailing selected autocompletion if you
//                       can provoke one) during the delay.
//   write <delaySecs> <old> <new>
//                       Sleep, then replace the first occurrence of
//                       <old> with <new> in Spotlight's focused field —
//                       tries AXReplaceRangeWithText first (verified by
//                       re-read; the return value lies), falls back to
//                       the select→replace→restore transaction.

import ApplicationServices
import AppKit

func ts() -> String {
    let f = DateFormatter(); f.dateFormat = "HH:mm:ss.SSS"; return f.string(from: Date())
}
func say(_ msg: String) { print("[\(ts())] \(msg)"); fflush(stdout) }

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}
func selRange(_ el: AXUIElement) -> CFRange? {
    guard let v = attr(el, kAXSelectedTextRangeAttribute), CFGetTypeID(v) == AXValueGetTypeID()
    else { return nil }
    var r = CFRange(); AXValueGetValue(v as! AXValue, .cfRange, &r); return r
}
func describeElement(_ el: AXUIElement, label: String) {
    let role = (attr(el, kAXRoleAttribute) as? String) ?? "?"
    let subrole = (attr(el, kAXSubroleAttribute) as? String) ?? "-"
    let value = (attr(el, kAXValueAttribute) as? String) ?? "<no AXValue>"
    var pid: pid_t = 0; AXUIElementGetPid(el, &pid)
    let app = NSRunningApplication(processIdentifier: pid)
    say("\(label): pid=\(pid) app=\(app?.localizedName ?? "?") bundle=\(app?.bundleIdentifier ?? "?")")
    say("  role=\(role) subrole=\(subrole)")
    say("  value=\(value.debugDescription) (utf16 len \(value.utf16.count))")
    if let r = selRange(el) { say("  selection: loc=\(r.location) len=\(r.length)") }
    var names: CFArray?
    if AXUIElementCopyAttributeNames(el, &names) == .success, let ns = names as? [String] {
        say("  attributes: \(ns.joined(separator: " "))")
    }
    var pnames: CFArray?
    if AXUIElementCopyParameterizedAttributeNames(el, &pnames) == .success, let ps = pnames as? [String] {
        say("  parameterized: \(ps.joined(separator: " "))")
    }
    for a in [kAXSelectedTextRangeAttribute, kAXSelectedTextAttribute, kAXValueAttribute] {
        var settable = DarwinBoolean(false)
        if AXUIElementIsAttributeSettable(el, a as CFString, &settable) == .success {
            say("  settable \(a): \(settable.boolValue)")
        }
    }
}

func spotlightPid() -> pid_t? {
    NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Spotlight")
        .first?.processIdentifier
}

guard AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary) else {
    say("NOT TRUSTED — grant Accessibility to this terminal, then rerun.")
    exit(1)
}
let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "focus"

switch mode {
case "activation":
    let secs = args.count > 2 ? Double(args[2]) ?? 15 : 15
    say("Logging NSWorkspace activations for \(Int(secs))s — press Cmd+Space, type, press Esc, repeat…")
    NSWorkspace.shared.notificationCenter.addObserver(
        forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
    ) { note in
        let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
        say("didActivate: \(app?.localizedName ?? "?") (\(app?.bundleIdentifier ?? "?"))")
    }
    var timer: Timer? = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
        let f = NSWorkspace.shared.frontmostApplication
        say("frontmost: \(f?.localizedName ?? "?")")
    }
    RunLoop.main.run(until: Date(timeIntervalSinceNow: secs))
    timer?.invalidate(); timer = nil
    say("done. If Spotlight never appeared above, the bridge's attach trigger cannot see it.")

case "watch":
    let secs = args.count > 2 ? Double(args[2]) ?? 20 : 20
    guard let pid = spotlightPid() else { say("Spotlight not running"); exit(1) }
    say("Observing Spotlight pid \(pid) for \(Int(secs))s — press Cmd+Space and type…")
    var observer: AXObserver?
    final class Ctx { var focused: AXUIElement? }
    let ctx = Ctx()
    let cb: AXObserverCallback = { obs, element, notification, refcon in
        let ctx = Unmanaged<Ctx>.fromOpaque(refcon!).takeUnretainedValue()
        let n = notification as String
        switch n {
        case kAXFocusedUIElementChangedNotification as String:
            say("notification: focus changed")
            describeElement(element, label: "  focused")
            if let old = ctx.focused {
                AXObserverRemoveNotification(obs, old, kAXValueChangedNotification as CFString)
                AXObserverRemoveNotification(obs, old, kAXSelectedTextChangedNotification as CFString)
                AXObserverRemoveNotification(obs, old, kAXUIElementDestroyedNotification as CFString)
            }
            ctx.focused = element
            AXObserverAddNotification(obs, element, kAXValueChangedNotification as CFString, refcon)
            AXObserverAddNotification(obs, element, kAXSelectedTextChangedNotification as CFString, refcon)
            AXObserverAddNotification(obs, element, kAXUIElementDestroyedNotification as CFString, refcon)
        case kAXValueChangedNotification as String:
            let v = (attr(element, kAXValueAttribute) as? String) ?? "?"
            let r = selRange(element)
            say("notification: value changed → \(v.debugDescription) sel=(\(r?.location ?? -1),\(r?.length ?? -1))")
        case kAXSelectedTextChangedNotification as String:
            let r = selRange(element)
            say("notification: selection changed → (\(r?.location ?? -1),\(r?.length ?? -1))")
        case kAXUIElementDestroyedNotification as String:
            say("notification: element destroyed (panel dismissed)")
        default:
            say("notification: \(n)")
        }
    }
    guard AXObserverCreate(pid, cb, &observer) == .success, let o = observer else {
        say("AXObserverCreate failed for Spotlight pid \(pid)"); exit(1)
    }
    let refcon = Unmanaged.passUnretained(ctx).toOpaque()
    let appEl = AXUIElementCreateApplication(pid)
    let addErr = AXObserverAddNotification(o, appEl, kAXFocusedUIElementChangedNotification as CFString, refcon)
    say("AddNotification(focus-changed) on Spotlight app element: \(addErr == .success ? "ok" : "err \(addErr.rawValue)")")
    if let el = attr(appEl, kAXFocusedUIElementAttribute) {
        describeElement(el as! AXUIElement, label: "already-focused")
    } else {
        say("no focused element in Spotlight yet (panel closed) — that's expected; open it now")
    }
    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(o), .defaultMode)
    RunLoop.main.run(until: Date(timeIntervalSinceNow: secs))
    say("done.")

case "focus":
    let delay = args.count > 2 ? Double(args[2]) ?? 5 : 5
    say("Sleeping \(Int(delay))s — press Cmd+Space and type a query now…")
    Thread.sleep(forTimeInterval: delay)
    let systemWide = AXUIElementCreateSystemWide()
    if let el = attr(systemWide, kAXFocusedUIElementAttribute) {
        describeElement(el as! AXUIElement, label: "system-wide focused element")
    } else {
        say("system-wide kAXFocusedUIElement: NONE")
    }
    if let pid = spotlightPid() {
        let appEl = AXUIElementCreateApplication(pid)
        if let el = attr(appEl, kAXFocusedUIElementAttribute) {
            describeElement(el as! AXUIElement, label: "Spotlight-pid focused element")
        } else {
            say("Spotlight app element reports no focused element")
        }
    }

case "write":
    guard args.count > 4 else { say("usage: write <delaySecs> <old> <new>"); exit(1) }
    let delay = Double(args[2]) ?? 5
    let old = args[3], new = args[4]
    say("Sleeping \(Int(delay))s — open Spotlight and type text containing \(old.debugDescription)…")
    Thread.sleep(forTimeInterval: delay)
    guard let pid = spotlightPid() else { say("Spotlight not running"); exit(1) }
    let appEl = AXUIElementCreateApplication(pid)
    guard let raw = attr(appEl, kAXFocusedUIElementAttribute) else {
        say("no focused element in Spotlight — was the panel open?"); exit(1)
    }
    let el = raw as! AXUIElement
    guard let value = attr(el, kAXValueAttribute) as? String else { say("no AXValue"); exit(1) }
    say("value before: \(value.debugDescription)")
    let u = Array(value.utf16), needle = Array(old.utf16)
    var start = -1
    if !needle.isEmpty && u.count >= needle.count {
        for i in 0...(u.count - needle.count) where Array(u[i..<i+needle.count]) == needle { start = i; break }
    }
    guard start >= 0 else { say("\(old.debugDescription) not found in value"); exit(1) }
    var range = CFRange(location: start, length: needle.count)
    guard let axRange = AXValueCreate(.cfRange, &range) else { say("range create failed"); exit(1) }

    var res: CFTypeRef?
    let err = AXUIElementCopyParameterizedAttributeValue(
        el, "AXReplaceRangeWithText" as CFString,
        ["AXReplacementRange": axRange, "AXReplacementText": new as CFString] as CFDictionary, &res)
    let after1 = (attr(el, kAXValueAttribute) as? String) ?? ""
    say("AXReplaceRangeWithText: err=\(err.rawValue) value after: \(after1.debugDescription)")
    if after1.contains(new) { say("→ atomic path WORKS on Spotlight"); exit(0) }

    say("atomic path no-op — trying selection transaction…")
    let e1 = AXUIElementSetAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, axRange)
    let e2 = AXUIElementSetAttributeValue(el, kAXSelectedTextAttribute as CFString, new as CFTypeRef)
    let after2 = (attr(el, kAXValueAttribute) as? String) ?? ""
    say("selection transaction: setRange=\(e1.rawValue) setText=\(e2.rawValue) value after: \(after2.debugDescription)")
    say(after2.contains(new) ? "→ selection path WORKS on Spotlight" : "→ NEITHER write path works")

default:
    say("unknown mode \(mode) — modes: activation | watch | focus | write")
    exit(1)
}
