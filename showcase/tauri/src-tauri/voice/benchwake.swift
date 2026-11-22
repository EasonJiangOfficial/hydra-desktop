// --bench <set dir> [--out file.jsonl]: the wake phrase and the sleep word measured on the recorded set (bench/make-set.sh).
// Each clip is heard five ways (as recorded; in a noisy room, about 15 dB under the voice; through a quiet mic; with the
// level changing and noise; in an echoey room),
// padded with silence, and fed through the same path the mic feeds (MicHub.deliver: the quiet-mic boost, then the
// recogniser, with the hints the helper gives it), then every reading the recogniser gives is checked as live wake
// listening checks it: the sleep word first, then the wake phrase. A positive counts when its phrase is heard; a
// negative is a false wake when any of the set's phrases (wake or sleep) would fire on it. Every reading goes to
// --out, one JSON line per clip and way, so another matcher can be measured on the same readings.
import AVFoundation
import Foundation
import Speech

enum WakeBench {
    struct Row { let file, set, expect, wake, sleep, text: String }
    static let ways: [(name: String, gain: Float, noise: Float, ramp: Bool, echo: Bool)] = [("as recorded", 1, 0, false, false), ("noisy room", 0.7, 0.03, false, false),
        ("quiet mic", 0.08, 0.0006, false, false), ("level changing", 1, 0.01, true, false), ("echoey room", 0.6, 0.008, false, true)]

    /// Every config the set uses: a negative must fire none of them.
    static func configs(_ rows: [Row]) -> [(wake: String, sleep: String)] {
        var seen = Set<String>(), out: [(String, String)] = []
        for r in rows where r.expect != "none" && seen.insert("\(r.wake)|\(r.sleep)").inserted { out.append((r.wake, r.sleep)) }
        return out
    }

    /// The first reading that fires and is confirmed as live wake listening confirms it: a match on an open last word
    /// counts once the next reading fires too, or when no reading follows (Voice.tentative).
    static func confirmed(_ readings: [String], _ fire: (String) -> String?) -> String? {
        for (k, t) in readings.enumerated() {
            guard let f = fire(t) else { continue }
            if !WakeWord.endsOpen(t) || k == readings.count - 1 || fire(readings[k + 1]) != nil { return f }
        }
        return nil
    }
    /// The other readings, as Voice.heardAlternatives takes them: only ended ones.
    static func fromAlternatives(_ alts: [String], _ fire: (String) -> String?) -> String? {
        alts.lazy.filter { !WakeWord.endsOpen($0) }.compactMap(fire).first
    }
    /// What live wake listening does with one reading under a config: "sleep", "wake" or nil.
    static func fires(_ text: String, wake: String, sleep: String) -> String? {
        WakeWord.setPhrase(wake); SleepWord.set(sleep)
        if SleepWord.heard(in: text) { return "sleep" }
        return WakeWord.match(text) != nil ? "wake" : nil
    }

