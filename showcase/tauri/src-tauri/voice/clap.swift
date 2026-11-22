// Double-clap for Hydra (macOS): asleep it wakes Hydra, awake (clap-to-talk) it starts a take, while Hydra speaks it
// interrupts. It runs on the one mic tap (mic.swift) whenever it's on, asleep included, and looks only at the sound's
// energy, 100 frames a second. No words, no recording, no network.
//
// Per 10 ms frame: the energy in dB, a noise floor that follows the room (down fast, up over a few seconds), and how
// high the sound is (the first difference's share of the energy, as a frequency). A clap is a transient:
// - a sharp onset: louder than `level` dBFS, `rise` dB over the room's floor, and 9 dB over the 30 ms just before it
//   (so a clap over someone talking still counts);
// - bright: mostly above 900 Hz (a knock, a kick drum or a thump is low);
// - short: 60 to 100 ms after it, 6 dB down from its peak (a word, a note or a door keeps sounding). A room's ring-out
//   below that is fine.
// A double clap is two transients 0.15 to 0.8 s apart, with no other transient for 0.6 s before the first and 0.45 s
// after the second (typing and music make many). Sounds that aren't transients (talk) don't break it up.
// Low, Medium and High (the panel's sensitivity, 0.2 / 0.5 / 0.8) set `level` and `rise`; the panel's "Clap twice"
// measures the owner's own claps in his room and sets them from those instead (calibration).
import AVFoundation
import Foundation

final class ClapDetector {
    /// The owner's own claps, measured by "Clap twice": their quieter peak (dBFS) and rise (dB).
    struct Calibration: Equatable { var peakDb: Double; var riseDb: Double }
    /// 0 (only loud, close claps) to 1 (softer claps from across the room). 0.5 by default.
    var sensitivity: Double { didSet { sensitivity = min(1, max(0, sensitivity)) } }
    var calibration: Calibration?
    /// Calibrating: every transient is reported (onTransient) whatever its level, and nothing wakes.
    var calibrating = false
    let rate: Double
    private let hop: Int
    private var frame: [Float] = []
    private(set) var now = 0.0 // seconds of sound seen
    private(set) var floorDb = -70.0
    private var recent: [Double] = [-120, -120, -120] // the last three frames' dB, newest last
    private var holdFloorUntil = 0.0 // the floor doesn't learn from a clap or its ring-out
    static var debug = ProcessInfo.processInfo.environment["CLAP_DEBUG"] != nil
    /// A local log line per candidate peak: its level and why it was taken or turned down (audio thread).
    var onCandidate: ((String) -> Void)?
    /// Each transient's peak and rise (audio thread), for calibration.
    var onTransient: ((Double, Double) -> Void)?
    /// The loudest frame since the meter last read it (meterRead), for the panel's live clap level.
    private var meterPeak = -120.0
    private var lastLine = -10.0, linesThisSecond = 0

    // An onset waiting to show it dies away like a clap.
    // inner: another sharp onset came inside its window (keys typed close together).
    private struct Pending { var t: Double; var peak: Double; var rise: Double; var hz: Double; var frames: Int; var tail: Double; var inner = false }
    private var pending: Pending?
    private var lastTransient = -10.0
    private enum State { case idle, one(Double, Double), two(Double, Double) }
    private var state = State.idle
    private var coolUntil = 0.0

    static let minGap = 0.15, maxGap = 0.8, quietBefore = 0.6, quietAfter = 0.45, flam = 0.15
    static let decayDb = 6.0, brightHz = 900.0, jumpDb = 9.0
    /// "Clap twice" never calibrates to a pair quieter than this (a keystroke, a cup set down): it asks again (R11-6).
    static let minCalPeakDb = -45.0

    enum CalPick: Equatable { case none, soft, set(Calibration) }
    /// "Clap twice": the newest transient and one 0.15 to 1.5 s before it are the owner's claps; the quieter one's peak and
    /// rise set the calibration (a softer clap still counts at Medium). .soft when that peak is under minCalPeakDb.
    static func pickCalibration(_ heard: [(t: Double, peak: Double, rise: Double)]) -> CalPick {
        guard let last = heard.last, let first = heard.dropLast().last(where: { last.t - $0.t >= 0.15 && last.t - $0.t <= 1.5 }) else { return .none }
        let c = Calibration(peakDb: min(first.peak, last.peak), riseDb: min(first.rise, last.rise))
        return c.peakDb < minCalPeakDb ? .soft : .set(c)
    }

