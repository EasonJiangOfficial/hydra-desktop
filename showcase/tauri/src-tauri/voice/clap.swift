// Double-clap wake for Hydra (macOS). While the Hydra Agent sleeps, speech recognition is off and nothing leaves the
// Mac; this keeps the mic open and looks only at the sound's energy, 100 frames a second: two sharp, broadband
// claps 0.25 to 0.8 s apart, with quiet before, between and after them, wake it. No words, no recording, no network.
//
// Per 10 ms frame: the energy in dB, an adaptive noise floor, and two cheap "how high is this sound" measures (zero
// crossings, and the energy of the first difference), each turned into a frequency so the rule doesn't depend on the
// sample rate. A clap: a jump of `rise` dB over the floor within one frame, louder than `loudest` dBFS, mostly above
// 1 kHz, and gone (12 dB down) within 60 ms. Speech (voiced, low, and sustained after a plosive), typing (many
// onsets close together), and music (sustained energy, beats in a row) fail one of those or the quiet-around check.
import AVFoundation
import Foundation

final class ClapDetector {
    /// 0 (only loud, close claps) to 1 (softer claps from across the room). 0.5 by default.
    var sensitivity: Double { didSet { sensitivity = min(1, max(0, sensitivity)) } }
    let rate: Double
    private let hop: Int
    private var frame: [Float] = []
    private(set) var now = 0.0 // seconds of sound seen
    private var floorDb = -70.0
    private var prevDb = -120.0, prev2Db = -120.0
    static var debug = ProcessInfo.processInfo.environment["CLAP_DEBUG"] != nil
    // A loud onset waiting to show it dies away like a clap: when it started, its peak, the frames since.
    private var pending: (t: Double, peak: Double, frames: Int, tail: Double)?
    private var lastLoud = -10.0 // the last loud frame that wasn't part of a clap
    private var lastClap = -10.0
    private var clapTail = -10.0 // frames up to here belong to the last clap (its ring-out)
    private enum State { case idle, one(Double), two(Double, Double) }
    private var state = State.idle
    private var coolUntil = 0.0

    static let minGap = 0.25, maxGap = 0.8
    static let quietBefore = 0.5, quietAfter = 0.6

    init(rate: Double, sensitivity: Double = 0.5) {
        self.rate = rate
        self.sensitivity = min(1, max(0, sensitivity))
        hop = max(64, Int(rate / 100))
        frame.reserveCapacity(hop)
    }

    private var riseDb: Double { 26 - 12 * sensitivity } // 20 dB over the floor at 0.5
    private var loudestDb: Double { -20 - 16 * sensitivity } // and louder than -28 dBFS at 0.5

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

    private func step() -> Bool {
        now += Double(hop) / rate
        var e: Float = 0, d: Float = 0, zc = 0, mean: Float = 0
        for x in frame { mean += x }
        mean /= Float(hop)
        var prev = frame[0] - mean
        for i in 0 ..< hop {
            let x = frame[i] - mean
            e += x * x
            if i > 0 { let dx = x - prev; d += dx * dx; if (x >= 0) != (prev >= 0) { zc += 1 } }
            prev = x
        }
        let db = 10 * log10(Double(e) / Double(hop) + 1e-12)
        // How high the sound is, two ways: zero crossings, and the first difference's share of the energy.
        let zcHz = Double(zc) / Double(hop - 1) * rate / 2
        let r = Double(d) / Double(max(e, 1e-12))
        let dHz = rate / Double.pi * asin(min(1, sqrt(r) / 2))
        defer { prev2Db = prevDb; prevDb = db }
        if now <= Double(hop) / rate * 1.5 { floorDb = db } // the first frame sets the room's level
        if Self.debug, db - floorDb > 15 { print(String(format: "  t=%.3f db=%.1f floor=%.1f zc=%.0f d=%.0f", now, db, floorDb, zcHz, dHz)) }

        // A pending onset: does it die away like a clap?
        if var p = pending {
            p.frames += 1
            p.peak = max(p.peak, p.frames <= 2 ? db : p.peak)
            if p.frames >= 4 && p.frames <= 6 { p.tail = max(p.tail, db) }
            pending = p
            if p.frames == 6 {
                pending = nil
                if p.tail <= p.peak - 12 { clapTail = p.t + 0.15; return clap(at: p.t) }
                lastLoud = now // loud and lasting: a word, a note, a door
            }
            return settle()
        }

        let over = db - floorDb
        if over >= riseDb, db >= loudestDb, db - min(prevDb, prev2Db) >= 12, zcHz >= 900, dHz >= 900 {
            pending = (now, db, 0, -120)
        } else if over >= 10, now > clapTail {
            lastLoud = now
        }
        // The floor follows the room: down quickly, up slowly (about 5 s), never from a clap or its ring-out.
        if now > clapTail { floorDb += (db < floorDb ? 0.2 : 0.004) * (db - floorDb) }
        return settle()
    }

