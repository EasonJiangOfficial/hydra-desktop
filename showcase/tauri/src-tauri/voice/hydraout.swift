// Hydra's own voice on this Mac (W5 voice contract sections 5 and 6).
// - It plays here, through the same voice-processing audio engine as the barge-in mic (barge.swift), so echo
//   cancellation has Hydra's voice as its reference and takes it out of what the mic hears. When that mic isn't
//   running (barge-in off, no permission, asleep), an output-only engine plays it.
// - Voice processing turns other audio down by default; that is switched off (Ducking), and mute-while-listening
//   never mutes Hydra's own voice (OutputMute.shouldMute).
// - The orb's spectrum: 24 bands of 0...1 (Spectrum), Hydra's voice while it speaks and the mic while a take listens,
//   sent at most 30 times a second (BandPacer).
import Accelerate
import AVFoundation
import Foundation

/// 24 log-spaced bands from 80 Hz to 8 kHz (or just under half the rate), each the loudest bin in it, in dBFS mapped
/// from -70 dB (0) to -10 dB (1). A 1024-sample Hann window over the newest samples.
enum Spectrum {
    static let count = 24, size = 1024, floorDb: Float = -70, topDb: Float = -10
    private static let log2n = vDSP_Length(10)
    private static let setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2))!
    private static let window: [Float] = {
        var w = [Float](repeating: 0, count: size)
        vDSP_hann_window(&w, vDSP_Length(size), Int32(vDSP_HANN_DENORM))
        return w
    }()

    static func bands(_ x: UnsafePointer<Float>, count n: Int, rate: Double) -> [Float] {
        var buf = [Float](repeating: 0, count: size)
        let m = min(n, size)
        for i in 0 ..< m { buf[size - m + i] = x[n - m + i] }
        vDSP_vmul(buf, 1, window, 1, &buf, 1, vDSP_Length(size))
        let half = size / 2
        var re = [Float](repeating: 0, count: half), im = [Float](repeating: 0, count: half), power = [Float](repeating: 0, count: half)
        re.withUnsafeMutableBufferPointer { rp in
            im.withUnsafeMutableBufferPointer { ip in
                var sc = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                buf.withUnsafeBufferPointer { bp in
                    bp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: half) { vDSP_ctoz($0, 2, &sc, 1, vDSP_Length(half)) }
                }
                vDSP_fft_zrip(setup, &sc, 1, log2n, FFTDirection(FFT_FORWARD))
                sc.imagp[0] = 0 // the packed Nyquist term
                vDSP_zvmags(&sc, 1, &power, 1, vDSP_Length(half))
            }
        }
        // A sine of amplitude A peaks at (A * size / 2)^2 here (Hann sums to size / 2, zrip doubles).
        let full = Float(size / 2) * Float(size / 2)
        let lo = 80.0, hi = min(8000.0, rate / 2 * 0.95)
        var out = [Float](repeating: 0, count: count)
        for k in 0 ..< count {
            let f0 = lo * pow(hi / lo, Double(k) / Double(count)), f1 = lo * pow(hi / lo, Double(k + 1) / Double(count))
            let b0 = max(1, Int(f0 / rate * Double(size))), b1 = min(half, max(b0 + 1, Int((f1 / rate * Double(size)).rounded(.up))))
            var peak: Float = 0
            for b in b0 ..< b1 { peak = max(peak, power[b]) }
            let db = 10 * log10(peak / full + 1e-20)
            out[k] = min(1, max(0, (db - floorDb) / (topDb - floorDb)))
        }
        return out
    }
    static func bands(_ x: [Float], rate: Double) -> [Float] { x.withUnsafeBufferPointer { bands($0.baseAddress!, count: x.count, rate: rate) } }
}

/// At most 30 sends a second.
struct BandPacer {
    private var last = -1.0
    static let gap = 1.0 / 30
    mutating func ready(_ now: Double) -> Bool { if now - last >= Self.gap - 1e-6 { last = now; return true }; return false }
}

/// Other audio is never turned down by voice processing: Hydra's own voice is in that engine (W5 contract 6).
enum Ducking {
    @available(macOS 14, *)
    static var configuration: AVAudioVoiceProcessingOtherAudioDuckingConfiguration { .init(enableAdvancedDucking: false, duckingLevel: .min) }
}