    init(rate: Double, sensitivity: Double = 0.5, calibration: Calibration? = nil) {
        self.rate = rate
        self.sensitivity = min(1, max(0, sensitivity))
        self.calibration = calibration
        hop = max(64, Int(rate / 100))
        frame.reserveCapacity(hop)
    }

    /// The quietest clap peak that counts, in dBFS: -27 / -38 / -49 at Low / Medium / High; from the owner's own claps
    /// when calibrated (12 dB under them at Medium, so a softer clap still counts).
    var levelDb: Double {
        if let c = calibration { return c.peakDb - 6 - 12 * sensitivity }
        return -20 - 36 * sensitivity
    }
    /// How far a clap's onset must rise over the room and the moment before it: 18 / 15 / 12 dB.
    var riseDb: Double {
        if let c = calibration { return max(10, min(20, c.riseDb - 4 - 6 * (sensitivity - 0.5))) }
        return 20 - 10 * sensitivity
    }

    /// The loudest frame since the last read, then starts over.
    func meterRead() -> Double { defer { meterPeak = -120 }; return meterPeak }

    /// Feeds samples (mono, -1...1). True once a double clap is confirmed (the moment the quiet after it has passed).
    func feed(_ samples: UnsafePointer<Float>, count: Int) -> Bool {
        var woke = false
        for i in 0 ..< count {
            frame.append(samples[i])
            if frame.count == hop { if step() { woke = true }; frame.removeAll(keepingCapacity: true) }
        }
        return woke
    }

    func feed(_ samples: [Float]) -> Bool { samples.withUnsafeBufferPointer { feed($0.baseAddress!, count: $0.count) } }

    private func say(_ s: @autoclosure () -> String) {
        guard let out = onCandidate else { return }
        if now - lastLine >= 1 { lastLine = now; linesThisSecond = 0 }
        linesThisSecond += 1
        if linesThisSecond <= 4 { out(s()) }
    }

    private func step() -> Bool {
        now += Double(hop) / rate
        var e: Float = 0, d: Float = 0, mean: Float = 0
        for x in frame { mean += x }
        mean /= Float(hop)
        var prev = frame[0] - mean
        for i in 0 ..< hop {
            let x = frame[i] - mean
            e += x * x
            if i > 0 { let dx = x - prev; d += dx * dx }
            prev = x
        }
        let db = max(-120, 10 * log10(Double(e) / Double(hop) + 1e-12))
        let r = Double(d) / Double(max(e, 1e-12))
        let hz = rate / Double.pi * asin(min(1, sqrt(r) / 2))
        meterPeak = max(meterPeak, db)
        // The 30 ms before this frame, as one level (their mean power).
        let before = 10 * log10(recent.map { pow(10, $0 / 10) }.reduce(0, +) / Double(recent.count) + 1e-12)
        defer { recent.removeFirst(); recent.append(db) }
        if now <= Double(hop) / rate * 1.5 { floorDb = db } // the first frame sets the room's level
        if Self.debug, db - floorDb > 12 { print(String(format: "  t=%.3f db=%.1f floor=%.1f before=%.1f hz=%.0f", now, db, floorDb, before, hz)) }

        // Over the room by `rise`, and a sharp jump over the moment before (9 dB: over someone talking that's all a
        // clap can have; the word around it fails the decay instead).
        let rise = db - floorDb, jump = db - before
        let level = calibrating ? floorDb + 12 : levelDb
        let onset = rise >= (calibrating ? 10 : riseDb) && jump >= Self.jumpDb && db >= level
        if var p = pending {
            p.frames += 1
            // A much louder onset while a softer one is still being judged (a clap on top of a word): judge the new one.
            if p.frames > 2, onset, db > p.peak + 6 {
                say(String(format: "clap candidate %.1f dB: kept sounding (louder sound right after it)", p.peak))
                pending = Pending(t: now, peak: db, rise: jump, hz: hz, frames: 0, tail: -120)
                holdFloorUntil = now + 0.3
                return settle()
            }
            if p.frames > 3, jump >= riseDb, db >= level - 6, hz >= Self.brightHz { p.inner = true }
            if p.frames <= 2, db > p.peak { p.peak = db; p.hz = max(p.hz, hz) }
            if p.frames >= 6 && p.frames <= 10 { p.tail = max(p.tail, db) }
            pending = p
            if p.frames == 10 {
                pending = nil
                return judge(p)
            }
            return settle()
        }

        if onset, now >= coolUntil || calibrating {
            pending = Pending(t: now, peak: db, rise: jump, hz: hz, frames: 0, tail: -120)
            holdFloorUntil = now + 0.3
        } else if rise >= riseDb - 6, jump >= Self.jumpDb - 3, db >= level - 6, now > holdFloorUntil {
            say(String(format: "clap candidate %.1f dB (needs %.1f), %.1f dB over the room (needs %.1f), jump %.1f dB: %@", db, level, rise, riseDb, jump, db < level ? "too quiet" : rise < riseDb ? "too close to the room's level" : "no sharp rise"))
        }
        // The floor follows the room: down quickly, up slowly (about 3 s), never from a clap or its ring-out.
        if now > holdFloorUntil { floorDb += (db < floorDb ? 0.2 : 0.006) * (db - floorDb) }
        return settle()
    }

