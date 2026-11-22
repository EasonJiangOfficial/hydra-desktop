// The one mic (owner: "clapping and saying the keyphrase still barely work"). Before, a take, wake listening, the
// clap detector and barge-in each opened an engine of their own, so turning one on closed another: the mic was
// opened and shut hundreds of times an hour, with gaps between, and voice processing failed to start right after
// another engine let go (kAUInitialize). Now one engine and one input tap feed everyone who listens:
// - consumers (the clap detector, barge-in's talk detector, the recogniser's feed) are added and removed on a running
//   engine; that never restarts it;
// - the engine runs while anyone wants it, and goes 3 s after the last one leaves;
// - with interrupt-by-talking on (macOS 14+), it runs with voice processing (echo cancellation) and Hydra's voice
//   plays in it (hydraout.swift), so barge-in is only one more consumer;
// - a mic plugged in or out, or the default changing, rebuilds it once, half a second after the last change.
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
    var hasSpeech: Bool { lock.lock(); defer { lock.unlock() }; return speech != nil }

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
        if engine != nil { close(why: "switching") }
        var sawNoEcho = false
        let opened = InputDevice.firstOpening(InputDevice.tries(picked: device, current: InputDevice.current(), builtIn: InputDevice.builtIn())) { dev -> (AVAudioEngine, Bool)? in
            if wantEcho, #available(macOS 14, *) {
                switch start(dev, echo: true) {
                case .ok(let e): return (e, true)
                case .noEcho: sawNoEcho = true
                case .failed: break // voice processing that won't start on this mic: the plain mic, and again later
                }
            }
            if case .ok(let e) = start(dev, echo: false) { return (e, false) }
            return nil
        }
        guard let (eng, echo) = opened else { log("mic couldn't open\(device.map { " (device \($0))" } ?? "")"); return false }
        engine = eng; self.device = device; echoCancel = echo; opens += 1; openedAt = uptime()
        if wantEcho && !echo { if sawNoEcho { onNoEchoCancel() } else { echoRetryAt = uptime() + 30 } }
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: eng, queue: .main) { [weak self] _ in
            // An engine reports a change of its own as it settles (voice processing's aggregate device, a switch to the
            // built-in mic): not a reason to rebuild. One that really stopped is opened again by tick.
            guard let self, self.engine === eng, uptime() - self.openedAt > 1.5 else { return }
            log("mic: audio devices changed")
            self.changed()
        }
        log("mic open\(echo ? " (echo cancellation)" : "")\(device.map { " on device \($0)" } ?? "")")
        return true
    }

    private enum Start { case ok(AVAudioEngine), noEcho, failed }
    private func start(_ dev: AudioDeviceID?, echo: Bool) -> Start {
        let eng = AVAudioEngine()
        let input = eng.inputNode
        if let dev, !InputDevice.use(dev, on: input) { return .failed }
        if echo, #available(macOS 14, *) {
            do { try input.setVoiceProcessingEnabled(true) } catch { log("mic: no echo cancellation (\(error))"); return .noEcho }
            guard input.isVoiceProcessingEnabled else { return .noEcho }
            // Voice processing turns other sound down by default: that would duck Hydra's own voice.
            input.voiceProcessingOtherAudioDuckingConfiguration = Ducking.configuration
        }
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { return .failed }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in self?.deliver(buffer) }
        if echo { out?.attach(eng) }
        do { eng.prepare(); try eng.start(); return .ok(eng) } catch {
            if echo { out?.detach() }
            input.removeTap(onBus: 0)
            if echo, #available(macOS 14, *) { try? input.setVoiceProcessingEnabled(false) }
            log("mic couldn't start\(dev.map { " on device \($0)" } ?? "")\(echo ? " with echo cancellation" : ""): \(error)")
            return .failed
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

    private var retryAt = 0.0, echoRetryAt = 0.0
    /// Each frame (Voice.tick): `wanted` is whether anyone needs the mic now, `device` and `echo` how. Rebuilds after a
    /// device change, opens when wanted (a failure tries again in 10 s; echo cancellation that wouldn't start, in 30 s),
    /// closes 3 s after nobody is.
    func tick(now: Double, wanted: Bool, device: AudioDeviceID?, echo: Bool) {
        guard !fileMode else { return }
        let echo = echo && now >= echoRetryAt
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
        return bad == 0 ? 0 : 1
    }
}