enum Resample {
    /// 16-bit little-endian mono PCM as samples in -1...1.
    static func int16(_ d: Data) -> [Float] {
        let n = d.count / 2
        var out = [Float](repeating: 0, count: n)
        d.withUnsafeBytes { raw in
            for i in 0 ..< n { out[i] = Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: 2 * i, as: Int16.self))) / 32768 }
        }
        return out
    }
    /// Linear interpolation to another rate (22.05 kHz Mac voice to the player's 44.1 kHz).
    static func linear(_ x: [Float], from: Double, to: Double) -> [Float] {
        guard from != to, from > 0, to > 0, x.count > 1 else { return x }
        let n = Int((Double(x.count) * to / from).rounded())
        var out = [Float](repeating: 0, count: n)
        for i in 0 ..< n {
            let t = Double(i) * from / to, j = Int(t), f = Float(t - Double(j))
            out[i] = j + 1 < x.count ? x[j] * (1 - f) + x[j + 1] * f : x[x.count - 1]
        }
        return out
    }
}

/// The player. attach(engine) puts it in the barge-in mic's engine before that starts; otherwise play() makes an
/// output-only engine of its own. Main thread only.
final class HydraOut {
    static let rate = 44100.0
    private let format = AVAudioFormat(standardFormatWithSampleRate: HydraOut.rate, channels: 1)!
    private var player: AVAudioPlayerNode?
    private var host: AVAudioEngine?
    private var own: AVAudioEngine?
    private var current: String?
    private var generation = 0
    private(set) var pending = 0
    private(set) var paused = false
    var volume: Float = 1 { didSet { player?.volume = volume } }
    /// Audio is queued or sounding.
    var busy: Bool { pending > 0 }
    /// Playing on its own output-only engine (moving it into the mic's engine now would cut it off).
    var onOwnEngine: Bool { host != nil && host === own }
    var onBands: ([Float]) -> Void = { _ in }
    var onFail: (String) -> Void = { _ in }

    func attach(_ eng: AVAudioEngine) {
        detach()
        let p = AVAudioPlayerNode()
        eng.attach(p)
        eng.connect(p, to: eng.mainMixerNode, format: format)
        p.volume = volume
        var pacer = BandPacer()
        let rate = eng.mainMixerNode.outputFormat(forBus: 0).sampleRate
        eng.mainMixerNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
            guard let ch = buffer.floatChannelData?[0], buffer.frameLength > 0, pacer.ready(uptime()) else { return }
            let b = Spectrum.bands(ch, count: Int(buffer.frameLength), rate: rate)
            DispatchQueue.main.async { if self?.busy == true { self?.onBands(b) } }
        }
        player = p; host = eng
    }

    /// Out of its engine (that engine is stopping): what was queued is dropped.
    func detach() {
        guard let eng = host else { return }
        generation += 1
        player?.stop()
        eng.mainMixerNode.removeTap(onBus: 0)
        if let p = player { eng.detach(p) }
        player = nil; host = nil
        let was = pending > 0
        pending = 0; current = nil
        if eng === own { eng.stop(); own = nil }
        if was { onBands([Float](repeating: 0, count: Spectrum.count)) }
    }

    /// One chunk of a reply (id): a new id drops the last reply's audio first.
    func play(id: String, pcm: Data, rate: Double) {
        if id != current { stop(); current = id }
        if player == nil && !startOwn() { onFail("no output"); return }
        guard let p = player else { return }
        var f = Resample.int16(pcm)
        if rate != HydraOut.rate { f = Resample.linear(f, from: rate, to: HydraOut.rate) }
        guard !f.isEmpty, let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(f.count)) else { return }
        buf.frameLength = AVAudioFrameCount(f.count)
        f.withUnsafeBufferPointer { src in buf.floatChannelData![0].update(from: src.baseAddress!, count: f.count) }
        // Hydra's own voice is never muted by mute-while-listening.
        OutputMute.end()
        pending += 1
        let gen = generation
        p.scheduleBuffer(buf) { [weak self] in
            DispatchQueue.main.async {
                guard let self, self.generation == gen else { return }
                self.pending = max(0, self.pending - 1)
                if self.pending == 0 { self.idle() }
            }
        }
        if !paused && !p.isPlaying { p.play() }
    }

    func stop() {
        guard pending > 0 || current != nil else { return }
        generation += 1
        player?.stop()
        pending = 0; current = nil
        onBands([Float](repeating: 0, count: Spectrum.count))
        idle()
    }

    func pause(_ on: Bool) {
        paused = on
        guard let p = player else { return }
        if on { p.pause() } else if pending > 0 { p.play() }
    }

    private func startOwn() -> Bool {
        let eng = AVAudioEngine()
        own = eng
        attach(eng)
        do { eng.prepare(); try eng.start(); log("Hydra's voice: output only (no echo reference)"); return true }
        catch { log("Hydra's voice couldn't start: \(error)"); detach(); own = nil; return false }
    }

    /// Nothing left to play: the output-only engine goes after a moment (the next sentence usually comes first).
    private func idle() {
        onBands([Float](repeating: 0, count: Spectrum.count))
        guard own != nil else { return }
        let gen = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self, self.generation == gen, self.pending == 0, self.onOwnEngine else { return }
            self.detach()
        }
    }
}