    /// An onset has had its 100 ms: was it a clap, and does it make a double clap?
    private func judge(_ p: Pending) -> Bool {
        let decay = p.peak - p.tail
        let line = String(format: "clap candidate %.1f dB (needs %.1f), rise %.1f dB, %.0f Hz, down %.1f dB in 100 ms", p.peak, calibrating ? floorDb + 12 : levelDb, p.rise, p.hz, decay)
        guard p.hz >= Self.brightHz else { say("\(line): dull (no high sound, a knock or a thump)"); return settle() }
        guard decay >= Self.decayDb else {
            // Sharp sounds one after another (typing): not a clap, and nothing around them is alone either.
            if p.inner, !calibrating { lastTransient = p.t; if case .two = state { state = .idle }; say("\(line): sharp sounds close together (typing?)") }
            else { say("\(line): kept sounding (a word, a note, a door)") }
            return settle()
        }
        // Calibrating: typing (another sharp onset inside its window) is still not a clap (R11-6).
        if calibrating, p.inner { say("\(line): sharp sounds close together (typing?)"); return settle() }
        if calibrating { onTransient?(p.peak, p.rise); say("\(line): heard (calibrating)"); return settle() }
        defer { lastTransient = p.t }
        let quiet = p.t - lastTransient
        switch state {
        case .idle:
            if quiet >= Self.quietBefore { state = .one(p.t, p.peak); say("\(line): first clap") }
            else { say("\(line): not alone (another sharp sound \(String(format: "%.2f", quiet)) s before)") }
        case .one(let t1, let peak1):
            let gap = p.t - t1
            if gap < Self.flam { say("\(line): part of the last clap"); return settle() }
            if gap <= Self.maxGap, abs(p.peak - peak1) <= 12 { state = .two(t1, p.t); say("\(line): second clap, \(String(format: "%.2f", gap)) s after the first") }
            else if gap <= Self.maxGap { state = .idle; say("\(line): second clap too unlike the first") }
            else { state = quiet >= Self.quietBefore ? .one(p.t, p.peak) : .idle; say("\(line): first clap (the last was \(String(format: "%.2f", gap)) s ago)") }
        case .two:
            state = .idle
            say("\(line): a third clap: not a double clap")
        }
        return settle()
    }

    private func settle() -> Bool {
        switch state {
        case .idle, .one: if case .one(let t1, _) = state, now - t1 > Self.maxGap + 0.1, pending == nil { state = .idle }; return false
        case .two(_, let t2):
            guard pending == nil, now - t2 >= Self.quietAfter else { return false }
            state = .idle
            coolUntil = now + 1
            say("double clap")
            return true
        }
    }
}

