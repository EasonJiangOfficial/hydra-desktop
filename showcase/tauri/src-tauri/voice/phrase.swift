// How a heard word is compared with a word of the wake phrase or the sleep word (owner: "when I say 3 kill or say the
// starting phrase ... it works like 1/10 times"). The recogniser writes the same sound many ways: "3 kill" and "three
// kill", "Hydro" and "Hidra" for Hydra, "Goodnight" and "Good night". So both sides are normalised the same way:
// - words: lowercase, no apostrophes ("Hydra's" -> "hydras"), digits split off letters ("3kill" -> "3", "kill") and
//   numbers spelled out ("3" -> "three", "20" -> "twenty", "42" -> "four two");
// - a sound key per word (a small Metaphone: "hydra", "hydro", "hidra" -> "HTR"; "three" -> "0R"; "tree" -> "TR");
// - a word matches when it's the same word, has the same sound key, or (5 letters or more) differs by one sound and
//   at most two letters ("tree" for "three"). A sound more or less never matches: "compute" isn't "computer",
//   "hydrate" isn't "hydra". Words of 4 letters or fewer need the same sound key and the same vowel sound: "keel" and
//   "gill" are "kill", but "call", "cool" and "goal" aren't (the sleep word "3 kill" fired on "their call").
import Foundation

