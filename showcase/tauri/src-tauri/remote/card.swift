// The card rule's backstop (hasCardNumber and the tail in sidecar/remotepolicy.mjs), here in the helper: what the
// focused field reads after this input, from its own value and selection, read here and never sent. The sidecar's
// tail cannot see where a click put the cursor or what the field held before the session. A paste reads the
// clipboard's plain text the same way; only its digits go back to the sidecar (`pasted` on done), for the tail.
import AppKit
import ApplicationServices

/// A3's card reading (RUN in sidecar/hardlimits-core.mjs: digit groups and the separators between them), written here by
/// node test/swiftsync.mjs --write.
let CARD_RUN = try! NSRegularExpression(pattern: #"\d+(?:(?:\s*[.,:+x×*·•/_\-‐-―−]\s*|\s+)\d+)*"#, options: [])

enum Card {
    /// Every decimal digit in the text (any script, full-width too): a paste's digits, and the count once the field
    /// cannot be read.
    static func digits(_ s: String) -> [Int] {
        s.precomposedStringWithCompatibilityMapping.unicodeScalars.compactMap { u in
            u.properties.numericType == .decimal ? u.properties.numericValue.map { Int($0) } : nil
        }
    }
    static func luhn(_ d: ArraySlice<Int>) -> Bool {
        var sum = 0
        for (i, x) in d.reversed().enumerated() { var v = x; if i % 2 == 1 { v *= 2; if v > 9 { v -= 9 } }; sum += v }
        return sum % 10 == 0
    }
    /// A3's card brands (BRANDS in sidecar/hardlimits-core.mjs): each prefix and its lengths, written here by
    /// node test/swiftsync.mjs --write, so the backstop knows every card the sidecar's cardNumber knows.
    static let CARD_BRANDS: [(String, [Int])] = [("^4", [16, 19]), ("^(5[1-5]|2[2-7])", [16]), ("^3[47]", [15]), ("^3(0[0-5]|[689])", [14, 16]), ("^6(011|4[4-9]|5)", [16, 17, 18, 19]), ("^35(2[89]|[3-8])", [16, 17, 18, 19]), ("^62", [16, 17, 18, 19]), ("^(50|5[6-8]|6[37])", [13, 14, 15, 16, 17, 18, 19]), ("^220[0-4]", [16, 17, 18, 19]), ("^(60|65|81|82|508)", [16]), ("^(8600|9860)", [16]), ("^9792", [16]), ("^(506[01]|507[89]|650[0-2])", [16, 18, 19])]
    static func brand(_ d: ArraySlice<Int>) -> Bool {
        let s = d.map(String.init).joined(), n = d.count
        return CARD_BRANDS.contains { $0.1.contains(n) && s.range(of: $0.0, options: .regularExpression) != nil }
    }
    /// The text with every decimal digit (any script, full-width too: NFKC) as its ASCII digit.
    static func ascii(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        for u in s.precomposedStringWithCompatibilityMapping.unicodeScalars {
            if u.properties.numericType == .decimal, let v = u.properties.numericValue { out.append(UnicodeScalar(UInt8(48 + Int(v)))) } else { out.append(u) }
        }
        return String(out)
    }
    /// A separator as it is written (sepOf in hardlimits-core.mjs): spaces alone are one space, ", " stays (a list),
    /// others lose their spaces (" - " is "-").
    static func sepOf(_ x: String) -> String {
        let t = x.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression), trimmed = t.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return " " }
        if trimmed == "," { return String(t.drop(while: { $0 == " " })) }
        return trimmed
    }
    static func matches(_ s: String, _ p: String) -> Bool { s.range(of: p, options: .regularExpression) != nil }
    /// How a card is written (cardGroups in hardlimits-core.mjs): whole, or in fours (the last one 1 to 4), Amex's
    /// 4-6-5, Diners' 4-6-4 or digit by digit, with one kind of separator; a comma or colon only between fours.
    static func groupsOK(_ g: [Int], _ seps: [String]) -> Bool {
        if g.count == 1 { return true }
        guard Set(seps).count == 1, let sep = seps.first, !sep.contains(", ") else { return false }
        let s = g.map(String.init).joined(separator: "-")
        if sep.contains(where: { $0 == "," || $0 == ":" }) && !matches(s, #"^(4-)+4$"#) { return false }
        return g.allSatisfy { $0 == 1 } || matches(s, #"^(4-)+[1-4]$"#) || (matches(s, #"^(4-){2,}[1-3]-[1-3]$"#) && g[g.count - 1] + g[g.count - 2] == 4) || s == "4-6-5" || s == "4-6-4"
    }
    /// A3's cardNumber (hardlimits-core.mjs) on ASCII digits: each run of digit groups (CARD_RUN) tried group-aligned,
    /// every 13-19 digit window written as a card, with a brand's prefix and length and Luhn. A run is never joined
    /// to the next value across a word, so three phone numbers in a note are no card.
    static func cardIn(_ text: String) -> Bool {
        let ns = text as NSString
        for m in CARD_RUN.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            var groups: [[Int]] = [], seps: [String] = [], cur: [Int] = [], sep = ""
            for u in ns.substring(with: m.range).unicodeScalars {
                if u.value >= 48 && u.value <= 57 {
                    if !sep.isEmpty { groups.append(cur); cur = []; seps.append(sepOf(sep)); sep = "" }
                    cur.append(Int(u.value) - 48)
                } else { sep.unicodeScalars.append(u) }
            }
            groups.append(cur)
            for i in groups.indices {
                var d: [Int] = []
                for j in i ..< groups.count {
                    d += groups[j]
                    if d.count > 19 { break }
                    if d.count >= 13 && groupsOK(groups[i ... j].map(\.count), Array(seps[i ..< j])) && brand(d[...]) && luhn(d[...]) { return true }
                }
            }
        }
        return false
    }
    /// A card number in the text, read as the sidecar's hasCardNumber reads it (remotepolicy.mjs): with format
    /// characters dropped or as spaces, each as written and as a card mask reads it (letters and marks dropped, any
    /// other separator a space). Release round 2: never every digit in the text joined.
    static func has(_ s: String) -> Bool {
        let n = s.precomposedStringWithCompatibilityMapping.unicodeScalars
        let dropped = String(String.UnicodeScalarView(n.filter { $0.properties.generalCategory != .format }))
        let spaced = String(String.UnicodeScalarView(n.map { $0.properties.generalCategory == .format ? " " : $0 }))
        return [dropped, spaced].contains { t in
            let a = ascii(t)
            var mask = String.UnicodeScalarView()
            for u in a.unicodeScalars {
                let c = u.properties.generalCategory
                if [.uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter, .nonspacingMark, .spacingMark, .enclosingMark].contains(c) { continue }
                mask.append((u.value >= 48 && u.value <= 57) || u.properties.isWhitespace ? u : " ")
            }
            return cardIn(a) || cardIn(String(mask))
        }
    }
    /// The digits of a paste, for the sidecar's tail (never the clipboard's words). The last 400.
    static func digitString(_ s: String) -> String { String(digits(s).map(String.init).joined().suffix(400)) }

    /// The one character a key types (keyChar in remotepolicy.mjs), or nil.
    static func keyChar(_ combo: String) -> String? {
        let parts = combo.lowercased().replacingOccurrences(of: " ", with: "").split(separator: "+", omittingEmptySubsequences: false).map(String.init)
        guard let key = parts.last, key.count == 1, !parts.dropLast().contains(where: { ["cmd", "command", "ctrl", "control"].contains($0) }) else { return nil }
        return key
    }

    static let W = 60 // UTF-16 units read on each side of the edit: room for a card and the letters a mask drops

    /// true: the input would leave a card number in the field that was not there. t, key, text: the input. paste: the
    /// clipboard's text when it pastes. field: the focused value and selection (UTF-16), nil when unreadable: then a
    /// paste is checked with the sidecar's tail, and typing too once the cursor moved (moved: the sidecar's own rule
    /// cannot tell where the cursor is then): a digit is refused once the tail, this input in it, holds 13 digits (the
    /// shortest card). Before a move, typing is left to the sidecar's rule.
    static func refuses(t: String, key: String, text: String, paste: String?, field: (String, NSRange)?, tail: String, moved: Bool = false) -> Bool {
        let ins: String? = paste ?? (t == "text" ? text : t == "key" ? keyChar(key) : nil)
        guard let (value, sel0) = field else {
            if let p = paste { return has(tail + p) && !has(tail) }
            if moved, let s = ins, !digits(s).isEmpty { return digits(tail).count >= 13 }
            return false
        }
        let v = value as NSString
        let loc = min(max(0, sel0.location), v.length), len = min(max(0, sel0.length), v.length - loc)
        let a = max(0, loc - W), b = min(v.length, loc + len + W)
        let pre = v.substring(with: NSRange(location: a, length: loc - a)), post = v.substring(with: NSRange(location: loc + len, length: b - loc - len))
        let before = pre + v.substring(with: NSRange(location: loc, length: len)) + post
        if has(before) { return false } // not this input's doing
        if let s = ins { return !digits(s).isEmpty && has(pre + s + post) }
        guard t == "key" else { return false }
        let parts = key.lowercased().replacingOccurrences(of: " ", with: "").split(separator: "+").map(String.init)
        let k = parts.last ?? "", mods = Set(parts.dropLast()), ctrl = mods.contains("ctrl") || mods.contains("control")
        let back = ["delete", "backspace"].contains(k) || (ctrl && k == "h"), fwd = ["fwddelete", "forwarddelete"].contains(k) || (ctrl && ["d", "k"].contains(k))
        guard back || fwd else { return false }
        if len > 0 { return has(pre + post) }
        let p = pre as NSString, q = post as NSString
        // One character, or (a word, a line: any other modifier) every cut that reaches the cursor.
        let plain = mods.isEmpty || (ctrl && mods.count == 1 && k != "k")
        if back {
            guard p.length > 0 else { return false }
            let one = p.rangeOfComposedCharacterSequence(at: p.length - 1)
            if plain { return has(p.substring(to: one.location) + post) }
            return (0 ..< p.length).contains { has(p.substring(to: $0) + post) }
        }
        guard q.length > 0 else { return false }
        let one = q.rangeOfComposedCharacterSequence(at: 0)
        if plain { return has(pre + q.substring(from: one.length)) }
        return (1 ... q.length).contains { has(pre + q.substring(from: $0)) }
    }

    /// The focused element's value and selected range, when it has both (a text field, a web input).
    static func field() -> (String, NSRange)? {
        guard let f = Hit.attr(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute) else { return nil }
        let e = f as! AXUIElement
        guard let v = Hit.attr(e, kAXValueAttribute) as? String, let r = Hit.attr(e, kAXSelectedTextRangeAttribute), CFGetTypeID(r) == AXValueGetTypeID() else { return nil }
        var cf = CFRange()
        guard AXValueGetValue(r as! AXValue, .cfRange, &cf) else { return nil }
        return (v, NSRange(location: cf.location, length: cf.length))
    }
    static func clipboard() -> String { NSPasteboard.general.string(forType: .string) ?? "" }
}