/// The clap detector as a consumer of the one mic tap (mic.swift): made at the mic's rate, set from the main thread.
final class ClapTap {
    private let lock = NSLock()
    private var det: ClapDetector?
    private var sensitivity = 0.5, calibration: ClapDetector.Calibration?, calibrating = false
    /// A double clap (main queue).
    var onClap: () -> Void = {}
    /// A transient while calibrating: its peak and rise (main queue).
    var onTransient: (Double, Double) -> Void = { _, _ in }
    /// Candidate lines go to the local log (voice log); off unless CLAP_LOG or calibrating.
    static var lines = ProcessInfo.processInfo.environment["CLAP_LOG"] != "0"

    func configure(sensitivity: Double, calibration: ClapDetector.Calibration?) {
        lock.lock(); self.sensitivity = sensitivity; self.calibration = calibration; det?.sensitivity = sensitivity; det?.calibration = calibration; lock.unlock()
    }
    func setCalibrating(_ on: Bool) { lock.lock(); calibrating = on; det?.calibrating = on; lock.unlock() }
    /// The live clap level for the panel: the loudest frame since the last read, the room's floor, what a clap needs.
    func meter() -> (db: Double, floor: Double, needs: Double)? {
        lock.lock(); defer { lock.unlock() }
        guard let d = det else { return nil }
        return (d.meterRead(), d.floorDb, d.levelDb)
    }

    /// One buffer from the mic (audio thread).
    func feed(_ buffer: AVAudioPCMBuffer) {
        guard let ch = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
        lock.lock()
        let rate = buffer.format.sampleRate
        if det == nil || det!.rate != rate {
            let d = ClapDetector(rate: rate, sensitivity: sensitivity, calibration: calibration)
            d.calibrating = calibrating
            if Self.lines { d.onCandidate = { log($0) } }
            let tell = onTransient
            d.onTransient = { p, r in DispatchQueue.main.async { tell(p, r) } }
            det = d
        }
        let fired = det!.feed(ch, count: Int(buffer.frameLength))
        lock.unlock()
        if fired { let f = onClap; DispatchQueue.main.async { f() } }
    }
}

// ---------- test signals (--test-clap, --bench) ----------

enum ClapTest {
    struct Rng { var s: UInt64; mutating func next() -> Float { s = s &* 6364136223846793005 &+ 1442695040888963407; return Float(Int64(bitPattern: s >> 11) % 2_000_000) / 1_000_000 - 1 } }

    /// A room: faint noise (about -62 dBFS).
    static func room(_ seconds: Double, rate: Double, rng: inout Rng, level: Float = 0.0012) -> [Float] {
        (0 ..< Int(seconds * rate)).map { _ in rng.next() * level }
    }

    /// One clap at `at` s: a noise burst brightened by a first difference, a 1 ms attack and ~8 ms decay, and a
    /// room's ring-out 25 dB down. lowpass > 0 dulls it like a laptop mic (one-pole, 0...1). reverb: a room's tail,
    /// (level under the peak, as a gain; RT60 in s), decaying noise as a real room's is.
    static func clap(_ buf: inout [Float], at: Double, rate: Double, peak: Float = 0.5, rng: inout Rng, lowpass: Float = 0, ring: Float = 0.05, reverb: (Float, Double)? = nil) {
        let start = Int(at * rate), n = Int((reverb.map { max(0.25, $0.1) } ?? 0.25) * rate)
        var last: Float = 0, lp: Float = 0
        for i in 0 ..< n where start + i < buf.count {
            let t = Double(i) / rate
            var env = Float(min(1, t / 0.001) * exp(-t / 0.008)) + ring * Float(exp(-t / 0.06))
            if let (g, rt) = reverb { env += g * Float(min(1, t / 0.004) * exp(-6.91 * t / rt)) }
            let w = rng.next(), hi = w - last; last = w
            lp = lowpass > 0 ? lp + (1 - lowpass) * (hi - lp) : hi
            buf[start + i] = max(-1, min(1, buf[start + i] + peak * env * lp * 0.7)) // a real mic clips
        }
    }

