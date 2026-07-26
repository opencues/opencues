// Hotkey-capture probe — can the AX bridge see (and swallow) the cycling
// chords? AX delivers focus/value/cursor events but NEVER keystrokes, so
// cycling on native mac apps needs a separate key channel. This measures the
// candidate before any of it is wired into ax-bridge.swift.
//
// Approach under test: CGEventTap at the session level. We already hold the
// Accessibility grant (the AX bridge requires it), which is what an ACTIVE
// tap needs — the alternative, Carbon RegisterEventHotKey, always swallows
// its chord process-wide and can't decide per-focus, so the tap is tried
// first.
//
// Usage:
//   swiftc -O -o /tmp/hotkey-probe hotkey-probe.swift -framework ApplicationServices
//   /tmp/hotkey-probe [timeout-seconds]
// Then press Ctrl+Option+↑ (or have another process post it). Prints one
// JSON line per captured chord and whether it was swallowed.

import Foundation
import ApplicationServices
import CoreGraphics

let timeoutSecs = Double(CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "10") ?? 10

func out(_ obj: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: obj),
          let s = String(data: d, encoding: .utf8) else { return }
    print(s); fflush(stdout)
}

// Arrow key codes (Carbon kVK_*): ←123 →124 ↓125 ↑126
let ARROWS: [Int64: String] = [126: "up", 125: "down", 123: "left", 124: "right"]

out(["type": "probe-start", "trusted": AXIsProcessTrusted(), "timeoutSecs": timeoutSecs])

let callback: CGEventTapCallBack = { _, type, event, _ in
    // A tap can be disabled by the system (timeout / user input overload);
    // re-enabling is the caller's job, so surface it rather than dying quiet.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        out(["type": "tap-disabled", "reason": type == .tapDisabledByTimeout ? "timeout" : "user-input"])
        return Unmanaged.passUnretained(event)
    }
    let code = event.getIntegerValueField(.keyboardEventKeycode)
    let flags = event.flags
    let ctrl = flags.contains(.maskControl)
    let alt = flags.contains(.maskAlternate)
    guard let name = ARROWS[code], ctrl, alt else {
        return Unmanaged.passUnretained(event)   // not ours — pass through
    }
    out([
        "type": "key", "key": name,
        "modifiers": ["ctrl": ctrl, "alt": alt,
                      "shift": flags.contains(.maskShift), "meta": flags.contains(.maskCommand)],
        "swallowed": true,
    ])
    return nil   // consume: the focused app must NOT also act on the chord
}

guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .defaultTap,                                  // active tap → can consume
    eventsOfInterest: CGEventMask(1 << CGEventType.keyDown.rawValue),
    callback: callback,
    userInfo: nil
) else {
    out(["type": "fatal", "error": "tapCreate returned nil — the Accessibility/Input-Monitoring grant is missing for this process"])
    exit(1)
}

let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
out(["type": "tap-armed"])

DispatchQueue.global().asyncAfter(deadline: .now() + timeoutSecs) {
    out(["type": "probe-end", "reason": "timeout"])
    exit(0)
}
CFRunLoopRun()