enum Spoken {
    private static let small = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
                                "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"]
    private static let tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]

    /// A number as it's said: 0 to 20 and the tens as words, others digit by digit ("42" -> "four two").
    static func number(_ digits: String) -> [String] {
        if let n = Int(digits), digits.count <= 2 {
            if n <= 20 { return [small[n]] }
            if n % 10 == 0 { return [tens[n / 10]] }
        }
        return digits.compactMap { $0.wholeNumberValue.map { small[$0] } }
    }

    /// Lowercased words without apostrophes, digits apart from letters and spelled out, with where each sits in the text.
    /// A spelled-out number keeps its digits' range for each of its words.
    static func words(_ text: String) -> [(word: String, range: Range<String.Index>)] {
        var out: [(word: String, range: Range<String.Index>)] = []
        var start: String.Index?, digits = false
        var i = text.startIndex
        func flush(_ end: String.Index) {
            guard let s = start else { return }
            let w = text[s ..< end].lowercased().filter { $0 != "'" && $0 != "\u{2019}" }
            if !w.isEmpty { if digits { for n in number(w) { out.append((n, s ..< end)) } } else { out.append((w, s ..< end)) } }
            start = nil
        }
        while true {
            let c: Character? = i == text.endIndex ? nil : text[i]
            let isDigit = c?.isNumber == true && c?.wholeNumberValue != nil
            let isLetter = c.map { $0.isLetter || (($0 == "'" || $0 == "\u{2019}") && start != nil && !digits) } ?? false
            if isDigit || isLetter {
                if start != nil && digits != isDigit { flush(i) }
                if start == nil { start = i; digits = isDigit }
            } else { flush(i) }
            if c == nil { break }
            i = text.index(after: i)
        }
        return out
    }

    /// A small Metaphone: the word's consonant sounds, a leading vowel as "A". "hydra" -> "HTR", "three" -> "0R".
    static func key(_ word: String) -> String {
        var w = Array(word.lowercased().filter { $0.isLetter && $0.isASCII })
        guard !w.isEmpty else { return "" }
        if w.count > 1, ["kn", "gn", "pn", "wr", "ps"].contains(String(w[0 ... 1])) { w.removeFirst() }
        if w[0] == "x" { w[0] = "s" }
        let vowels: Set<Character> = ["a", "e", "i", "o", "u", "y"]
        func at(_ i: Int) -> Character? { i >= 0 && i < w.count ? w[i] : nil }
        var out = ""
        var i = 0
        func put(_ s: String) { if out.last.map(String.init) != s || s == "A" && out.isEmpty { out += s } }
        while i < w.count {
            let c = w[i], next = at(i + 1)
            if vowels.contains(c) && c != "y" || c == "y" && (next == nil || !vowels.contains(next!)) {
                if i == 0 { out = "A" }
                i += 1; continue
            }
            switch c {
            case "b": if !(i == w.count - 1 && at(i - 1) == "m") { put("P") }
            case "c":
                if next == "h" { put("X"); i += 1 }
                else if let n = next, "eiy".contains(n) { put("S") }
                else if next == "k" { put("K"); i += 1 }
                else { put("K") }
            case "d": if next == "g", let n = at(i + 2), "eiy".contains(n) { put("J"); i += 1 } else { put("T") }
            // Always hard: "gill" sounds like "kill" (a soft g, "gin", is rare in what's said to Hydra).
            case "g":
                if next == "h" { if i == 0 { put("K") }; i += 1 } // "night", "though": silent
                else { put("K") }
            case "h":
                // Sounded only before a vowel and not after a consonant that takes it ("sh", "th" are handled there).
                if let n = next, vowels.contains(n), i == 0 || vowels.contains(at(i - 1)!) { put("H") }
            case "k", "q": put("K")
            case "p": if next == "h" { put("F"); i += 1 } else { put("P") }
            case "s":
                if next == "h" { put("X"); i += 1 }
                else if next == "c", at(i + 2) == "h" { put("SK"); i += 2 }
                else { put("S") }
            case "t":
                if next == "h" { put("0"); i += 1 }
                else if next == "c", at(i + 2) == "h" { i += 1 }
                else { put("T") }
            case "v": put("F")
            case "w": if let n = next, vowels.contains(n) { put("W") }
            case "x": put("KS")
            case "y": put("Y")
            case "z": put("S")
            default: put(String(c).uppercased())
            }
            i += 1
        }
        return out
    }

    /// The word's first vowel sound, roughly: "kill", "keel", "kiel" -> "i"; "call" -> "a"; "cool", "goal" -> "o".
    static func vowel(_ word: String) -> String {
        let w = Array(word.lowercased().filter { $0.isLetter && $0.isASCII })
        let vowels: Set<Character> = ["a", "e", "i", "o", "u", "y"]
        guard let s = w.indices.first(where: { vowels.contains(w[$0]) && (w[$0] != "y" || $0 > 0) }) else { return "" }
        let two = s + 1 < w.count ? String(w[s ... s + 1]) : String(w[s])
        if ["ee", "ea", "ie", "ey"].contains(two) || w[s] == "y" { return "i" }
        return String(w[s])
    }

    static func edits(_ a: String, _ b: String) -> Int {
        let a = Array(a), b = Array(b)
        if a.isEmpty || b.isEmpty { return max(a.count, b.count) }
        var prev = Array(0 ... b.count), cur = prev
        for i in 1 ... a.count {
            cur[0] = i
            for j in 1 ... b.count { cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1)) }
            swap(&prev, &cur)
        }
        return prev[b.count]
    }

    /// Whether a heard word stands for a wanted one (see the top of this file). A heard plural or possessive ("hydras")
    /// counts for the word without its s; a letter dropped or added inside the word, not at its ends, counts too
    /// ("hyra" for "hydra", never "compute" for "computer").
    static func same(_ heard: String, _ want: String) -> Bool {
        if heard == want { return true }
        if heard.count > want.count, heard.hasSuffix("s"), !want.hasSuffix("s"), same(String(heard.dropLast()), want) { return true }
        let kh = key(heard), kw = key(want)
        guard !kw.isEmpty else { return false }
        if kh == kw { return want.count >= 5 || vowel(heard) == vowel(want) }
        guard want.count >= 5 else { return false }
        if heard.count >= 4, heard.first == want.first, heard.last == want.last, edits(heard, want) <= 1 { return true }
        guard kh.count == kw.count, kw.count >= 2 else { return false }
        let subs = zip(kh, kw).filter { $0 != $1 }.count
        return subs <= 1 && edits(heard, want) <= 2
    }

    /// A looser match, for one word of a longer phrase whose other words are heard well ("Good night, Heidler",
    /// "Three girl"): the same first and last sound, and one sound more or less in between. Never a different sound:
    /// "Heather" isn't "Hydra", "call" isn't "kill"; nor a last sound lost: "idea" isn't "Hydra". A word's first "h" is
    /// often lost in a noisy room ("Good night, Idler" for "Good night, Hydra"), so that counts as the same first sound.
    static func near(_ heard: String, _ want: String) -> Bool {
        if same(heard, want) { return true }
        var kh = Array(key(heard)), kw = Array(key(want))
        guard kw.count >= 2 else { return false }
        // Without its h ("idra" for "hydra"), or with it and one sound more or less ("idler"); "every" isn't "hydra".
        let lostH = kw.first == "H" && kh.first == "A"
        if lostH { kw[0] = "A"; if kh == kw { return true } }
        guard kh.first == kw.first, kh.last == kw.last, kh.count != kw.count else { return false }
        return edits(String(kh), String(kw)) <= 1
    }

    /// Where `want` is heard in `words`, starting at word `i`: the index just past it, or nil. A wanted word may be heard
    /// as two ("good night" for "goodnight") and two wanted words as one ("goodnight" for "good night"). loose: one word
    /// of a phrase of two or more may be only near (see near), when another is heard as itself and has 5 letters or more.
    /// exact: every word as it is written (a word heard as two, or two as one, still counts), nothing near.
    static func follows(_ want: [String], in words: [String], at i: Int, loose: Bool = false, exact: Bool = false) -> Int? {
        var j = i, k = 0, nearUsed = false, strong = false
        let same: (String, String) -> Bool = exact ? { $0 == $1 } : { Spoken.same($0, $1) }
        while k < want.count {
            guard j < words.count else { return nil }
            if same(words[j], want[k]) { strong = strong || want[k].count >= 5; j += 1; k += 1; continue }
            if j + 1 < words.count, same(words[j] + words[j + 1], want[k]) { strong = strong || want[k].count >= 5; j += 2; k += 1; continue }
            if k + 1 < want.count, same(words[j], want[k] + want[k + 1]) { strong = true; j += 1; k += 2; continue }
            if loose, !exact, want.count >= 2, !nearUsed, near(words[j], want[k]) { nearUsed = true; j += 1; k += 1; continue }
            return nil
        }
        return !nearUsed || strong ? j : nil
    }
}

