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
// Build 4 C8 (owner: "hydra keeps false triggering when I dont say anything"; at High his keys, taps and thumps made
// clap candidates at -36 to -48 dB with rises of 9 to 25 dB, 900 to 3300 Hz, down 6 to 20 dB): a hard floor no slider,
// calibration or "Clap twice" goes under. Never quieter than -46 dBFS, and the quieter a sound is, the sharper its rise,
// the clearer its fall and the brighter it must be (shapeMiss). His real claps (-10 to -37 dB, rises of 25 dB or more,
// 2300 Hz and up, down 19 dB or more) clear it at once. Each accepted candidate logs what it cleared.
// While Hydra speaks (C7) a clap must also stand 8 dB over the loudest sound of the second before it (Hydra's voice as
// the mic hears it), so its own syllables, a fan or a key under it never stop it.
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
    /// Hydra's voice plays with no echo reference (C6): level and rise never go below the calibrated or Medium ones.
    var guarded = false
    /// Hydra is speaking (C7): each clap must stand overVoiceDb over the loudest sound of the second before it.
    var speaking = false
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

    // An onset waiting to show it dies away like a clap. rise: over the 30 ms before it (base), at its first frame or the
    // next (a clap that starts late in a frame peaks in the next); bed: the loudest of the second before it (Hydra's
    // voice while it speaks); inner: another sharp onset came inside its window (keys typed close together); bump: its
    // tail grew again (a key let go, a word) instead of dying away as a room rings; last: the frame before, in dB.
    private struct Pending {
        var t: Double; var peak: Double; var rise: Double; var base: Double; var bed: Double; var hz: Double; var frames: Int; var tail: Double
        var inner = false, bump = false, last: Double
        // Its first 30 ms as one block (energy and first-difference energy): its brightness, not one frame's (a frame
        // that catches only the first millisecond of a tap reads as bright as a clap).
        var e: Double, d: Double
        // Its bright energy (the first difference's) in 1 ms blocks, from the frame before it to its third frame, and the
        // room's share of each block: how long the sound lasts (width).
        var w: [Double], noise: Double
        init(t: Double, db: Double, base: Double, bed: Double, hz: Double, e: Double, d: Double, w: [Double], noise: Double) {
            self.t = t; peak = db; rise = db - base; self.base = base; self.bed = bed; self.hz = hz; frames = 0; tail = -120; last = db; self.e = e; self.d = d
            self.w = w; self.noise = noise
        }
    }
    private var pending: Pending?
    private var lastTransient = -10.0, lastPeak = -120.0 // the last sharp sound: when, and how loud
    private var before: (gap: Double, peak: Double) = (99, -120) // what came before the first clap of a pair
    private enum State { case idle, one(Double, Double), two(Double, Double, Double) } // .two: both claps' times, the louder's peak
    private var state = State.idle
    private var coolUntil = 0.0
    private var firstLine = "" // the first clap of a pair, for the double clap's line
    // The last second's frames (dB), a clap and its ring-out left out: the loudest is what a clap must stand over while
    // Hydra speaks (its syllables stay in, whatever onsets they made).
    private var lastSecond = [Double](repeating: -120, count: 100), lastAt = 0, bedMuteUntil = 0.0
    // This frame's and the last one's bright energy in 1 ms blocks, and the last three frames' in all (width, noise).
    static let blocks = 10
    private var sub = [Double](repeating: 0, count: 10), prevSub = [Double](repeating: 0, count: 10), recentD = [0.0, 0.0, 0.0]
    private var hpLow: Float = 0, hpLow2: Float = 0 // two one-pole high-passes: a key's low knock out, a clap's ring in
    private lazy var hpPole = Float(1 - exp(-2 * Double.pi * Self.widthHz / rate))
    static let widthHz = 2000.0

    static let minGap = 0.15, maxGap = 0.8, quietBefore = 0.6, quietAfter = 0.45, flam = 0.15
    /// The quiet a double clap needs after its second clap: 0.45 s, or a quarter more than its gap, so a beat (a snare on
    /// 2 and 4 at 150 to 176 BPM, 0.68 to 0.8 s apart) shows its third hit before the pair counts.
    static func quietAfter(gap: Double) -> Double { max(quietAfter, 1.25 * gap) }
    static let decayDb = 6.0, brightHz = 900.0, jumpDb = 9.0
    /// C8: nothing quieter than this is a clap, whatever the slider, the calibration or "Clap twice" says.
    static let floorDb = -46.0
    /// C7: while Hydra speaks, a clap stands this far over the loudest sound of the second before it.
    static let overVoiceDb = 8.0
    /// C7: while Hydra speaks, a clap's hiss is at least this high. The real claps in the bench read 4.7 kHz and up.
    /// A key's body tone that lasts long enough to pass the width floor reads 2.7 to 3.6 kHz (the seed 4242 false stop).
    static let speakHz = 4000.0

    /// C8: what a clap must clear at its peak (dBFS): its rise over the 30 ms before it, its brightness, and its fall in
    /// the 60 to 100 ms after it. 9 dB / 2000 Hz / 6 dB at -22 dBFS or louder (a clap over talk, a room that rings), up to
    /// 16 dB / 3000 Hz / 13 dB at -36 dBFS, and a rise of 22 dB at -46 dBFS, where the owner's keys, mouse, taps and thumps
    /// were (rises of 9 to 25 dB, 900 to 3300 Hz, down 6 to 20 dB) and his claps weren't (2300 Hz and up, rises of 26 dB
    /// or more). A very bright sound (a clap's broadband hiss, 3.5 to 5 kHz and up) needs up to 2 dB less rise, so a faint
    /// clap over a fan still counts. A tail that dies away smoothly (a room ringing, not a key let go or a word) needs only
    /// 6 dB down. The rise is what a noisy room can't give, so it isn't what tells a key from a clap: the width is.
    struct Need: Equatable { let jump: Double, hz: Double, decay: Double }
    static let clapHz = 2000.0
    static func need(peak: Double, hz: Double = 0) -> Need {
        let q = min(1, max(0, (-22 - peak) / 14)), quiet = min(1, max(0, (-36 - peak) / 10))
        let bright = 2 * min(1, max(0, (hz - 3500) / 1500))
        return Need(jump: jumpDb + 7 * q + 6 * quiet - bright, hz: clapHz + 1000 * q, decay: decayDb + 7 * q)
    }
    /// Build 4 C8, second pass: how long a sound's bright energy lasts (ms), whatever the room's level: (sum)^2 / sum of
    /// squares of its 1 ms blocks, the room's share taken out. A key, a mouse button, a pen or a knuckle on the laptop is a
    /// click of 1 to 3 ms (2 to 4 ms here); a clap is the air squeezed out between two palms and the hands ringing, 5 to
    /// 15 ms (7 ms and up here), more in a room. The hard floor, the same at every sensitivity and calibration.
    static let minWidthMs = 6.0
    /// A palm clap on this mic (live log 2026-11-24): the thud pulls the centroid down to about 1 to 1.7 kHz, and the
    /// hiss still lasts this long. A key that clears the width floor is shorter. Only a sound this wide may be that dull.
    static let palmMs = 8.0
    static func width(_ blocks: [Double], noise: Double, blockMs: Double = 1) -> Double {
        var s = 0.0, s2 = 0.0
        for b in blocks { let x = max(0, b - noise * 1.5); s += x; s2 += x * x }
        return s2 > 0 ? s * s / s2 * blockMs : 0
    }
    /// The quietest rise any calibration can ask for: under it a sound isn't sharp enough to be a clap at all.
    static let minRiseDb = 10.0
    /// The rise a sound needs: need(), or 3 dB under the owner's own claps' rise when he calibrated ("Clap twice" in a
    /// room with a fan: his claps there rise less), never under minRiseDb. While calibrating minRiseDb itself: those are
    /// his claps (the width, brightness and fall still have to be a clap's).
    static func riseNeed(peak: Double, hz: Double, calRise: Double?) -> Double {
        let n = need(peak: peak, hz: hz).jump
        return calRise.map { max(minRiseDb, min(n, $0 - 3)) } ?? n
    }
    /// nil when a sound has a clap's shape; otherwise why not (the hard floor, the same at every sensitivity). width: the
    /// sound's width in ms (nil: not measured); calRise: the owner's own claps' rise ("Clap twice"), which may lower the
    /// rise asked of a sound as bright and as wide as a clap, never under minRiseDb.
    static func shapeMiss(peak: Double, jump: Double, hz: Double, decay: Double, smooth: Bool, width: Double? = nil, calRise: Double? = nil) -> String? {
        let riseNeed = Self.riseNeed(peak: peak, hz: hz, calRise: calRise), n = need(peak: peak, hz: hz)
        if peak < floorDb { return String(format: "under the %.0f dB floor", floorDb) }
        if let w = width, w < minWidthMs { return String(format: "a click, %.1f ms (a clap lasts %.1f ms or more: a key, a mouse, a pen)", w, minWidthMs) }
        if jump < riseNeed { return String(format: "rise needs %.1f dB at this level (a key, a tap, a fan)", riseNeed) }
        // A palm on this mic is wide, and the thud pulls the centroid under 2 kHz. The live clap that should
        // count was 1639 Hz. At a desk it is about -36 dB and rises about 20 dB, not 40: the 40 dB bar was a close
        // clap, so a normal desk clap died here as "dull" after the level cap let it through. A wide sound may be
        // that dull when its rise is still a clap's rise at this level. A desk tap that is this wide stays under
        // 1600 Hz (the false one was 1465 Hz). A short click already failed the width check, so it still needs
        // the strict brightness.
        let hzNeed = (width ?? 0) >= palmMs && jump >= riseNeed ? 1600.0 : n.hz
        if hz < hzNeed { return String(format: "needs %.0f Hz at this level (dull: a knock, a thump, a desk)", hzNeed) }
        if decay < (smooth ? decayDb : n.decay) { return String(format: "needs down %.1f dB (kept sounding: a word, a key let go, a door)", smooth ? decayDb : n.decay) }
        return nil
    }
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

    /// The quietest clap peak that counts, in dBFS: -27 / -38 / -46 at Low / Medium / High. "Clap twice" may open that
    /// further (12 dB under the owner's own claps at Medium, so a softer clap still counts). It never raises the bar:
    /// a close calibration (the live one, -20.9 dB) used to ask for -32.9 dB, and real claps at -33 to -38 dB were
    /// logged "too quiet" and never woke. Never under floorDb (C8).
    var levelDb: Double { max(Self.floorDb, guarded ? max(openLevel(sensitivity), openLevel(0.5)) : openLevel(sensitivity)) }
    /// How far a clap's onset must rise over the room and the moment before it: 18 / 15 / 12 dB. Calibration may ask
    /// for less. It never asks for more than the slider.
    var riseDb: Double { guarded ? max(openRise(sensitivity), openRise(0.5)) : openRise(sensitivity) }
    private func sliderLevel(_ s: Double) -> Double { -20 - 36 * s }
    private func sliderRise(_ s: Double) -> Double { 20 - 10 * s }
    private func openLevel(_ s: Double) -> Double {
        guard let c = calibration else { return sliderLevel(s) }
        return min(sliderLevel(s), c.peakDb - 6 - 12 * s)
    }
    private func openRise(_ s: Double) -> Double {
        guard let c = calibration else { return sliderRise(s) }
        let cal = max(10, min(20, c.riseDb - 4 - 6 * (s - 0.5)))
        return min(sliderRise(s), cal)
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

    /// A candidate's line: at most 4 a second, but an accepted one (`always`) is never dropped.
    private func say(_ s: @autoclosure () -> String, always: Bool = false) {
        guard let out = onCandidate else { return }
        if now - lastLine >= 1 { lastLine = now; linesThisSecond = 0 }
        linesThisSecond += 1
        if linesThisSecond <= 4 || always { out(s()) }
    }
    /// The loudest frame of the last second, a clap and its ring-out left out.
    var bedDb: Double { lastSecond.max() ?? -120 }
    /// A clap taken as one is not Hydra's voice: its frames so far leave the last second, and its ring-out stays out.
    private func dropFromBed(_ p: Pending) {
        for k in 1 ... min(lastSecond.count, p.frames) { lastSecond[(lastAt - k + lastSecond.count) % lastSecond.count] = -120 }
        bedMuteUntil = p.t + 0.3
    }
    /// A key's onset frames leave the last second (the bed): the bed stays the sustained sound under it.
    private func dropOnset(_ p: Pending) {
        for k in max(1, p.frames - 2) ... p.frames { lastSecond[(lastAt - k + lastSecond.count) % lastSecond.count] = -120 }
    }
    private var calLevel: Double { max(Self.floorDb, floorDb + 12) }

    private func step() -> Bool {
        now += Double(hop) / rate
        var e: Float = 0, d: Float = 0, mean: Float = 0
        for x in frame { mean += x }
        mean /= Float(hop)
        var prev = frame[0] - mean
        prevSub = sub
        for k in 0 ..< Self.blocks { sub[k] = 0 }
        for i in 0 ..< hop {
            let x = frame[i] - mean
            e += x * x
            if i > 0 { let dx = x - prev; d += dx * dx }
            hpLow += hpPole * (x - hpLow); let h1 = x - hpLow; hpLow2 += hpPole * (h1 - hpLow2); let h = h1 - hpLow2; sub[i * Self.blocks / hop] += Double(h * h)
            prev = x
        }
        let db = max(-120, 10 * log10(Double(e) / Double(hop) + 1e-12))
        let r = Double(d) / Double(max(e, 1e-12))
        let hz = rate / Double.pi * asin(min(1, sqrt(r) / 2))
        meterPeak = max(meterPeak, db)
        // The 30 ms before this frame, as one level (their mean power).
        let before = 10 * log10(recent.map { pow(10, $0 / 10) }.reduce(0, +) / Double(recent.count) + 1e-12)
        // A clap's rise is from where the room was: the frame just before may already hold its first millisecond.
        let roomBefore = min(before, 10 * log10(recent.dropLast().map { pow(10, $0 / 10) }.reduce(0, +) / Double(recent.count - 1) + 1e-12))
        let bed = bedDb
        // The room's bright energy per 1 ms block: the quietest of the last three frames (one may hold a clap's start).
        let noise = (recentD.min() ?? 0) / Double(Self.blocks)
        defer {
            recent.removeFirst(); recent.append(db)
            recentD.removeFirst(); recentD.append(sub.reduce(0, +))
            lastSecond[lastAt] = now < bedMuteUntil ? -120 : db; lastAt = (lastAt + 1) % lastSecond.count
        }
        if now <= Double(hop) / rate * 1.5 { floorDb = db } // the first frame sets the room's level
        if Self.debug, db - floorDb > 12 { print(String(format: "  t=%.3f db=%.1f floor=%.1f before=%.1f hz=%.0f", now, db, floorDb, before, hz)) }

        // Over the room by `rise`, and a sharp jump over the moment before (9 dB: over someone talking that's all a
        // clap can have; the word around it fails the decay instead).
        let rise = db - floorDb, jump = db - before
        let level = calibrating ? calLevel : levelDb
        let onset = rise >= (calibrating ? 10 : riseDb) && jump >= Self.jumpDb && db >= level
        if var p = pending {
            p.frames += 1
            // A much louder onset while a softer one is still being judged (a clap on top of a word): judge the new one.
            if p.frames > 2, onset, db > p.peak + 6 {
                say(String(format: "clap candidate %.1f dB: kept sounding (louder sound right after it)", p.peak))
                pending = Pending(t: now, db: db, base: roomBefore, bed: bed, hz: hz, e: Double(e), d: Double(d), w: prevSub + sub, noise: noise)
                holdFloorUntil = now + 0.3
                return settle()
            }
            if p.frames > 3, jump >= riseDb, db >= level - 6, hz >= Self.brightHz { p.inner = true }
            if p.frames <= 2 {
                if db > p.peak { p.peak = db }
                p.e += Double(e); p.d += Double(d); p.w += sub
                p.hz = rate / Double.pi * asin(min(1, sqrt(p.d / max(p.e, 1e-12)) / 2))
            }
            if p.frames == 1 { p.rise = max(p.rise, db - p.base) }
            if p.frames >= 3, db > p.last + 3, db > floorDb + 6 { p.bump = true }
            p.last = db
            if p.frames >= 6 && p.frames <= 10 { p.tail = max(p.tail, db) }
            pending = p
            if p.frames == 10 {
                pending = nil
                return judge(p)
            }
            return settle()
        }

        if onset, now >= coolUntil || calibrating {
            pending = Pending(t: now, db: db, base: roomBefore, bed: bed, hz: hz, e: Double(e), d: Double(d), w: prevSub + sub, noise: noise)
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
        let decay = p.peak - p.tail, jump = p.rise, n = Self.need(peak: p.peak, hz: p.hz)
        let width = Self.width(p.w, noise: p.noise, blockMs: Double(hop) / rate * 1000 / Double(Self.blocks))
        let calRise = calibrating ? Self.minRiseDb : calibration?.riseDb
        let riseNeed = Self.riseNeed(peak: p.peak, hz: p.hz, calRise: calRise)
        // A clap's hiss over Hydra's voice reads as a few milliseconds here (the bright energy is one burst). The width
        // floor is for a key in a quiet room. It is not applied to a sound already as bright as a clap and clear of the voice.
        let hiss = speaking && !calibrating && p.hz >= Self.speakHz && p.peak >= p.bed + Self.overVoiceDb
        var line = String(format: "clap candidate %.1f dB (needs %.1f), rise %.1f dB (needs %.1f), %.0f Hz (needs %.0f), %.1f ms wide (needs %.1f), down %.1f dB in 100 ms (needs %.1f)",
                          p.peak, calibrating ? calLevel : levelDb, jump, riseNeed, p.hz, n.hz, width, Self.minWidthMs, decay, p.bump ? n.decay : Self.decayDb)
        if speaking && !calibrating { line += String(format: ", %.1f dB over Hydra's voice (needs %.0f)", p.peak - p.bed, Self.overVoiceDb) }
        // The hard floor (C8), the same at every sensitivity and while calibrating.
        if let miss = Self.shapeMiss(peak: p.peak, jump: jump, hz: p.hz, decay: decay, smooth: !p.bump, width: hiss ? nil : width, calRise: calRise) {
            // Still a sharp, bright sound (a key, a mouse click): not a clap, and nothing just around it is alone either
            // (typing breaks the quiet a double clap needs). Sharp: it dies away, comes in a run (typing), or stands over
            // the sound under it (Hydra's voice, a fan) and falls back to it, as a key over Hydra's voice does though its
            // tail is that voice. A syllable is the sound under it and doesn't fall back: talk never counts.
            // A beat (a snare on 2 and 4): a third sound like the pair's, bright and sharp, as far after the second as the
            // second was after the first, however it dies away. Not a double clap.
            if case .two(let t1, let t2, let pk) = state, !calibrating, jump >= Self.jumpDb, p.hz >= Self.brightHz, abs(p.peak - pk) <= 6,
               abs((p.t - t2) - (t2 - t1)) <= 0.25 * (t2 - t1) {
                state = .idle; lastTransient = p.t; lastPeak = p.peak
                say("\(line): a third like them, in time (a beat): not a double clap"); return settle()
            }
            let fellBack = p.peak >= p.bed + 6 && p.tail <= max(p.bed, floorDb) + 3
            let sharp = jump >= Self.jumpDb && p.hz >= Self.brightHz && (decay >= Self.decayDb || p.inner || fellBack)
            if sharp, !calibrating {
                lastTransient = p.t; lastPeak = p.peak; if case .two = state { state = .idle }
                // Not the sound under the next one either: a run of keys each stands over Hydra's voice, not over the last key.
                if fellBack { dropOnset(p) }
            }
            say("\(line): \(p.inner && decay < (p.bump ? n.decay : Self.decayDb) ? "sharp sounds close together (typing?)" : miss)")
            return settle()
        }
        // While Hydra speaks, a key's body tone (about 2.7 to 3.6 kHz, long enough to pass the width floor) is not a clap.
        // A short sound still needs speakHz. A palm clap on this mic is wider and duller (the live log: 1.6 to 1.7 kHz,
        // 10 ms or more). At a desk its rise is about 20 dB, so the old 40 dB bar dropped it and it could not interrupt.
        // The dull band stops under 2.4 kHz, short of a key's tone. It still has to stand clear of the voice.
        // The tone still breaks the quiet a later key would need, when it stands over Hydra's voice. It does not
        // cancel a pair already open.
        if speaking, !calibrating, p.hz < Self.speakHz {
            let palm = width >= Self.palmMs && p.hz >= 1600 && p.hz < 2400 && jump >= riseNeed && p.peak >= p.bed + Self.overVoiceDb
            if !palm {
                if jump >= Self.jumpDb, p.hz >= Self.brightHz, p.peak >= p.bed + Self.overVoiceDb {
                    lastTransient = p.t; lastPeak = p.peak
                }
                say("\(line): needs \(Int(Self.speakHz)) Hz while Hydra speaks (a key's tone, not a clap)")
                return settle()
            }
        }
        // Calibrating: typing (another sharp onset inside its window) is still not a clap (R11-6).
        if calibrating, p.inner { say("\(line): sharp sounds close together (typing?)"); return settle() }
        if calibrating { onTransient?(p.peak, jump); say("\(line): heard (calibrating)", always: true); return settle() }
        // While Hydra speaks (C7): clear of its voice, or it's a syllable, a key or a fan under it.
        if speaking, p.peak < p.bed + Self.overVoiceDb {
            lastTransient = p.t; lastPeak = p.peak; if case .two = state { state = .idle }
            say("\(line): not clear of Hydra's voice"); return settle()
        }
        defer { lastTransient = p.t; lastPeak = p.peak }
        let quiet = p.t - lastTransient
        switch state {
        case .idle:
            if quiet >= Self.quietBefore {
                before = (quiet, lastPeak)
                state = .one(p.t, p.peak); firstLine = String(format: "%.1f dB after %.1f s of quiet", p.peak, min(quiet, 99)); dropFromBed(p)
                say("\(line): first clap", always: true)
            } else { say("\(line): not alone (another sharp sound \(String(format: "%.2f", quiet)) s before)") }
        case .one(let t1, let peak1):
            let gap = p.t - t1
            if gap < Self.flam { say("\(line): part of the last clap"); return settle() }
            // A beat (look-behind): a sound like them came before the first as far as the second came after it.
            if gap <= Self.maxGap, abs(before.gap - gap) <= 0.25 * gap, abs(before.peak - max(peak1, p.peak)) <= 6 {
                state = .idle; say("\(line): in time with the sound \(String(format: "%.2f", before.gap)) s before the first (a beat): not a double clap"); return settle()
            }
            if gap <= Self.maxGap, abs(p.peak - peak1) <= 12 {
                state = .two(t1, p.t, max(peak1, p.peak)); firstLine += String(format: ", then %.1f dB %.2f s later", p.peak, gap); dropFromBed(p)
                say("\(line): second clap, \(String(format: "%.2f", gap)) s after the first", always: true)
            } else if gap <= Self.maxGap { state = .idle; say("\(line): second clap too unlike the first") }
            else {
                state = quiet >= Self.quietBefore ? .one(p.t, p.peak) : .idle
                if quiet >= Self.quietBefore { before = (quiet, lastPeak) }
                if quiet >= Self.quietBefore { firstLine = String(format: "%.1f dB after %.1f s of quiet", p.peak, min(quiet, 99)); dropFromBed(p) }
                say("\(line): first clap (the last was \(String(format: "%.2f", gap)) s ago)", always: true)
            }
        case .two:
            state = .idle
            say("\(line): a third clap: not a double clap")
        }
        return settle()
    }

    private func settle() -> Bool {
        switch state {
        case .idle, .one: if case .one(let t1, _) = state, now - t1 > Self.maxGap + 0.1, pending == nil { state = .idle }; return false
        case .two(let t1, let t2, _):
            guard pending == nil, now - t2 >= Self.quietAfter(gap: t2 - t1) else { return false }
            state = .idle
            coolUntil = now + 1
            say("double clap: \(firstLine), nothing sharp for \(String(format: "%.2f", now - t2)) s after\(speaking ? ", both clear of Hydra's voice" : "")", always: true)
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
    private var guarded = false, speaking = false
    /// Hydra's voice plays with no echo reference (main queue, each mic tick); a change is logged once.
    func setGuarded(_ on: Bool) {
        lock.lock(); let changed = guarded != on; guarded = on; det?.guarded = on; lock.unlock()
        if changed && Self.lines { log(on ? "clap level held at Medium or calibrated: Hydra speaks with no echo reference" : "clap level back to the setting") }
    }
    /// Hydra is speaking (main queue, each mic tick): a clap must stand clear of its voice (C7).
    func setSpeaking(_ on: Bool) { lock.lock(); speaking = on; det?.speaking = on; lock.unlock() }
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
            d.guarded = guarded
            d.speaking = speaking
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

    static func wakes(_ buf: [Float], rate: Double, chunk: Int = 1024, sensitivity: Double = 0.5, calibration: ClapDetector.Calibration? = nil, guarded: Bool = false, speaking: Bool = false) -> Int {
        let det = ClapDetector(rate: rate, sensitivity: sensitivity, calibration: calibration)
        det.guarded = guarded; det.speaking = speaking
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
            // Build 4 E1 (C6): Hydra's voice with no echo reference: High holds at Medium (or calibrated) for that faint pair;
            // a normal clap still counts, and so does one at the owner's calibrated level.
            check("\(r) Hz: the faint pair at High while Hydra speaks with no echo reference", wakes(b, rate: rate, sensitivity: 0.8, guarded: true), 0)
            check("\(r) Hz: the same at the owner's faint calibration while Hydra speaks", wakes(b, rate: rate, calibration: .init(peakDb: -36, riseDb: 26), guarded: true), 1)
            var g = base(); clap(&g, at: 1.0, rate: rate, rng: &rng); clap(&g, at: 1.45, rate: rate, rng: &rng)
            check("\(r) Hz: a real double clap at High while Hydra speaks with no echo reference", wakes(g, rate: rate, sensitivity: 0.8, guarded: true), 1)
            // R11-6: "Clap twice" calibrates to a double clap, never to typing (two quick key pairs, 50 ms apart each).
            b = base(); clap(&b, at: 1.0, rate: rate, rng: &rng); clap(&b, at: 1.45, rate: rate, rng: &rng)
            check("\(r) Hz: calibrating to a double clap (calibrations)", calibrates(b, rate: rate), 1)
            b = base(); for t in [1.0, 1.05, 1.4, 1.45] { clap(&b, at: t, rate: rate, peak: 0.3, rng: &rng, ring: 0) }
            check("\(r) Hz: calibrating to two quick key pairs (calibrations)", calibrates(b, rate: rate), 0)
        }
        // ---- build 4 C8: the hard floor, the same at every sensitivity ----
        // The owner's own false candidates (voice log 2026-11-22, clap sensitivity 0.80, nobody clapping): peak dB, rise
        // dB, Hz, down dB in 100 ms. Every one is turned down, even with the most forgiving tail.
        let falses: [(Double, Double, Double, Double)] = [
            (-45.8, 14.9, 1864, 7.7), (-44.6, 9.6, 1040, 12.2), (-44.8, 13.8, 2836, 9.2), (-43.4, 15.2, 2745, 8.6), (-44.6, 22.2, 1076, 19.1),
            (-39.8, 16.2, 971, 12.5), (-43.0, 22.9, 965, 11.6), (-43.7, 21.2, 1369, 10.1), (-42.9, 22.8, 928, 10.2), (-40.6, 17.7, 943, 13.4),
            (-40.1, 18.1, 1091, 11.2), (-39.7, 24.9, 2418, 7.0), (-47.2, 14.4, 2038, 7.2), (-43.0, 15.5, 2611, 8.9), (-43.5, 16.0, 2632, 7.2),
            (-42.0, 16.4, 1457, 14.3), (-48.4, 11.7, 992, 12.3), (-38.2, 13.6, 3665, 20.7), (-40.1, 17.5, 2491, 6.2), (-39.3, 10.0, 3173, 6.5),
            (-44.8, 14.9, 2530, 13.3), (-45.0, 9.6, 2925, 7.9), (-36.4, 16.1, 1732, 8.7), (-42.9, 21.9, 2966, 7.3), (-47.0, 13.1, 2226, 9.1),
            (-41.5, 18.5, 2314, 10.3), (-41.3, 9.8, 2667, 9.2), (-36.8, 22.6, 1666, 9.9), (-44.6, 15.0, 1599, 11.3), (-35.7, 12.2, 2375, 12.7),
            (-41.3, 10.8, 2250, 6.9), (-41.4, 21.1, 2618, 16.0), (-46.4, 23.1, 2406, 17.9), (-45.5, 19.0, 5257, 13.8), (-36.1, 9.9, 4783, 9.3),
            (-43.1, 12.0, 3334, 11.4), (-43.2, 17.1, 3322, 13.6), (-38.9, 20.6, 1567, 8.0), (-40.0, 14.0, 2475, 7.4), (-42.1, 16.0, 2771, 15.6),
            // While Hydra spoke with no echo reference (cut it off, C7): its own syllables or a key under them.
            (-29.1, 17.8, 1753, 6.2), (-30.0, 9.6, 1451, 9.4), (-29.8, 12.2, 3453, 7.6)]
        let passed = falses.filter { ClapDetector.shapeMiss(peak: $0.0, jump: $0.1, hz: $0.2, decay: $0.3, smooth: true) == nil }
        check("the owner's \(falses.count) logged false candidates (-30 to -48 dB, rises of 9 to 25 dB) all fail the floor (\(passed.map { "\($0.0)" }))", passed.count, 0)
        // His real claps that night: every one clears it, even with the strictest tail.
        let reals: [(Double, Double, Double, Double)] = [(-20.6, 32.1, 4235, 26.0), (-17.6, 30.9, 3950, 21.0), (-22.0, 37.3, 4530, 23.7), (-30.4, 29.2, 4577, 21.8),
            (-15.2, 26.8, 2347, 21.3), (-23.7, 39.3, 7433, 24.9), (-18.1, 40.8, 7578, 27.4), (-14.9, 26.1, 5082, 24.8), (-17.1, 29.2, 5561, 23.8),
            (-14.3, 53.2, 6143, 24.1), (-9.6, 43.4, 3512, 27.9), (-36.6, 25.5, 5138, 24.1), (-24.2, 35.0, 7145, 29.9), (-29.9, 32.4, 5424, 19.9)]
        let missed = reals.filter { ClapDetector.shapeMiss(peak: $0.0, jump: $0.1, hz: $0.2, decay: $0.3, smooth: false) != nil }
        check("the owner's \(reals.count) real claps (-10 to -37 dB) all clear it (\(missed.map { "\($0.0)" }))", reals.count - missed.count, reals.count)
        check("no slider or calibration goes under -46 dB (High, High calibrated to -45 dB)", ClapDetector(rate: 48000, sensitivity: 1, calibration: .init(peakDb: -45, riseDb: 10)).levelDb == -46 && ClapDetector(rate: 48000, sensitivity: 0.8).levelDb == -46 ? 1 : 0, 1)
        for rate in [48000.0, 44100.0, 16000.0] {
            let r = Int(rate)
            for seed: UInt64 in [5, 21, 77] {
                var rng = Rng(s: seed)
                func u(_ a: Double, _ b: Double) -> Double { a + (b - a) * Double(abs(rng.next())) }
                // Pairs 0.18 to 0.75 s apart with a second or more of quiet around them: a double clap's timing exactly.
                func pairs(_ secs: Double, room: Float, _ one: (inout [Float], Double) -> Void) -> [Float] {
                    var b = ClapTest.room(secs, rate: rate, rng: &rng, level: room)
                    var t = 0.8
                    while t < secs - 1.2 { one(&b, t); one(&b, t + u(0.18, 0.75)); t += u(1.8, 2.5) }
                    return b
                }
                let lv = Float(u(0.0012, 0.004))
                let keys = pairs(9, room: lv) { b, t in ClapTest.key(&b, at: t, rate: rate, peak: Float(u(0.01, 0.12)), rng: &rng) }
                let mice = pairs(9, room: lv) { b, t in ClapTest.mouse(&b, at: t, rate: rate, peak: Float(u(0.01, 0.08)), rng: &rng) }
                let taps = pairs(9, room: lv) { b, t in ClapTest.tap(&b, at: t, rate: rate, peak: Float(u(0.01, 0.2)), rng: &rng) }
                let thumps = pairs(9, room: lv) { b, t in ClapTest.thump(&b, at: t, rate: rate, peak: Float(u(0.02, 0.6)), rng: &rng) }
                var fan = ClapTest.room(9, rate: rate, rng: &rng, level: lv); ClapTest.fan(&fan, from: 0.2, to: 8.8, rate: rate, level: Float(u(0.002, 0.006)), rng: &rng)
                for (name, b) in [("two keys at a time", keys), ("mouse clicks in pairs", mice), ("taps on the desk in pairs", taps), ("thumps in pairs", thumps), ("a fan spinning up", fan)] {
                    check("\(r) Hz seed \(seed): \(name) at High", wakes(b, rate: rate, sensitivity: 0.8), 0)
                    check("\(r) Hz seed \(seed): \(name), calibrated to faint claps (-36 dB), High", wakes(b, rate: rate, sensitivity: 0.8, calibration: .init(peakDb: -36, riseDb: 26)), 0)
                }
            }
            // Real double claps at a normal distance (-25 to -12 dBFS, as the owner's were) still wake it at Low, Medium and High.
            var rng = Rng(s: 99)
            var b = room(4, rate: rate, rng: &rng, level: 0.003); clap(&b, at: 1.0, rate: rate, peak: 0.6, rng: &rng, reverb: (0.2, 0.5)); clap(&b, at: 1.35, rate: rate, peak: 0.55, rng: &rng, reverb: (0.2, 0.5))
            for (k, name) in [(0.2, "Low"), (0.5, "Medium"), (0.8, "High")] { check("\(r) Hz: a real double clap at a normal distance, \(name)", wakes(b, rate: rate, sensitivity: k), 1) }
            // ---- C7: a clap while Hydra speaks must stand clear of its voice ----
            var voice = room(5, rate: rate, rng: &rng); speech(&voice, from: 0, to: 5, rate: rate, rng: &rng, level: 0.15)
            check("\(r) Hz: Hydra's own voice with no echo reference never claps (High)", wakes(voice, rate: rate, sensitivity: 0.8, guarded: true, speaking: true), 0)
            var over = voice; clap(&over, at: 2.0, rate: rate, peak: 1.0, rng: &rng); clap(&over, at: 2.4, rate: rate, peak: 1.0, rng: &rng)
            check("\(r) Hz: a clean double clap over Hydra's voice stops it", wakes(over, rate: rate, sensitivity: 0.5, guarded: true, speaking: true), 1)
            var under = voice; clap(&under, at: 2.0, rate: rate, peak: 0.12, rng: &rng); clap(&under, at: 2.4, rate: rate, peak: 0.12, rng: &rng)
            check("\(r) Hz: a double clap barely over Hydra's voice doesn't", wakes(under, rate: rate, sensitivity: 0.8, guarded: true, speaking: true), 0)
            // Hydra's own clicks (a "t", a "k" after a pause) as loud as its voice: sharp, bright and short like a clap,
            // so only the margin over its voice turns them down.
            var own = room(5, rate: rate, rng: &rng); speech(&own, from: 0, to: 2.2, rate: rate, rng: &rng, level: 0.15); speech(&own, from: 3.8, to: 5, rate: rate, rng: &rng, level: 0.15)
            clap(&own, at: 2.6, rate: rate, peak: 0.25, rng: &rng); clap(&own, at: 3.0, rate: rate, peak: 0.25, rng: &rng)
            check("\(r) Hz: clap-like clicks in Hydra's own voice, as loud as it, never stop it", wakes(own, rate: rate, sensitivity: 0.8, guarded: true, speaking: true), 0)
            check("\(r) Hz: (the same clicks with Hydra quiet are a double clap)", wakes(own, rate: rate, sensitivity: 0.8), 1)
            var echoed = room(9, rate: rate, rng: &rng); speech(&echoed, from: 0, to: 9, rate: rate, rng: &rng, level: 0.02)
            var t = 0.8
            while t < 8 { key(&echoed, at: t, rate: rate, peak: 0.05, rng: &rng); key(&echoed, at: t + 0.4, rate: rate, peak: 0.05, rng: &rng); t += 2 }
            check("\(r) Hz: two keys at a time while Hydra speaks (echo cancelled) never stop it, High", wakes(echoed, rate: rate, sensitivity: 0.8, speaking: true), 0)
        }
        // ---- build 4 C8, second verify pass: a key's width, not its rise, tells it from a clap ----
        // A click whose bright energy dies in 1.25 ms (a key) is narrower than the floor's width; a clap's (4 ms) is wider.
        let key = (0 ..< 40).map { pow(exp(-1.0 / 1.25), Double($0)) }, palm = (0 ..< 40).map { pow(exp(-1.0 / 4), Double($0)) }
        check("a key click's width (\(String(format: "%.1f", ClapDetector.width(key, noise: 0))) ms) is under the floor's \(ClapDetector.minWidthMs) ms, a clap's (\(String(format: "%.1f", ClapDetector.width(palm, noise: 0))) ms) over it",
              ClapDetector.width(key, noise: 0) < ClapDetector.minWidthMs && ClapDetector.width(palm, noise: 0) > ClapDetector.minWidthMs ? 1 : 0, 1)
        for rate in [48000.0, 44100.0, 16000.0] {
            let r = Int(rate)
            for seed: UInt64 in [3, 11, 42] {
                var rng = Rng(s: seed &+ 4242)
                func u(_ a: Double, _ b: Double) -> Double { a + (b - a) * Double(abs(rng.next())) }
                // The verifier's repro: bright keys (2.5 to 4 kHz, with soft releases) in pairs a double clap apart, in a
                // -68 dBFS room (they rise 23 to 27 dB there) at -46 to -36 dBFS; and 9 dB louder in a -63 dBFS room.
                for (lo, hi, lv, what) in [(0.06, 0.14, Float(0.0007), "bright keys in a -68 dB room"), (0.2, 0.4, Float(0.0012), "louder bright keys in a -63 dB room")] {
                    var b = room(9, rate: rate, rng: &rng, level: lv), t = 0.8
                    while t < 7.8 { for at in [t, t + u(0.18, 0.75)] { brightKey(&b, at: at, rate: rate, peak: Float(u(lo, hi)), rng: &rng) }; t += u(1.7, 2.6) }
                    for (name, k, cal) in [("Medium", 0.5, nil), ("High", 0.8, nil), ("High, calibrated to faint claps", 0.8, ClapDetector.Calibration(peakDb: -36, riseDb: 26))] as [(String, Double, ClapDetector.Calibration?)] {
                        check("\(r) Hz seed \(seed): \(what), \(name)", wakes(b, rate: rate, sensitivity: k, calibration: cal), 0)
                    }
                }
                // A song whose snares (on 2 and 4, 150 to 176 BPM) come a double clap apart: a beat, at every sensitivity.
                var song = room(9, rate: rate, rng: &rng, level: 0.002); backbeat(&song, rate: rate, rng: &rng, snare: Float(u(0.1, 0.4)))
                for (name, k) in [("Low", 0.2), ("Medium", 0.5), ("High", 0.8)] { check("\(r) Hz seed \(seed): a song, snare on 2 and 4, \(name)", wakes(song, rate: rate, sensitivity: k), 0) }
            }
            // Faint claps (about -33 dBFS) in a room with a fan (-53 dBFS), where they rise only 16 to 20 dB: High hears
            // them; "Clap twice" there calibrates to them, and Medium then hears them too.
            var rng = Rng(s: 77)
            var f = room(4, rate: rate, rng: &rng, level: 0.004); clap(&f, at: 1.0, rate: rate, peak: 0.05, rng: &rng, reverb: (0.2, 0.4)); clap(&f, at: 1.4, rate: rate, peak: 0.045, rng: &rng, reverb: (0.2, 0.4))
            check("\(r) Hz: a faint double clap in a -53 dB room, High", wakes(f, rate: rate, sensitivity: 0.8), 1)
            var c = room(3, rate: rate, rng: &rng, level: 0.004); clap(&c, at: 1.0, rate: rate, peak: 0.04, rng: &rng, reverb: (0.2, 0.4)); clap(&c, at: 1.4, rate: rate, peak: 0.038, rng: &rng, reverb: (0.2, 0.4))
            let det = ClapDetector(rate: rate); det.calibrating = true
            var heard: [(t: Double, peak: Double, rise: Double)] = []
            det.onTransient = { heard.append((det.now, $0, $1)) }
            _ = det.feed(c)
            if case .set(let cal) = ClapDetector.pickCalibration(heard) {
                var g = room(4, rate: rate, rng: &rng, level: 0.004); clap(&g, at: 1.0, rate: rate, peak: 0.04, rng: &rng, reverb: (0.2, 0.4)); clap(&g, at: 1.45, rate: rate, peak: 0.037, rng: &rng, reverb: (0.2, 0.4))
                check("\(r) Hz: fainter claps (about -35 dB) in that room, calibrated to them there, Medium (calibrated to \(String(format: "%.1f dB, rise %.1f", cal.peakDb, cal.riseDb)))", wakes(g, rate: rate, calibration: cal), 1)
            } else { check("\(r) Hz: \"Clap twice\" calibrates to fainter claps (about -35 dB) in a -53 dB room", 0, 1) }
        }
        // R11-6: a pair quieter than -45 dB is too soft to calibrate to: it asks again.
        let soft = ClapDetector.pickCalibration([(1.0, -52, 20), (1.4, -50, 20)]) == .soft ? 0 : 1
        check("a pair at -52 / -50 dB is too soft (soft = 0 wakes)", soft, 0)
        let fine = ClapDetector.pickCalibration([(1.0, -36, 20), (1.4, -30, 22)]) == .set(.init(peakDb: -36, riseDb: 20)) ? 1 : 0
        check("a pair at -36 / -30 dB sets -36 dB, rise 20 (set = 1)", fine, 1)
        // Live path (voice log 2026-11-24): "Clap twice" next to the mic saved -20.9 dB, rise 38.6. That used to ask
        // for -32.9 dB and a 20 dB rise, stricter than Medium, so real claps at -33 to -38 dB were "too quiet".
        let stuck = ClapDetector.Calibration(peakDb: -20.9, riseDb: 38.6)
        let held = ClapDetector(rate: 48000, sensitivity: 0.5, calibration: stuck)
        check("a close calibration does not raise Medium's level or rise (\(String(format: "%.1f dB, rise %.1f", held.levelDb, held.riseDb)))", held.levelDb <= -38 && held.riseDb <= 15 ? 1 : 0, 1)
        // The same log: loud claps the running app turned down. Wide and dull (the thud), not a click and not a thump.
        let liveClap = ClapDetector.shapeMiss(peak: -18.6, jump: 46, hz: 1639, decay: 24.9, smooth: true, width: 10.1) == nil
        check("the live log's palm clap (1639 Hz, 10 ms, rise 46 dB) clears the shape", liveClap ? 1 : 0, 1)
        check("a duller 982 Hz sound stays out (a desk tap sits there)", ClapDetector.shapeMiss(peak: -21.2, jump: 38, hz: 982, decay: 13.3, smooth: true, width: 14.5) == nil ? 1 : 0, 0)
        check("a wide desk tap at 1465 Hz stays a tap", ClapDetector.shapeMiss(peak: -26, jump: 32, hz: 1465, decay: 15, smooth: true, width: 13) == nil ? 1 : 0, 0)
        check("a desk clap at -36 dB (1670 Hz, 12 ms, rise 23) clears the shape", ClapDetector.shapeMiss(peak: -36, jump: 23, hz: 1670, decay: 18, smooth: true, width: 12) == nil ? 1 : 0, 1)
        check("a 1.5 ms click in that log stays a click", ClapDetector.shapeMiss(peak: -19.0, jump: 43.6, hz: 7285, decay: 23.8, smooth: true, width: 1.5) == nil ? 1 : 0, 0)
        check("a 666 Hz sound that keeps going stays out", ClapDetector.shapeMiss(peak: -26.7, jump: 21.5, hz: 666, decay: -0.1, smooth: false, width: 19.2) == nil ? 1 : 0, 0)
        // The function the mic tap calls (ClapTap.feed), with the stuck calibration, on a dull palm double clap.
        var rng = Rng(s: 11)
        var live = room(3, rate: 48000, rng: &rng, level: 0.002)
        palmClap(&live, at: 0.7, rate: 48000, peak: 0.08)
        palmClap(&live, at: 1.15, rate: 48000, peak: 0.07)
        check("the mic's feed fires on a dull palm double clap under the stuck calibration", micFires(live, rate: 48000, calibration: stuck), 1)
        var keys = room(3, rate: 48000, rng: &rng, level: 0.002)
        Self.key(&keys, at: 0.7, rate: 48000, peak: 0.08, rng: &rng)
        Self.key(&keys, at: 1.15, rate: 48000, peak: 0.07, rng: &rng)
        check("the mic's feed stays quiet for two keys under that calibration", micFires(keys, rate: 48000, calibration: stuck), 0)
        var over = room(4, rate: 48000, rng: &rng, level: 0.002)
        speech(&over, from: 0, to: 4, rate: 48000, rng: &rng, level: 0.08)
        clap(&over, at: 1.2, rate: 48000, peak: 1.0, rng: &rng)
        clap(&over, at: 1.65, rate: 48000, peak: 1.0, rng: &rng)
        check("a double clap over Hydra's voice, under the stuck calibration, stops it", wakes(over, rate: 48000, sensitivity: 0.5, calibration: stuck, guarded: true, speaking: true), 1)
        check("that same clap reaches the mic's feed while Hydra speaks", micFires(over, rate: 48000, calibration: stuck, speaking: true), 1)
        // The level cap let a -36 dB clap through, then the shape asked for 3000 Hz unless the rise was 40 dB.
        // A desk clap on this mic is about 1.7 kHz and rises about 20 dB. Same function the mic tap calls.
        let desk = deskPair(rate: 48000)
        check("the mic's feed wakes on a -36 dB desk clap under a calibration stricter than Medium", micFires(desk, rate: 48000, calibration: stuck), 1)
        check("that desk clap interrupts while Hydra speaks", micFires(desk, rate: 48000, calibration: stuck, speaking: true), 1)
        return bad == 0 ? 0 : 1
    }

    /// A desk clap as this laptop mic hears it: a 1.1 kHz thud and a little hiss. The loudest 10 ms frame, once scaled,
    /// sits near -36 dB and the centroid near 1.7 kHz. A close clap's 40 dB rise is not this.
    static func deskClap(_ buf: inout [Float], at: Double, rate: Double, peak: Float) {
        let start = Int(at * rate), n = Int(0.12 * rate)
        var rng = Rng(s: UInt64(max(1, at * 1000)) &+ 17)
        var lp: Float = 0
        let pole = Float(1 - exp(-2 * .pi * 3500 / rate))
        for i in 0 ..< n where start + i < buf.count {
            let t = Double(i) / rate
            let thud = Float(min(1, t / 0.0015) * exp(-t / 0.012) * sin(2 * .pi * 1100 * t))
            let hissEnv = t < 0.008 ? Float(min(1, t / 0.0006)) : Float(exp(-(t - 0.008) / 0.006))
            lp += pole * (rng.next() - lp)
            buf[start + i] += peak * (thud + 0.05 * hissEnv * lp)
        }
    }

    /// Two desk claps whose loudest 10 ms frames are -36 and -36.5 dBFS, in a quiet room.
    static func deskPair(rate: Double) -> [Float] {
        var rng = Rng(s: 11)
        var buf = room(3, rate: rate, rng: &rng, level: 0.002)
        func place(_ at: Double, _ db: Double) {
            var one = [Float](repeating: 0, count: buf.count)
            deskClap(&one, at: at, rate: rate, peak: 1)
            let hop = max(64, Int(rate / 100))
            var loud = -120.0, i = 0
            while i + hop <= one.count {
                var e = 0.0
                for k in 0 ..< hop { let x = Double(one[i + k]); e += x * x }
                loud = max(loud, 10 * log10(e / Double(hop) + 1e-12))
                i += hop
            }
            let g = Float(pow(10, (db - loud) / 20))
            for k in 0 ..< one.count { buf[k] += one[k] * g }
        }
        place(0.7, -36)
        place(1.15, -36.5)
        return buf
    }

    /// A palm clap as this laptop mic hears it: a 1.2 kHz thud and a hiss that lasts about 10 ms, then gone.
    static func palmClap(_ buf: inout [Float], at: Double, rate: Double, peak: Float) {
        let start = Int(at * rate), n = Int(0.12 * rate)
        var rng = Rng(s: UInt64(max(1, at * 1000)) &+ 17)
        var lp: Float = 0
        let pole = Float(1 - exp(-2 * .pi * 4000 / rate))
        for i in 0 ..< n where start + i < buf.count {
            let t = Double(i) / rate
            let thud = Float(min(1, t / 0.001) * exp(-t / 0.014) * sin(2 * .pi * 1200 * t))
            let hissEnv = t < 0.01 ? Float(min(1, t / 0.0008)) : Float(exp(-(t - 0.01) / 0.004))
            lp += pole * (rng.next() - lp)
            buf[start + i] = max(-1, min(1, buf[start + i] + peak * (0.8 * thud + 0.7 * hissEnv * lp)))
        }
    }

    /// What the mic tap calls: ClapTap.feed on 1024-frame float buffers. Counts double claps that reach onClap.
    static func micFires(_ samples: [Float], rate: Double, calibration: ClapDetector.Calibration?, speaking: Bool = false) -> Int {
        let tap = ClapTap()
        tap.configure(sensitivity: 0.5, calibration: calibration)
        tap.setSpeaking(speaking)
        tap.setGuarded(speaking)
        final class Count { var n = 0 }
        let count = Count()
        tap.onClap = { count.n += 1 }
        let fmt = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
        var i = 0
        while i < samples.count {
            let n = min(1024, samples.count - i)
            guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(n)) else { return -1 }
            buf.frameLength = AVAudioFrameCount(n)
            samples.withUnsafeBufferPointer { src in buf.floatChannelData![0].update(from: src.baseAddress! + i, count: n) }
            tap.feed(buf)
            i += n
        }
        let until = Date(timeIntervalSinceNow: 0.3)
        while count.n == 0 && Date() < until { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.01)) }
        return count.n
    }
}
