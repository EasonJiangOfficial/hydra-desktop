// Hands-free triggers for Hydra (macOS), all on this Mac: nothing is recognised or sent until a take starts.
// - Awake: a double clap starts a take (like the talk keys), and so does the key phrase ("Hey Hydra").
// - Asleep: a double clap, a tap on the orb or the key phrase wakes it (W5 contract 4: "Yes, phrase wakes it"); the
//   phrase's take goes on at once.
// - While Hydra speaks: the owner talking over it (barge-in) or a double clap stops the speech and starts a take.
//   The mic then runs with macOS voice processing (echo cancellation), so Hydra's own voice from the speakers is
//   taken out, and a talk needs a sustained rise over the room for 200 ms, not one loud frame.
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
    /// Whether the clap detector needs its own mic: nothing else holds the mic, and wake listening (which hears claps
    /// itself) can't run right now, whatever its setting.
    static func clapDetectorRuns(clapOn: Bool, idle: Bool, barging: Bool, wakeCanRun: Bool) -> Bool { clapOn && idle && !barging && !wakeCanRun }
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

/// The mic while Hydra speaks: voice processing on (echo cancellation), a talk detector and a double-clap detector on
/// the cleaned sound. Nothing is recorded or recognised.
final class BargeListener {
    private var engine: AVAudioEngine?
    var running: Bool { engine?.isRunning == true }
    var clapSensitivity = 0.5
    /// Hydra's voice plays in this engine while it runs (hydraout.swift): the echo canceller's reference.
    var out: HydraOut?
    private let onTalk: () -> Void, onClap: () -> Void
    init(onTalk: @escaping () -> Void, onClap: @escaping () -> Void) { self.onTalk = onTalk; self.onClap = onClap }

    enum Start { case started, failed, noEchoCancel }
    /// The same mics a take tries, in the same order (InputDevice.firstOpening). No echo cancellation only when no mic
    /// had it; a mic that failed to open says nothing about that.
    func start(device: AudioDeviceID?) -> Start {
        stop()
        // Before macOS 14 voice processing can't be kept from turning Hydra's own voice down: not used.
        guard #available(macOS 14, *) else { return .noEchoCancel }
        var saw = [Start]()
        let ok = InputDevice.firstOpening(InputDevice.tries(picked: device, current: InputDevice.current(), builtIn: InputDevice.builtIn())) { dev -> Bool? in
            let r = open(dev); saw.append(r); return r == .started ? true : nil
        }
        if ok == true { return .started }
        return !saw.isEmpty && saw.allSatisfy { $0 == .noEchoCancel } ? .noEchoCancel : .failed
    }

    @available(macOS 14, *)
    private func open(_ device: AudioDeviceID?) -> Start {
        let eng = AVAudioEngine()
        let input = eng.inputNode
        if let device, !InputDevice.use(device, on: input) { return .failed }
        do { try input.setVoiceProcessingEnabled(true) } catch { log("barge-in: no echo cancellation (\(error))"); return .noEchoCancel }
        guard input.isVoiceProcessingEnabled else { return .noEchoCancel }
        // Voice processing turns other sound down by default: that would duck Hydra's own voice.
        input.voiceProcessingOtherAudioDuckingConfiguration = Ducking.configuration
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { return .failed }
        let talk = SpeechOnset(rate: format.sampleRate), clap = ClapDetector(rate: format.sampleRate, sensitivity: clapSensitivity)
        let onTalk = onTalk, onClap = onClap
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            guard let ch = buffer.floatChannelData?[0] else { return }
            let n = Int(buffer.frameLength)
            if talk.feed(ch, count: n) { DispatchQueue.main.async { onTalk() } }
            if clap.feed(ch, count: n) { DispatchQueue.main.async { onClap() } }
        }
        out?.attach(eng)
        do { eng.prepare(); try eng.start() } catch { out?.detach(); input.removeTap(onBus: 0); try? input.setVoiceProcessingEnabled(false); log("barge-in listening couldn't start: \(error)"); return .failed }
        engine = eng
        log("barge-in listening on (echo cancellation)")
        return .started
    }

    func stop() {
        guard let eng = engine else { return }
        out?.detach()
        eng.inputNode.removeTap(onBus: 0)
        eng.stop()
        try? eng.inputNode.setVoiceProcessingEnabled(false)
        engine = nil
        InputDevice.freedAt = uptime()
        log("barge-in listening off")
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
        check("key phrase on but its mic not open (no permission, backing off, held): the clap detector listens", Trigger.clapDetectorRuns(clapOn: true, idle: true, barging: false, wakeCanRun: false))
        check("wake listening running hears claps itself: no second mic", !Trigger.clapDetectorRuns(clapOn: true, idle: true, barging: false, wakeCanRun: true))
        check("barge-in holds the mic: no second mic", !Trigger.clapDetectorRuns(clapOn: true, idle: true, barging: true, wakeCanRun: false))
        // The start order: the mic a stuck default can't open ('!dev') falls through to the next one, as a take does.
        var tried = [AudioDeviceID?]()
        let got = InputDevice.firstOpening(InputDevice.tries(picked: nil, current: 3, builtIn: 4)) { d -> AudioDeviceID? in tried.append(d); return d == nil ? nil : d }
        check("the clap detector and barge-in try the next mic when the system's choice fails", got == 3 && tried == [nil, 3])
        check("a picked mic is the only one they try", InputDevice.firstOpening(InputDevice.tries(picked: 7, current: 3, builtIn: 4)) { d -> AudioDeviceID? in d == 7 ? nil : d } == nil)
        check("the clap detector waits for the last engine's mic to go", !InputDevice.settled(now: 10.1, freedAt: 10.0) && InputDevice.settled(now: 10.5, freedAt: 10.0))
        check("nothing let go of the mic yet: it starts at once", InputDevice.settled(now: 1.0, freedAt: -10.0))
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
        }
        return bad == 0 ? 0 : 1
    }
}