    /// Speech-like: syllables of a voiced sound (120 Hz with formant-ish harmonics), each opened by a short plosive burst.
    static func speech(_ buf: inout [Float], from: Double, to: Double, rate: Double, rng: inout Rng, level: Float = 0.25) {
        var t = from
        while t < to {
            let syl = 0.12 + Double(abs(rng.next())) * 0.14
            let s0 = Int(t * rate), n = Int(syl * rate)
            for i in 0 ..< n where s0 + i < buf.count {
                let x = Double(i) / rate
                let env = Float(min(1, x / 0.02) * min(1, (syl - x) / 0.03))
                var v: Float = 0
                for h in 1 ... 12 { let f = 120.0 * Double(h); let g = f < 900 ? 1.0 : 900 / f; v += Float(g * sin(2 * .pi * f * x)) / Float(h) }
                let burst: Float = x < 0.008 ? rng.next() * Float(1 - x / 0.008) * 1.2 : 0
                buf[s0 + i] += level * (env * v * 0.35 + burst)
            }
            t += syl + 0.03 + Double(abs(rng.next())) * 0.08
        }
    }

    /// Typing: key clicks (2 ms bright bursts) every 80 to 250 ms.
    static func typing(_ buf: inout [Float], from: Double, to: Double, rate: Double, rng: inout Rng, peak: Float = 0.3) {
        var t = from
        while t < to {
            clap(&buf, at: t, rate: rate, peak: peak * (0.6 + 0.4 * abs(rng.next())), rng: &rng, ring: 0)
            t += 0.08 + Double(abs(rng.next())) * 0.17
        }
    }

    /// Music: a chord held under a kick on every beat and a snare on 2 and 4 (120 bpm).
    static func music(_ buf: inout [Float], from: Double, to: Double, rate: Double, rng: inout Rng) {
        let s0 = Int(from * rate), s1 = min(buf.count, Int(to * rate))
        for i in s0 ..< s1 {
            let x = Double(i) / rate
            var v = 0.0
            for f in [220.0, 277.2, 329.6, 440.0] { v += 0.04 * sin(2 * .pi * f * x) }
            let beat = (x - from).truncatingRemainder(dividingBy: 0.5)
            v += 0.5 * exp(-beat / 0.08) * sin(2 * .pi * 60 * beat)
            buf[i] += Float(v)
        }
        var b = from + 0.5
        while b < to { clap(&buf, at: b, rate: rate, peak: 0.35, rng: &rng, ring: 0.3); b += 1.0 }
    }

    /// Music with a hi-hat on every eighth note as well (bright, short, 0.25 s apart).
    static func hats(_ buf: inout [Float], from: Double, to: Double, rate: Double, rng: inout Rng) {
        music(&buf, from: from, to: to, rate: rate, rng: &rng)
        var b = from + 0.25
        while b < to { clap(&buf, at: b, rate: rate, peak: 0.2, rng: &rng, ring: 0); b += 0.25 }
    }

    /// A knock or a door: a low thump (80 to 160 Hz) that dies in about 60 ms.
    static func knock(_ buf: inout [Float], at: Double, rate: Double, peak: Float = 0.6) {
        let start = Int(at * rate)
        for i in 0 ..< Int(0.2 * rate) where start + i < buf.count {
            let t = Double(i) / rate
            buf[start + i] += peak * Float(min(1, t / 0.002) * exp(-t / 0.03) * sin(2 * .pi * (160 - 400 * t) * t))
        }
    }

    static func wakes(_ buf: [Float], rate: Double, chunk: Int = 1024, sensitivity: Double = 0.5, calibration: ClapDetector.Calibration? = nil) -> Int {
        let det = ClapDetector(rate: rate, sensitivity: sensitivity, calibration: calibration)
        if ProcessInfo.processInfo.environment["CLAP_LINES"] != nil { det.onCandidate = { print(String(format: "    %.2f ", det.now) + $0) } }
        var n = 0, i = 0
        while i < buf.count { let j = min(buf.count, i + chunk); if det.feed(Array(buf[i ..< j])) { n += 1 }; i = j }
        return n
    }

