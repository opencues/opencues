// AX hybrid spike (2026-07-12) — can the Accessibility API give the
// Notes integration a real editor channel: focused-note text, a true
// cursor, change NOTIFICATIONS (no polling), and in-place text
// replacement? Findings land in ../AX-SPIKE.md.
//
// Build:  swiftc -O ax-spike.swift -o /tmp/ax-spike
// Run:    /tmp/ax-spike tree|read|cursor|write <old> <new>|watch <secs>
//
// Requires Accessibility permission for the invoking context
// (AXIsProcessTrusted reports it).

import ApplicationServices
import AppKit

func fail(_ msg: String) -> Never {
    print("ERR: \(msg)")
    exit(1)
}

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(el, name as CFString, &v)
    return err == .success ? v : nil
}

func str(_ el: AXUIElement, _ name: String) -> String? {
    attr(el, name) as? String
}

func children(_ el: AXUIElement) -> [AXUIElement] {
    (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

/// Depth-first search for elements of a role.
func findAll(_ el: AXUIElement, role: String, depth: Int = 0, limit: Int = 10) -> [AXUIElement] {
    if depth > 12 { return [] }
    var out: [AXUIElement] = []
    if str(el, kAXRoleAttribute) == role { out.append(el) }
    for c in children(el) {
        if out.count >= limit { break }
        out.append(contentsOf: findAll(c, role: role, depth: depth + 1, limit: limit - out.count))
    }
    return out
}

func notesAppElement() -> (AXUIElement, pid_t) {
    guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.apple.Notes" })
    else { fail("Notes is not running") }
    return (AXUIElementCreateApplication(app.processIdentifier), app.processIdentifier)
}

/// The note BODY editor: the AXTextArea inside the split group's LAST
/// scroll area (sidebar and note list come first; a naive whole-window
/// walk crawls 342 note-list rows and takes ~29s — measured. Targeted:
/// <5ms). The search field is an AXTextField so role disambiguates.
func bodyTextArea() -> AXUIElement {
    let (app, _) = notesAppElement()
    guard let windows = attr(app, kAXWindowsAttribute) as? [AXUIElement], let win = windows.first
    else { fail("no Notes window") }
    guard let split = children(win).first(where: { str($0, kAXRoleAttribute) == "AXSplitGroup" })
    else { fail("no AXSplitGroup in the Notes window") }
    let scrolls = children(split).filter { str($0, kAXRoleAttribute) == "AXScrollArea" }
    for scroll in scrolls.reversed() {
        if let body = findAll(scroll, role: "AXTextArea", depth: 8, limit: 1).first { return body }
    }
    fail("no AXTextArea in any scroll area (is a note selected?)")
}

func describe(_ el: AXUIElement, _ pad: String, _ depth: Int, _ lines: inout [String]) {
    if depth > 8 || lines.count > 120 { return }
    let role = str(el, kAXRoleAttribute) ?? "?"
    let sub = str(el, kAXSubroleAttribute).map { "(\($0))" } ?? ""
    let desc = str(el, kAXDescriptionAttribute) ?? ""
    let id = str(el, "AXIdentifier") ?? ""
    lines.append("\(pad)\(role)\(sub) \(id.isEmpty ? "" : "#\(id)") \(desc.isEmpty ? "" : "— \(desc)")")
    for c in children(el) { describe(c, pad + "  ", depth + 1, &lines) }
}

let mode = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "read"

guard AXIsProcessTrusted() else {
    fail("this process is NOT AX-trusted — grant Accessibility to the invoking app first")
}

switch mode {
case "tree":
    let (app, pid) = notesAppElement()
    print("Notes pid \(pid)")
    var lines: [String] = []
    if let windows = attr(app, kAXWindowsAttribute) as? [AXUIElement] {
        for w in windows { describe(w, "", 0, &lines) }
    }
    print(lines.joined(separator: "\n"))

case "read":
    var t0 = Date()
    let body = bodyTextArea()
    let findMs = Int(-t0.timeIntervalSinceNow * 1000)
    t0 = Date()
    let value = str(body, kAXValueAttribute) ?? "<nil>"
    let readMs = Int(-t0.timeIntervalSinceNow * 1000)
    t0 = Date()
    _ = str(body, kAXValueAttribute)
    let rereadMs = Int(-t0.timeIntervalSinceNow * 1000)
    print("findMs=\(findMs) readMs=\(readMs) rereadMs=\(rereadMs) chars=\(value.count)")
    print("--- first 300 chars ---")
    print(String(value.prefix(300)))

case "cursor":
    let body = bodyTextArea()
    for _ in 0..<3 {
        let t0 = Date()
        var v: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(body, kAXSelectedTextRangeAttribute as CFString, &v)
        let ms = Int(-t0.timeIntervalSinceNow * 1000)
        if err == .success, let v = v, CFGetTypeID(v) == AXValueGetTypeID() {
            var range = CFRange()
            AXValueGetValue(v as! AXValue, .cfRange, &range)
            print("cursor: loc=\(range.location) len=\(range.length) (\(ms)ms)")
        } else {
            print("cursor read failed: \(err.rawValue) (\(ms)ms)")
        }
        usleep(300_000)
    }

case "write":
    // Replace first occurrence of <old> with <new> via range-selection +
    // AXSelectedText set — the formatting-preservation test.
    guard CommandLine.arguments.count == 4 else { fail("usage: write <old> <new>") }
    let old = CommandLine.arguments[2], new = CommandLine.arguments[3]
    let body = bodyTextArea()
    guard let value = str(body, kAXValueAttribute) else { fail("no AXValue") }
    guard let r = value.range(of: old) else { fail("'\(old)' not found in body") }
    // AX ranges are UTF-16 offsets.
    let loc = value.utf16.distance(from: value.utf16.startIndex, to: r.lowerBound.samePosition(in: value.utf16)!)
    let len = old.utf16.count
    var range = CFRange(location: loc, length: len)
    guard let axRange = AXValueCreate(.cfRange, &range) else { fail("range create") }
    let t0 = Date()
    let selErr = AXUIElementSetAttributeValue(body, kAXSelectedTextRangeAttribute as CFString, axRange)
    guard selErr == .success else { fail("set selection failed: \(selErr.rawValue)") }
    let setErr = AXUIElementSetAttributeValue(body, kAXSelectedTextAttribute as CFString, new as CFTypeRef)
    let ms = Int(-t0.timeIntervalSinceNow * 1000)
    guard setErr == .success else { fail("set selected text failed: \(setErr.rawValue)") }
    let after = str(body, kAXValueAttribute) ?? ""
    print("write ok in \(ms)ms; body now contains new text: \(after.contains(new))")

case "watch":
    let secs = CommandLine.arguments.count > 2 ? Int(CommandLine.arguments[2]) ?? 10 : 10
    let (_, pid) = notesAppElement()
    let body = bodyTextArea()
    var observer: AXObserver?
    guard AXObserverCreate(pid, { _, _, notification, _ in
        let ts = ISO8601DateFormatter().string(from: Date())
        print("\(ts) \(notification)")
        fflush(stdout)
    }, &observer) == .success, let obs = observer else { fail("observer create failed") }
    for n in [kAXValueChangedNotification, kAXSelectedTextChangedNotification, kAXUIElementDestroyedNotification] {
        let err = AXObserverAddNotification(obs, body, n as CFString, nil)
        print("subscribe \(n): \(err == .success ? "ok" : "err \(err.rawValue)")")
    }
    CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(obs), .defaultMode)
    print("watching for \(secs)s — type in the frontmost note…")
    fflush(stdout)
    CFRunLoopRunInMode(.defaultMode, CFTimeInterval(secs), false)
    print("done")

default:
    fail("unknown mode \(mode)")
}
