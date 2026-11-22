// --bench-claps [set dir]: the double-clap detector measured on made-up recordings, set by set. Positives are double
// claps (several levels, gaps, rooms that ring, a dull laptop mic, over room noise and over someone talking: the
// `say` sentences of the recorded set when its folder is given); negatives are everything that must not wake it. Each
// set is 40 seeded trials at 48, 44.1 and 16 kHz. Prints each set's rate; the target is 9 in 10 or better on every
// positive set and at most 1 false wake in 20 on the negatives.
import AVFoundation
import Foundation

enum ClapBench {
    /// A detector for a rate, a sensitivity and maybe a calibration: samples in, true on a double clap.
    typealias Make = (_ rate: Double, _ sensitivity: Double, _ cal: ClapDetector.Calibration?) -> ([Float]) -> Bool
    struct Result { let set: String; let positive: Bool; let trials: Int; let hits: Int }

    static func resample(_ x: [Float], from: Double, to: Double) -> [Float] {
        guard from != to, x.count > 1 else { return x }
        let n = Int(Double(x.count) * to / from)
        return (0 ..< n).map { i in let t = Double(i) * from / to, j = Int(t), f = Float(t - Double(j)); return j + 1 < x.count ? x[j] * (1 - f) + x[j + 1] * f : x[x.count - 1] }
    }

