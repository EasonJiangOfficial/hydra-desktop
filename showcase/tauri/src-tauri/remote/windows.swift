// The on-screen windows (id, pid, bundle id, app, title, bounds, the front window's document or address), read every
// 100 ms and sent only when they change. The sidecar decides what is hidden (safety.mjs): this helper holds no list.
import AppKit
import ApplicationServices

enum Windows {
    static var bundles: [pid_t: String] = [:]
    static func bundle(_ pid: pid_t) -> String {
        if let b = bundles[pid] { return b }
        let b = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? ""
        bundles[pid] = b
        return b
    }

    /// The front app's focused window: its file (AXDocument) or, in a browser, its address.
    static func front() -> (pid: pid_t, doc: String)? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        let ax = AXUIElementCreateApplication(app.processIdentifier)
        guard let w = Hit.attr(ax, kAXFocusedWindowAttribute), let d = Hit.attr(w as! AXUIElement, kAXDocumentAttribute) as? String else { return (app.processIdentifier, "") }
        return (app.processIdentifier, String(d.prefix(500)))
    }

    /// skip: our own windows (the pill), never classified and never a shield.
    static func list(skip: Set<Int>) -> [[String: Any]] {
        guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
        let fr = front()
        var out: [[String: Any]] = [], seenFront = false
        for w in raw {
            guard let id = w[kCGWindowNumber as String] as? Int, !skip.contains(id),
                  let pid = (w[kCGWindowOwnerPID as String] as? Int).map({ pid_t($0) }),
                  let bd = w[kCGWindowBounds as String] as? NSDictionary, let b = CGRect(dictionaryRepresentation: bd),
                  (w[kCGWindowAlpha as String] as? Double ?? 1) > 0, b.width >= 1, b.height >= 1 else { continue }
            let owner = w[kCGWindowOwnerName as String] as? String ?? ""
            if owner == "Window Server" { continue }
            // The Dock's and WindowManager's own windows (Mission Control, App Exposé, Stage Manager, Launchpad) draw
            // thumbnails of other windows away from their frames: sent as overlays, never classified or a key target.
            if owner == "Dock" || owner == "WindowManager" {
                out.append(["id": id, "pid": Int(pid), "app": owner, "overlay": true, "bounds": [b.minX, b.minY, b.width, b.height].map { Double($0) }, "layer": w[kCGWindowLayer as String] as? Int ?? 0])
                continue
            }
            var item: [String: Any] = ["id": id, "pid": Int(pid), "bundle": bundle(pid), "app": owner, "title": w[kCGWindowName as String] as? String ?? "",
                                       "bounds": [b.minX, b.minY, b.width, b.height].map { Double($0) }, "layer": w[kCGWindowLayer as String] as? Int ?? 0]
            // The front app's first normal window is its focused one (the list is front to back).
            if let fr, !seenFront, fr.pid == pid, (item["layer"] as? Int) == 0 {
                seenFront = true
                item["front"] = true
                if !fr.doc.isEmpty { if fr.doc.hasPrefix("file:") { item["document"] = URL(string: fr.doc)?.path ?? fr.doc } else { item["url"] = fr.doc } }
            }
            out.append(item)
        }
        if let fr, !seenFront { markFront(&out, pid: fr.pid) }
        return out
    }

    /// The front app has no normal window (a password manager's floating Quick Access panel, say): its first window,
    /// at any layer, is the front one, so no key goes to it from the phone.
    static func markFront(_ out: inout [[String: Any]], pid: pid_t) {
        if let i = out.firstIndex(where: { ($0["pid"] as? Int) == Int(pid) }) { out[i]["front"] = true }
    }

    /// A list's identity, to send only on a change.
    static func key(_ l: [[String: Any]]) -> String {
        (try? JSONSerialization.data(withJSONObject: l, options: [.sortedKeys])).map { String(decoding: $0, as: UTF8.self) } ?? ""
    }
}
