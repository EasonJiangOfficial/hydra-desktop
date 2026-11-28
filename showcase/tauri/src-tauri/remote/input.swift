// The phone's taps, drags, scrolls and keys as Mac events (RV plan section 5). plan() is pure (the self-test reads
// it); post() sends at the HID tap with the real cursor. New small code, not hands/main.swift (audit U3 may take it).
import CoreGraphics
import Foundation

enum Input {
    enum Step: Equatable {
        case mouse(CGEventType, CGPoint, CGMouseButton, Int64)   // type, global point, button, click count
        case scroll(CGPoint, Int32, Int32)                        // at, dy, dx (pixels)
        case key(CGKeyCode, CGEventFlags)
        case text(String)                                         // whole characters, at most 16 UTF-16 units
    }

    static let KEYS: [String: CGKeyCode] = ["return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
        "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117, "fwddelete": 117,
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
        "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37,
        "j": 38, "k": 40, "n": 45, "m": 46, "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101,
        "f10": 109, "f11": 103, "f12": 111, "=": 24, "-": 27, "/": 44, ".": 47, ",": 43, ";": 41, "'": 39, "[": 33, "]": 30, "\\": 42, "`": 50]

    /// "cmd+shift+z": every modifier the phone holds rides on the key (the Mac holds no modifier state). nil: unknown.
    static func parseKey(_ combo: String) -> (CGKeyCode, CGEventFlags)? {
        var flags: CGEventFlags = [], keys: [String] = []
        for p in combo.lowercased().replacingOccurrences(of: " ", with: "").split(separator: "+").map(String.init) {
            switch p {
            case "cmd", "command": flags.insert(.maskCommand)
            case "ctrl", "control": flags.insert(.maskControl)
            case "opt", "option", "alt": flags.insert(.maskAlternate)
            case "shift": flags.insert(.maskShift)
            default: keys.append(p)
            }
        }
        guard keys.count == 1, let k = KEYS[keys[0]] else { return nil }
        return (k, flags)
    }

    /// Typed text in pieces of whole characters (an emoji or a flag is never split, audit CU-16).
    static func chunks(_ s: String, max n: Int = 16) -> [String] {
        var out: [String] = [], cur = ""
        for ch in s {
            if !cur.isEmpty && cur.utf16.count + String(ch).utf16.count > n { out.append(cur); cur = "" }
            cur.append(ch)
        }
        if !cur.isEmpty { out.append(cur) }
        return out
    }

    /// x, y: 0 to 1 of the viewed display (frame: its global bounds, top-left). held: the left button is down (a drag).
    static func plan(_ m: [String: Any], frame: CGRect, held: Bool) -> [Step]? {
        let t = m["t"] as? String ?? ""
        let nx = min(1, max(0, (m["x"] as? Double) ?? 0)), ny = min(1, max(0, (m["y"] as? Double) ?? 0))
        let p = CGPoint(x: frame.minX + nx * frame.width, y: frame.minY + ny * frame.height)
        switch t {
        case "click":
            let right = (m["b"] as? String) == "r", count = (m["c"] as? Int) == 2 ? 2 : 1
            let (dn, upT, b): (CGEventType, CGEventType, CGMouseButton) = right ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
            // c:2 is the second tap of a double tap: the first already went as c:1, so only the count-2 click.
            let c = Int64(count)
            return [.mouse(.mouseMoved, p, .left, 0), .mouse(dn, p, b, c), .mouse(upT, p, b, c)]
        case "down": return [.mouse(.mouseMoved, p, .left, 0), .mouse(.leftMouseDown, p, .left, 1)]
        case "move": return [.mouse(held ? .leftMouseDragged : .mouseMoved, p, .left, held ? 1 : 0)]
        case "up": return [.mouse(.leftMouseUp, p, .left, 1)]
        case "scroll":
            let dx = Int32(clamping: Int(((m["dx"] as? Double) ?? 0).rounded())), dy = Int32(clamping: Int(((m["dy"] as? Double) ?? 0).rounded()))
            return [.mouse(.mouseMoved, p, .left, 0), .scroll(p, dy, dx)]
        case "key": return (m["k"] as? String).flatMap(parseKey).map { [.key($0.0, $0.1)] }
        case "text":
            let s = String((m["s"] as? String ?? "").prefix(200))
            return chunks(s).map { .text($0) }
        default: return nil
        }
    }