// ---------- --test-phrase: the word rules on their own ----------
enum PhraseTest {
    static func run() -> Int32 {
        var bad = 0
        func check(_ name: String, _ ok: Bool) { print("\(ok ? "ok" : "FAIL") \(name)"); if !ok { bad += 1 } }
        check("3 kill is three kill", Spoken.words("3 kill").map(\.word) == ["three", "kill"])
        check("3kill splits", Spoken.words("3kill!").map(\.word) == ["three", "kill"])
        check("20 is twenty, 42 is four two", Spoken.words("20 42").map(\.word) == ["twenty", "four", "two"])
        check("Hydra's is hydras", Spoken.words("Hydra's").map(\.word) == ["hydras"])
        check("hydra, hydro, hidra, heidra sound alike", Set(["hydra", "hydro", "hidra", "heidra", "hydre"].map(Spoken.key)).count == 1)
        for (h, w, want) in [("hydro", "hydra", true), ("hidra", "hydra", true), ("hydras", "hydra", true), ("hydrate", "hydra", false),
                             ("hyundai", "hydra", false), ("heather", "hydra", false), ("harry", "hydra", false), ("tree", "three", true),
                             ("compute", "computer", false), ("computr", "computer", true), ("nora", "nova", false), ("jervis", "jarvis", true),
                             ("travis", "jarvis", false), ("keel", "kill", true), ("skill", "kill", false), ("killed", "kill", false),
                             ("slip", "sleep", true), ("goodnight", "goodnight", true), ("hey", "hydra", false), ("hyra", "hydra", true),
                             ("gill", "kill", true), ("header", "hydra", true), ("heather", "hydra", false),
                             ("call", "kill", false), ("cool", "kill", false), ("goal", "kill", false), ("coal", "kill", false),
                             ("calls", "kill", false), ("kiel", "kill", true)] {
            check("\(h) \(want ? "is" : "isn't") \(w)", Spoken.same(h, w) == want)
        }
        let w = { (s: String) in Spoken.words(s).map(\.word) }
        check("good night is goodnight", Spoken.follows(w("goodnight hydra"), in: w("good night, Hydra"), at: 0) == 3)
        check("goodnight is good night", Spoken.follows(w("good night hydra"), in: w("Goodnight Hydra"), at: 0) == 2)
        check("one word of a phrase may be near: good night, Heidler", Spoken.follows(w("goodnight hydra"), in: w("Good night, Heidler."), at: 0, loose: true) == 3)
        check("free girl is three kill, loosely", Spoken.follows(w("3 kill"), in: w("Free girl."), at: 0, loose: true) == 2)
        check("but not strictly", Spoken.follows(w("3 kill"), in: w("Free girl."), at: 0) == nil)
        check("two near words aren't the phrase", Spoken.follows(w("3 kill"), in: w("we girl"), at: 0, loose: true) == nil)
        check("a lost h, loosely: good night, Idler", Spoken.follows(w("goodnight hydra"), in: w("Good night, Idler."), at: 0, loose: true) == 3)
        check("never for the name alone: either isn't Hydra", !Spoken.same("either", "hydra"))
        check("good night, every one isn't good night, Hydra", Spoken.follows(w("goodnight hydra"), in: w("Good night, every one."), at: 0, loose: true) == nil)
        check("a different sound isn't near: good night, Heather", Spoken.follows(w("goodnight hydra"), in: w("Good night, Heather."), at: 0, loose: true) == nil)
        check("a lost last sound isn't near: good night idea", Spoken.follows(w("goodnight hydra"), in: w("good night idea"), at: 0, loose: true) == nil)
        check("call isn't near kill: their call", Spoken.follows(w("3 kill"), in: w("it's their call"), at: 1, loose: true) == nil)
        check("a near word alone isn't a strong one: hey Harry", Spoken.follows(w("hey hydra"), in: w("hey harry"), at: 0, loose: true) == nil)
        // Build 4 E1 (C5): exact, while a turn runs, takes only the words themselves.
        check("exact: sleep least isn't sleep beast", Spoken.follows(w("sleep beast"), in: w("sleep least"), at: 0, exact: true) == nil)
        check("exact: the words themselves are", Spoken.follows(w("sleep beast"), in: w("Sleep, beast."), at: 0, exact: true) == 2)
        check("exact: good night is still goodnight", Spoken.follows(w("goodnight hydra"), in: w("good night Hydra"), at: 0, exact: true) == 3)
        check("exact: never a letter off (Hydro)", Spoken.follows(w("hydra sleep"), in: w("Hydro sleep"), at: 0, loose: true, exact: true) == nil)
        return bad == 0 ? 0 : 1
    }
}