    static func run(dir: String, out: String?) -> Never {
        let base = URL(fileURLWithPath: dir)
        guard let man = try? String(contentsOf: base.appendingPathComponent("manifest.tsv"), encoding: .utf8) else { print("no manifest.tsv in \(dir)"); exit(2) }
        let rows = man.split(separator: "\n").compactMap { l -> Row? in
            let c = l.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            return c.count >= 6 ? Row(file: c[0], set: c[1], expect: c[2], wake: c[3], sleep: c[4], text: c[5]) : nil
        }
        let limit = ProcessInfo.processInfo.environment["BENCH_LIMIT"].flatMap(Int.init) ?? Int.max
        let jobs = rows.flatMap { r in ways.indices.map { (r, $0) } }.prefix(limit)
        let cfgs = configs(rows)
        var outFile: FileHandle?
        if let out { FileManager.default.createFile(atPath: out, contents: nil); outFile = FileHandle(forWritingAtPath: out) }
        var tally: [String: (n: Int, hit: Int)] = [:]
        var rng = ClapTest.Rng(s: 99)
        let started = Date()
        var idx = 0
        var live: Recognizer? // the recogniser being heard holds itself only weakly: kept here until it's done
        func next() {
            guard idx < jobs.count else { finish() ; return }
            let (row, w) = jobs[jobs.startIndex + idx]
            idx += 1
            guard let (x, rate) = ClapBench.read(base.appendingPathComponent(row.file)) else { print("can't read \(row.file)"); next(); return }
            // Padded with silence (and the room) as a window of wake listening hears it.
            let way = ways[w]
            var y = [Float](repeating: 0, count: Int(0.5 * rate)) + x + [Float](repeating: 0, count: Int(1.2 * rate))
            if way.echo { // three feedback combs: a room's tail of about half a second
                var wet = [Float](repeating: 0, count: y.count)
                for d in [0.0297, 0.0371, 0.0411].map({ Int($0 * rate) }) {
                    var c = [Float](repeating: 0, count: y.count)
                    for i in d ..< y.count { c[i] = y[i - d] + 0.72 * c[i - d] }
                    for i in y.indices { wet[i] += c[i] * 0.2 }
                }
                for i in y.indices { y[i] = 0.7 * y[i] + wet[i] }
            }
            for i in y.indices {
                let g = way.ramp ? Float(0.25 + 0.75 * Double(i) / Double(y.count)) : way.gain
                y[i] = max(-1, min(1, y[i] * g + rng.next() * way.noise))
            }
            WakeWord.setPhrase(row.wake); SleepWord.set(row.sleep)
            var readings: [String] = [], alternatives: [String] = []
            var done = false
            let end = {
                guard !done else { return }
                done = true
                _ = live
                live = nil
                var got: String?
                if row.expect == "none" {
                    got = cfgs.lazy.compactMap { c in confirmed(readings) { fires($0, wake: c.wake, sleep: c.sleep) } ?? fromAlternatives(alternatives) { fires($0, wake: c.wake, sleep: c.sleep) } }.first
                } else {
                    got = (confirmed(readings) { fires($0, wake: row.wake, sleep: row.sleep) } ?? fromAlternatives(alternatives) { fires($0, wake: row.wake, sleep: row.sleep) }).flatMap { $0 == row.expect ? $0 : nil }
                }
                let hit = row.expect == "none" ? (got != nil ? 1 : 0) : (got != nil ? 1 : 0)
                let key = "\(row.set)|\(row.expect)|\(way.name)"
                tally[key, default: (0, 0)].n += 1; tally[key, default: (0, 0)].hit += hit
                let line: [String: Any] = ["file": row.file, "set": row.set, "expect": row.expect, "wake": row.wake, "sleep": row.sleep, "way": way.name, "readings": readings, "alternatives": alternatives, "fired": got ?? NSNull()]
                if let d = try? JSONSerialization.data(withJSONObject: line) { outFile?.write(d); outFile?.write(Data("\n".utf8)) }
                if idx % 50 == 0 { FileHandle.standardError.write(Data("bench: \(idx)/\(jobs.count) in \(Int(Date().timeIntervalSince(started))) s\n".utf8)) }
                DispatchQueue.main.async { next() }
            }
            var cb = RecognizerCallbacks(onText: { t in if readings.last != t { readings.append(t) } }, onDone: { end() }, onError: { e in FileHandle.standardError.write(Data("bench: \(row.file): \(e.localizedDescription)\n".utf8)); end() })
            if ProcessInfo.processInfo.environment["BENCH_NO_ALTS"] == nil { cb.onAlternatives = { alternatives.append(contentsOf: $0) } }
            var r: Recognizer?
            if #available(macOS 26, *), SpeechTranscriber.isAvailable { r = AnalyzerRecognizer(cb) } else { r = LegacyRecognizer(cb, onDeviceOnly: true) }
            guard let rec = r, let fmt = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1) else { print("speech recognition unavailable"); exit(2) }
            live = rec
            let hub = MicHub()
            hub.fileMode = true
            let gain = AutoGain()
            hub.setSpeech { buf in
                if let ch = buf.floatChannelData?[0] {
                    var sum: Float = 0
                    for k in 0 ..< Int(buf.frameLength) { sum += ch[k] * ch[k] }
                    gain.apply(buf, rms: sqrt(sum / Float(max(1, buf.frameLength))))
                }
                rec.append(buf)
            }
            var i = 0
            while i < y.count {
                let n = min(1024, y.count - i)
                guard let b = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(n)) else { break }
                b.frameLength = AVAudioFrameCount(n)
                y.withUnsafeBufferPointer { src in b.floatChannelData![0].update(from: src.baseAddress! + i, count: n) }
                hub.deliver(b)
                i += n
            }
            rec.end()
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) { end() }
        }
        func finish() {
            print("wake phrase and sleep word (\(jobs.count) runs, \(Int(Date().timeIntervalSince(started))) s)")
            var ok = true
            let sets = Array(Set(tally.keys.map { $0.split(separator: "|").prefix(2).joined(separator: "|") })).sorted()
            for s in sets {
                let parts = s.split(separator: "|"), negative = parts[1] == "none"
                var n = 0, hit = 0, detail: [String] = []
                for w in ways { if let t = tally["\(s)|\(w.name)"] { n += t.n; hit += t.hit; detail.append("\(w.name) \(t.hit)/\(t.n)") } }
                let good = negative ? Double(hit) <= Double(n) / 20 : Double(hit) >= 0.9 * Double(n)
                if !good { ok = false }
                print("  \(good ? "ok  " : "MISS") \(String(parts[0]).padding(toLength: 11, withPad: " ", startingAt: 0)) \(negative ? "false wakes" : "fired      ") \(hit)/\(n)  (\(detail.joined(separator: ", ")))")
            }
            exit(ok ? 0 : 1)
        }
        DispatchQueue.main.async { next() }
        dispatchMain()
    }
}