    /// "Clap twice" on a recording: 1 when it would calibrate, 0 when not (none, or too soft).
    static func calibrates(_ buf: [Float], rate: Double) -> Int {
        let det = ClapDetector(rate: rate); det.calibrating = true
        if ProcessInfo.processInfo.environment["CLAP_LINES"] != nil { det.onCandidate = { print(String(format: "    %.2f ", det.now) + $0) } }
        var heard: [(t: Double, peak: Double, rise: Double)] = []
        det.onTransient = { heard.append((det.now, $0, $1)) }
        _ = det.feed(buf)
        if case .set = ClapDetector.pickCalibration(heard) { return 1 }
        return 0
    }

    static func run() -> Int32 {
        var bad = 0
        func check(_ name: String, _ got: Int, _ want: Int) {
            print("\(got == want ? "ok" : "FAIL") \(name): \(got) wake\(got == 1 ? "" : "s"), want \(want)")
            if got != want { bad += 1 }
        }
        for rate in [48000.0, 44100.0, 16000.0] {
            var rng = Rng(s: 7)
            func base() -> [Float] { room(4, rate: rate, rng: &rng) }
            let r = Int(rate)
            var b = base(); clap(&b, at: 1.0, rate: rate, rng: &rng); clap(&b, at: 1.45, rate: rate, rng: &rng)
            check("\(r) Hz: a double clap 0.45 s apart", wakes(b, rate: rate), 1)
            b = base(); clap(&b, at: 1.0, rate: rate, rng: &rng); clap(&b, at: 1.2, rate: rate, rng: &rng)
            check("\(r) Hz: a quick double clap (0.2 s)", wakes(b, rate: rate), 1)
            b = base(); clap(&b, at: 1.0, rate: rate, rng: &rng); clap(&b, at: 1.75, rate: rate, rng: &rng)
            check("\(r) Hz: a slow double clap (0.75 s)", wakes(b, rate: rate), 1)
            // Regression (owner: claps never woke it): a real room rings on for half a second after each clap.
            b = base(); clap(&b, at: 1.0, rate: rate, rng: &rng, reverb: (0.25, 0.6)); clap(&b, at: 1.4, rate: rate, rng: &rng, reverb: (0.25, 0.6))
            check("\(r) Hz: a double clap in a room that rings (RT60 0.6 s)", wakes(b, rate: rate), 1)
            // Recorded-style: a dull laptop mic, a long ring-out, a DC offset, quieter, and odd buffer sizes.
            b = room(4, rate: rate, rng: &rng, level: 0.003).map { $0 + 0.01 }
            clap(&b, at: 1.2, rate: rate, peak: 1.8, rng: &rng, lowpass: 0.85, ring: 0.12); clap(&b, at: 1.7, rate: rate, peak: 1.5, rng: &rng, lowpass: 0.85, ring: 0.12)
            check("\(r) Hz: a recorded-style double clap", wakes(b, rate: rate, chunk: 470), 1)
            b = room(5, rate: rate, rng: &rng); speech(&b, from: 0.3, to: 4.7, rate: rate, rng: &rng, level: 0.1)
            clap(&b, at: 2.0, rate: rate, peak: 1.2, rng: &rng); clap(&b, at: 2.4, rate: rate, peak: 1.2, rng: &rng)
            check("\(r) Hz: a double clap while someone talks", wakes(b, rate: rate), 1)
            b = base(); clap(&b, at: 1.0, rate: rate, rng: &rng)
            check("\(r) Hz: one clap", wakes(b, rate: rate), 0)
            b = base(); for t in [1.0, 1.45, 1.9] { clap(&b, at: t, rate: rate, rng: &rng) }
            check("\(r) Hz: three claps 0.45 s apart", wakes(b, rate: rate), 0)
            b = base(); for t in [0.6, 1.6, 2.6] { clap(&b, at: t, rate: rate, rng: &rng) }
            check("\(r) Hz: three claps 1 s apart", wakes(b, rate: rate), 0)
            b = base(); clap(&b, at: 1.0, rate: rate, rng: &rng); clap(&b, at: 1.08, rate: rate, rng: &rng)
            check("\(r) Hz: two claps too close (0.08 s)", wakes(b, rate: rate), 0)
            b = base(); clap(&b, at: 1.0, rate: rate, rng: &rng); clap(&b, at: 2.0, rate: rate, rng: &rng)
            check("\(r) Hz: two claps too far apart (1 s)", wakes(b, rate: rate), 0)
            b = base(); knock(&b, at: 1.0, rate: rate); knock(&b, at: 1.4, rate: rate)
            check("\(r) Hz: two knocks", wakes(b, rate: rate), 0)
            b = room(6, rate: rate, rng: &rng); speech(&b, from: 0.3, to: 5.7, rate: rate, rng: &rng)
            check("\(r) Hz: speech", wakes(b, rate: rate), 0)
            b = room(6, rate: rate, rng: &rng); speech(&b, from: 0.3, to: 5.7, rate: rate, rng: &rng, level: 0.6)
            check("\(r) Hz: loud speech", wakes(b, rate: rate), 0)
            b = room(6, rate: rate, rng: &rng); typing(&b, from: 0.3, to: 5.7, rate: rate, rng: &rng)
            check("\(r) Hz: typing", wakes(b, rate: rate), 0)
            b = room(6, rate: rate, rng: &rng); typing(&b, from: 0.3, to: 5.7, rate: rate, rng: &rng, peak: 0.6)
            check("\(r) Hz: loud typing", wakes(b, rate: rate), 0)
            b = room(8, rate: rate, rng: &rng); music(&b, from: 0.2, to: 7.8, rate: rate, rng: &rng)
            check("\(r) Hz: music with drums", wakes(b, rate: rate), 0)
            b = room(8, rate: rate, rng: &rng); hats(&b, from: 0.2, to: 7.8, rate: rate, rng: &rng)
            check("\(r) Hz: music with hi-hats", wakes(b, rate: rate), 0)
            b = base(); clap(&b, at: 1.0, rate: rate, peak: 0.03, rng: &rng); clap(&b, at: 1.45, rate: rate, peak: 0.03, rng: &rng)
            check("\(r) Hz: a faint double clap at Low", wakes(b, rate: rate, sensitivity: 0.2), 0)
            check("\(r) Hz: the same at High", wakes(b, rate: rate, sensitivity: 0.8), 1)
            // Calibrated to claps this faint, Medium hears them; calibrated to loud ones, it doesn't.
            check("\(r) Hz: the same, calibrated to the owner's faint claps", wakes(b, rate: rate, calibration: .init(peakDb: -36, riseDb: 26)), 1)
            check("\(r) Hz: the same, calibrated to loud claps", wakes(b, rate: rate, calibration: .init(peakDb: -6, riseDb: 50)), 0)
            // R11-6: "Clap twice" calibrates to a double clap, never to typing (two quick key pairs, 50 ms apart each).
            b = base(); clap(&b, at: 1.0, rate: rate, rng: &rng); clap(&b, at: 1.45, rate: rate, rng: &rng)
            check("\(r) Hz: calibrating to a double clap (calibrations)", calibrates(b, rate: rate), 1)
            b = base(); for t in [1.0, 1.05, 1.4, 1.45] { clap(&b, at: t, rate: rate, peak: 0.3, rng: &rng, ring: 0) }
            check("\(r) Hz: calibrating to two quick key pairs (calibrations)", calibrates(b, rate: rate), 0)
        }
        // R11-6: a pair quieter than -45 dB is too soft to calibrate to: it asks again.
        let soft = ClapDetector.pickCalibration([(1.0, -52, 20), (1.4, -50, 20)]) == .soft ? 0 : 1
        check("a pair at -52 / -50 dB is too soft (soft = 0 wakes)", soft, 0)
        let fine = ClapDetector.pickCalibration([(1.0, -36, 20), (1.4, -30, 22)]) == .set(.init(peakDb: -36, riseDb: 20)) ? 1 : 0
        check("a pair at -36 / -30 dB sets -36 dB, rise 20 (set = 1)", fine, 1)
        return bad == 0 ? 0 : 1
    }
}