    private func clap(at t: Double) -> Bool {
        defer { lastClap = t }
        guard t >= coolUntil else { return false }
        switch state {
        case .idle:
            if t - lastLoud >= Self.quietBefore, t - lastClap > Self.maxGap { state = .one(t) }
        case .one(let t1):
            let gap = t - t1
            if gap >= Self.minGap, gap <= Self.maxGap, lastLoud < t1 { state = .two(t1, t) }
            else { state = .idle }
        case .two:
            state = .idle // a third clap: not a double clap
        }
        return false
    }

    private func settle() -> Bool {
        switch state {
        case .idle: return false
        case .one(let t1):
            if lastLoud > t1 || now - t1 > Self.maxGap + 0.1 { state = .idle }
            return false
        case .two(_, let t2):
            if lastLoud > t2 || pending != nil { if lastLoud > t2 { state = .idle }; return false }
            if now - t2 >= Self.quietAfter {
                state = .idle
                coolUntil = now + 1
                return true
            }
            return false
        }
    }
}

/// The mic, opened only for the clap detector while Hydra sleeps. Its own engine; started and stopped by Voice.tick.
final class ClapListener {
    private var engine: AVAudioEngine?
    var sensitivity = 0.5
    var running: Bool { engine?.isRunning == true }
    private let onClap: () -> Void

    init(onClap: @escaping () -> Void) { self.onClap = onClap }

    /// The same mics a take tries, in the same order (InputDevice.tries): the system's choice, the default by name,
    /// the built-in. Only the system's choice, it failed with '!dev' whenever the process's input was stuck on a mic
    /// that went away, so the double clap never started.
    func start(device: AudioDeviceID?) -> Bool {
        stop()
        let k = sensitivity, fire = onClap
        let opened = InputDevice.firstOpening(InputDevice.tries(picked: device, current: InputDevice.current(), builtIn: InputDevice.builtIn())) { dev -> AVAudioEngine? in
            let eng = AVAudioEngine()
            let input = eng.inputNode
            if let dev, !InputDevice.use(dev, on: input) { return nil }
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else { return nil }
            let det = ClapDetector(rate: format.sampleRate, sensitivity: k)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                guard let ch = buffer.floatChannelData?[0] else { return }
                if det.feed(ch, count: Int(buffer.frameLength)) { DispatchQueue.main.async { fire() } }
            }
            do { eng.prepare(); try eng.start() } catch { input.removeTap(onBus: 0); log("clap listening couldn't start\(dev.map { " on device \($0)" } ?? ""): \(error)"); return nil }
            if dev != device { log("clap listening on device \(dev ?? 0) after the default one failed") }
            return eng
        }
        guard let eng = opened else { return false }
        engine = eng
        log("clap listening on (sensitivity \(String(format: "%.2f", sensitivity)))")
        return true
    }

    func stop() {
        guard let eng = engine else { return }
        eng.inputNode.removeTap(onBus: 0)
        eng.stop()
        engine = nil
        InputDevice.freedAt = uptime()
        log("clap listening off")
    }
}

// ---------- test signals (--test-clap) ----------

enum ClapTest {
    struct Rng { var s: UInt64; mutating func next() -> Float { s = s &* 6364136223846793005 &+ 1442695040888963407; return Float(Int64(bitPattern: s >> 11) % 2_000_000) / 1_000_000 - 1 } }

    /// A room: faint noise (about -62 dBFS).
    static func room(_ seconds: Double, rate: Double, rng: inout Rng, level: Float = 0.0012) -> [Float] {
        (0 ..< Int(seconds * rate)).map { _ in rng.next() * level }
    }

