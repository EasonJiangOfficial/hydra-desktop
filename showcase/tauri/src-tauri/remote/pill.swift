// The "Being viewed from your phone" pill (RV plan 6.3): top centre of the main display, 8 px under the menu bar,
// 280 x 28, white, hairline, round; a 6 px ink dot that breathes (still under reduced motion), the words, and End.
// It is in the capture's own process and shows before the first frame. End ends the session: the process exits.
import AppKit

final class Pill: NSObject {
    static let size = CGSize(width: 280, height: 28)
    let panel: NSPanel
    let words = NSTextField(labelWithString: "Being viewed from your phone")
    let onEnd: () -> Void

    /// Cocoa coordinates (bottom-left): centred, 8 px under the menu bar (the visible frame's top).
    static func frame(screen: CGRect, visible: CGRect) -> CGRect {
        CGRect(x: (screen.midX - size.width / 2).rounded(), y: visible.maxY - 8 - size.height, width: size.width, height: size.height)
    }

    init(onEnd: @escaping () -> Void) {
        self.onEnd = onEnd
        let main = NSScreen.screens.first ?? NSScreen.main
        let f = Pill.frame(screen: main?.frame ?? .zero, visible: main?.visibleFrame ?? .zero)
        panel = NSPanel(contentRect: f, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        // Hide Others (cmd+opt+H, which the phone may send) or hiding the helper would take the Mac's indicator away.
        panel.canHide = false
        let ink = NSColor(white: 0.07, alpha: 1)
        let box = NSView(frame: NSRect(origin: .zero, size: Pill.size))
        box.wantsLayer = true
        box.layer?.backgroundColor = NSColor.white.cgColor
        box.layer?.cornerRadius = Pill.size.height / 2
        box.layer?.borderWidth = 1
        box.layer?.borderColor = NSColor(white: 0, alpha: 0.12).cgColor
        let dot = NSView(frame: NSRect(x: 12, y: 11, width: 6, height: 6))
        dot.wantsLayer = true
        dot.layer?.backgroundColor = ink.cgColor
        dot.layer?.cornerRadius = 3
        if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            let a = CABasicAnimation(keyPath: "opacity")
            a.fromValue = 1; a.toValue = 0.35; a.duration = 1.2; a.autoreverses = true; a.repeatCount = .infinity
            dot.layer?.add(a, forKey: "breathe")
        }
        words.font = .systemFont(ofSize: 12, weight: .medium)
        words.textColor = ink
        words.frame = NSRect(x: 26, y: 6, width: 200, height: 16)
        let end = NSButton(title: "End", target: self, action: #selector(endTapped))
        end.isBordered = false
        end.font = .systemFont(ofSize: 12, weight: .semibold)
        end.contentTintColor = ink
        end.frame = NSRect(x: Pill.size.width - 52, y: 4, width: 42, height: 20)
        end.setAccessibilityLabel("End Phone View")
        [dot, words, end].forEach(box.addSubview)
        panel.contentView = box
    }

    var windowID: Int { panel.windowNumber }
    /// Global top-left points, for dropping a remote click that lands on it.
    var quartzFrame: CGRect {
        let h = NSScreen.screens.first?.frame.height ?? 0
        return CGRect(x: panel.frame.minX, y: h - panel.frame.maxY, width: panel.frame.width, height: panel.frame.height)
    }
    func show() { panel.orderFrontRegardless() }
    func hide() { panel.orderOut(nil) }
    func say(_ text: String) { words.stringValue = String(text.prefix(40)) }
    @objc func endTapped() { onEnd() }
}
