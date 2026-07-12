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
//   in:  {"cmd":"replace","id":3,"start":10,"length":1,"text":"…"}
//        {"cmd":"read"}
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
// Build: swiftc -O ax-bridge.swift -o dist/ax-bridge

import ApplicationServices
import AppKit

let MAX_CHARS = 200_000
let TEXT_ROLES: Set<String> = ["AXTextArea", "AXTextField", "AXComboBox"]

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

final class Bridge {
    var observer: AXObserver?
    var observedPid: pid_t = 0
    var focusedElement: AXUIElement?

    func start() {
        emit(["type": "ready", "trusted": AXIsProcessTrusted()])
        guard AXIsProcessTrusted() else { return }
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.attachTo(pid: app.processIdentifier)
        }
        if let front = NSWorkspace.shared.frontmostApplication {
            attachTo(pid: front.processIdentifier)
        }
    }

    func attachTo(pid: pid_t) {
        guard pid != getpid() else { return }
        if let obs = observer {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
            observer = nil
        }
        observedPid = pid
        var obs: AXObserver?
        let cb: AXObserverCallback = { _, element, notification, refcon in
            let bridge = Unmanaged<Bridge>.fromOpaque(refcon!).takeUnretainedValue()
            bridge.handle(notification as String, element)
        }
        guard AXObserverCreate(pid, cb, &obs) == .success, let o = obs else { return }
        observer = o
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        let appEl = AXUIElementCreateApplication(pid)
        AXObserverAddNotification(o, appEl, kAXFocusedUIElementChangedNotification as CFString, refcon)
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(o), .defaultMode)
        refocus(appEl)
    }

    /// Re-resolve the focused element and re-arm element observers.
    func refocus(_ appEl: AXUIElement) {
        guard let obs = observer else { return }
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        if let old = focusedElement {
            AXObserverRemoveNotification(obs, old, kAXValueChangedNotification as CFString)
            AXObserverRemoveNotification(obs, old, kAXSelectedTextChangedNotification as CFString)
            AXObserverRemoveNotification(obs, old, kAXUIElementDestroyedNotification as CFString)
            focusedElement = nil
        }
        guard let el = attr(appEl, kAXFocusedUIElementAttribute) else { emit(["type": "blur"]); return }
        let element = el as! AXUIElement
        let role = (attr(element, kAXRoleAttribute) as? String) ?? ""
        let subrole = (attr(element, kAXSubroleAttribute) as? String) ?? ""
        guard TEXT_ROLES.contains(role), subrole != "AXSecureTextField" else {
            emit(["type": "blur"])
            return
        }
        guard let value = attr(element, kAXValueAttribute) as? String, value.utf16.count <= MAX_CHARS else {
            emit(["type": "blur"])
            return
        }
        focusedElement = element
        replaceAttrWorks = nil // re-learn the write path per focused element
        AXObserverAddNotification(obs, element, kAXValueChangedNotification as CFString, refcon)
        AXObserverAddNotification(obs, element, kAXSelectedTextChangedNotification as CFString, refcon)
        AXObserverAddNotification(obs, element, kAXUIElementDestroyedNotification as CFString, refcon)
        let app = NSRunningApplication(processIdentifier: observedPid)
        emit([
            "type": "focus",
            "app": app?.localizedName ?? "?",
            "bundle": app?.bundleIdentifier ?? "?",
            "role": role,
            "value": value,
            "cursor": cursorOf(element),
        ])
    }

    func handle(_ notification: String, _ element: AXUIElement) {
        switch notification {
        case kAXFocusedUIElementChangedNotification as String:
            refocus(AXUIElementCreateApplication(observedPid))
        case kAXUIElementDestroyedNotification as String:
            if focusedElement != nil { focusedElement = nil; emit(["type": "blur"]) }
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
            emit(["type": "blur"]); return
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
            default: break
            }
        }
    }
    // stdin closed — daemon is gone.
    exit(0)
}

DispatchQueue.main.async { bridge.start() }
RunLoop.main.run()
