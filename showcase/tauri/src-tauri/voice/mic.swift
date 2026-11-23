// The one mic (owner: "clapping and saying the keyphrase still barely work"). Before, a take, wake listening, the
// clap detector and barge-in each opened an engine of their own, so turning one on closed another: the mic was
// opened and shut hundreds of times an hour, with gaps between, and voice processing failed to start right after
// another engine let go (kAUInitialize). Now one engine and one input tap feed everyone who listens:
// - consumers (the clap detector, barge-in's talk detector, the recogniser's feed) are added and removed on a running
//   engine; that never restarts it;
// - the engine runs while anyone wants it, and goes 3 s after the last one leaves;
// - while Hydra speaks with interrupt-by-talking on (macOS 14+), it runs with voice processing (echo cancellation)
//   and Hydra's voice plays in it (hydraout.swift), so barge-in is only one more consumer; the rest of the time it's
//   the plain mic, so claps and the wake phrase aren't put through noise suppression;
// - a mic plugged in or out, or the default changing, rebuilds it once, half a second after the last change.
// Build 4 C7: echo cancellation failed to start on the owner's Mac (118 lines of -10875, kAUInitialize on the output
// node, as the engine switched from the plain mic), so barge-in never ran. Now: it isn't tried when the output device
// has no usable format (the other -10875 his log shows); a kAUInitialize failure waits a moment for the engine that
// just let go and tries once more; a failure that stays waits 30 s, then 60 s, then gives up until the mic changes;
// and each open logs one line, however many mics and tries it took.
// The file-input harness (--bench) feeds recordings through deliver(), the same path the tap uses.
import AVFoundation
import CoreAudio
import Foundation

final class MicHub {
    typealias Consumer = (AVAudioPCMBuffer) -> Void
    /// Raw consumers run first, in name order; the recogniser's feed last (it boosts the buffer in place).
    private let lock = NSLock()
    private var raw: [(String, Consumer)] = []
    private var speech: Consumer?

    private(set) var engine: AVAudioEngine?
    private(set) var device: AudioDeviceID?
    /// Running with voice processing (echo cancellation): barge-in can listen over Hydra's voice.
    private(set) var echoCancel = false
    var running: Bool { engine?.isRunning == true || fileMode }
    /// No engine: buffers come from deliver() (the harness, --test-live).
    var fileMode = false
    /// Hydra's voice plays in this engine while it runs with echo cancellation.
    var out: HydraOut?
    /// Called on the main queue after a rebuild (the format may have changed) and when the engine stops on its own.
    var onRebuilt: () -> Void = {}
    /// Voice processing wouldn't turn on for any mic: barge-in can't work on this one.
    var onNoEchoCancel: () -> Void = {}
    private var configObserver: NSObjectProtocol?
    private var rebuildAt: Double?
    private var idleSince: Double?
    private(set) var opens = 0, rebuilds = 0

    // ---------- consumers (any thread) ----------

    func add(_ name: String, _ c: @escaping Consumer) {
        lock.lock(); raw.removeAll { $0.0 == name }; raw.append((name, c)); raw.sort { $0.0 < $1.0 }; lock.unlock()
    }
    func remove(_ name: String) { lock.lock(); raw.removeAll { $0.0 == name }; lock.unlock() }
    func has(_ name: String) -> Bool { lock.lock(); defer { lock.unlock() }; return raw.contains { $0.0 == name } }
    func setSpeech(_ c: Consumer?) { lock.lock(); speech = c; lock.unlock() }

    /// One buffer from the mic (the tap's thread) or a recording: to every consumer.
    func deliver(_ buffer: AVAudioPCMBuffer) {
        lock.lock(); let cs = raw.map(\.1), sp = speech; lock.unlock()
        for c in cs { c(buffer) }
        sp?(buffer)
    }

    // ---------- the engine (main thread) ----------