    /// Mono samples of a recording and its rate.
    static func read(_ url: URL) -> ([Float], Double)? {
        guard let f = try? AVAudioFile(forReading: url), let b = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: AVAudioFrameCount(f.length)),
              (try? f.read(into: b)) != nil, let ch = b.floatChannelData?[0] else { return nil }
        return (Array(UnsafeBufferPointer(start: ch, count: Int(b.frameLength))), f.processingFormat.sampleRate)
    }

    static func run(make: Make, setDir: String?) -> [Result] {
        // Talk to clap over: the recorded set's sentences when there is one, else made-up speech.
        var talk: [([Float], Double)] = []
        if let dir = setDir, let names = try? FileManager.default.contentsOfDirectory(atPath: dir) {
            for n in names.sorted() where n.hasPrefix("negative-") && n.hasSuffix(".wav") { if let r = read(URL(fileURLWithPath: dir).appendingPathComponent(n)) { talk.append(r) } }
        }
        var rng = ClapTest.Rng(s: 2026)
        func u(_ a: Double, _ b: Double) -> Double { a + (b - a) * Double(abs(rng.next())) }
        func pick<T>(_ xs: [T]) -> T { xs[min(xs.count - 1, Int(Double(abs(rng.next())) * Double(xs.count)))] }
        func speech(_ b: inout [Float], from: Double, rate: Double, rms: Float) {
            if talk.isEmpty { ClapTest.speech(&b, from: from, to: Double(b.count) / rate - 0.2, rate: rate, rng: &rng, level: rms * 4); return }
            var at = Int(from * rate)
            while at < b.count {
                let (x, r) = pick(talk)
                let y = resample(x, from: r, to: rate)
                let have = sqrt(y.reduce(0) { $0 + $1 * $1 } / Float(max(1, y.count)))
                let g = have > 0 ? rms / have : 0
                for i in 0 ..< y.count where at + i < b.count { b[at + i] += y[i] * g }
                at += y.count + Int(0.15 * rate)
            }
        }
        func room(_ secs: Double, _ rate: Double, _ level: Float = 0.0012) -> [Float] { ClapTest.room(secs, rate: rate, rng: &rng, level: level) }
        func reverb() -> (Float, Double)? { pick([nil, (0.15, 0.3), (0.25, 0.6), (0.35, 0.9)]) }
        func clapPair(_ b: inout [Float], at: Double, gap: Double, rate: Double, peak: Float, lowpass: Float = 0, verb: (Float, Double)?) {
            ClapTest.clap(&b, at: at, rate: rate, peak: peak * Float(u(0.8, 1.0)), rng: &rng, lowpass: lowpass, reverb: verb)
            ClapTest.clap(&b, at: at + gap, rate: rate, peak: peak * Float(u(0.8, 1.0)), rng: &rng, lowpass: lowpass, reverb: verb)
        }
        func count(_ buf: [Float], _ rate: Double, _ k: Double = 0.5, _ cal: ClapDetector.Calibration? = nil, chunk: Int = 1024) -> Int {
            let feed = make(rate, k, cal)
            var n = 0, i = 0
            while i < buf.count { let j = min(buf.count, i + chunk); if feed(Array(buf[i ..< j])) { n += 1 }; i = j }
            return n
        }
        let trials = 40
        var out: [Result] = []
        func set(_ name: String, positive: Bool, _ trial: (Double) -> Int) {
            var hits = 0
            let verbose = ProcessInfo.processInfo.environment["CLAP_BENCH"].map { name.hasPrefix($0) } ?? false
            for t in 0 ..< trials {
                if verbose { print("-- trial \(t)") }
                let got = trial([48000.0, 44100, 16000][t % 3])
                if verbose { print("-- trial \(t): \(got)") }
                hits += got
            }
            out.append(Result(set: name, positive: positive, trials: trials, hits: hits))
        }
        let pos = { (n: Int) in n >= 1 ? 1 : 0 }
        // ---- positives ----
        set("double clap, quiet room, Medium", positive: true) { r in
            var b = room(4, r); clapPair(&b, at: u(0.8, 1.5), gap: u(0.2, 0.75), rate: r, peak: Float(u(0.2, 1.2)), lowpass: pick([0, 0.6]), verb: reverb()); return pos(count(b, r))
        }
        set("double clap, room that rings (RT60 0.6 to 1 s)", positive: true) { r in
            var b = room(4, r); clapPair(&b, at: u(0.8, 1.5), gap: u(0.25, 0.75), rate: r, peak: Float(u(0.3, 1.2)), verb: (Float(u(0.25, 0.4)), u(0.6, 1.0))); return pos(count(b, r))
        }
        set("double clap, laptop mic (dull, DC offset, odd buffers)", positive: true) { r in
            var b = room(4, r, 0.003).map { $0 + 0.01 }; clapPair(&b, at: u(0.8, 1.5), gap: u(0.2, 0.75), rate: r, peak: Float(u(0.8, 1.8)), lowpass: 0.85, verb: reverb()); return pos(count(b, r, chunk: 470))
        }
        set("double clap, room noise (-45 dBFS)", positive: true) { r in
            var b = room(4, r, 0.01); clapPair(&b, at: u(0.8, 1.5), gap: u(0.2, 0.75), rate: r, peak: Float(u(0.3, 1.2)), verb: reverb()); return pos(count(b, r))
        }
        set("double clap, someone talking", positive: true) { r in
            var b = room(5, r); speech(&b, from: 0.2, rate: r, rms: Float(u(0.02, 0.05)))
            clapPair(&b, at: u(1.5, 2.5), gap: u(0.25, 0.75), rate: r, peak: Float(u(0.6, 1.5)), verb: reverb()); return pos(count(b, r))
        }
        set("soft double clap across the room, High", positive: true) { r in
            var b = room(4, r); clapPair(&b, at: u(0.8, 1.5), gap: u(0.2, 0.75), rate: r, peak: Float(u(0.04, 0.12)), verb: reverb()); return pos(count(b, r, 0.8))
        }
        set("soft double clap, Medium, calibrated to them", positive: true) { r in
            let peak = Float(u(0.04, 0.12))
            var c = room(3, r); clapPair(&c, at: 1.0, gap: 0.4, rate: r, peak: peak, verb: nil)
            var cal: ClapDetector.Calibration?
            let det = ClapDetector(rate: r); det.calibrating = true
            var seen: [(Double, Double)] = []
            det.onTransient = { seen.append(($0, $1)) }
            _ = det.feed(c)
            if seen.count >= 2 { cal = .init(peakDb: seen.map(\.0).min()!, riseDb: seen.map(\.1).min()!) }
            var b = room(4, r); clapPair(&b, at: u(0.8, 1.5), gap: u(0.2, 0.75), rate: r, peak: peak, verb: reverb()); return pos(count(b, r, 0.5, cal))
        }
        // ---- negatives (false wakes per trial) ----
        set("one clap", positive: false) { r in var b = room(4, r); ClapTest.clap(&b, at: u(0.8, 2), rate: r, peak: Float(u(0.2, 1.2)), rng: &rng, reverb: reverb()); return count(b, r) }
        set("two claps 1.1 to 1.6 s apart", positive: false) { r in var b = room(5, r); clapPair(&b, at: 0.8, gap: u(1.1, 1.6), rate: r, peak: Float(u(0.3, 1.0)), verb: reverb()); return count(b, r) }
        set("someone talking", positive: false) { r in var b = room(8, r); speech(&b, from: 0.2, rate: r, rms: Float(u(0.02, 0.06))); return count(b, r) }
        set("loud talking, close to the mic", positive: false) { r in var b = room(8, r); speech(&b, from: 0.2, rate: r, rms: Float(u(0.1, 0.2))); return count(b, r) }
        set("talking at High", positive: false) { r in var b = room(8, r); speech(&b, from: 0.2, rate: r, rms: Float(u(0.02, 0.1))); return count(b, r, 0.8) }
        set("typing", positive: false) { r in var b = room(6, r); ClapTest.typing(&b, from: 0.3, to: 5.7, rate: r, rng: &rng, peak: Float(u(0.2, 0.6))); return count(b, r) }
        set("typing at High", positive: false) { r in var b = room(6, r); ClapTest.typing(&b, from: 0.3, to: 5.7, rate: r, rng: &rng, peak: Float(u(0.1, 0.4))); return count(b, r, 0.8) }
        set("music with drums", positive: false) { r in var b = room(8, r); ClapTest.music(&b, from: 0.2, to: 7.8, rate: r, rng: &rng); return count(b, r) }
        set("music with hi-hats", positive: false) { r in var b = room(8, r); ClapTest.hats(&b, from: 0.2, to: 7.8, rate: r, rng: &rng); return count(b, r) }
        set("knocks on a door", positive: false) { r in var b = room(4, r); let t = u(0.8, 1.5), g = u(0.2, 0.5); for k in 0 ..< 3 { ClapTest.knock(&b, at: t + Double(k) * g, rate: r, peak: Float(u(0.3, 0.9))) }; return count(b, r) }
        set("one clap while talking", positive: false) { r in var b = room(6, r); speech(&b, from: 0.2, rate: r, rms: Float(u(0.02, 0.05))); ClapTest.clap(&b, at: u(1.5, 3), rate: r, peak: Float(u(0.6, 1.5)), rng: &rng, reverb: reverb()); return count(b, r) }
        return out
    }

    /// Prints the table and returns 0 when every set meets the target.
    static func report(_ rs: [Result], label: String) -> Int32 {
        var ok = true
        print("\(label)")
        for r in rs {
            let good = r.positive ? Double(r.hits) / Double(r.trials) >= 0.9 : Double(r.hits) / Double(r.trials) <= 0.05
            if !good { ok = false }
            print("  \(good ? "ok  " : "MISS") \(r.set.padding(toLength: 54, withPad: " ", startingAt: 0)) \(r.positive ? "woke       " : "false wakes") \(r.hits)/\(r.trials)")
        }
        return ok ? 0 : 1
    }
}
