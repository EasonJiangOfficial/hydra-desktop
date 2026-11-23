// Hands-free triggers for Hydra (macOS), all on this Mac: nothing is recognised or sent until a take starts.
// - Awake: a double clap starts a take (like the talk keys), and so does the key phrase ("Hey Hydra").
// - Asleep: a double clap, a tap on the orb or the key phrase wakes it (W5 contract 4: "Yes, phrase wakes it"); the
//   phrase's take goes on at once.
// - While Hydra speaks: the owner talking over it (barge-in, once the recogniser has his words: BargeGate) or a clean
//   double clap stops the speech and starts a take.
//   The one mic (mic.swift) runs with macOS voice processing (echo cancellation) while interrupting is on, so Hydra's
//   own voice from the speakers is taken out, and a talk needs a sustained rise over the room for 200 ms, not one loud
//   frame. The talk detector is one more consumer of that mic, added while Hydra speaks.
import AVFoundation
import Foundation

enum Trigger {
    enum Event { case clap, phrase, voice }
    enum Act: Equatable { case wake, take, none }
    /// What a heard trigger does. clapTalk, phrase, barge: the panel's switches.
    static func decide(_ e: Event, asleep: Bool, speaking: Bool, clapTalk: Bool, phrase: Bool, barge: Bool) -> Act {
        if asleep { return e == .clap ? .wake : e == .phrase && phrase ? .take : .none }
        switch e {
        case .clap: return clapTalk || (speaking && barge) ? .take : .none
        case .phrase: return phrase ? .take : .none
        case .voice: return speaking && barge ? .take : .none
        }
    }
}

/// Someone starting to talk, from the mic's energy alone (no words), in 10 ms frames. The "bed" follows the loudest
/// recent sound: Hydra's own voice as it is left after echo cancellation, which starts before this listens (it runs
/// only while Hydra speaks) and is learned in the first half second. It rises at most 1 dB a frame and sinks 2 dB a
/// second, so the next sentence of Hydra's doesn't count as someone new. A talk: 15 of the last 25 frames at least 9 dB
/// over the bed (so not one loud frame, and a gap between syllables doesn't reset it). Fires once, then rests a second.
final class SpeechOnset {
    let rate: Double
    private let hop: Int
    private var frame: [Float] = []
    private var bed = -120.0 // dB
    private var recent: [Bool] = [], rest = 0, frames = 0
    static let rise = 9.0, window = 25, needed = 15, learnFrames = 50, floorDb = -60.0

    init(rate: Double) { self.rate = rate; hop = max(64, Int(rate / 100)); frame.reserveCapacity(hop) }

    /// Mono samples (-1...1). True at the moment a talk is confirmed.
    func feed(_ samples: UnsafePointer<Float>, count: Int) -> Bool {
        var fired = false
        for i in 0 ..< count {
            frame.append(samples[i])
            if frame.count == hop { if step() { fired = true }; frame.removeAll(keepingCapacity: true) }
        }
        return fired
    }
    func feed(_ samples: [Float]) -> Bool { samples.withUnsafeBufferPointer { feed($0.baseAddress!, count: $0.count) } }

    private func step() -> Bool {
        var e: Float = 0
        for x in frame { e += x * x }
        let db = max(-120, 10 * log10(Double(e) / Double(hop) + 1e-12))
        frames += 1
        if frames <= Self.learnFrames { bed = max(bed - 0.02, db); return false }
        let loud = db > max(bed + Self.rise, Self.floorDb)
        if !loud { bed = db > bed ? min(db, bed + 1) : bed - 0.02 }
        recent.append(loud)
        if recent.count > Self.window { recent.removeFirst() }
        if rest > 0 { rest -= 1; return false }
        if recent.filter({ $0 }).count >= Self.needed { recent.removeAll(); rest = 100; return true }
        return false
    }
}