// ---------- --test-bands and --test-ducking ----------
enum OutTest {
    static func check(_ name: String, _ ok: Bool, _ bad: inout Int) { print("\(ok ? "ok" : "FAIL") \(name)"); if !ok { bad += 1 } }
    static func sine(_ hz: Double, amp: Float, rate: Double, n: Int = 2048) -> [Float] { (0 ..< n).map { amp * Float(sin(2 * .pi * hz * Double($0) / rate)) } }

    static func bands() -> Int32 {
        var bad = 0
        for rate in [44100.0, 48000.0, 16000.0] {
            let r = Int(rate)
            let quiet = Spectrum.bands([Float](repeating: 0, count: 2048), rate: rate)
            check("\(r) Hz: 24 bands", quiet.count == 24, &bad)
            check("\(r) Hz: silence is all 0", quiet.allSatisfy { $0 < 0.01 }, &bad)
            let k = Spectrum.bands(sine(1000, amp: 0.5, rate: rate), rate: rate)
            let top = k.indices.max { k[$0] < k[$1] }!
            check("\(r) Hz: every band is 0...1", k.allSatisfy { $0 >= 0 && $0 <= 1 }, &bad)
            check("\(r) Hz: a 1 kHz tone peaks in its own band (\(top)) at \(String(format: "%.2f", k[top]))", k[top] > 0.8 && abs(Double(top) - expected(1000, rate: rate)) <= 1, &bad)
            check("\(r) Hz: far bands stay low (\(String(format: "%.2f", k[0])), \(String(format: "%.2f", k[23])))", k[0] < 0.3 && k[23] < 0.3, &bad)
            let low = Spectrum.bands(sine(200, amp: 0.5, rate: rate), rate: rate)
            let lowTop = low.indices.max { low[$0] < low[$1] }!
            check("\(r) Hz: a 200 Hz tone peaks lower (\(lowTop) < \(top))", lowTop < top, &bad)
            let soft = Spectrum.bands(sine(1000, amp: 0.005, rate: rate), rate: rate)
            check("\(r) Hz: a quieter tone is lower (\(String(format: "%.2f", soft[top])) < \(String(format: "%.2f", k[top])))", soft[top] < k[top] - 0.3 && soft[top] > 0, &bad)
            let both = zip(sine(200, amp: 0.3, rate: rate), sine(3000, amp: 0.3, rate: rate)).map { $0 + $1 }
            let b = Spectrum.bands(both, rate: rate)
            check("\(r) Hz: two tones make two spikes", b[lowTop] > 0.7 && b[Int(expected(3000, rate: rate))] > 0.7 && b[Int(expected(1000, rate: rate))] < 0.5, &bad)
        }
        var p = BandPacer()
        let sent = stride(from: 0.0, to: 1.0, by: 0.005).filter { p.ready($0) }.count
        check("at most 30 sends a second (\(sent))", sent <= 30 && sent >= 28, &bad)
        let up = Resample.linear([0, 1, 0, -1], from: 22050, to: 44100)
        check("22.05 kHz doubles to 44.1 kHz (\(up.count))", up.count == 8 && abs(up[1] - 0.5) < 1e-6, &bad)
        let pcm = Data([0x00, 0x80, 0xff, 0x7f, 0x00, 0x00])
        let s = Resample.int16(pcm)
        check("16-bit PCM reads as -1...1", s.count == 3 && s[0] == -1 && abs(s[1] - 32767 / 32768) < 1e-6 && s[2] == 0, &bad)
        return bad == 0 ? 0 : 1
    }
    /// The band a frequency falls in.
    static func expected(_ hz: Double, rate: Double) -> Double {
        let lo = 80.0, hi = min(8000.0, rate / 2 * 0.95)
        return floor(log(hz / lo) / log(hi / lo) * Double(Spectrum.count))
    }

    static func ducking() -> Int32 {
        var bad = 0
        if #available(macOS 14, *) {
            let c = Ducking.configuration
            check("voice processing doesn't use advanced ducking", c.enableAdvancedDucking.boolValue == false, &bad)
            check("voice processing ducks other audio the least it can", c.duckingLevel == .min, &bad)
        } else { print("ok ducking: before macOS 14 voice processing isn't used") }
        check("mute while listening: other sound is muted", OutputMute.shouldMute(enabled: true, hydraPlaying: false), &bad)
        check("mute while listening never mutes Hydra's own voice", !OutputMute.shouldMute(enabled: true, hydraPlaying: true), &bad)
        check("mute while listening off: nothing is muted", !OutputMute.shouldMute(enabled: false, hydraPlaying: false), &bad)
        return bad == 0 ? 0 : 1
    }
}