    /// Opens the mic (closing it first if it's open another way): `device` (nil: the system's choice, then the
    /// default, then the built-in, as InputDevice.tries says), with echo cancellation when asked and it starts. True
    /// when it runs.
    @discardableResult func open(device: AudioDeviceID?, echoCancel wantEcho: Bool) -> Bool {
        idleSince = nil
        if fileMode { return true }
        if running, self.device == device, echoCancel == wantEcho { return true }
        if device != self.device { echoFails = 0; echoRetryAt = 0 }
        if engine != nil { close(why: "switching") }
        var sawNoEcho = false, settled = false, failures: [String] = []
        let opened = InputDevice.firstOpening(InputDevice.tries(picked: device, current: InputDevice.current(), builtIn: InputDevice.builtIn())) { dev -> (AVAudioEngine, Bool)? in
            if wantEcho, #available(macOS 14, *) {
                // Voice processing that won't start on this mic: the plain mic, and again later.
                tries: while true {
                    switch start(dev, echo: true) {
                    case .ok(let e): return (e, true)
                    case .noEcho: sawNoEcho = true; break tries
                    case .failed(let why, let initFailed):
                        failures.append(why)
                        // kAUInitialize right after another engine let go: give it a moment, then once more (once per open).
                        guard initFailed, !settled else { break tries }
                        settled = true
                        Thread.sleep(forTimeInterval: Self.settle)
                    }
                }
            }
            switch start(dev, echo: false) {
            case .ok(let e): return (e, false)
            case .failed(let why, _): failures.append(why)
            case .noEcho: break
            }
            return nil
        }
        guard let (eng, echo) = opened else { log("mic couldn't open\(device.map { " (device \($0))" } ?? ""): \(Self.summary(failures))"); return false }
        engine = eng; self.device = device; echoCancel = echo; opens += 1; openedAt = uptime()
        var note = ""
        if wantEcho && !echo {
            if sawNoEcho { onNoEchoCancel(); note = " (no echo cancellation on this mic)" }
            else { echoFailed(now: uptime()); note = " (echo cancellation couldn't start: \(Self.summary(failures)); \(echoFails < Self.echoTries ? "next try in \(Int(echoRetryAt - uptime())) s" : "not tried again until the mic changes"))" }
        }
        if echo { echoFails = 0 }
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: eng, queue: .main) { [weak self] _ in
            // An engine reports a change of its own as it settles (voice processing's aggregate device, a switch to the
            // built-in mic): not a reason to rebuild. One that really stopped is opened again by tick.
            guard let self, self.engine === eng, uptime() - self.openedAt > 1.5 else { return }
            log("mic: audio devices changed")
            self.changed()
        }
        log("mic open\(echo ? " (echo cancellation)" : "")\(device.map { " on device \($0)" } ?? "")\(note)")
        return true
    }

    /// How long a kAUInitialize failure waits before its one more try (the engine that just let go settling).
    static let settle = 0.25
    /// The tries an open made, as one short line: each distinct failure once, with how many times.
    static func summary(_ failures: [String]) -> String {
        var seen: [(String, Int)] = []
        for f in failures { if let i = seen.firstIndex(where: { $0.0 == f }) { seen[i].1 += 1 } else { seen.append((f, 1)) } }
        return seen.isEmpty ? "no reason given" : seen.map { $0.1 > 1 ? "\($0.0) x\($0.1)" : $0.0 }.joined(separator: "; ")
    }
    /// A CoreAudio error as a few words: its code and the call or condition that failed.
    static func short(_ error: Error) -> (String, initFailed: Bool) {
        let ns = error as NSError
        let what = (ns.userInfo["failed call"] as? String) ?? (ns.userInfo["false condition"] as? String) ?? ""
        let call = what.replacingOccurrences(of: "err = ", with: "").replacingOccurrences(of: "PerformCommand", with: "")
        return ("\(ns.code)\(call.isEmpty ? "" : " \(call)")", ns.code == -10875 && what.contains("kAUInitialize"))
    }

    private enum Start { case ok(AVAudioEngine), noEcho, failed(String, initFailed: Bool) }
    private func start(_ dev: AudioDeviceID?, echo: Bool) -> Start {
        let eng = AVAudioEngine()
        let input = eng.inputNode
        if let dev, !InputDevice.use(dev, on: input) { return .failed("device \(dev) wouldn't take", initFailed: false) }
        if echo, #available(macOS 14, *) {
            // Voice processing works the output too: with no usable output format it can't start (-10875).
            let hw = eng.outputNode.outputFormat(forBus: 0)
            guard hw.sampleRate > 0, hw.channelCount > 0 else { return .failed("the output device has no usable format", initFailed: false) }
            do { try input.setVoiceProcessingEnabled(true) } catch { log("mic: no echo cancellation (\(error))"); return .noEcho }
            guard input.isVoiceProcessingEnabled else { return .noEcho }
            // Voice processing turns other sound down by default: that would duck Hydra's own voice.
            input.voiceProcessingOtherAudioDuckingConfiguration = Ducking.configuration
        }
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { return .failed("the mic has no usable format", initFailed: false) }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in self?.deliver(buffer) }
        if echo { out?.attach(eng) }
        do { eng.prepare(); try eng.start(); return .ok(eng) } catch {
            if echo { out?.detach() }
            input.removeTap(onBus: 0)
            if echo, #available(macOS 14, *) { try? input.setVoiceProcessingEnabled(false) }
            let (why, initFailed) = Self.short(error)
            return .failed("\(dev.map { "device \($0): " } ?? "")\(why)", initFailed: initFailed)
        }
    }

    func close(why: String) {
        idleSince = nil
        if let o = configObserver { NotificationCenter.default.removeObserver(o); configObserver = nil }
        guard let eng = engine else { return }
        if echoCancel { out?.detach() }
        eng.inputNode.removeTap(onBus: 0)
        eng.stop()
        if echoCancel, #available(macOS 14, *) { try? eng.inputNode.setVoiceProcessingEnabled(false) }
        engine = nil; echoCancel = false
        log("mic closed (\(why))")
    }

    private var openedAt = -10.0, rebuiltAt: [Double] = []
    /// A device change: one rebuild, half a second after the last change (they come in bursts). Three in 30 s: the
    /// next waits until 30 s after the last, so a mic that keeps reporting changes can't reopen it over and over.
    func changed() {
        let now = uptime()
        rebuiltAt = rebuiltAt.filter { now - $0 < 30 }
        rebuildAt = rebuiltAt.count >= 3 ? rebuiltAt.last! + 30 : now + 0.5
    }
    /// Another mic picked, or the default input changed: rebuilt on it, and it may take voice processing.
    func newMic() { echoFails = 0; echoRetryAt = 0; changed() }

    /// Voice processing that failed to start (kAUInitialize, after its one settle-and-retry): tried again 30 s later,
    /// then 60 s, while it's still wanted, three times at most on one mic; then barge-in is off until the mic changes.
    /// Before, every 30 s for ever, each time closing the working mic.
    private(set) var echoFails = 0
    private var echoRetryAt = 0.0
    static let echoTries = 3
    static func echoBackoff(_ fails: Int) -> Double { 30 * pow(2, Double(max(0, fails - 1))) }
    func echoAllowed(now: Double) -> Bool { echoFails < Self.echoTries && now >= echoRetryAt }
    func echoFailed(now: Double) {
        echoFails += 1; echoRetryAt = now + Self.echoBackoff(echoFails)
        if echoFails == Self.echoTries { log("mic: echo cancellation failed \(Self.echoTries) times on this mic: not tried again until it changes"); onNoEchoCancel() }
    }

    private var retryAt = 0.0
    /// Each frame (Voice.tick): `wanted` is whether anyone needs the mic now, `device` and `echo` how. Rebuilds after a
    /// device change, opens when wanted (a failure tries again in 10 s; echo cancellation that wouldn't start, in 30 s),
    /// closes 3 s after nobody is.
    func tick(now: Double, wanted: Bool, device: AudioDeviceID?, echo: Bool) {
        guard !fileMode else { return }
        let echo = echo && echoAllowed(now: now)
        if let at = rebuildAt, now >= at {
            rebuildAt = nil
            guard engine != nil || wanted else { return }
            close(why: "rebuild after a device change")
            rebuilds += 1; rebuiltAt.append(now)
            if wanted { if open(device: device, echoCancel: echo) { onRebuilt() } else { retryAt = now + 10 } }
            return
        }
        if wanted {
            idleSince = nil
            guard now >= retryAt, !running || self.device != device || echo != echoCancel else { return }
            if engine != nil && !running { close(why: "stopped on its own") }
            if open(device: device, echoCancel: echo) { onRebuilt() } else { retryAt = now + 10 }
        } else if engine != nil {
            if idleSince == nil { idleSince = now }
            if now - (idleSince ?? now) >= 3 { close(why: "not needed") }
        }
    }
}