/// While Hydra speaks, what may stop it (build 4 C7; owner: "the agent speaks and is interupted by my laptop fans or
/// sounds not by my speach"). Energy alone never does: a talk onset (SpeechOnset) only opens a check, in which the
/// recogniser listens on this Mac while Hydra goes on; the check becomes a take (that stops Hydra) once it has heard
/// enough: two real words, a stop word ("wait", "stop"), or the wake phrase. A fan, a key, a click, a thump or a cough
/// makes no words, and the check ends quietly after `window` s. A clean double clap (clap.swift's rules while Hydra
/// speaks) is a take at once, as before.
struct BargeGate {
    enum Act: Equatable { case none, check, take, drop }
    static let window = 3.0
    static let fillers: Set<String> = ["um", "uh", "uhh", "umm", "hmm", "hm", "mm", "mmm", "mhm", "ah", "oh", "er", "erm", "huh", "eh"]
    static let stopWords: Set<String> = ["stop", "wait", "pause", "cancel", "enough", "quiet", "hold", "shush", "nevermind"]
    private(set) var since: Double?
    var checking: Bool { since != nil }
    /// The words that count: any with a letter that isn't a filler.
    static func realWords(_ text: String) -> [String] {
        Spoken.words(text).map(\.word).filter { w in w.contains(where: \.isLetter) && !fillers.contains(w) }
    }
    /// Enough to stop Hydra: two real words, a stop word, or the wake phrase.
    static func enough(_ text: String) -> Bool {
        let w = realWords(text)
        return w.count >= 2 || w.contains(where: stopWords.contains) || !w.isEmpty && WakeWord.match(text) != nil
    }
    /// A talk onset: opens a check (the recogniser starts listening), unless one is open.
    mutating func onset(now: Double) -> Act { guard since == nil else { return .none }; since = now; return .check }
    /// What the recogniser has heard so far in the check.
    mutating func heard(_ text: String, now: Double) -> Act {
        guard since != nil, Self.enough(text) else { return .none }
        since = nil
        return .take
    }
    /// Each frame: a check that heard too little in `window` s (or once Hydra stopped speaking for a second) ends.
    mutating func tick(now: Double, speakingAgo: Double = 0) -> Act {
        guard let t = since, now - t >= Self.window || speakingAgo >= 1 else { return .none }
        since = nil
        return .drop
    }
    mutating func end() { since = nil }
}

/// The talk detector as a consumer of the one mic tap while Hydra speaks: a fresh one (it learns the bed again) each
/// time it's added (reset).
final class BargeTap {
    private let lock = NSLock()
    private var det: SpeechOnset?
    var onTalk: () -> Void = {}
    func reset() { lock.lock(); det = nil; lock.unlock() }
    /// One buffer from the mic (audio thread).
    func feed(_ buffer: AVAudioPCMBuffer) {
        guard let ch = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
        lock.lock()
        if det == nil || det!.rate != buffer.format.sampleRate { det = SpeechOnset(rate: buffer.format.sampleRate) }
        let fired = det!.feed(ch, count: Int(buffer.frameLength))
        lock.unlock()
        if fired { let f = onTalk; DispatchQueue.main.async { f() } }
    }
}

extension BargeGate {
    /// The decisions Voice makes while Hydra speaks, on samples alone, the recogniser stubbed by `heard` (what it would
    /// have written so far): for --bench-claps and --test-triggers. Talk detection runs only with echo cancellation
    /// (Voice.syncMic) and its onset only opens a check; the clap detector runs with Hydra's speaking rules. True once
    /// Hydra is interrupted.
    static func interrupter(rate: Double, sensitivity: Double, echo: Bool) -> (_ chunk: [Float], _ now: Double, _ heard: String) -> Bool {
        let talk = SpeechOnset(rate: rate), clap = ClapDetector(rate: rate, sensitivity: sensitivity)
        clap.guarded = !echo; clap.speaking = true
        var gate = BargeGate()
        return { chunk, now, heard in
            if echo, talk.feed(chunk) { _ = gate.onset(now: now) }
            if gate.heard(heard, now: now) == .take { return true }
            _ = gate.tick(now: now)
            return clap.feed(chunk)
        }
    }
}