    /// A key or text that types into the focused field (the secure-field backstop).
    static func typing(_ t: String, _ combo: String) -> Bool {
        guard t != "text" else { return true }
        guard let (k, f) = parseKey(combo) else { return false }
        if k == 9 && f.contains(.maskCommand) { return true } // any cmd+v chord pastes (shift+cmd+v: Match Style)
        return !f.contains(.maskCommand) && !f.contains(.maskControl) && k < 51 && ![36, 48, 49].contains(k)
    }

    /// Any chord of cmd and v (Paste, Paste and Match Style).
    static func pastes(_ combo: String) -> Bool {
        guard let (k, f) = parseKey(combo) else { return false }
        return k == 9 && f.contains(.maskCommand)
    }

    /// A password manager's fill chord (autofillKey in remotepolicy.mjs: cmd+\\, cmd+shift+l, cmd+shift+space,
    /// cmd+shift+x, ctrl+y): refused on every remote key (it fills the page's login wherever focus is on the page).
    static func fillChord(_ combo: String) -> Bool {
        guard let (k, f) = parseKey(combo) else { return false }
        let cmdOrCtrl = f.contains(.maskCommand) || f.contains(.maskControl)
        return (cmdOrCtrl && k == 42) || (cmdOrCtrl && f.contains(.maskShift) && [37, 49, 7].contains(k)) || (f.contains(.maskControl) && k == 16)
    }
    /// A fill chord, or Up and Down (they pick from a browser's saved sign-ins): refused in a credential field.
    static func autofill(_ combo: String) -> Bool {
        guard let (k, _) = parseKey(combo) else { return false }
        return fillChord(combo) || [125, 126].contains(k)
    }

    static let src = CGEventSource(stateID: .hidSystemState)
    /// Check again after hover and between text chunks. Returning false stops later steps without replaying earlier ones.
    static func dispatch(_ steps: [Step], permit: (Step) -> Bool, emit: (Step) -> Bool) -> Bool {
        for step in steps { if !permit(step) || !emit(step) { return false } }
        return true
    }

    enum Outcome { case done, refused, partial }

    /// A release belongs to an already-sent down. It may balance that event when focus changes inside the same window.
    static func keyboardPair(emit: (Bool) -> Bool, current: () -> Bool, canRelease: () -> Bool) -> Outcome {
        guard emit(true) else { return .refused }
        let unchanged = current()
        guard canRelease(), emit(false) else { return .partial }
        return unchanged ? .done : .partial
    }

    @discardableResult
    static func post(_ steps: [Step], pid: pid_t? = nil, permit: (Step) -> Bool = { _ in true },
                     keyboardCleanup: () -> Bool = { false }, emitted: (Step) -> Void = { _ in }) -> Outcome {
        var keyDownSent = false
        let completed = dispatch(steps, permit: permit) { step in
            func send(_ event: CGEvent) {
                if let pid { event.postToPid(pid) } else { event.post(tap: .cghidEventTap) }
            }
            func keyboard(_ key: CGKeyCode, _ flags: CGEventFlags, _ text: String?, _ delay: useconds_t) -> Bool {
                guard pid != nil, keyboardCleanup() else { return false }
                let result = keyboardPair(emit: { down in
                    guard let event = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: down) else { return false }
                    if down, let text {
                        var units = Array(text.utf16)
                        event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
                    }
                    event.flags = flags
                    send(event)
                    if down { keyDownSent = true; emitted(step) }
                    return true
                }, current: { permit(step) }, canRelease: keyboardCleanup)
                if result == .done { usleep(delay) }
                return result == .done
            }
            switch step {
            case let .mouse(t, p, b, c):
                guard let e = CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: p, mouseButton: b) else { return false }
                if c > 0 { e.setIntegerValueField(.mouseEventClickState, value: c) }
                e.flags = []
                send(e)
                emitted(step)
                usleep(t == .mouseMoved || t == .leftMouseDragged ? 4_000 : 12_000)
            case let .scroll(p, dy, dx):
                guard let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else { return false }
                e.location = p
                send(e)
            case let .key(k, f):
                return keyboard(k, f, nil, 20_000)
            case let .text(str):
                return keyboard(0, [], str, 12_000)
            }
            return true
        }
        return completed ? .done : keyDownSent ? .partial : .refused
    }

    /// Every end path: a button the phone held goes up, so a dropped drag never leaves it down (T-D1-8).
    static func release(at p: CGPoint, button: CGMouseButton = .left, pid: pid_t? = nil) {
        post([.mouse(button == .left ? .leftMouseUp : .rightMouseUp, p, button, 1)], pid: pid)
    }
}