    /// One clap at `at` s: a noise burst brightened by a first difference, a 1 ms attack and ~8 ms decay, and a
    /// room's ring-out 25 dB down. lowpass > 0 dulls it like a laptop mic (one-pole, 0...1).
    static func clap(_ buf: inout [Float], at: Double, rate: Double, peak: Float = 0.5, rng: inout Rng, lowpass: Float = 0, ring: Float = 0.05) {
        let start = Int(at * rate), n = Int(0.25 * rate)
        var last: Float = 0, lp: Float = 0
        for i in 0 ..< n where start + i < buf.count {
            let t = Double(i) / rate
            let env = Float(min(1, t / 0.001) * exp(-t / 0.008)) + ring * Float(exp(-t / 0.06))
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

    static func wakes(_ buf: [Float], rate: Double, chunk: Int = 1024, sensitivity: Double = 0.5) -> Int {
        let det = ClapDetector(rate: rate, sensitivity: sensitivity)
        var n = 0, i = 0
        while i < buf.count { let j = min(buf.count, i + chunk); if det.feed(Array(buf[i ..< j])) { n += 1 }; i = j }
        return n
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
            var b = base(); clap(&b, at: 1.0, rate: rate, rng: &rng); clap(&b, at: 1.45, rate: rate, rng: &rng)
            check("\(Int(rate)) Hz: a double clap 0.45 s apart", wakes(b, rate: rate), 1)
            b = base(); clap(&b, at: 1.0, rate: rate, rng: &rng); clap(&b, at: 1.28, rate: rate, rng: &rng)
            check("\(Int(rate)) Hz: a quick double clap (0.28 s)", wakes(b, rate: rate), 1)
            b = base(); clap(&b, at: 1.0, rate: rate, rng: &rng); clap(&b, at: 1.75, rate: rate, rng: &rng)
            check("\(Int(rate)) Hz: a slow double clap (0.75 s)", wakes(b, rate: rate), 1)
            // Recorded-style: a dull laptop mic, a long ring-out, a DC offset, quieter, and odd buffer sizes.
            b = room(4, rate: rate, rng: &rng, level: 0.003).map { $0 + 0.01 }
            clap(&b, at: 1.2, rate: rate, peak: 1.8, rng: &rng, lowpass: 0.85, ring: 0.12); clap(&b, at: 1.7, rate: rate, peak: 1.5, rng: &rng, lowpass: 0.85, ring: 0.12)
            check("\(Int(rate)) Hz: a recorded-style double clap", wakes(b, rate: rate, chunk: 470), 1)
            b = base(); clap(&b, at: 1.0, rate: rate, rng: &rng)
            check("\(Int(rate)) Hz: one clap", wakes(b, rate: rate), 0)
            b = base(); for t in [1.0, 1.45, 1.9] { clap(&b, at: t, rate: rate, rng: &rng) }
            check("\(Int(rate)) Hz: three claps 0.45 s apart", wakes(b, rate: rate), 0)
            b = base(); for t in [0.6, 1.6, 2.6] { clap(&b, at: t, rate: rate, rng: &rng) }
            check("\(Int(rate)) Hz: three claps 1 s apart", wakes(b, rate: rate), 0)
            b = base(); clap(&b, at: 1.0, rate: rate, rng: &rng); clap(&b, at: 1.1, rate: rate, rng: &rng)
            check("\(Int(rate)) Hz: two claps too close (0.1 s)", wakes(b, rate: rate), 0)
            b = base(); clap(&b, at: 1.0, rate: rate, rng: &rng); clap(&b, at: 2.0, rate: rate, rng: &rng)
            check("\(Int(rate)) Hz: two claps too far apart (1 s)", wakes(b, rate: rate), 0)
            b = room(6, rate: rate, rng: &rng); speech(&b, from: 0.3, to: 5.7, rate: rate, rng: &rng)
            check("\(Int(rate)) Hz: speech", wakes(b, rate: rate), 0)
            b = room(6, rate: rate, rng: &rng); speech(&b, from: 0.3, to: 5.7, rate: rate, rng: &rng, level: 0.6)
            check("\(Int(rate)) Hz: loud speech", wakes(b, rate: rate), 0)
            b = room(6, rate: rate, rng: &rng); typing(&b, from: 0.3, to: 5.7, rate: rate, rng: &rng)
            check("\(Int(rate)) Hz: typing", wakes(b, rate: rate), 0)
            b = room(6, rate: rate, rng: &rng); typing(&b, from: 0.3, to: 5.7, rate: rate, rng: &rng, peak: 0.6)
            check("\(Int(rate)) Hz: loud typing", wakes(b, rate: rate), 0)
            b = room(8, rate: rate, rng: &rng); music(&b, from: 0.2, to: 7.8, rate: rate, rng: &rng)
            check("\(Int(rate)) Hz: music with drums", wakes(b, rate: rate), 0)
            b = base(); clap(&b, at: 1.0, rate: rate, peak: 0.06, rng: &rng); clap(&b, at: 1.45, rate: rate, peak: 0.06, rng: &rng)
            check("\(Int(rate)) Hz: a faint double clap at sensitivity 0.5", wakes(b, rate: rate), 0)
            check("\(Int(rate)) Hz: the same at sensitivity 1", wakes(b, rate: rate, sensitivity: 1), 1)
        }
        return bad == 0 ? 0 : 1
    }
}
