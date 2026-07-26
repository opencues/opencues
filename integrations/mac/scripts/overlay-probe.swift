// Overlay probe — can the AX bridge, a plain CLI with no app bundle, paint a
// click-through window over another app WITHOUT stealing focus?
//
// That is the second unknown for the dim/highlight overlay (the first,
// AXBoundsForRange → screen rects, is answered by bounds-probe.swift). A CLI
// has no NSApplication until something touches NSApplication.shared, and a
// window that activates or accepts clicks would be worse than no overlay at
// all: it would steal the caret the moment OpenCues tried to annotate it.
//
// Contract being measured:
//   - window appears above the focused app
//   - ignoresMouseEvents → clicks pass through to the app underneath
//   - .accessory activation policy → no Dock icon, no focus steal
//   - the frontmost app is UNCHANGED after showing it
//
// Usage:
//   swiftc -O -o /tmp/overlay-probe overlay-probe.swift -framework AppKit
//   /tmp/overlay-probe            # paints two rects for 3s, then exits

import AppKit
import Foundation

func out(_ o: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: o),
          let s = String(data: d, encoding: .utf8) else { return }
    print(s); fflush(stdout)
}

let frontBefore = NSWorkspace.shared.frontmostApplication?.localizedName ?? "?"

// Touching .shared creates the NSApplication; .accessory keeps us out of the
// Dock and stops the process from becoming active when a window is ordered in.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// AX rects are top-left origin (Quartz); NSWindow is bottom-left. Flip against
// the screen that CONTAINS the rect, not the main screen — a rect on a second
// display flips wrong otherwise.
func flip(_ r: CGRect) -> NSRect {
    let screen = NSScreen.screens.first { $0.frame.contains(CGPoint(x: r.midX, y: NSScreen.screens[0].frame.maxY - r.midY)) }
        ?? NSScreen.main ?? NSScreen.screens[0]
    let maxY = screen.frame.maxY
    return NSRect(x: r.origin.x, y: maxY - r.origin.y - r.size.height, width: r.size.width, height: r.size.height)
}

final class OverlayView: NSView {
    var dim: [NSRect] = []
    var hl: NSRect?
    override var isOpaque: Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedWhite: 0.5, alpha: 0.28).setFill()
        for r in dim { r.fill() }
        if let h = hl {
            NSColor(calibratedRed: 0.36, green: 0.61, blue: 0.96, alpha: 0.35).setFill()
            h.fill()
            NSColor(calibratedRed: 0.36, green: 0.61, blue: 0.96, alpha: 0.9).setStroke()
            NSBezierPath(rect: h.insetBy(dx: 0.5, dy: 0.5)).stroke()
        }
    }
}

let screen = NSScreen.main ?? NSScreen.screens[0]
// NSPanel, not NSWindow: .nonactivatingPanel is a panel-only style mask and
// NSWindow logs "does not support nonactivating panel styleMask 0x80" and drops
// it. orderFrontRegardless avoided activation anyway, but the panel makes the
// never-activate property structural rather than incidental.
let win = NSPanel(
    contentRect: screen.frame,
    styleMask: [.borderless, .nonactivatingPanel],
    backing: .buffered,
    defer: false
)
win.isOpaque = false
win.backgroundColor = .clear
win.hasShadow = false
win.ignoresMouseEvents = true                 // clicks pass through
win.level = .statusBar
win.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
let view = OverlayView(frame: screen.frame)
win.contentView = view

// Two sample rects in the top-left region — visible whatever is focused.
view.dim = [flip(CGRect(x: 220, y: 150, width: 120, height: 14)),
            flip(CGRect(x: 360, y: 150, width: 80, height: 14))]
view.hl = flip(CGRect(x: 220, y: 170, width: 90, height: 14))
win.orderFrontRegardless()                    // never activates the process
view.needsDisplay = true

out(["stage": "shown", "frontBefore": frontBefore,
     "policy": "accessory", "ignoresMouseEvents": true])

DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
    let frontAfter = NSWorkspace.shared.frontmostApplication?.localizedName ?? "?"
    out(["stage": "done",
         "frontAfter": frontAfter,
         "focusStolen": frontAfter != frontBefore,
         "windowVisible": win.isVisible])
    exit(0)
}
RunLoop.main.run()