// ---------- --test-triggers: the decisions, and the talk detector on made-up sound ----------
enum TriggerTest {
    static func run() -> Int32 {
        var bad = 0
        func check(_ name: String, _ ok: Bool) { print("\(ok ? "ok" : "FAIL") \(name)"); if !ok { bad += 1 } }
        let d = { (e: Trigger.Event, asleep: Bool, speaking: Bool) in Trigger.decide(e, asleep: asleep, speaking: speaking, clapTalk: true, phrase: true, barge: true) }
        check("clap while awake starts a take", d(.clap, false, false) == .take)
        check("phrase while awake starts a take", d(.phrase, false, false) == .take)
        check("phrase while asleep wakes it and opens a take", d(.phrase, true, false) == .take)
        check("phrase off: the phrase while asleep does nothing", Trigger.decide(.phrase, asleep: true, speaking: false, clapTalk: true, phrase: false, barge: true) == .none)
        // W5 contract 4: the cursor visualizer only for a keyboard-shortcut take.
        check("the cursor shows a take from the talk keys", Voice.cursorShows(via: "keys"))
        for via in ["phrase", "clap", "tap", "barge", "listen", "pointer", "idle"] { check("the cursor never shows a \(via) take", !Voice.cursorShows(via: via)) }
        check("wake listening is held only while Hydra speaks (thinking: the phrase adds on)", Voice.wakeHeld(hold: true, speaking: true) && !Voice.wakeHeld(hold: true, speaking: false) && !Voice.wakeHeld(hold: false, speaking: true))
        check("clap while asleep wakes", d(.clap, true, false) == .wake)
        check("talking over Hydra starts a take (and the take stops the speech)", d(.voice, false, true) == .take)
        check("a clap while Hydra speaks starts a take", d(.clap, false, true) == .take)
        check("talking while Hydra is quiet does nothing (the key phrase is for that)", d(.voice, false, false) == .none)
        check("talking while asleep does nothing", d(.voice, true, true) == .none)
        check("clap-to-talk off: a clap while awake and quiet does nothing", Trigger.decide(.clap, asleep: false, speaking: false, clapTalk: false, phrase: true, barge: true) == .none)
        check("key phrase off: the phrase does nothing", Trigger.decide(.phrase, asleep: false, speaking: false, clapTalk: true, phrase: false, barge: true) == .none)
        check("interrupt off: talking over Hydra does nothing", Trigger.decide(.voice, asleep: false, speaking: true, clapTalk: true, phrase: true, barge: false) == .none)
        // The start order: the mic a stuck default can't open ('!dev') falls through to the next one, as a take does.
        var tried = [AudioDeviceID?]()
        let got = InputDevice.firstOpening(InputDevice.tries(picked: nil, current: 3, builtIn: 4)) { d -> AudioDeviceID? in tried.append(d); return d == nil ? nil : d }
        check("the mic tries the next one when the system's choice fails", got == 3 && tried == [nil, 3])
        check("a picked mic is the only one it tries", InputDevice.firstOpening(InputDevice.tries(picked: 7, current: 3, builtIn: 4)) { d -> AudioDeviceID? in d == 7 ? nil : d } == nil)
        check("clap-to-talk off still wakes from sleep", Trigger.decide(.clap, asleep: true, speaking: false, clapTalk: false, phrase: false, barge: false) == .wake)

        // The talk detector. "Playback" is Hydra's voice as it reaches the mic after echo cancellation (about 25 dB
        // down, with its own ups and downs); "voice" is the owner starting to talk, close to the mic.
        for rate in [48000.0, 16000.0] {
            var rng = ClapTest.Rng(s: 11)
            func onsetAt(_ buf: [Float]) -> Double? {
                let det = SpeechOnset(rate: rate)
                var i = 0
                while i < buf.count { let j = min(buf.count, i + 512); if det.feed(Array(buf[i ..< j])) { return Double(j) / rate }; i = j }
                return nil
            }
            func playback(_ secs: Double, level: Float) -> [Float] {
                var b = ClapTest.room(secs, rate: rate, rng: &rng)
                ClapTest.speech(&b, from: 0, to: secs, rate: rate, rng: &rng, level: level)
                return b
            }
            let r = Int(rate)
            check("\(r) Hz: a quiet room never fires", onsetAt(ClapTest.room(6, rate: rate, rng: &rng)) == nil)
            check("\(r) Hz: Hydra's voice from the speakers (after echo cancellation) never fires", onsetAt(playback(8, level: 0.02)) == nil)
            check("\(r) Hz: even with echo left louder than usual", onsetAt(playback(8, level: 0.05)) == nil)
            var click = playback(4, level: 0.02)
            ClapTest.clap(&click, at: 2.0, rate: rate, peak: 0.8, rng: &rng)
            check("\(r) Hz: one loud knock while Hydra speaks never fires", onsetAt(click) == nil)
            var talk = playback(6, level: 0.02)
            var voice = [Float](repeating: 0, count: talk.count)
            ClapTest.speech(&voice, from: 3.0, to: 5.5, rate: rate, rng: &rng, level: 0.3)
            for i in 0 ..< talk.count { talk[i] += voice[i] }
            let at = onsetAt(talk)
            check("\(r) Hz: the owner talking over Hydra fires within 300 ms (\(at.map { String(format: "%.0f ms", ($0 - 3.0) * 1000) } ?? "never"))", at.map { $0 >= 3.0 && $0 - 3.0 <= 0.3 } ?? false)
            // Build 4 C7, end to end with the recogniser stubbed: what stops Hydra while it speaks (echo cancelled).
            func stops(_ buf: [Float], _ words: [(Double, String)], echo: Bool = true, k: Double = 0.8) -> Double? {
                let f = BargeGate.interrupter(rate: rate, sensitivity: k, echo: echo)
                var i = 0
                while i < buf.count {
                    let j = min(buf.count, i + 512), now = Double(j) / rate
                    if f(Array(buf[i ..< j]), now, words.last { $0.0 <= now }?.1 ?? "") { return now }
                    i = j
                }
                return nil
            }
            var fan = playback(8, level: 0.02); ClapTest.fan(&fan, from: 0.5, to: 7.5, rate: rate, level: 0.004, rng: &rng)
            check("\(r) Hz: a fan spinning up while Hydra speaks never stops it (the recogniser hears \"Hmm.\")", stops(fan, [(1, "Hmm.")]) == nil)
            var keys = playback(8, level: 0.02)
            for t in stride(from: 0.8, to: 7.5, by: 0.21) { ClapTest.key(&keys, at: t, rate: rate, peak: 0.06, rng: &rng) }
            check("\(r) Hz: typing while Hydra speaks never stops it", stops(keys, []) == nil)
            var cough = playback(6, level: 0.02); ClapTest.speech(&cough, from: 3.0, to: 3.5, rate: rate, rng: &rng, level: 0.3)
            check("\(r) Hz: a sound that makes one filler (\"Uh.\") never stops it", stops(cough, [(3.4, "Uh.")]) == nil)
            check("\(r) Hz: nor one word that isn't a stop word (\"the\")", stops(cough, [(3.4, "the")]) == nil)
            for word in ["Wait.", "Stop", "Hold on"] {
                var said = playback(6, level: 0.02); ClapTest.speech(&said, from: 3.0, to: 3.5, rate: rate, rng: &rng, level: 0.3)
                let at = stops(said, [(3.45, word)])
                check("\(r) Hz: \"\(word)\" said over Hydra stops it once heard (\(at.map { String(format: "%.2f s", $0 - 3.0) } ?? "never"))", at.map { $0 >= 3.45 && $0 < 3.6 } ?? false)
            }
            var two = playback(6, level: 0.02); ClapTest.speech(&two, from: 3.0, to: 4.2, rate: rate, rng: &rng, level: 0.3)
            check("\(r) Hz: two real words stop it, one doesn't yet", stops(two, [(3.4, "Can"), (3.8, "Can you")]).map { $0 >= 3.8 } ?? false)
        }
        // The gate by itself.
        var g = BargeGate()
        check("an onset opens a check", g.onset(now: 0) == .check && g.checking)
        check("a second onset while checking does nothing", g.onset(now: 0.5) == .none)
        check("fillers aren't words", g.heard("Hmm, uh", now: 1) == .none && BargeGate.realWords("Um, uh, hmm.").isEmpty)
        check("too few words in 3 s: the check ends, Hydra goes on", g.tick(now: 2.9) == .none && g.tick(now: 3.0) == .drop && !g.checking)
        check("heard words count only in a check", g.heard("wait wait", now: 3.1) == .none)
        _ = g.onset(now: 10)
        check("Hydra stopped speaking a second ago: the check ends", g.tick(now: 10.5, speakingAgo: 1.0) == .drop)
        for (t, want) in [("wait", true), ("Stop.", true), ("hold on", true), ("Hey Hydra", true), ("I think", true), ("the", false), ("", false), ("Mm.", false)] {
            check("\"\(t)\" is \(want ? "" : "not ")enough to stop Hydra", BargeGate.enough(t) == want)
        }
        return bad == 0 ? 0 : 1
    }
}