// ---------- --test-mic: the consumer rules, with no mic ----------
enum MicTest {
    static func run() -> Int32 {
        var bad = 0
        func check(_ name: String, _ ok: Bool) { print("\(ok ? "ok" : "FAIL") \(name)"); if !ok { bad += 1 } }
        let hub = MicHub()
        hub.fileMode = true
        var order: [String] = []
        hub.setSpeech { _ in order.append("speech") }
        hub.add("clap") { _ in order.append("clap") }
        hub.add("barge") { _ in order.append("barge") }
        let buf = AVAudioPCMBuffer(pcmFormat: AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!, frameCapacity: 16)!
        buf.frameLength = 16
        hub.deliver(buf)
        check("every consumer gets the buffer, the recogniser's feed last (it boosts in place)", order == ["barge", "clap", "speech"])
        hub.remove("clap"); order = []; hub.deliver(buf)
        check("a consumer removed gets nothing more; the rest go on", order == ["barge", "speech"])
        hub.add("barge") { _ in order.append("barge2") }; order = []; hub.deliver(buf)
        check("adding one again replaces it", order == ["barge2", "speech"])
        check("adding and removing never opened or closed an engine", hub.opens == 0 && hub.engine == nil)
        // The mic isn't wanted with every trigger off, though the recogniser's feed is always attached.
        check("nothing listening: the mic closes", !Voice.micWanted(allowed: true, take: false, wake: false, clap: false, barging: false, playingInMic: false))
        check("wake listening wants it", Voice.micWanted(allowed: true, take: false, wake: true, clap: false, barging: false, playingInMic: false))
        check("no permission: never", !Voice.micWanted(allowed: false, take: true, wake: true, clap: true, barging: true, playingInMic: true))
        // Echo cancellation only while Hydra speaks with interrupting on, and 3 s after; never switched mid-take.
        let ew = Voice.echoWanted
        check("interrupting on, Hydra quiet: no echo cancellation (claps and wake hear the plain mic)", !ew(true, false, 100, false, false, false))
        check("turning interrupting on or off while quiet doesn't reopen", ew(true, false, 100, false, false, false) == ew(false, false, 100, false, false, false))
        check("Hydra speaking, interrupting on: echo cancellation", ew(true, true, 0, false, false, false))
        check("interrupting turned off mid-sentence: kept until it ends", ew(false, true, 0, false, true, false))
        check("kept 3 s after Hydra stops", ew(true, false, 2, false, true, false) && !ew(true, false, 4, false, true, false))
        check("kept through a take", ew(false, false, 60, true, true, false))
        check("not moved while Hydra speaks on its own engine", !ew(true, true, 0, false, false, true))
        check("nor turned on after that sentence ends", !ew(true, false, 1, false, false, false))
        // Voice processing that won't start: 3 tries 30 s apart on one mic, then not again until the mic changes.
        var gaveUp = 0
        hub.onNoEchoCancel = { gaveUp += 1 }
        check("echo cancellation allowed at first", hub.echoAllowed(now: 0))
        hub.echoFailed(now: 0)
        check("a failure waits 30 s", !hub.echoAllowed(now: 29) && hub.echoAllowed(now: 31))
        hub.echoFailed(now: 31); hub.echoFailed(now: 62)
        check("three failures: given up, and barge-in told", !hub.echoAllowed(now: 1000) && gaveUp == 1)
        hub.changed()
        check("the engine reporting a change of its own doesn't", !hub.echoAllowed(now: 1000))
        hub.newMic()
        check("another mic tries again", hub.echoAllowed(now: 1000))
        // Build 4 C7: the backoff, and one line per open however many tries it took.
        check("the next try waits 30 s, then 60 s", MicHub.echoBackoff(1) == 30 && MicHub.echoBackoff(2) == 60)
        let failed = NSError(domain: "com.apple.coreaudio.avfaudio", code: -10875, userInfo: ["failed call": "err = PerformCommand(*outputNode, kAUInitialize, NULL, 0)"])
        let short = MicHub.short(failed)
        check("the owner's -10875 reads as a kAUInitialize failure, tried once more after \(MicHub.settle) s (\(short.0))", short.initFailed && short.0 == "-10875 (*outputNode, kAUInitialize, NULL, 0)" && MicHub.settle > 0 && MicHub.settle <= 0.3)
        let format = NSError(domain: "com.apple.coreaudio.avfaudio", code: -10875, userInfo: ["false condition": "IsFormatSampleRateAndChannelCountValid(outputHWFormat)"])
        check("a bad output format isn't tried again at once", !MicHub.short(format).initFailed)
        let line = MicHub.summary([short.0, short.0, short.0, short.0, "the output device has no usable format"])
        check("two mics tried twice each: one line, each failure once with its count (\(line))", line == "-10875 (*outputNode, kAUInitialize, NULL, 0) x4; the output device has no usable format")
        return bad == 0 ? 0 : 1
    }
}
