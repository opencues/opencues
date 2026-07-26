// AXBoundsForRange probe — can we turn char ranges into screen rects?
//
// The graying/highlight overlay needs the same primitive the Windows shim gets
// from UIA's GetBoundingRectangles: given [start,end) char offsets into the
// focused element's value, produce screen rectangles to paint over. On macOS
// that is the parameterized attribute AXBoundsForRange (plus AXRangeForIndex /
// AXFrame as fallbacks). Support varies by toolkit — AppKit, WebKit and
// Electron all implement AX differently — so measure per app BEFORE building
// an overlay on top of it.
//
// Usage:
//   swiftc -O -o /tmp/bounds-probe bounds-probe.swift -framework ApplicationServices -framework AppKit
//   /tmp/bounds-probe            # probes whatever is focused right now
//
// Prints one JSON line: the focused app/role, the value length, and the rect
// for a few sample ranges — or the AXError that says it is unsupported.

import Foundation
import ApplicationServices
import AppKit

func out(_ o: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: o),
          let s = String(data: d, encoding: .utf8) else { return }
    print(s); fflush(stdout)
}

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

guard AXIsProcessTrusted() else {
    out(["error": "not trusted for Accessibility"]); exit(1)
}
guard let app = NSWorkspace.shared.frontmostApplication else {
    out(["error": "no frontmost app"]); exit(1)
}
let appEl = AXUIElementCreateApplication(app.processIdentifier)
guard let focused = attr(appEl, kAXFocusedUIElementAttribute) else {
    out(["error": "no focused element", "app": app.localizedName ?? "?"]); exit(1)
}
let el = focused as! AXUIElement
let role = (attr(el, kAXRoleAttribute) as? String) ?? "?"
let value = (attr(el, kAXValueAttribute) as? String) ?? ""

/// Ask for the screen rect of [start, start+len) — the primitive an overlay
/// needs. Returns the rect or the AXError name so an unsupported element is
/// distinguishable from an empty one.
func boundsFor(_ start: Int, _ len: Int) -> [String: Any] {
    var range = CFRange(location: start, length: len)
    guard let rangeValue = AXValueCreate(.cfRange, &range) else { return ["error": "AXValueCreate failed"] }
    var result: CFTypeRef?
    let err = AXUIElementCopyParameterizedAttributeValue(
        el, kAXBoundsForRangeParameterizedAttribute as CFString, rangeValue, &result)
    guard err == .success, let r = result, CFGetTypeID(r) == AXValueGetTypeID() else {
        return ["error": "AXError \(err.rawValue)"]
    }
    var rect = CGRect.zero
    AXValueGetValue(r as! AXValue, .cgRect, &rect)
    return ["x": rect.origin.x, "y": rect.origin.y, "w": rect.size.width, "h": rect.size.height]
}

var samples: [[String: Any]] = []
// Whole value, first word, and a mid-string slice — an element can support the
// attribute for one and fail for another (wrapped lines, multi-rect ranges).
for (label, start, len) in [("all", 0, value.utf16.count),
                            ("first5", 0, min(5, value.utf16.count)),
                            ("mid5", max(0, value.utf16.count / 2), min(5, value.utf16.count))] {
    if len <= 0 { continue }
    var s: [String: Any] = boundsFor(start, len)
    s["range"] = "\(label)[\(start),\(start + len))"
    samples.append(s)
}

out([
    "app": app.localizedName ?? "?",
    "bundle": app.bundleIdentifier ?? "?",
    "role": role,
    "valueLen": value.utf16.count,
    "supportsBoundsForRange": samples.contains { $0["error"] == nil },
    "samples": samples,
])
