// Voice helper for Roamies (macOS). Watches ⌃⌥, captures the mic and transcribes on-device with
// Apple's SpeechAnalyzer (macOS 26+, works with Siri and Dictation off; SFSpeechRecognizer before that).
// A session never ends while ⌃⌥ is held: it ends on release (push-to-talk), or for hands-free
// (quick tap) on a pause or the next press-and-release. Hold ⌃⌥ = push-to-talk (release sends). Quick tap = hands-free
// (ends on a pause or another tap). JSON lines on stdout; exits when stdin closes.
// Modifier state is read with CGEventSource, which needs no Input Monitoring permission.
// While ⌃⌥ is held, moving the cursor draws on the screen (ink.swift); the marked area goes out with what was said.
// While listening, a small voice-bar pill rides beside the cursor (wave.swift) instead of a transcript bubble.
// With the wake word on, it also listens quietly for "Hey Roamies" and starts a hands-free take on hearing it.
import AVFoundation
import AppKit
import CoreAudio
import CoreGraphics
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) else { return }
    print(line)
}

/// Whether a click does something that changes what's on screen: a button, link, tab, menu item, pop-up or search
/// field, or a double-click that opens a row or icon in a list. Roles run from the clicked element up to its window.
enum ClickTarget {
    static let acting: Set<String> = ["AXButton", "AXLink", "AXMenuItem", "AXMenuBarItem", "AXMenuButton", "AXPopUpButton", "AXComboBox",
                                      "AXSearchField", "AXRadioButton", "AXTab", "AXDisclosureTriangle", "AXIncrementor", "AXColorWell",
                                      "AXDockItem", "AXSegmentedControl"]
    // Where climbing stops: a click on the empty part of one of these does nothing, but a double-click in a list opens.
    static let containers: Set<String> = ["AXWebArea", "AXScrollArea", "AXSplitGroup", "AXApplication", "AXLayoutArea", "AXWindow",
                                          "AXList", "AXTable", "AXOutline", "AXBrowser"]
    static let opensOnDouble: Set<String> = ["AXList", "AXTable", "AXOutline", "AXBrowser"]
    static func acts(roles: [String], count: Int) -> Bool {
        for r in roles {
            if acting.contains(r) { return true }
            if containers.contains(r) { return count >= 2 && opensOnDouble.contains(r) }
        }
        return false
    }
    /// The roles under a point and its app (empty when it can't be read); nil for Roamies' own windows.
    static func at(_ p: CGPoint) -> (roles: [String], app: String)? {
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.25)
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(p.x), Float(p.y), &hit) == .success, var e = hit else { return ([], "") }
        var pid: pid_t = 0
        AXUIElementGetPid(e, &pid)
        if pid == getpid() || pid == getppid() { return nil }
        var roles: [String] = []
        for _ in 0 ..< 10 {
            var v: CFTypeRef?
            if AXUIElementCopyAttributeValue(e, kAXRoleAttribute as CFString, &v) == .success, let r = v as? String { roles.append(r) }
            var up: CFTypeRef?
            guard AXUIElementCopyAttributeValue(e, kAXParentAttribute as CFString, &up) == .success, let u = up, CFGetTypeID(u) == AXUIElementGetTypeID() else { break }
            e = u as! AXUIElement
        }
        return (roles, NSRunningApplication(processIdentifier: pid)?.localizedName ?? "")
    }
}

func log(_ s: String) {
    FileHandle.standardError.write(Data("[voice] \(s)\n".utf8))
}

// Wake lines carry the time, so a missed "Hey Roamies" can be matched to when it was said.
private let clock: DateFormatter = { let f = DateFormatter(); f.dateFormat = "HH:mm:ss"; return f }()
func wakeLog(_ s: String) { log("wake \(clock.string(from: Date())): \(s)") }

let dryRun = ProcessInfo.processInfo.environment["ROAMIES_VOICE_DRYRUN"] == "1"

// --test-live <wav>: the recording stands in for the room, played in real time to whatever is listening (wake or a
// take), with the wake word on and nothing muted. Runs the real paths end to end; exits 15 s after the recording ends.
enum LiveTest {
    static let url: URL? = {
        let a = CommandLine.arguments
        guard let i = a.firstIndex(of: "--test-live"), i + 1 < a.count else { return nil }
        return URL(fileURLWithPath: a[i + 1])
    }()
    static var sink: ((AVAudioPCMBuffer) -> Void)?
    private static var timer: DispatchSourceTimer?

    static func start() {
        guard let url, let file = try? AVAudioFile(forReading: url),
              let all = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
              (try? file.read(into: all)) != nil else { log("test-live: can't read the recording"); exit(2) }
        let fmt = all.format, chunk: AVAudioFrameCount = 1024
        var pos: AVAudioFrameCount = 0, silent = 0
        let t = DispatchSource.makeTimerSource(queue: .global())
        t.schedule(deadline: .now(), repeating: Double(chunk) / fmt.sampleRate)
        t.setEventHandler {
            guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: chunk) else { return }
            buf.frameLength = chunk
            for c in 0 ..< Int(fmt.channelCount) {
                let dst = buf.floatChannelData![c]
                for k in 0 ..< Int(chunk) { dst[k] = pos + AVAudioFrameCount(k) < all.frameLength ? all.floatChannelData![c][Int(pos) + k] : 0 }
            }
            if pos < all.frameLength { pos += chunk; if pos >= all.frameLength { log("test-live: recording ended") } }
            else { silent += 1; if Double(silent * Int(chunk)) / fmt.sampleRate > 15 { DispatchQueue.main.async { exit(0) } } }
            DispatchQueue.main.async { sink?(buf) }
        }
        t.resume()
        timer = t
    }
}
func uptime() -> Double { ProcessInfo.processInfo.systemUptime }

// One recognition session. Callbacks always arrive on the main queue.
protocol Recognizer: AnyObject {
    func append(_ buffer: AVAudioPCMBuffer)
    func end()
    func cancel()
}
struct RecognizerCallbacks {
    let onText: (String) -> Void
    let onDone: () -> Void
    let onError: (Error) -> Void
    /// The recogniser's other readings of the same moment (wake listening only, macOS 26+): the phrase may be in one.
    var onAlternatives: (([String]) -> Void)? = nil
}

// Locale.current is limited to the bundle's localizations (none ship), so it is always English:
// follow the user's own language list instead, which also honours a per-app language in System Settings.
func speechLocaleCandidates() -> [Locale] {
    Locale.preferredLanguages.map { Locale(identifier: $0) } + [Locale.current, Locale(identifier: "en-US")]
}

// The older recogniser wants an exact supported locale: take the first of the user's languages it has,
// in that language's main region when the user's region isn't offered (en-BR → en-US).
func legacySpeechLocale() -> Locale? {
    let supported = SFSpeechRecognizer.supportedLocales().sorted { $0.identifier < $1.identifier }
    for want in speechLocaleCandidates() {
        if let hit = supported.first(where: { speechKey($0.identifier) == speechKey(want.identifier) }) { return hit }
        let lang = speechKey(want.identifier).split(separator: "_").first.map(String.init) ?? ""
        let same = supported.filter { speechKey($0.identifier).split(separator: "_").first.map(String.init) == lang }
        if same.isEmpty { continue }
        if #available(macOS 13, *), let region = Locale.Language(identifier: lang).maximalIdentifier.split(separator: "-").last,
           let main = same.first(where: { speechKey($0.identifier) == "\(lang)_\(region.lowercased())" }) { return main }
        return same.first
    }
    return nil
}

// Compares locale ids loosely: "ar-SA", "ar_sa" and "AR-sa" are the same.
func speechKey(_ id: String) -> String { id.replacingOccurrences(of: "-", with: "_").lowercased() }

// The older recogniser's locale for an explicit speech language such as "ar-SA": the same id, else the first
// offered locale in that language (ar → ar_SA or whichever Apple lists first). nil when none is offered.
func legacyLocale(for id: String) -> Locale? {
    let supported = SFSpeechRecognizer.supportedLocales().sorted { $0.identifier < $1.identifier }
    let want = speechKey(id)
    if let hit = supported.first(where: { speechKey($0.identifier) == want }) { return hit }
    let lang = want.split(separator: "_").first.map(String.init) ?? ""
    return supported.first(where: { speechKey($0.identifier).split(separator: "_").first.map(String.init) == lang })
}

// macOS 26+: SpeechAnalyzer + SpeechTranscriber. Model assets are shared system-wide and
// downloaded on first use; the locale and audio format are resolved once and reused.
@available(macOS 26, *)
final class AnalyzerRecognizer: Recognizer {
    // One prepared task per locale (nil: the user's own languages, as before).
    private static var prepared: [String: Task<(Locale, AVAudioFormat?), Error>] = [:]
    static func prepare(locale given: Locale? = nil) -> Task<(Locale, AVAudioFormat?), Error> {
        let cacheKey = given?.identifier ?? ""
        if let p = prepared[cacheKey] { return p }
        let t = Task { () throws -> (Locale, AVAudioFormat?) in
            var locale: Locale?
            if let given {
                locale = await SpeechTranscriber.supportedLocale(equivalentTo: given)
            } else {
                for want in speechLocaleCandidates() where locale == nil {
                    locale = await SpeechTranscriber.supportedLocale(equivalentTo: want)
                }
            }
            let resolved = locale ?? Locale(identifier: "en-US")
            let probe = SpeechTranscriber(locale: resolved, preset: .progressiveTranscription)
            if let req = try await AssetInventory.assetInstallationRequest(supporting: [probe]) {
                log("downloading speech model for \(resolved.identifier)")
                try await req.downloadAndInstall()
            }
            let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [probe])
            log("speech analyzer ready: \(resolved.identifier) \(format.map { "\($0.sampleRate)Hz" } ?? "native")")
            return (resolved, format)
        }
        prepared[cacheKey] = t
        return t
    }

    private let raw: AsyncStream<AVAudioPCMBuffer>.Continuation
    private var work: Task<Void, Never>?
    private var finalized = "", volatile = ""

    init(_ cb: RecognizerCallbacks, locale: Locale? = nil) {
        let (stream, cont) = AsyncStream<AVAudioPCMBuffer>.makeStream()
        raw = cont
        let wanted = locale
        work = Task { [weak self] in
            var analyzer: SpeechAnalyzer?, reader: Task<Void, Error>?
            do {
                let (locale, format) = try await Self.prepare(locale: wanted).value
                // Wake listening also asks for the other readings it weighed ("Hey Hydra" under "Hey, Heidler").
                let p = SpeechTranscriber.Preset.progressiveTranscription
                let tr = cb.onAlternatives == nil ? SpeechTranscriber(locale: locale, preset: p)
                    : SpeechTranscriber(locale: locale, transcriptionOptions: p.transcriptionOptions, reportingOptions: p.reportingOptions.union([.alternativeTranscriptions]), attributeOptions: p.attributeOptions)
                let a = SpeechAnalyzer(modules: [tr])
                analyzer = a
                // Lean toward the app's names, as contextualStrings does for the older recogniser ("Hey Roamies").
                let context = AnalysisContext()
                context.contextualStrings[.general] = WakeWord.hints
                try? await a.setContext(context)
                var converter: AVAudioConverter?
                let inputs = AsyncStream<AnalyzerInput> { out in
                    Task {
                        for await buf in stream {
                            if let format, buf.format != format {
                                if converter == nil || converter?.inputFormat != buf.format { converter = AVAudioConverter(from: buf.format, to: format) }
                                if let c = converter, let conv = Self.convert(buf, with: c, to: format) { out.yield(AnalyzerInput(buffer: conv)) }
                            } else {
                                out.yield(AnalyzerInput(buffer: buf))
                            }
                        }
                        out.finish()
                    }
                }
                try await a.start(inputSequence: inputs)
                reader = Task {
                    for try await r in tr.results {
                        let text = String(r.text.characters)
                        guard let self else { return }
                        let before = self.finalized
                        if r.isFinal { self.finalized = Self.join(self.finalized, text); self.volatile = "" } else { self.volatile = text }
                        let shown = Self.join(self.finalized, self.volatile).trimmingCharacters(in: .whitespaces)
                        let alts = cb.onAlternatives == nil ? [] : r.alternatives.dropFirst().map { Self.join(before, String($0.characters)).trimmingCharacters(in: .whitespaces) }
                        DispatchQueue.main.async { cb.onText(shown); if !alts.isEmpty { cb.onAlternatives?(alts) } }
                    }
                }
                // Hold until the user stops talking (end()), then flush what's left.
                await self?.waitForEnd()
                // Cancelled (Esc, or the wake recogniser's refresh): stop now, so this analyzer is let go at once and
                // can't hold up the next one.
                if Task.isCancelled { reader?.cancel(); await a.cancelAndFinishNow(); return }
                try await a.finalizeAndFinishThroughEndOfInput()
                try await reader?.value
                DispatchQueue.main.async { cb.onDone() }
            } catch is CancellationError {
                reader?.cancel(); await analyzer?.cancelAndFinishNow()
            } catch {
                reader?.cancel(); await analyzer?.cancelAndFinishNow()
                DispatchQueue.main.async { cb.onError(error) }
            }
        }
    }

    private var ended = false, endWaiters: [CheckedContinuation<Void, Never>] = []
    private func waitForEnd() async {
        await withCheckedContinuation { c in
            DispatchQueue.main.async { if self.ended { c.resume() } else { self.endWaiters.append(c) } }
        }
    }

    private static func join(_ a: String, _ b: String) -> String {
        if a.isEmpty { return b }
        if b.isEmpty { return a }
        return a.hasSuffix(" ") || b.hasPrefix(" ") ? a + b : a + " " + b
    }

    private static func convert(_ buf: AVAudioPCMBuffer, with c: AVAudioConverter, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let cap = AVAudioFrameCount(Double(buf.frameLength) * format.sampleRate / buf.format.sampleRate) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: cap) else { return nil }
        var fed = false
        var err: NSError?
        c.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return buf
        }
        return err == nil && out.frameLength > 0 ? out : nil
    }

    func append(_ buffer: AVAudioPCMBuffer) { raw.yield(buffer) }
    func end() {
        raw.finish()
        DispatchQueue.main.async { self.ended = true; self.endWaiters.forEach { $0.resume() }; self.endWaiters = [] }
    }
    func cancel() {
        raw.finish()
        work?.cancel()
        DispatchQueue.main.async { self.ended = true; self.endWaiters.forEach { $0.resume() }; self.endWaiters = [] }
    }
}

// Before macOS 26: SFSpeechRecognizer. Needs Siri or Dictation turned on in System Settings.
final class LegacyRecognizer: Recognizer {
    private let req = SFSpeechAudioBufferRecognitionRequest()
    private var task: SFSpeechRecognitionTask?

    /// onDeviceOnly: nil rather than sending audio to Apple's servers (wake listening, which hears everything).
    /// locale: the explicit speech language's locale; nil keeps the automatic choice (the user's own languages).
    init?(_ cb: RecognizerCallbacks, onDeviceOnly: Bool = false, locale: Locale? = nil) {
        let explicit = locale.flatMap { SFSpeechRecognizer(locale: $0) }
        guard let rec = explicit ?? legacySpeechLocale().flatMap({ SFSpeechRecognizer(locale: $0) }) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")), rec.isAvailable else { return nil }
        if onDeviceOnly && !rec.supportsOnDeviceRecognition { return nil }
        req.shouldReportPartialResults = true
        if rec.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        if #available(macOS 13, *) { req.addsPunctuation = true }
        req.taskHint = .dictation
        req.contextualStrings = WakeWord.hints
        task = rec.recognitionTask(with: req) { result, error in
            DispatchQueue.main.async {
                if let result {
                    cb.onText(result.bestTranscription.formattedString)
                    if result.isFinal { cb.onDone() }
                }
                if let error { cb.onError(error) }
            }
        }
    }
    func append(_ buffer: AVAudioPCMBuffer) { req.append(buffer) }
    func end() { req.endAudio() }
    func cancel() { task?.cancel(); task = nil }
}

// Mutes the default output while you talk so music or videos don't drown you out (or end up in the
// transcript), then puts it back. Only ever un-mutes what it muted itself.
enum OutputMute {
    private static var device: AudioDeviceID?
    static var enabled = true

    private static func addr(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }
    private static func defaultOutput() -> AudioDeviceID? {
        var id = AudioDeviceID(0), size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var a = addr(kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal)
        return AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &id) == noErr && id != 0 ? id : nil
    }
    private static func muted(_ dev: AudioDeviceID) -> Bool? {
        var a = addr(kAudioDevicePropertyMute, kAudioDevicePropertyScopeOutput)
        guard AudioObjectHasProperty(dev, &a) else { return nil }
        var v = UInt32(0), size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(dev, &a, 0, nil, &size, &v) == noErr ? v != 0 : nil
    }
    private static func set(_ dev: AudioDeviceID, _ on: Bool) -> Bool {
        var a = addr(kAudioDevicePropertyMute, kAudioDevicePropertyScopeOutput)
        var v: UInt32 = on ? 1 : 0
        return AudioObjectSetPropertyData(dev, &a, 0, nil, UInt32(MemoryLayout<UInt32>.size), &v) == noErr
    }

    /// Mute other sound while listening, never Hydra's own voice: it plays through the default output too (hydraout.swift).
    static func shouldMute(enabled: Bool, hydraPlaying: Bool) -> Bool { enabled && !hydraPlaying }
    static var hydraPlaying: () -> Bool = { false }
    static func begin() {
        guard shouldMute(enabled: enabled, hydraPlaying: hydraPlaying()), device == nil, let dev = defaultOutput(), muted(dev) == false else { return }
        if set(dev, true) { device = dev; log("output muted while listening") }
    }
    /// Unmute for a moment (a cue that must be heard while listening), then mute again if still listening.
    static func lift(for seconds: Double) {
        guard let dev = device, set(dev, false) else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
            if device == dev, muted(dev) == false { _ = set(dev, true) }
        }
    }
    static func end() {
        guard let dev = device else { return }
        device = nil
        // Unmute only if it's still muted: the user may have unmuted by hand meanwhile.
        if muted(dev) == true, set(dev, false) { log("output restored") }
    }
}

// Where the mic's buffers go: swapped on the main thread while the audio thread feeds it, so wake listening can
// start a fresh recogniser without reopening the mic. It keeps the last 0.7 s of sound, so a new wake window can hear
// that first (preroll) and nothing said as the windows change falls between them.
final class Feed {
    private let lock = NSLock()
    private var target: Recognizer?
    private var recent: [AVAudioPCMBuffer] = [], recentFrames = 0
    static let keep = 0.7
    func set(_ r: Recognizer?, preroll: Bool = false) {
        lock.lock(); defer { lock.unlock() }
        if let r, preroll { for b in recent { r.append(b) } }
        target = r
    }
    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let t = target
        recent.append(buffer); recentFrames += Int(buffer.frameLength)
        while let first = recent.first, recentFrames - Int(first.frameLength) >= Int(Self.keep * buffer.format.sampleRate) { recentFrames -= Int(first.frameLength); recent.removeFirst() }
        lock.unlock()
        t?.append(buffer)
    }
}

// Wake listening keeps the mic open. On a Bluetooth headset that drops it (AirPods too) to call-quality sound for as
// long as it's on, so it listens on the built-in mic instead. A mic picked in the panel is used for everything.
enum InputDevice {
    private static func addr(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }
    private static func defaultInput() -> AudioDeviceID? {
        var id = AudioDeviceID(0), size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var a = addr(kAudioHardwarePropertyDefaultInputDevice)
        return AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &id) == noErr && id != 0 ? id : nil
    }
    private static func transport(_ dev: AudioDeviceID) -> UInt32? {
        var v = UInt32(0), size = UInt32(MemoryLayout<UInt32>.size)
        var a = addr(kAudioDevicePropertyTransportType)
        return AudioObjectGetPropertyData(dev, &a, 0, nil, &size, &v) == noErr ? v : nil
    }
    private static func hasInput(_ dev: AudioDeviceID) -> Bool {
        var size = UInt32(0)
        var a = addr(kAudioDevicePropertyStreams, kAudioDevicePropertyScopeInput)
        return AudioObjectGetPropertyDataSize(dev, &a, 0, nil, &size) == noErr && size > 0
    }
    private static func all() -> [AudioDeviceID] {
        var size = UInt32(0)
        var a = addr(kAudioHardwarePropertyDevices)
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        return AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &ids) == noErr ? ids : []
    }
    private static func text(_ dev: AudioDeviceID, _ sel: AudioObjectPropertySelector) -> String? {
        var v: Unmanaged<CFString>?, size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var a = addr(sel)
        guard AudioObjectGetPropertyData(dev, &a, 0, nil, &size, &v) == noErr, let s = v?.takeRetainedValue() else { return nil }
        return s as String
    }
    /// The mic picked in the panel, by its UID (the same across replugs); nil is automatic.
    static var chosen: String?
    /// The picked mic while it's plugged in; nil means automatic.
    static func picked() -> AudioDeviceID? {
        guard let uid = chosen else { return nil }
        return all().first { hasInput($0) && text($0, kAudioDevicePropertyDeviceUID) == uid }
    }
    /// Wake listening's mic: the picked one, else the built-in one while the default is Bluetooth; nil is the default.
    static func forListening() -> AudioDeviceID? { picked() ?? forWake() }
    /// {"type":"mics"} for the panel's picker: every input [{id: UID, name}], the default's UID, and what automatic uses.
    static func list() -> [String: Any] {
        let mics = all().filter(hasInput).compactMap { d -> [String: String]? in
            guard let uid = text(d, kAudioDevicePropertyDeviceUID) else { return nil }
            return ["id": uid, "name": text(d, kAudioObjectPropertyName) ?? uid]
        }
        let uid = { (d: AudioDeviceID?) in d.flatMap { text($0, kAudioDevicePropertyDeviceUID) } ?? "" }
        return ["type": "mics", "list": mics, "default": uid(defaultInput()), "auto": uid(forWake() ?? defaultInput()), "chosen": chosen ?? ""]
    }
    /// The built-in mic when the default input is Bluetooth; nil means use the default.
    static func forWake() -> AudioDeviceID? {
        guard let dev = defaultInput(), let t = transport(dev), t == kAudioDeviceTransportTypeBluetooth || t == kAudioDeviceTransportTypeBluetoothLE else { return nil }
        return all().first { transport($0) == kAudioDeviceTransportTypeBuiltIn && hasInput($0) }
    }
    /// The default input as this process sees it now, if it's a live mic.
    static func current() -> AudioDeviceID? { defaultInput().flatMap { hasInput($0) ? $0 : nil } }
    static func builtIn() -> AudioDeviceID? { all().first { transport($0) == kAudioDeviceTransportTypeBuiltIn && hasInput($0) } }
    /// The mics a take tries, in order. AVAudioEngine's input unit is shared by the whole process, and once it's stuck
    /// on a mic that went away (an iPhone's Continuity mic dropping out) every new engine fails on it until a restart;
    /// naming a live mic unsticks it. Automatic tries the system's choice, then the default by name, then the built-in.
    static func tries(picked: AudioDeviceID?, current: AudioDeviceID?, builtIn: AudioDeviceID?) -> [AudioDeviceID?] {
        if picked != nil { return [picked] }
        var out: [AudioDeviceID?] = [nil]
        for d in [current, builtIn] { if let d, !out.contains(d) { out.append(d) } }
        return out
    }
    /// Opens the first mic in `tries` that `open` gets running. The one mic (mic.swift) goes through this order, so it
    /// never stays stuck on a mic the process lost (AVAudioEngine's start then fails with kAudioHardwareBadDeviceError,
    /// '!dev', 560227702, from canPerformIO).
    static func firstOpening<T>(_ tries: [AudioDeviceID?], _ open: (AudioDeviceID?) -> T?) -> T? {
        for dev in tries { if let t = open(dev) { return t } }
        return nil
    }
    static func use(_ dev: AudioDeviceID, on input: AVAudioInputNode) -> Bool {
        guard let unit = input.audioUnit else { return false }
        var id = dev
        return AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &id, UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr
    }
}

// Some mics (many USB, headset and webcam ones) deliver speech near -50 dBFS, too faint for Speech to make
// out words. Boost quiet speech toward ordinary level, at most +20 dB; normal and loud mics pass through as is.
// Only sounds well above the room's noise count as speech, so silence alone never raises the boost.
final class AutoGain {
    static let target: Float = 0.05 // about -26 dBFS RMS, ordinary speech
    static let maxGain: Float = 10
    private(set) var gain: Float = 1
    private var noise: Float = 0, speech: Float = 0

    /// Feed one buffer's RMS (before boosting); returns the boost for it.
    func next(_ rms: Float) -> Float {
        noise = noise == 0 ? max(rms, 1e-5) : rms < noise ? max(rms, 1e-5) : noise * 1.002
        if rms > noise * 3 && rms > 1e-4 { speech = max(speech, rms) } else { speech *= 0.998 }
        let want = speech > 0 ? min(Self.maxGain, max(1, Self.target / speech)) : 1
        // Down at once so a louder voice never clips; up gradually (about 0.5 s from 1x to 10x).
        gain = want < gain ? want : min(want, gain * 1.1)
        return gain
    }

    /// Boosts the buffer in place, ramping from the previous boost to avoid clicks.
    func apply(_ buffer: AVAudioPCMBuffer, rms: Float) {
        let from = gain, to = next(rms)
        guard let ch = buffer.floatChannelData, from != 1 || to != 1 else { return }
        let n = Int(buffer.frameLength), step = (to - from) / Float(max(n, 1))
        for c in 0 ..< Int(buffer.format.channelCount) {
            let x = ch[c]
            for i in 0 ..< n { x[i] = min(1, max(-1, x[i] * (from + step * Float(i + 1)))) }
        }
    }
}

// The wake phrase, "Hey Hydra": a greeting, then the name, at the start of something said (the text's start or after a
// sentence end), or the name alone as the first word ("Hydra, open Mail"). Words are compared by Spoken.same
// (phrase.swift): "Hey Hydro", "Hay Hidra", "A Hydra" all wake; "hydrate" and "Hyundai" don't.
// The name can be the user's own ("Hey Jarvis"), or Hydra's wake phrase another phrase entirely ("Okay Computer").
enum WakeWord {
    // Greetings as the recogniser writes "Hey" ("hay", "a", "high"...), and the stray words that may come before it.
    static let greetings: Set<String> = ["hey", "hi", "hay", "heya", "hiya", "hei", "high", "hello", "a", "ay", "eh", "okay", "ok", "yo", "they", "he"]
    /// Greetings that are everyday words too ("a heater", "they're cool", "high power"): only before the name itself.
    static let weakGreetings: Set<String> = ["a", "ay", "eh", "he", "they", "high", "yo"]
    static let fillers: Set<String> = ["um", "uh", "erm", "er", "oh", "so", "and", "well", "okay", "ok", "hm", "hmm", "the", "a"]
    static let defaultNames = ["hydra"]
    // Set and read on the main thread.
    private(set) static var names = defaultNames
    /// The chosen name as a word for the recogniser's hints ("Jarvis"); nil for Hydra.
    private(set) static var custom: String?
    /// The words the recogniser leans toward: the name, the phrase and the sleep word ("three kill" for "3 kill").
    static var hints: [String] { ["Hydra", "Hey Hydra"] + (custom.map { [$0, "Hey \($0)"] } ?? []) + (phrase.map { [$0.joined(separator: " ")] } ?? []) + [SleepWord.words.joined(separator: " ")] }
    /// Hydra's wake phrase when it isn't a greeting and a name ("Okay Computer"): its words, else nil.
    private(set) static var phrase: [String]?
    /// What the names and phrase are now, to tell a real change from the same setting sent again.
    static var signature: String { "\(names)|\(phrase ?? [])" }

    /// The wake phrase from Hydra's settings (agent_settings.wake_phrase, W5 contract 1). A greeting and one name
    /// ("Hey Hydra", "Hi Jarvis") keep the greeting rule (setName); any other phrase must be heard word for word at the
    /// start of what's said. A phrase with no words, more than six, or one short word is refused (false) and the last
    /// one stays.
    @discardableResult static func setPhrase(_ raw: String) -> Bool {
        let w = Spoken.words(raw).map(\.word)
        guard !w.isEmpty, w.count <= 6, w.count > 1 || w[0].count >= 5 else { return false }
        // Only a real greeting makes it "a greeting and a name": "Okay Computer" stays a phrase, heard word for word.
        if w.count == 2, ["hey", "hi", "hay", "heya", "hiya", "hello"].contains(w[0]), setName(w[1]) { phrase = nil; return true }
        if w.count == 1, setName(w[0]) { phrase = nil; return true }
        phrase = w
        return true
    }

    /// Sets the name after the greeting; nil, "" or Hydra goes back to Hydra. Letters only, 4 to 20 of them; anything
    /// else is refused (returns false) and the name stays as it was.
    @discardableResult static func setName(_ raw: String?) -> Bool {
        let w = (raw ?? "").lowercased().filter { $0.isLetter }
        if w.isEmpty || defaultNames.contains(w) { names = defaultNames; custom = nil; return true }
        guard w.count >= 4, w.count <= 20 else { return false }
        names = [w]
        custom = w.prefix(1).uppercased() + w.dropFirst()
        return true
    }

    /// What was said after the phrase ("" if nothing yet), or nil when the phrase isn't there.
    static func match(_ text: String) -> String? { scan(text).rest }

    /// What follows the first n words of the text: the wake phrase as first heard, once a later reading of it no
    /// longer matches ("Hey Hydra" revised to "Hey high drama"), so it still isn't sent as part of the request.
    static func dropping(_ n: Int, from text: String) -> String {
        let words = tokens(text)
        guard n > 0 else { return text }
        guard words.count > n else { return "" }
        return String(text[words[n].range.lowerBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func tokens(_ text: String) -> [(word: String, range: Range<String.Index>)] { Spoken.words(text) }
    /// Whether the reading ends inside a word that may still grow (no full stop, comma or question mark after it).
    static func endsOpen(_ text: String) -> Bool { text.trimmingCharacters(in: .whitespaces).last.map { $0.isLetter || $0.isNumber } ?? false }

    private static func isName(_ w: String) -> Bool { names.contains { Spoken.same(w, $0) } }
    /// How many letters off the closest name a heard word is, a plural's s aside ("hydras" is 0).
    private static func off(_ w: String) -> Int { names.map { Spoken.edits(w.count > $0.count && w.hasSuffix("s") ? String(w.dropLast()) : w, $0) }.min() ?? Int.max }
    /// The name after a greeting: two letters off at most ("Hey Heidra"; not "Hey hider"), the name itself after a weak
    /// greeting ("A Hydra"; not "a hotter", "a header", "a hydro plant").
    private static func isGreeted(_ w: String, after g: String) -> Bool { isName(w) && off(w) <= (weakGreetings.contains(g) ? 0 : 2) }
    /// The name alone needs to be closer: two letters off at most ("header" sounds like "hydra" but isn't it).
    private static func isNameAlone(_ w: String) -> Bool { names.contains { Spoken.same(w, $0) && Spoken.edits(w, $0) <= 2 } }

    /// The match, plus the closest name's edit distance (nil if no word came near), and when there's no match but it
    /// looks like a try, why it missed (for the log).
    static func scan(_ text: String) -> (rest: String?, distance: Int?, miss: String?) {
        let words = tokens(text), ws = words.map(\.word)
        func gap(_ i: Int) -> Substring { text[(i == 0 ? text.startIndex : words[i - 1].range.upperBound) ..< words[i].range.lowerBound] }
        // Up to two stray words may come first ("um", "okay", a cough heard as "the"); live text rarely has a full stop.
        func atStart(_ i: Int) -> Bool { i <= 2 || gap(i).contains(where: { ".?!".contains($0) }) }
        // The name alone: the very first word, after a sentence end, or after stray words only ("Um, Hydra").
        func nameStarts(_ i: Int) -> Bool { i == 0 || gap(i).contains(where: { ".?!".contains($0) }) || (i <= 2 && ws[..<i].allSatisfy { fillers.contains($0) || greetings.contains($0) }) }
        func rest(after j: Int) -> String {
            String(text[words[j].range.upperBound...].drop(while: { !$0.isLetter && !$0.isNumber })).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let want = phrase {
            for i in ws.indices where atStart(i) {
                if let end = Spoken.follows(want, in: ws, at: i, loose: true) { return (rest(after: end - 1), 0, nil) }
            }
            return (nil, nil, ws.contains { Spoken.same($0, want[0]) } ? "part of the phrase" : nil)
        }
        var closest: Int?, late = false
        for i in ws.indices {
            closest = names.map { Spoken.edits(ws[i], $0) }.min().map { min(closest ?? $0, $0) } ?? closest
            // A greeting, then the name (or the name split in two: "Hi dra"), with only spaces or a comma between.
            if greetings.contains(ws[i]), i + 1 < ws.count, text[words[i].range.upperBound ..< words[i + 1].range.lowerBound].allSatisfy({ $0 == " " || $0 == "," }) {
                var hit: Int?
                if isGreeted(ws[i + 1], after: ws[i]) { hit = i + 1 } else if i + 2 < ws.count, isGreeted(ws[i + 1] + ws[i + 2], after: ws[i]) { hit = i + 2 }
                if let j = hit {
                    if atStart(i) { return (rest(after: j), Spoken.edits(ws[i + 1], names[0]), nil) }
                    late = true
                }
            }
            // The name alone, first. Only near it ("Hydro"), it must stand alone too: a pause mark or nothing after it
            // ("Hydro, open Mail"; not "hydro power is cheap").
            if isNameAlone(ws[i]) || i + 1 < ws.count && isNameAlone(ws[i] + ws[i + 1]) && !isName(ws[i + 1]) {
                let j = isNameAlone(ws[i]) ? i : i + 1
                let stands = off(j == i ? ws[i] : ws[i] + ws[j]) == 0 || j + 1 == words.count || !text[words[j].range.upperBound ..< words[j + 1].range.lowerBound].allSatisfy { $0 == " " }
                if stands {
                    if nameStarts(i) { return (rest(after: j), Spoken.edits(ws[i], names[0]), nil) }
                    late = true
                }
            }
        }
        if late { return (nil, closest, "the phrase came after other words") }
        if let c = closest, c <= 3 { return (nil, closest, "a word \(c) letters off the name") }
        return (nil, closest, nil)
    }

    static func distance(_ word: String) -> Int { names.map { Spoken.edits(word, $0) }.min() ?? Int.max }
    static func edits(_ a: String, _ b: String) -> Int { Spoken.edits(a, b) }
}

// The sleep word (default "Hydra, sleep"; a setting): heard while Hydra listens, it puts Hydra to sleep at once.
// Its words in order, anywhere in what was said, compared as the wake phrase's are ("3 kill" is "three kill").
enum SleepWord {
    private(set) static var words = ["hydra", "sleep"]
    /// True when it changed.
    @discardableResult static func set(_ phrase: String) -> Bool {
        let w = Spoken.words(phrase).map(\.word)
        let next = w.isEmpty ? ["hydra", "sleep"] : w
        defer { words = next }
        return next != words
    }
    /// The words that may stand around it in a strict take (the sidecar's power.mjs AROUND, kept the same).
    static let around: Set<String> = ["ok", "okay", "hey", "now", "please", "thanks", "thank", "you", "so", "um", "uh", "alright", "right", "then", "go", "to"]
    /// strict (while Hydra works on a turn): its exact words only, never a letter off, and alone in the take but for a few
    /// fillers (as power.mjs heardSleepWord), so a near miss or a sentence that mentions it ("I told Hydra sleep is
    /// important") can't end the work.
    static func heard(in text: String, strict: Bool = false) -> Bool {
        let got = Spoken.words(text).map(\.word)
        return got.indices.contains { i in
            guard let j = Spoken.follows(words, in: got, at: i, loose: !strict, exact: strict) else { return false }
            return !strict || (got[..<i] + got[j...]).allSatisfy { around.contains($0) }
        }
    }
}

final class Voice {
    // wake: listening quietly for "Hey Roamies" (no pill, nothing muted); hearing it turns into a hands-free take.
    // barge: the owner may be talking over Hydra (C7): the recogniser listens quietly while Hydra goes on, and enough words
    // turn it into a hands-free take (BargeGate).
    enum Phase { case idle, wake, barge, armed, holding, handsFree, finishing }

    private var phase = Phase.idle
    // How long a hands-free take waits for words before giving up (auto-listen's setting; 8 s otherwise).
    private var nothingWait = 8.0
    private var chordAt = 0.0, listenAt = 0.0, heardAt = 0.0, voiceAt = 0.0, levelAt = 0.0, releasedAt: Double?
    // When talking ended and what finished the words (the recogniser, its 2.5 s cap): sent with them, for timing.
    private var finishedAt = 0.0, endedVia = ""
    private var blocked = false, prevChord = false, authorizing = false, reportEmpty = false, failed = false
    // The keys already reading down when the chord went down: they can't be part of its shortcut (isShortcut).
    private var heldAtArm = Set<CGKeyCode>()
    // Kept across sessions (same mic, usually), so later takes start at the right boost.
    private let autoGain = AutoGain()
    private var rec: Recognizer?
    private var best = ""
    private var finishTimer: Timer?
    private let feed = Feed()
    // The one mic: wake listening, takes, the clap detector and barge-in all hear the same tap (mic.swift).
    let hub = MicHub()
    // Wake word: on in settings; held off while Hydra speaks; resting just after a take.
    private var wakeOn = false
    // The double-clap detector (clap.swift): on whenever clapOn (asleep it wakes Hydra, awake with clap-to-talk it
    // starts a take), and while Hydra speaks with interrupting on. Never makes words of anything.
    private var clapOn = false
    private(set) var asleep = false, clapTalk = false
    let claps = ClapTap()
    private var clapSensitivity = 0.5, clapCalibration: ClapDetector.Calibration?
    // "Clap twice" in the panel: the claps heard until then, and when it gives up. clapMeter: the panel shows the level.
    private var calibrateUntil: Double?, calibrated: [(t: Double, peak: Double, rise: Double)] = []
    var clapMeter = false
    private var meterAt = 0.0
    func setClap(_ on: Bool, asleep: Bool? = nil, talk: Bool? = nil, sensitivity: Double? = nil, calibration: ClapDetector.Calibration?? = nil) {
        if let asleep { self.asleep = asleep }
        if let talk { clapTalk = talk }
        var changed = false
        if let k = sensitivity, k != clapSensitivity { clapSensitivity = min(1, max(0, k)); changed = true }
        if let c = calibration, c != clapCalibration { clapCalibration = c; changed = true }
        if changed { claps.configure(sensitivity: clapSensitivity, calibration: clapCalibration); log("clap sensitivity \(String(format: "%.2f", clapSensitivity))\(clapCalibration.map { String(format: ", calibrated to %.1f dB", $0.peakDb) } ?? "")") }
        if on != clapOn { clapOn = on; log("double clap \(on ? "on" : "off")") }
    }
    /// "Clap twice": the next 8 s of claps (any level) set the detector for this room.
    func calibrateClaps() {
        calibrateUntil = uptime() + 8; calibrated = []
        claps.setCalibrating(true)
        log("clap calibration: listening for two claps")
    }
    private func clapTransient(_ peak: Double, _ rise: Double) {
        guard let until = calibrateUntil, uptime() <= until else { return }
        calibrated.append((uptime(), peak, rise))
        log(String(format: "clap calibration: a clap at %.1f dB, rise %.1f dB", peak, rise))
        // Two claps close together: the quieter one's peak and rise set it (a softer clap still counts at Medium); too
        // soft to be claps, it asks again.
        switch ClapDetector.pickCalibration(calibrated) {
        case .set(let c): finishCalibration(c)
        case .soft: finishCalibration(nil, soft: true)
        case .none: break
        }
    }
    private func finishCalibration(_ c: ClapDetector.Calibration?, soft: Bool = false) {
        calibrateUntil = nil
        claps.setCalibrating(false)
        if let c {
            clapCalibration = c
            claps.configure(sensitivity: clapSensitivity, calibration: c)
            log(String(format: "clap calibration: set to %.1f dB, rise %.1f dB", c.peakDb, c.riseDb))
            emit(["type": "clap_calibrated", "ok": true, "peakDb": (c.peakDb * 10).rounded() / 10, "riseDb": (c.riseDb * 10).rounded() / 10])
        } else {
            log(soft ? "clap calibration: two sounds, too soft to be claps" : "clap calibration: heard \(calibrated.count) clap\(calibrated.count == 1 ? "" : "s"), not two")
            emit(["type": "clap_calibrated", "ok": false, "heard": calibrated.count, "soft": soft])
        }
    }
    /// A double clap from the clap detector.
    func clapHeard() {
        guard clapOn || speaking else { return }
        switch Trigger.decide(.clap, asleep: asleep, speaking: speaking, clapTalk: clapTalk, phrase: wakeOn, barge: bargeOn) {
        case .wake: log("double clap"); emit(["type": "clap"])
        case .take:
            guard phase == .idle || phase == .wake || phase == .barge else { return }
            endBarge("a double clap")
            // Over Hydra's voice, a take that hears no words gives the reply back in BargeGate.window s, not 8 (C7).
            log("double clap: listening"); startTake(via: "clap", wait: speaking ? BargeGate.window : nil)
        case .none: log("double clap: nothing to do (clap-to-talk off)")
        }
    }
    // Barge-in: while Hydra speaks, the owner talking over it (or a double clap) stops the speech and starts a take.
    // The speech stops because a take starting does that already (the sidecar on voice_state listening).
    private(set) var bargeOn = true
    /// Hydra is speaking: the overlay says so, or its voice is playing here (hydraout.swift).
    private var shellSpeaking = false
    var speaking: Bool { shellSpeaking || out.busy }
    let out = HydraOut()
    let barge = BargeTap()
    /// The cursor visualizer (the pill) only for a take from the talk keys (W5 contract 4).
    static func cursorShows(via: String) -> Bool { via == "keys" }
    /// Wake listening waits while Hydra's own voice plays (it mustn't wake itself); while it thinks, the phrase adds on.
    static func wakeHeld(hold: Bool, speaking: Bool) -> Bool { hold && speaking }
    /// A chunk of Hydra's voice: it plays in the mic's engine when that runs with echo cancellation (the echo
    /// reference), opening the mic for it when it can; else on an output-only engine.
    func play(id: String, pcm: Data, rate: Double) {
        var mac14 = false
        if #available(macOS 14, *) { mac14 = true }
        // Second verify pass: the owner's log had 79 replies "output only (no echo reference)" and not one try at echo
        // cancellation, so talking over Hydra could never stop it there. Each reply now logs, once, why it plays where it does.
        let now = uptime()
        let why = Self.echoAtPlay(macOS14: mac14, busy: out.busy, bargeWanted: bargeWanted, bargeBroken: bargeBroken, asleep: asleep, phase: "\(phase)",
                                  test: dryRun || LiveTest.url != nil, echoNow: hub.echoCancel, micAllowed: micAllowed, echoFails: hub.echoFails, echoAllowed: hub.echoAllowed(now: now))
        if why == nil, !hub.echoCancel, #available(macOS 14, *) {
            let opens = hub.opens
            hub.open(device: InputDevice.forListening(), echoCancel: true)
            if hub.opens != opens { micReopened() }
        }
        if id != lastPlayId {
            lastPlayId = id
            log("Hydra's voice for this reply: \(hub.echoCancel ? "in the mic's engine (echo cancellation: talking over it can stop it)" : "output only, talking over it can't stop it: \(why ?? "echo cancellation didn't start")")")
        }
        out.play(id: id, pcm: pcm, rate: rate)
    }
    private var lastPlayId = ""
    /// Why a reply's first chunk won't open the mic with echo cancellation (its voice then plays output only, and talking
    /// over it can't stop it), or nil when it will (or the mic already has it). The order is the checks' order in play().
    static func echoAtPlay(macOS14: Bool, busy: Bool, bargeWanted: Bool, bargeBroken: Bool, asleep: Bool, phase: String, test: Bool,
                           echoNow: Bool, micAllowed: Bool, echoFails: Int, echoAllowed: Bool) -> String? {
        if echoNow { return nil }
        if !macOS14 { return "macOS 13 or older has no echo cancellation for it" }
        if !bargeWanted { return "interrupting by talking is off (the panel)" }
        if bargeBroken { return "this mic has no echo cancellation (tried again when the mic changes)" }
        if asleep { return "asleep" }
        if phase != "idle" && phase != "wake" { return "a take was open (\(phase))" }
        if test { return "test mode" }
        if busy { return "the last reply's voice was still playing on its own engine" }
        if !micAllowed { return "no mic permission" }
        if !echoAllowed { return echoFails >= MicHub.echoTries ? "echo cancellation failed \(echoFails) times on this mic: not tried until it changes" : "echo cancellation failed \(echoFails) time\(echoFails == 1 ? "" : "s"): waiting to try again" }
        return nil
    }
    // bargeBroken: this mic had no echo cancellation; tried again when the mic changes.
    private var bargeBroken = false, bargeWanted = true
    func setBarge(_ on: Bool) { bargeWanted = on; bargeOn = on && !bargeBroken }
    func setSpeaking(_ on: Bool) { shellSpeaking = on }
    private var bargeCan: Bool { bargeOn && !asleep && (phase == .idle || phase == .wake) && !dryRun && LiveTest.url == nil }
    private var micAllowed: Bool { LiveTest.url != nil || !dryRun && AVCaptureDevice.authorizationStatus(for: .audio) == .authorized }
    /// Echo cancellation on the mic only while Hydra speaks with interrupting on (its voice is then the reference), and
    /// 3 s after. Not all the time: its noise suppression and level control would work on every clap and wake word too.
    /// Never moved mid-sentence (Hydra speaking on its own engine) and never dropped mid-take or mid-sentence, so
    /// turning interrupting on or off doesn't restart the mic.
    private var spokeAt = -100.0
    private var echoWanted: Bool {
        guard #available(macOS 14, *) else { return false }
        let take = phase == .barge || phase == .armed || phase == .holding || phase == .handsFree || phase == .finishing
        return Self.echoWanted(barge: bargeOn, speaking: speaking, spokeAgo: uptime() - spokeAt, take: take, echoNow: hub.echoCancel, ownEngineBusy: out.onOwnEngine && out.busy)
    }
    static func echoWanted(barge: Bool, speaking: Bool, spokeAgo: Double, take: Bool, echoNow: Bool, ownEngineBusy: Bool) -> Bool {
        if ownEngineBusy { return false }
        if echoNow && (take || speaking || spokeAgo < 3) { return true }
        return barge && speaking
    }
    /// Whether the one mic is needed: a take, wake listening, the clap detector, barge-in or Hydra's voice in its engine.
    /// The recogniser's feed is always attached, so it doesn't count by itself (it kept the mic open with everything off).
    static func micWanted(allowed: Bool, take: Bool, wake: Bool, clap: Bool, barging: Bool, playingInMic: Bool) -> Bool {
        allowed && (take || wake || clap || barging || playingInMic)
    }
    /// Someone may be talking over Hydra (a sustained rise over its voice, C7): energy alone never stops it. The recogniser
    /// listens on this Mac (with the moment before, so the first word isn't lost) while Hydra goes on; enough words make it
    /// a take (heardOverVoice), too few in BargeGate.window s and it ends quietly (endBarge).
    private var gate = BargeGate()
    private func talkedOver() {
        guard Trigger.decide(.voice, asleep: asleep, speaking: speaking, clapTalk: clapTalk, phrase: wakeOn, barge: bargeOn) == .take, phase == .idle || phase == .wake else { return }
        guard gate.onset(now: uptime()) == .check else { return }
        if phase == .wake { stopWake() }
        hub.remove("barge")
        phase = .barge
        best = ""; woke = false; heardAt = uptime()
        guard let r = makeRecognizer() else { gate.end(); phase = .idle; return }
        rec = r; feed.set(r, preroll: true)
        log("talk over Hydra: listening for words, Hydra goes on")
    }
    /// The check's recogniser heard something: enough of it stops Hydra and starts the take with those words; the sleep
    /// word puts Hydra to sleep, as it does when wake listening hears it (wake listening is held while Hydra speaks).
    private func heardOverVoice(_ text: String) {
        best = text; heardAt = uptime()
        switch gate.heard(text, now: uptime(), strict: wakeHold) {
        case .take: bargeTake(text)
        case .sleep: sleptOverVoice(text)
        default: break
        }
    }
    private func sleptOverVoice(_ text: String) {
        endBarge("the sleep word")
        wakeLog("heard the sleep word over Hydra's voice\(wakeHold ? " (exact, while Hydra answers)" : ""): \"\(text.prefix(120))\"")
        emit(["type": "sleep_word"])
    }
    // A take opened over Hydra's voice on the wake phrase: the sleep word in it (said slowly, after the name) still sleeps.
    private var bargeWoke = false
    private func bargeTake(_ text: String) {
        let n = BargeGate.realWords(text).count
        log("talked over Hydra: \(n) word\(n == 1 ? "" : "s") heard, listening")
        // The wake phrase said over it: what follows it is the take, as when it wakes.
        if let rest = WakeWord.match(text) { woke = true; bargeWoke = true; wakeWords = max(0, WakeWord.tokens(text).count - WakeWord.tokens(rest).count); best = rest }
        nothingWait = Self.phraseWait
        phase = .handsFree
        chordAt = uptime()
        emit(["type": "trigger", "via": "barge"])
        showListening("handsfree", uptime(), via: "barge")
    }
    /// The check is over with no take: its recogniser goes, and Hydra was never stopped.
    private func endBarge(_ why: String) {
        guard phase == .barge else { return }
        gate.end()
        let n = BargeGate.realWords(best).count
        feed.set(nil); rec?.cancel(); rec = nil
        phase = .idle; best = ""
        log("talk over Hydra: \(why), \(n) real word\(n == 1 ? "" : "s"): Hydra goes on")
    }
    /// A hands-free take, as the talk keys start one; mode tells the overlay what started it.
    private func startTake(via: String, wait: Double? = nil) {
        hub.remove("barge")
        emit(["type": "trigger", "via": via])
        listenNow(wait: wait, via: via)
    }
    var wakeHold = false {
        didSet { if wakeOn && wakeHold != oldValue { wakeLog(wakeHold ? "paused while Hydra answers" : "resumed") } }
    }
    private var wakeLoud = 0.0, wakeLevelAt = 0.0 // seconds loud enough to be speech in this wake window
    private var wakeCooldownUntil = 0.0, wakeRetryAt = 0.0, wakeAt = 0.0
    private var wakeText = "", woke = false, wakeMiss: String?
    private var wakeWords = 0 // how many words the wake phrase took, in the take it started
    private var useAnalyzer: Bool { if #available(macOS 26, *) { return SpeechTranscriber.isAvailable } else { return false } }

    // The speech language for takes: "auto" follows the Mac's language list; otherwise a locale id such as "ar-SA" ({"cmd":"lang"}).
    var speechLang = "auto"
    // Whether SpeechAnalyzer has speechLang (macOS 26+); nil until checked. Only read while speechLang is explicit.
    private var langOnAnalyzer: Bool?

    /// Which recogniser a take uses. Wake listening always takes the automatic choice, as before. An explicit speech
    /// language goes to SpeechAnalyzer when it has it, else to SFSpeechRecognizer with that exact locale. The automatic
    /// choice has a nil locale, which keeps each recogniser's own default.
    func takeEngine() -> (analyzer: Bool, locale: Locale?) {
        let automatic = (analyzer: useAnalyzer, locale: nil as Locale?)
        guard phase != .wake, speechLang != "auto" else { return automatic }
        if langOnAnalyzer == true { return (true, Locale(identifier: speechLang)) }
        if langOnAnalyzer == false, let loc = legacyLocale(for: speechLang) { return (false, loc) }
        return automatic
    }

    /// {"cmd":"lang"}: sets the speech language ("auto" or "" = the Mac's own languages) and tells the app which engine has it.
    func setSpeechLang(_ id: String) {
        let trimmed = id.trimmingCharacters(in: .whitespaces)
        speechLang = trimmed.isEmpty ? "auto" : trimmed
        langOnAnalyzer = nil
        let asked = speechLang
        guard asked != "auto" else { return resolveLang() }
        if #available(macOS 26, *), SpeechTranscriber.isAvailable {
            let want = Locale(identifier: asked)
            Task {
                let ok = await SpeechTranscriber.supportedLocale(equivalentTo: want) != nil
                DispatchQueue.main.async {
                    guard self.speechLang == asked else { return } // changed again while this was checked
                    self.langOnAnalyzer = ok
                    if ok { _ = AnalyzerRecognizer.prepare(locale: want) } // fetch the model now, not on the first take
                    self.resolveLang()
                }
            }
        } else {
            langOnAnalyzer = false
            resolveLang()
        }
    }

    // Logs and tells the app which engine the current speech language uses, and whether that engine sends audio to Apple.
    private func resolveLang() {
        let id = speechLang
        var engine = "none"
        var locale: Locale?
        if id == "auto" {
            engine = useAnalyzer ? "analyzer" : "sfspeech"
        } else if langOnAnalyzer == true {
            engine = "analyzer"
        } else if let loc = legacyLocale(for: id) {
            engine = "sfspeech"
            locale = loc
        } else {
            log("speech language \(id) isn't offered by either recogniser; using automatic")
        }
        var online = false
        if engine == "sfspeech" {
            let rec = SFSpeechRecognizer(locale: locale ?? legacySpeechLocale() ?? Locale(identifier: "en-US"))
            online = rec?.supportsOnDeviceRecognition != true
        }
        log("speech language \(id): \(engine)")
        emit(["type": "lang", "id": id, "engine": engine, "online": online])
    }

    init() {
        // Resolve the locale and fetch the model up front so the first ⌃⌥ is instant.
        if #available(macOS 26, *), SpeechTranscriber.isAvailable { _ = AnalyzerRecognizer.prepare() }
        hub.out = out
        hub.setSpeech(makeIngest())
        hub.onRebuilt = { [weak self] in self?.micReopened() }
        hub.onNoEchoCancel = { [weak self] in
            // No echo cancellation on this Mac: listening over Hydra could hear Hydra and interrupt itself, so barge-in
            // stays off for this session (the panel says so); another mic tries again.
            guard let self, !self.bargeBroken else { return }
            self.bargeBroken = true; self.bargeOn = false
            emit(["type": "barge_unavailable"]); log("barge-in off for this session: no echo cancellation")
        }
        claps.onClap = { [weak self] in self?.clapHeard() }
        claps.onTransient = { [weak self] p, r in self?.clapTransient(p, r) }
        barge.onTalk = { [weak self] in self?.talkedOver() }
        if LiveTest.url != nil { hub.fileMode = true; LiveTest.sink = { [weak self] b in self?.hub.deliver(b) } }
    }

    // The talk chord: any two of ⌃ ⌥ ⌘ ⇧ (default ⌃⌥). Set with --chord or {"cmd":"chord"}.
    private static let allMods: CGEventFlags = [.maskControl, .maskAlternate, .maskCommand, .maskShift]
    private var chordMask: CGEventFlags = [.maskControl, .maskAlternate]
    static func mask(_ names: [String]) -> CGEventFlags? {
        var m: CGEventFlags = []
        for n in names {
            switch n.lowercased() {
            case "control", "ctrl": m.insert(.maskControl)
            case "option", "alt": m.insert(.maskAlternate)
            case "command", "cmd": m.insert(.maskCommand)
            case "shift": m.insert(.maskShift)
            default: return nil
            }
        }
        return names.count == 2 && m.rawValue.nonzeroBitCount == 2 ? m : nil
    }
    func setChord(_ names: [String]) {
        guard let m = Self.mask(names) else { return log("ignored chord \(names)") }
        if phase == .wake { stopWake() } else if phase == .barge { endBarge("the talk keys changed") } else if phase != .idle { cancel() }
        chordMask = m; blocked = true
        log("talk chord: \(names.joined(separator: "+"))")
    }

    private static let modifierKeys: Set<CGKeyCode> = [0x36, 0x37, 0x38, 0x39, 0x3A, 0x3B, 0x3C, 0x3D, 0x3E, 0x3F]
    private static let tapLimit = 0.25
    // A release must last this long to count, so one glitchy frame of key state can't end a session.
    private static let releaseDebounce = 0.09
    private static let pauseEnds = 1.2
    private static let wordsEnd = 2.5 // hands-free: no new words for this long ends it, even with background sound
    private static let maxSession = 60.0
    private static let wakeRecycle = 30.0 // a fresh wake recogniser this often, so memory stays bounded
    private static let wakePause = 1.2 // words stopped this long without the phrase: start fresh for the next thing said
    private static let wakeCooldown = 2.0
    static let phraseWait = 8.0 // a take started by the wake phrase waits this long for words, as one from the keys

    var engineName: String { useAnalyzer ? "speechanalyzer" : "sfspeech" }

    // ---------- hotkey ----------

    private func keysDown() -> Set<CGKeyCode> {
        Set((CGKeyCode(0) ..< 0x80).filter { !Self.modifierKeys.contains($0) && CGEventSource.keyState(.combinedSessionState, key: $0) })
    }

    /// At the chord's first moment: an extra ⇧ or ⌘, or a key pressed since the chord went down, makes it a shortcut
    /// (⌃⌥S), not a talk. A key that already read as down then doesn't count: macOS can report a key as held that
    /// isn't (seen: one key code reading down at almost every press, which a real press of it didn't clear), and that
    /// turned nearly every talk into a "shortcut".
    static func isShortcut(extra: Bool, heldAtArm: Set<CGKeyCode>, now: Set<CGKeyCode>) -> Bool {
        extra || !now.subtracting(heldAtArm).isEmpty
    }

    let ink = Ink()
    let wave = Wave()
    let buddy = Buddy()

    // ---------- clicks under a drawing ----------
    // Only while the sidekick has a drawing on a window (it says so): each click on another app is reported, with
    // whether it's on something that does something, so the drawing goes with the screen it was about. A global
    // monitor, not the button state, so a tap-to-click (shorter than a frame) isn't missed.
    private var clickMonitor: Any?
    private let clickQueue = DispatchQueue(label: "roamies.voice.clicks")
    var watchClicks = false {
        didSet {
            guard watchClicks != oldValue else { return }
            if watchClicks { clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown]) { [weak self] e in self?.clicked(count: e.clickCount) } }
            else if let m = clickMonitor { NSEvent.removeMonitor(m); clickMonitor = nil }
        }
    }
    private func clicked(count: Int) {
        let m = NSEvent.mouseLocation, top = NSScreen.screens.first?.frame.maxY ?? 0, p = CGPoint(x: m.x, y: top - m.y)
        clickQueue.async {
            guard let hit = ClickTarget.at(p) else { return }
            let acts = ClickTarget.acts(roles: hit.roles, count: count)
            DispatchQueue.main.async { emit(["type": "click", "x": Int(p.x.rounded()), "y": Int(p.y.rounded()), "role": hit.roles.first ?? "", "app": hit.app, "acts": acts]) }
        }
    }

    func tick() {
        // Drawing follows the keys: only while ⌃⌥ is down for a talk.
        defer { ink.setArmed(phase == .armed || phase == .holding); ink.follow(); wave.tick(); buddy.tick() }
        let now = uptime()
        let f = CGEventSource.flagsState(.combinedSessionState).intersection(Self.allMods)
        let held = f.intersection(chordMask)
        let down = held == chordMask // once talking, a stray extra modifier doesn't count as letting go
        let extra = !f.subtracting(chordMask).isEmpty
        let chord = down && !extra
        defer { prevChord = chord }
        if held.isEmpty { blocked = false }

        // Debounced release: true only once ⌃⌥ has been up for releaseDebounce.
        let released: Bool = {
            if down { releasedAt = nil; return false }
            if releasedAt == nil { releasedAt = now }
            return now - (releasedAt ?? now) >= Self.releaseDebounce
        }()

        syncMic(now)

        switch phase {
        case .idle:
            if chord && !prevChord && !blocked { arm(now) }
            else if wakeAllowed(now) { startWake(now) }
        case .wake:
            if chord && !prevChord && !blocked { stopWake(); arm(now); return }
            if !wakeOn || Self.wakeHeld(hold: wakeHold, speaking: speaking) { stopWake(); return } // Hydra's own voice playing: the mic stays open but unheard
            if let t = tentative, now - t.at >= 0.35 { heardWhileWaiting(t.text, confirmed: true); if phase != .wake { return } }
            let paused = !wakeText.isEmpty && now - heardAt > Self.wakePause && now - voiceAt > Self.wakePause / 2
            // The 30 s refresh waits for a quiet moment, so it can't split "Hey" from "Roamies".
            let quiet = now - voiceAt > Self.wakePause / 2 && now - heardAt > Self.wakePause
            if paused || (now - wakeAt > Self.wakeRecycle && quiet) || now - wakeAt > Self.wakeRecycle * 2 { recycleWake(now) }
        case .barge:
            if chord && !prevChord && !blocked { endBarge("the talk keys"); arm(now); return }
            if asleep || !bargeOn { endBarge("interrupting is off"); return }
            switch gate.tick(now: now) {
            case .drop: endBarge("too few words in \(Int(BargeGate.window)) s")
            case .take: bargeTake(best)
            default: break
            }
        case .armed:
            // Only the first moment decides shortcut vs. talk: ⌃⌥ plus a key pressed since, ⇧ or ⌘ is a shortcut.
            if down && Self.isShortcut(extra: extra, heldAtArm: heldAtArm, now: keysDown()) { log("not a talk: ⌃⌥ was part of a shortcut"); cancel(); blocked = true; return }
            if released { phase = .handsFree; showListening("handsfree", now, via: "keys"); return }
            if down && now - chordAt >= Self.tapLimit { phase = .holding; showListening("hold", now, via: "keys") }
        case .holding:
            if released { end("released"); finish(); return }
            if now - listenAt > Self.maxSession { end("max length"); finish() }
        case .handsFree:
            // Pressing again switches to push-to-talk; letting go then sends.
            if chord && !prevChord && !blocked { phase = .holding; releasedAt = nil; askTake = false; return }
            let quiet = now - max(heardAt, voiceAt)
            // Steady sound in the room (a fan, music) keeps the level up, so words that stopped coming end it too.
            if !best.isEmpty && (quiet > Self.pauseEnds || now - heardAt > Self.wordsEnd) { end(quiet > Self.pauseEnds ? "pause" : "no new words"); finish() }
            else if best.isEmpty && now - listenAt > nothingWait { end("nothing heard"); cancel() }
            else if now - listenAt > Self.maxSession { end("max length"); finish() }
        case .finishing:
            break
        }
    }

    /// The one mic each frame: who listens (barge-in while Hydra speaks, the clap detector while it's on, the
    /// recogniser's feed during wake listening and takes), and whether it's open (mic.swift).
    private func syncMic(_ now: Double) {
        let barging = bargeCan && speaking && hub.echoCancel
        if barging != hub.has("barge") { if barging { barge.reset(); hub.add("barge", barge.feed) } else { hub.remove("barge") } }
        if let until = calibrateUntil, now > until { finishCalibration(nil) }
        let clapWanted = clapOn || bargeOn && speaking || calibrateUntil != nil || clapMeter
        if clapWanted != hub.has("clap") { if clapWanted { hub.add("clap", claps.feed) } else { hub.remove("clap") } }
        // Hydra's voice on the output-only engine (no echo reference): the room hears it as it is, so a clap must clear
        // the calibrated or Medium level, whatever the slider says (C6); and while it speaks a clap must stand clear of
        // its voice (C7).
        claps.setGuarded(speaking && !hub.echoCancel)
        claps.setSpeaking(speaking)
        let take = phase == .armed || phase == .holding || phase == .handsFree || phase == .finishing
        if speaking { spokeAt = now }
        let wanted = Self.micWanted(allowed: micAllowed, take: take, wake: phase == .wake, clap: clapWanted, barging: bargeCan && speaking || phase == .barge, playingInMic: out.busy && hub.echoCancel)
        hub.tick(now: now, wanted: wanted, device: InputDevice.forListening(), echo: echoWanted)
        if clapMeter, hub.running, now - meterAt >= 0.1, let m = claps.meter() {
            meterAt = now
            let r = { (x: Double) in (max(-120, x) * 10).rounded() / 10 }
            emit(["type": "clap_level", "db": r(m.db), "floor": r(m.floor), "needs": r(m.needs)])
        }
    }
    /// The mic was opened again (a device change, or another way): wake listening starts a fresh recogniser on it.
    func micReopened() { if phase == .wake { recycleWake(uptime(), preroll: false) } }

    private func end(_ why: String) { log("session end: \(why) after \(String(format: "%.1f", uptime() - listenAt))s, mic boost \(String(format: "%.1f", autoGain.gain))x") }

    // ---------- session ----------

    private func arm(_ now: Double) {
        phase = .armed
        askTake = false
        nothingWait = Self.phraseWait
        chordAt = now
        heldAtArm = keysDown()
        if !heldAtArm.isEmpty { log("chord: keys already down don't count toward a shortcut: \(heldAtArm.sorted())") }
        best = ""
        woke = false; bargeWoke = false
        // The drawing layer first: starting the mic below holds this thread for a moment (longer with Bluetooth),
        // and a drag begun in that moment would otherwise land in the app underneath.
        ink.setArmed(true)
        // ROAMIES_VOICE_DRYRUN_TEXT: what a dry run "hears", to test what goes out with the words (like pen marks).
        if dryRun { best = ProcessInfo.processInfo.environment["ROAMIES_VOICE_DRYRUN_TEXT"] ?? ""; return }
        // Already allowed: start the mic now so the first word isn't lost. Otherwise wait until
        // the press is clearly a talk (hold or tap), so shortcuts like ⌃⌥S never trigger a prompt.
        if authorized() { startAudio() }
    }

    // Whether the recogniser needs Speech Recognition permission: a take's (its speech language decides), or the wake word's.
    private func needsSpeechPermission(wake: Bool = false) -> Bool { wake ? !useAnalyzer : !takeEngine().analyzer }

    private func authorized(wake: Bool = false) -> Bool {
        LiveTest.url != nil || AVCaptureDevice.authorizationStatus(for: .audio) == .authorized && (!needsSpeechPermission(wake: wake) || SFSpeechRecognizer.authorizationStatus() == .authorized)
    }

    /// A take is listening: the mic's spectrum goes to the orb (read on the audio thread too).
    private var takeBands = false {
        didSet { if oldValue && !takeBands { emit(["type": "bands", "b": [Double](repeating: 0, count: Spectrum.count)]) } }
    }
    /// The take a wake opens (via 'wake'): if it hears nothing, Hydra just stays awake, with no "I didn't hear anything".
    private var quietEmpty = false
    /// A clap or a wake take ignores words that were already being said when the chime started (a TV, a call).
    private var roomTalk = false
    private var takeVia = ""
    /// The take open now is one an ask opened (listen via 'ask'): only that one is closed by the ask's cancel (only
    /// "ask"). Any other take (the owner's keys, a clap, the phrase) clears it, as does the owner taking this one over.
    private var askTake = false
    /// Whether a cancel closes the take open now: an ask's cancel (onlyAsk) only the take an ask opened.
    static func cancels(onlyAsk: Bool, askTake: Bool) -> Bool { !onlyAsk || askTake }
    private func showListening(_ mode: String, _ now: Double, via: String) {
        listenAt = now; heardAt = now; voiceAt = now
        takeBands = true
        if !dryRun && rec == nil {
            ensureAuthorized { [weak self] in
                guard let self, self.phase == .holding || self.phase == .handsFree, self.rec == nil else { return }
                self.startAudio()
            }
        }
        if !dryRun { OutputMute.begin() }
        quietEmpty = via == "wake"
        takeVia = via
        roomTalk = false
        // The listen chime (cue.swift) only for the owner's own triggers; never the pending loop while he talks.
        Cue.pending(false)
        if !dryRun { if Cue.audible(via: via) { Cue.play("listen") } else { Cue.keepAudible() } }
        // The pill beside the cursor only for the talk keys; otherwise the orb shows the listening.
        let cursor = Self.cursorShows(via: via) && !wave.off
        if cursor { wave.show() } else { wave.hide() }
        // wave: the cursor shows the listening, so the app shows no listening bubble.
        emit(["type": "state", "state": "listening", "mode": mode, "wave": cursor, "ask": askTake])
        if !best.isEmpty { emit(["type": "partial", "text": best]) }
    }

    private func finish() {
        guard phase == .armed || phase == .holding || phase == .handsFree else { return }
        let shown = phase != .armed
        reportEmpty = shown && !failed && !quietEmpty
        phase = .finishing
        finishedAt = uptime(); endedVia = "recognizer"
        wave.think()
        wave.setHidden(true)
        ink.capture { [weak self] in self?.wave.setHidden(false) }
        if shown { emit(["type": "state", "state": "processing"]) }
        guard let r = rec, !failed else { stopAudio(); endedVia = "failed"; finalize(); return }
        // Keep the mic open a moment after release so a word said while letting go isn't clipped.
        let tail = Timer(timeInterval: 0.3, repeats: false) { [weak self] _ in
            guard let self, self.phase == .finishing, self.rec === r else { return }
            self.stopAudio()
            r.end()
            let t = Timer(timeInterval: 2.5, repeats: false) { [weak self] _ in self?.endedVia = "cap"; self?.finalize() }
            RunLoop.main.add(t, forMode: .common)
            self.finishTimer = t
        }
        RunLoop.main.add(tail, forMode: .common)
        finishTimer = tail
    }

    private func finalize() {
        guard phase == .finishing else { return }
        // An error or final result can land before the tail timer fires; its stop must still happen.
        stopAudio()
        finishTimer?.invalidate(); finishTimer = nil
        rec?.cancel(); rec = nil
        phase = .idle; askTake = false
        woke = false; bargeWoke = false; wakeCooldownUntil = uptime() + Self.wakeCooldown
        let text = best.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { wave.hide() } else { wave.awaitAnswer() }
        let empty = text.isEmpty && reportEmpty, spoke = voiceAt > listenAt + 0.05
        reportEmpty = false
        let rest = {
            emit(["type": "state", "state": "idle"])
            // Listened but got no words: say so instead of closing silently.
            if empty { emit(["type": "error", "code": "nothing_heard", "spoke": spoke]) }
        }
        if text.isEmpty {
            // Circled something but said nothing: drop it quietly and just go (no "I didn't hear you").
            ink.take { area in
                guard let file = area?["file"] as? String else { return rest() }
                try? FileManager.default.removeItem(atPath: file)
                log("nothing said, dropped the circled area")
                emit(["type": "state", "state": "idle"])
            }
            return
        }
        // What was marked on screen while talking rides along with the words.
        ink.take { area in
            var msg: [String: Any] = ["type": "final", "text": text, "ms": Int(((uptime() - self.finishedAt) * 1000).rounded()), "via": self.endedVia]
            if let area { msg["area"] = area }
            log("sent what was said\(area == nil ? "" : ", with the circled area")")
            emit(msg)
            rest()
        }
    }

    private func cancel() {
        stopAudio()
        rec?.cancel(); rec = nil
        finishTimer?.invalidate(); finishTimer = nil
        phase = .idle; askTake = false
        woke = false; bargeWoke = false; wakeCooldownUntil = uptime() + Self.wakeCooldown
        reportEmpty = false
        ink.clear()
        wave.hide()
        emit(["type": "state", "state": "idle", "cancelled": true])
    }

    /// The shell saw ⌃⌥S: that ⌃⌥ was a shortcut, not a request to talk.
    /// Start listening hands-free without a key press (after an area snap). Ends on a pause or a tap.
    /// via: what opened it (the cue plays for an orb tap, not for auto-listen or the take after a wake).
    func listenNow(wait: Double? = nil, via: String = "listen", ask: Bool = false) {
        if phase == .wake { stopWake() }
        // The owner is already talking over Hydra, or a take is open. Keep it. Do not drop it and ask for the wake phrase.
        if phase == .barge { bargeTake(best); return }
        if phase == .handsFree || phase == .holding || phase == .armed || phase == .finishing { return }
        endBarge("a take opened")
        guard phase == .idle else { return }
        arm(uptime())
        askTake = ask
        nothingWait = min(15, max(3, wait ?? 8))
        phase = .handsFree
        blocked = true // the snap shortcut's keys may still be held: don't read them as a tap
        showListening("handsfree", uptime(), via: via)
    }

    func externalCancel(onlyAsk: Bool = false) {
        guard Self.cancels(onlyAsk: onlyAsk, askTake: askTake) else { return }
        afterVoiceGen += 1 // a take still waiting for Hydra's voice (listenAfterVoice) never opens
        endBarge("cancelled")
        if phase == .armed || phase == .holding || phase == .handsFree { cancel() }
        blocked = true
    }

    /// An orb tap during a take (the sidecar's listen_finish): it sends what was heard, as a second tap on the talk keys
    /// does. Esc still cancels (externalCancel).
    func externalFinish() {
        guard phase == .armed || phase == .holding || phase == .handsFree else { return }
        end("orb tap")
        finish()
    }

    /// A take once Hydra's voice has said what it is saying (an ask's question: "Say yes or no."), so a bare "yes" is
    /// heard: it waits for the voice to start (at most 4 s), then for 0.4 s of quiet after it; still speaking after 30 s,
    /// no take. A take opened meanwhile wins (listenNow opens only from idle).
    private var afterVoiceGen = 0
    func listenAfterVoice(wait: Double?, via: String) {
        afterVoiceGen += 1
        let gen = afterVoiceGen, t0 = uptime()
        var started = false, quietAt = t0
        let t = Timer(timeInterval: 0.1, repeats: true) { [weak self] timer in
            guard let self, gen == self.afterVoiceGen else { timer.invalidate(); return }
            let now = uptime()
            if self.speaking { started = true; quietAt = now }
            guard let go = Self.afterVoiceDue(started: started, quietFor: now - quietAt, waited: now - t0) else { return }
            timer.invalidate()
            if go { self.listenNow(wait: wait, via: via) }
        }
        RunLoop.main.add(t, forMode: .common)
    }
    /// listenAfterVoice's decision: true listen now, false give up, nil keep waiting.
    static func afterVoiceDue(started: Bool, quietFor: Double, waited: Double) -> Bool? {
        if started { return quietFor >= 0.4 ? true : waited > 30 ? false : nil }
        return waited >= 4 ? true : nil
    }

    // ---------- wake word ----------

    func setWake(_ on: Bool) {
        guard on != wakeOn else { return }
        wakeOn = on
        if on { wakeRetryAt = 0 }
        log("wake word \(on ? "on" : "off")")
        if !on { stopWake() }
    }

    // Never asks for permission: wake listening starts only once talking has been allowed.
    private func wakeAllowed(_ now: Double) -> Bool {
        // Asleep too: the phrase wakes it (W5 contract 4). Held only while Hydra's own voice plays.
        wakeOn && !Self.wakeHeld(hold: wakeHold, speaking: speaking) && !dryRun && now >= wakeCooldownUntil && now >= wakeRetryAt && authorized(wake: true)
    }

    private func startWake(_ now: Double) {
        wakeRetryAt = now + 5 // if the mic won't open, try again in a moment rather than every frame
        phase = .wake
        best = ""; wakeText = ""; wakeMiss = nil; woke = false; wakeLoud = 0
        wakeAt = now; heardAt = now; voiceAt = now
        let device = InputDevice.forListening()
        startAudio()
        if phase == .wake { wakeLog("listening\(device == nil ? "" : InputDevice.picked() != nil ? " on the picked mic" : " on the built-in mic (the default input is Bluetooth)")") }
    }

    /// Another mic (picked, or the Mac's default input changed): it may have echo cancellation, so try barge-in again.
    func retryBarge() {
        if bargeBroken { bargeBroken = false; bargeOn = bargeWanted; emit(["type": "barge_available"]) }
    }
    /// Another mic was picked, or the default input changed: the one mic is rebuilt on it once (debounced, mic.swift).
    func micChanged() {
        retryBarge()
        hub.newMic()
    }

    private func stopWake() {
        guard phase == .wake else { return }
        tentative = nil
        logNearMiss()
        stopAudio()
        rec?.cancel(); rec = nil
        phase = .idle
        best = ""; wakeText = ""
    }

    // A fresh recogniser on the open mic: after a pause with no phrase (so it must start what's said next), or every 30 s,
    // well before the recogniser's own limit. preroll: it hears the last moment of sound first (Feed keeps it), so a
    // phrase said just as the windows change isn't cut in two. Not after the sleep word (it would hear it again).
    private func recycleWake(_ now: Double, preroll: Bool = true) {
        if let t = tentative { tentative = nil; heardWhileWaiting(t.text, confirmed: true); guard phase == .wake else { return } }
        logNearMiss()
        feed.set(nil)
        rec?.cancel(); rec = nil
        guard let r = makeRecognizer() else { stopWake(); wakeRetryAt = now + 30; return }
        rec = r; feed.set(r, preroll: preroll)
        wakeAt = now; heardAt = now; wakeText = ""
    }

    private func logNearMiss() {
        // How a window ended: a near try (with what was heard, in this Mac's local log only, to tune the matcher), other
        // words (only how many), or sound the recogniser made no words of.
        if let m = wakeMiss { wakeLog("missed (\(m)): \"\(wakeText.prefix(120))\"") }
        else if !wakeText.isEmpty { wakeLog("heard \(WakeWord.tokens(wakeText).count) words, not the phrase") }
        else if wakeLoud >= 0.5 { wakeLog("heard sound for \(String(format: "%.1f", wakeLoud)) s, but no words came back") }
        wakeMiss = nil; wakeLoud = 0
    }

    /// A match that ends on the reading's last word, with no full stop after it, may be a word still being written ("The
    /// Hydra" before "The hydraulic press"): it waits for the next reading, or 0.35 s without one (tick).
    private var tentative: (text: String, at: Double)?
    private func heardWhileWaiting(_ text: String, confirmed: Bool = false) {
        guard text != wakeText || confirmed else { return }
        let now = uptime()
        if !confirmed { wakeText = text; heardAt = now }
        tentative = nil
        let open = !confirmed && WakeWord.endsOpen(text)
        if SleepWord.heard(in: text, strict: wakeHold) {
            if open { tentative = (text, now); return }
            wakeLog("heard the sleep word\(wakeHold ? " (exact, while Hydra answers)" : ""): \"\(text.prefix(120))\""); emit(["type": "sleep_word"]); wakeMiss = nil; wakeText = ""; wakeLoud = 0; recycleWake(now, preroll: false); return
        }
        let (rest, d, miss) = WakeWord.scan(text)
        guard let rest else { if let miss { wakeMiss = miss }; return }
        if open && rest.isEmpty { tentative = (text, now); return }
        guard Trigger.decide(.phrase, asleep: asleep, speaking: speaking, clapTalk: clapTalk, phrase: wakeOn, barge: bargeOn) == .take else { return }
        wakeLog("heard the phrase (distance \(d ?? 0))\(asleep ? " while asleep: waking" : "")")
        // Asleep: it wakes, and this take goes on at once (the app skips its greeting).
        if asleep { asleep = false; emit(["type": "phrase_wake"]) }
        wakeMiss = nil
        // Same mic, same recogniser: what follows the phrase is already the start of the take.
        woke = true; bargeWoke = false
        wakeWords = max(0, WakeWord.tokens(text).count - WakeWord.tokens(rest).count)
        // The take's own wait for words, as a key press gives it (an earlier listenNow may have left 3 s).
        nothingWait = Self.phraseWait
        phase = .handsFree
        askTake = false
        chordAt = now
        best = rest
        showListening("wake", now, via: "phrase")
    }

    /// The recogniser's other readings while wake listening: one that has the sleep word or the phrase, ended (not a word
    /// still being written), counts as hearing it.
    private func heardAlternatives(_ alts: [String]) {
        for t in alts where !WakeWord.endsOpen(t) && (SleepWord.heard(in: t, strict: wakeHold) || WakeWord.match(t) != nil) {
            wakeLog("heard it in another reading")
            heardWhileWaiting(t, confirmed: true)
            return
        }
    }

    // ---------- permissions ----------

    private func ensureAuthorized(_ then: @escaping () -> Void) {
        let mic = AVCaptureDevice.authorizationStatus(for: .audio)
        let speech = SFSpeechRecognizer.authorizationStatus()
        let needsSpeech = needsSpeechPermission()
        if mic == .authorized && (!needsSpeech || speech == .authorized) { then(); return }
        if mic == .denied || mic == .restricted { return denied("microphone") }
        if needsSpeech && (speech == .denied || speech == .restricted) { return denied("speech") }
        if authorizing { return }
        authorizing = true
        AVCaptureDevice.requestAccess(for: .audio) { micOK in
            guard micOK else {
                DispatchQueue.main.async { self.authorizing = false; self.denied("microphone") }
                return
            }
            if !needsSpeech { DispatchQueue.main.async { self.authorizing = false; then() }; return }
            SFSpeechRecognizer.requestAuthorization { status in
                DispatchQueue.main.async {
                    self.authorizing = false
                    if status == .authorized { then() } else { self.denied("speech") }
                }
            }
        }
    }

    private func denied(_ what: String) {
        emit(["type": "error", "code": "permission", "what": what])
        cancel()
    }

    // ---------- audio + recognition ----------

    private func makeRecognizer() -> Recognizer? {
        var mine: Recognizer?
        let cb = RecognizerCallbacks(
            onText: { [weak self] text in guard let self, self.rec === mine else { return }; self.onText(text) },
            onDone: { [weak self] in
                guard let self, self.rec === mine else { return }
                if self.phase == .wake { self.recycleWake(uptime()) } else if self.phase == .barge { self.endBarge("the recogniser ended") } else if self.phase == .finishing { self.finalize() }
            },
            onError: { [weak self] err in guard let self, self.rec === mine else { return }; self.onError(err) },
            onAlternatives: phase == .wake ? { [weak self] alts in guard let self, self.rec === mine, self.phase == .wake else { return }; self.heardAlternatives(alts) } : nil
        )
        let engine = takeEngine()
        if phase != .wake && phase != .barge { // one line per take, not per wake window or check
            let shown = engine.locale?.identifier ?? (engine.analyzer ? "auto" : legacySpeechLocale()?.identifier ?? "auto")
            log("speech: \(engine.analyzer ? "analyzer" : "sfspeech") \(shown)")
        }
        if #available(macOS 26, *), engine.analyzer { mine = AnalyzerRecognizer(cb, locale: engine.locale) } else { mine = LegacyRecognizer(cb, onDeviceOnly: phase == .wake || phase == .barge, locale: engine.locale) }
        return mine
    }

    /// A recogniser on the one mic (opened now if it isn't, so a take that can't have it says so at once).
    private func startAudio() {
        failed = false
        // Wake listening fails quietly and tries again later; a take tells the user.
        let fail = { (code: String, extra: [String: Any]) in
            if self.phase == .wake { self.phase = .idle; self.wakeRetryAt = uptime() + 30; wakeLog("couldn't start (\(code))") } else { emit(["type": "error", "code": code].merging(extra) { a, _ in a }); self.cancel() }
        }
        guard let r = makeRecognizer() else { return fail("unavailable", [:]) }
        if !hub.running && !hub.open(device: InputDevice.forListening(), echoCancel: echoWanted) {
            r.cancel()
            // A mic that's there but won't open isn't a missing mic.
            return fail("no_input", ["reason": "failed"])
        }
        rec = r
        feed.set(r, preroll: phase == .wake)
    }

    /// The recogniser's side of the mic, on the tap's thread: the orb's spectrum while a take listens, the quiet-mic
    /// boost, the feed (which keeps the last moment for the next wake window), and the level for pauses.
    private func makeIngest() -> MicHub.Consumer {
        let gain = autoGain, feed = feed
        var pacer = BandPacer()
        return { [weak self] buffer in
            guard let samples = buffer.floatChannelData?[0] else { feed.append(buffer); return }
            let n = Int(buffer.frameLength)
            // The orb's spectrum while a take listens (W5 contract 5): the mic's own sound, before the boost.
            if self?.takeBands == true, pacer.ready(uptime()) {
                let b = Spectrum.bands(samples, count: n, rate: buffer.format.sampleRate)
                DispatchQueue.main.async { if self?.takeBands == true { emit(["type": "bands", "b": b.map { ($0 * 1000).rounded() / 1000 }]) } }
            }
            var sum: Float = 0
            for i in 0 ..< n { sum += samples[i] * samples[i] }
            let rms = sqrt(sum / Float(max(n, 1)))
            gain.apply(buffer, rms: rms)
            feed.append(buffer)
            // Level and pause detection use the mic's own level, so boosted room noise can't hold a session open.
            let level = min(1, max(0, (Double(20 * log10(max(rms, 1e-7))) + 55) / 40))
            DispatchQueue.main.async { self?.onLevel(level) }
        }
    }

    /// The take or wake window is over: its recogniser hears nothing more. The mic stays with whoever else listens.
    private func stopAudio() {
        OutputMute.end()
        takeBands = false
        feed.set(nil)
    }

    private func onLevel(_ v: Double) {
        let now = uptime()
        if phase == .wake { if v > 0.2 { wakeLoud += min(0.2, now - wakeLevelAt) }; wakeLevelAt = now }
        if v > 0.2 { voiceAt = now }
        if phase == .holding || phase == .handsFree { wave.setLevel(v) }
        guard phase == .holding || phase == .handsFree, now - levelAt >= 0.05 else { return }
        levelAt = now
        emit(["type": "level", "v": (v * 100).rounded() / 100])
    }

    private func onText(_ raw: String) {
        if phase == .wake { return heardWhileWaiting(raw) }
        if phase == .barge { return heardOverVoice(raw) }
        if bargeWoke, SleepWord.heard(in: raw, strict: true) {
            bargeWoke = false
            wakeLog("heard the sleep word over Hydra's voice: \"\(raw.prefix(120))\""); emit(["type": "sleep_word"]); cancel(); return
        }
        // A take started by the wake phrase: the phrase itself isn't part of what was said.
        let text = woke ? (WakeWord.match(raw) ?? WakeWord.dropping(wakeWords, from: raw)) : raw
        // Speech already running when the chime started never confirms the take. Words after the chime do.
        if (quietEmpty || takeVia == "clap"), uptime() < Cue.until + 0.05 {
            roomTalk = true
            return
        }
        if roomTalk { return }
        guard text != best else { return }
        best = text
        heardAt = uptime()
        if phase != .armed && phase != .idle { emit(["type": "partial", "text": text]) }
    }

    private func onError(_ error: Error) {
        let msg = error.localizedDescription
        // Ending a request early reports "no speech"/cancel errors; only real failures reach the user.
        let ns = error as NSError
        let benign = ns.domain == "kAFAssistantErrorDomain" && [203, 216, 301, 1110].contains(ns.code)
        // The check over Hydra's voice never bothers the user: it just ends, and Hydra goes on.
        if phase == .barge { endBarge(benign ? "the recogniser ended" : "recognition: \(msg)"); return }
        // Wake listening never bothers the user: start fresh, or rest a while after a real failure.
        if phase == .wake {
            if benign { recycleWake(uptime()) } else { wakeLog("recognition: \(msg)"); stopWake(); wakeRetryAt = uptime() + 30 }
            return
        }
        log("recognition: \(msg)")
        if !benign && best.isEmpty {
            failed = true
            let code = msg.localizedCaseInsensitiveContains("dictation") || msg.localizedCaseInsensitiveContains("siri") ? "dictation_off" : "recognition"
            emit(["type": "error", "code": code, "message": msg])
        }
        // A failed recognizer can't hear anything more, so end; otherwise keep listening while held.
        if phase == .finishing { finalize() }
        else if failed { end("recognition error"); finish() }
    }
}

// ---------- one-shot permission modes (used by the setup guide) ----------
// --perms prints the current state; --request <mic|speech|screen> asks, then prints the state.
// Run as a child of Roamies, so macOS attributes the prompts and grants to Roamies.
func permStatus() -> [String: Any] {
    func av(_ s: AVAuthorizationStatus) -> String { s == .authorized ? "granted" : s == .notDetermined ? "unknown" : "denied" }
    func sp(_ s: SFSpeechRecognizerAuthorizationStatus) -> String { s == .authorized ? "granted" : s == .notDetermined ? "unknown" : "denied" }
    var analyzer = false
    if #available(macOS 26, *) { analyzer = SpeechTranscriber.isAvailable }
    return [
        "type": "perms",
        "mic": av(AVCaptureDevice.authorizationStatus(for: .audio)),
        // SpeechAnalyzer (macOS 26+) needs no speech-recognition permission.
        "speech": analyzer ? "granted" : sp(SFSpeechRecognizer.authorizationStatus()),
        "speechNeeded": !analyzer,
        "screen": CGPreflightScreenCaptureAccess() ? "granted" : "unknown",
    ]
}
let args = CommandLine.arguments
// --test-gain checks the quiet-mic boost with made-up levels; exits 1 on a failure.
if args.contains("--test-gain") {
    var bad = 0
    func check(_ name: String, _ ok: Bool) { print("\(ok ? "ok" : "FAIL") \(name)"); if !ok { bad += 1 } }
    func run(_ g: AutoGain, _ rms: Float, _ n: Int) { for _ in 0 ..< n { _ = g.next(rms) } }
    var g = AutoGain(); run(g, 0.001, 50); run(g, 0.06, 50)
    check("normal mic stays at 1x", g.gain == 1)
    g = AutoGain(); run(g, 0.0003, 50); run(g, 0.003, 30)
    check("quiet mic (-50 dB) boosted to 10x within 0.7 s", g.gain == AutoGain.maxGain)
    g = AutoGain(); run(g, 0.0003, 50); run(g, 0.01, 50)
    check("slightly quiet mic boosted just to ordinary level", abs(g.gain - 5) < 0.01)
    g = AutoGain(); run(g, 0.0005, 500)
    check("silence alone never boosted", g.gain == 1)
    g = AutoGain(); run(g, 0.0003, 50); run(g, 0.003, 50); _ = g.next(0.2)
    check("loud sound drops the boost at once", g.gain == 1)
    let fmt = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
    let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: 4)!
    buf.frameLength = 4
    for c in 0 ..< 2 { for i in 0 ..< 4 { buf.floatChannelData![c][i] = 0.5 } }
    g = AutoGain(); run(g, 0.0003, 50); run(g, 0.003, 50); g.apply(buf, rms: 0.003)
    check("boost applies to every channel and never clips", (0 ..< 2).allSatisfy { c in buf.floatChannelData![c][3] == 1 })
    exit(bad == 0 ? 0 : 1)
}
// --test-clap checks the double-clap detector on made-up sounds (clap.swift); exits 1 on a failure.
if args.contains("--test-clap") { exit(ClapTest.run()) }
// --test-phrase: how heard words are compared with the phrase's (phrase.swift); exits 1 on a failure.
if args.contains("--test-phrase") { exit(PhraseTest.run()) }
// --test-mic: the one mic's consumers (mic.swift), with no mic; exits 1 on a failure.
if args.contains("--test-mic") { exit(MicTest.run()) }
// --bench-claps [set dir]: the double-clap detector's rates on made-up recordings (benchclaps.swift).
if let i = args.firstIndex(of: "--bench-claps") {
    let dir = i + 1 < args.count && !args[i + 1].hasPrefix("--") ? args[i + 1] : nil
    var bad: Int32 = 0
    // Every seed is a full bench (ClapBench.seeds): one lucky seed can't pass it.
    for seed in ClapBench.seeds {
        ClapBench.seed = seed
        let tag = seed.map { " (seed \($0))" } ?? " (the usual trials)"
        let rs = ClapBench.run(make: { rate, k, cal in let d = ClapDetector(rate: rate, sensitivity: k, calibration: cal); if ProcessInfo.processInfo.environment["CLAP_BENCH"] != nil { d.onCandidate = { print(String(format: "  %.2f ", d.now) + $0) } }; return { d.feed($0) } }, setDir: dir)
        bad |= ClapBench.report(rs, label: "double clap (this build)\(tag)")
        // While Hydra speaks (C7): the same decisions Voice makes, the recogniser stubbed with each fixture's words.
        bad |= ClapBench.report(ClapBench.runOver(over: BargeGate.interrupter), label: "what stops Hydra while it speaks (this build)\(tag)")
    }
    exit(bad)
}
// --test-bands: the orb's spectrum (24 bands from an FFT) and its 30-a-second pace; exits 1 on a failure.
if args.contains("--test-bands") { exit(OutTest.bands()) }
// --test-ducking: voice processing never turns other audio down, and mute-while-listening never mutes Hydra.
if args.contains("--test-ducking") { exit(OutTest.ducking()) }
// --test-cue [<sounds dir>]: which takes chime, the pending loop's ducking and the sound switch (cue.swift).
if let i = args.firstIndex(of: "--test-cue") { exit(CueTest.run(dir: i + 1 < args.count ? args[i + 1] : nil)) }
// --test-triggers checks what a clap, the key phrase and talking over Hydra do, awake and asleep, and the talk detector.
if args.contains("--test-triggers") { exit(TriggerTest.run()) }
// --test-wake checks the wake phrase matcher on transcripts the recogniser could write; exits 1 on a failure.
if args.contains("--test-wake") {
    var bad = 0
    func check(_ text: String, _ want: String?) {
        let got = WakeWord.match(text)
        print("\(got == want ? "ok" : "FAIL") \"\(text)\" -> \(got.map { "\"\($0)\"" } ?? "no wake")")
        if got != want { bad += 1 }
    }
    check("Hey Hydra", "")
    check("Hey Hydra, open Safari.", "open Safari.")
    check("hey hydra open safari", "open safari")
    check("Hey, Hydra.", "")
    check("Hi Hydra what time is it?", "what time is it?")
    check("Hey Hidra", "")
    check("Hey Hydro, play some music", "play some music")
    check("Hey Hydra's, open Notes", "open Notes")
    check("That's it. Hey Hydra, open Mail", "open Mail")
    check("HEY HYDRA! What's on today?", "What's on today?")
    check("Hey Heather", nil)
    check("Hey Hey", nil)
    check("Hey Harry, come here", nil)
    check("Hey hi", nil)
    // The name alone, first in what was said, wakes it too (owner: the phrase "still barely works").
    check("Hydra is great", "is great")
    check("Hydra", "")
    check("Hydra, open Mail.", "open Mail.")
    check("Um, Hydra what time is it", "what time is it")
    check("Hey hydro open Notes", "open Notes")
    check("A Hydra, play music", "play music")
    check("Hay Hydra", "")
    check("High Hydra, what's up", "what's up")
    check("Hi dra, open Mail", "open Mail")
    check("I need to hydrate", nil)
    check("My new car is a Hyundai", nil)
    check("Hydrate after the run", nil)
    check("The hydraulic press", nil)
    check("Heather is here", nil)
    check("I told him hey Hydra", nil)
    check("Um hey Hydra, open Mail", "open Mail")
    check("Okay, hi Hydra", "")
    check("So I said hey Hydra", nil)
    check("Hey there", nil)
    check("Hey", nil)
    check("Hey. Hydra", "")
    check("", nil)
    // Everyday talk that sounds like the name (the verify pass: each of these woke it).
    for t in ["It's a hotter day today", "That's a header problem", "A heater is on", "Okay, a hatter", "hydro power is cheap",
              "Hey hider", "They hydrate a lot", "a hydro plant"] { check(t, nil) }
    check("Hydro, open Mail", "open Mail")
    check("Hydro", "")
    check("Hey Heidra", "")
    // The sleep word, anywhere in what was said.
    func sleeps(_ text: String, _ want: Bool) { let got = SleepWord.heard(in: text); print("\(got == want ? "ok" : "FAIL") sleep \"\(text)\" -> \(got)"); if got != want { bad += 1 } }
    sleeps("Hydra, sleep.", true)
    sleeps("Hydro sleep", true)
    sleeps("hydra sleep", true)
    sleeps("Okay Hidra sleep now", true)
    sleeps("Hydra, open Sleep Cycle", false)
    sleeps("I need sleep", false)
    sleeps("Hydra", false)
    SleepWord.set("Goodnight Hydra")
    sleeps("goodnight, Hydra", true)
    sleeps("Good night, Heather", false)
    sleeps("good night idea", false)
    sleeps("Good night, Heidler.", true)
    sleeps("Hydra, sleep", false)
    SleepWord.set("Good night Hydra")
    sleeps("Goodnight Hydra", true)
    SleepWord.set("3 kill")
    sleeps("Three kill.", true)
    sleeps("3 kill", true)
    sleeps("three-kill", true)
    sleeps("We killed three hours", false)
    sleeps("three skills", false)
    for t in ["I have three calls today", "it's their call", "that's their goal", "they're cool", "free call now",
              "three goals in the first half", "there's coal"] { sleeps(t, false) }
    sleeps("Free girl.", true)
    sleeps("three keel", true)
    SleepWord.set("")
    sleeps("Hydra, sleep", true)
    // Build 4 E1 (C5): while a turn runs only the exact words count.
    func strictly(_ text: String, _ want: Bool) { let got = SleepWord.heard(in: text, strict: true); print("\(got == want ? "ok" : "FAIL") strict sleep \"\(text)\" -> \(got)"); if got != want { bad += 1 } }
    strictly("Hydra, sleep.", true)
    strictly("Hydro sleep", false)
    strictly("Okay Hidra sleep now", false)
    strictly("okay Hydra sleep now", true)
    strictly("I told Hydra sleep is important", false)
    strictly("so Hydra sleep mode is broken right", false)
    SleepWord.set("Sleep beast")
    strictly("Sleep beast", true)
    strictly("sleep least", false)
    sleeps("sleep least", true)
    SleepWord.set("")
    // A later reading of the take that no longer matches the phrase: its words still come off.
    func dropped(_ n: Int, _ text: String, _ want: String) { let got = WakeWord.dropping(n, from: text); print("\(got == want ? "ok" : "FAIL") drop \(n) \"\(text)\" -> \"\(got)\""); if got != want { bad += 1 } }
    dropped(2, "Hey Hyde, what time is it?", "what time is it?")
    dropped(2, "Hey Hyde", "")
    dropped(3, "Um hey Hyde open Mail", "open Mail")
    dropped(0, "open Mail", "open Mail")
    // A name of the user's own.
    func named(_ ok: Bool, _ name: String) { let got = WakeWord.setName(name); print("\(got == ok ? "ok" : "FAIL") name \"\(name)\" \(ok ? "taken" : "refused")"); if got != ok { bad += 1 } }
    named(false, "Bob")
    named(false, "a really very long name for this")
    named(true, "Jarvis")
    check("Hey Jarvis", "")
    check("Hey Jarvis, open Safari.", "open Safari.")
    check("hi jarvis what time is it", "what time is it")
    check("Hey Jervis, open Notes", "open Notes")
    check("Hey Jar vis, hello", "hello")
    check("Hey Travis", nil)
    check("Hey Service", nil)
    check("Hey Hydra", nil)
    check("Jarvis is great", "is great")
    check("I told him hey Jarvis", nil)
    named(true, "Nova")
    check("Hey Nova, play music", "play music")
    check("Hey Nora", nil) // a short name must be heard exactly
    named(true, "")
    check("Hey Hydra, open Mail", "open Mail")
    check("Hey Jarvis", nil)
    // Hydra's wake phrase from its settings (W5 contract 1).
    func phrased(_ ok: Bool, _ p: String) { let got = WakeWord.setPhrase(p); print("\(got == ok ? "ok" : "FAIL") phrase \"\(p)\" \(ok ? "taken" : "refused")"); if got != ok { bad += 1 } }
    phrased(true, "Hey Jarvis")
    check("hey jarvis open mail", "open mail")
    check("Hey Jervis, open Notes", "open Notes") // a greeting and a name keep the tuned rule
    phrased(true, "Okay Computer")
    check("Okay computer, open Mail", "open Mail")
    check("okay computer", "")
    check("Um okay computr play music", "play music")
    check("Computer okay", nil)
    check("So I said okay computer", nil)
    check("Hey Hydra", nil)
    phrased(false, "")
    phrased(false, "Yo")
    phrased(false, "one two three four five six seven")
    check("okay computer what's on", "what's on") // a refused phrase keeps the last one
    check("Okay, compute the total for me", nil)
    phrased(true, "3 kill")
    check("three kill", "")
    check("Three Kill, open Mail", "open Mail")
    phrased(true, "Hey Hydra")
    check("Hey Hydra, open Mail", "open Mail")
    check("Okay computer", nil)
    exit(bad == 0 ? 0 : 1)
}
// --test-snap checks which drawn paths count as a circled area; exits 1 on a failure.
if args.contains("--test-snap") {
    var bad = 0
    func check(_ name: String, _ ok: Bool) { print("\(ok ? "ok" : "FAIL") \(name)"); if !ok { bad += 1 } }
    func arc(_ cx: CGFloat, _ cy: CGFloat, _ r: CGFloat, turns: CGFloat, steps: Int = 80) -> [CGPoint] {
        (0 ... steps).map { k in let a = turns * 2 * .pi * CGFloat(k) / CGFloat(steps); return CGPoint(x: cx + r * cos(a), y: cy + r * sin(a)) }
    }
    let lead = (0 ..< 20).map { CGPoint(x: 100 + CGFloat($0) * 4, y: 300) }
    check("a full circle snaps", Loop.closing(arc(300, 300, 60, turns: 1)) != nil)
    check("a circle with a run-up and overshoot snaps from where the loop starts", Loop.closing(lead + arc(200, 300, 60, turns: 1.08)).map { $0 >= lead.count - 2 } == true)
    check("three-quarters of a circle doesn't", Loop.closing(arc(300, 300, 60, turns: 0.75)) == nil)
    check("three-quarters doesn't close even at the end", Loop.closing(arc(300, 300, 60, turns: 0.75), gap: Loop.closeGap * 1.8) == nil)
    check("a nearly closed circle closes with the looser gap at the end", Loop.closing(arc(300, 300, 60, turns: 0.93), gap: Loop.closeGap * 1.8) != nil)
    check("a straight line doesn't", Loop.closing((0 ..< 80).map { CGPoint(x: CGFloat($0) * 5, y: 200) }) == nil)
    let there = (0 ..< 40).map { CGPoint(x: CGFloat($0) * 5, y: 200) }
    check("a line drawn back over itself doesn't", Loop.closing(there + there.reversed().map { CGPoint(x: $0.x, y: $0.y + 3) }) == nil)
    check("a zigzag doesn't", Loop.closing((0 ..< 60).map { CGPoint(x: CGFloat($0) * 6, y: 200 + ($0 % 2 == 0 ? 0 : 30)) }) == nil)
    check("a tiny scribble doesn't", Loop.closing(arc(300, 300, 8, turns: 3)) == nil)
    var box: [CGPoint] = stride(from: CGFloat(0), through: 120, by: 6).map { CGPoint(x: $0, y: 0) }
    box += stride(from: CGFloat(0), through: 90, by: 6).map { CGPoint(x: 120, y: $0) }
    box += stride(from: CGFloat(120), through: 0, by: -6).map { CGPoint(x: $0, y: 90) }
    box += stride(from: CGFloat(90), through: 0, by: -6).map { CGPoint(x: 2, y: $0) }
    check("a rough box snaps", Loop.closing(box) != nil)
    exit(bad == 0 ? 0 : 1)
}
// --test-chord checks when the talk chord counts as part of a shortcut, with made-up key states; exits 1 on a failure.
if args.contains("--test-chord") {
    var bad = 0
    func check(_ name: String, _ ok: Bool) { print("\(ok ? "ok" : "FAIL") \(name)"); if !ok { bad += 1 } }
    check("the chord alone is a talk", !Voice.isShortcut(extra: false, heldAtArm: [], now: []))
    check("a key pressed with it is a shortcut (⌃⌥S)", Voice.isShortcut(extra: false, heldAtArm: [], now: [0x01]))
    check("an extra ⇧ or ⌘ is a shortcut", Voice.isShortcut(extra: true, heldAtArm: [], now: []))
    // Regression: key code 0 read as held at almost every press, though no key was, so nearly every talk was rejected.
    check("a key already down when the chord went down doesn't count", !Voice.isShortcut(extra: false, heldAtArm: [0x00], now: [0x00]))
    check("a key pressed after it still does", Voice.isShortcut(extra: false, heldAtArm: [0x00], now: [0x00, 0x01]))
    check("a held key let go isn't a key pressed", !Voice.isShortcut(extra: false, heldAtArm: [0x00], now: []))
    check("an extra ⇧ or ⌘ still counts with a key held", Voice.isShortcut(extra: true, heldAtArm: [0x00], now: [0x00]))
    exit(bad == 0 ? 0 : 1)
}
// --test-spaces checks when a shown panel the window server isn't drawing is built again; exits 1 on a failure.
if args.contains("--test-spaces") {
    var bad = 0
    func check(_ name: String, _ ok: Bool) { print("\(ok ? "ok" : "FAIL") \(name)"); if !ok { bad += 1 } }
    func step(_ stage: OnScreenStage, _ onScreen: [Bool?], screen: Bool = true) -> (line: String?, next: OnScreenNext) {
        onScreenStep("pill", stage, onScreen: onScreen, screenAttached: screen)
    }
    check("first look, on screen: done", step(.first, [true]) == (nil, .done))
    check("first look, off screen: a second look before anything else", step(.first, [false]) == (nil, .confirm))
    check("first look, no answer from the window server: done", step(.first, [nil]) == (nil, .done))
    check("no display attached (asleep): never built again", step(.first, [false], screen: false) == (nil, .done) && step(.confirm, [false], screen: false) == (nil, .done))
    check("no panel shown: nothing", step(.first, []) == (nil, .done))
    check("one panel of two off screen (the drawing layer has one per screen): a second look", step(.first, [true, false]).next == .confirm)
    // Regression: the pill faded to alpha 1 beside the cursor while the window server said it wasn't on screen.
    check("off at the second look too: built again, and said", step(.confirm, [false]) == ("pill: not on screen after being shown, building it again", .rebuild))
    check("on screen at the second look: left alone", step(.confirm, [true]) == (nil, .done))
    check("no answer at the second look: left alone", step(.confirm, [nil]) == (nil, .done))
    check("after the rebuild, on screen: said, not built again", step(.rebuilt, [true]) == ("pill: on screen after being built again", .done))
    check("after the rebuild, still off: said, not built again", step(.rebuilt, [false]) == ("pill: still not on screen after being built again", .done))
    check("after the rebuild, one on and one unknown: nothing", step(.rebuilt, [true, nil]) == (nil, .done))
    // The looks themselves, on a made-up clock with made-up window-server answers (no windows): when each look reads, in
    // ms after the call, and when the panel is built again. shownUntil: hidden from then on; replacedAt: another panel.
    var clock = 0.0, due: [(at: Double, run: () -> Void)] = []
    func later(_ d: Double, _ f: @escaping () -> Void) { due.append((clock + d, f)) }
    func runClock() { while let i = due.indices.min(by: { due[$0].at < due[$1].at }) { let d = due.remove(at: i); clock = d.at; d.run() } }
    func ms(_ t: [Double]) -> [Int] { t.map { Int(($0 * 1000).rounded()) } }
    func watch(_ name: String, _ answers: [Bool?], screen: Bool = true, shownUntil: Double = .infinity, replacedAt: Double = .infinity) -> (reads: [Int], rebuilds: [Int]) {
        clock = 0
        let a = NSObject(), b = NSObject()
        var reads: [Double] = [], rebuilds: [Double] = [], left = answers
        watchOnScreen(name, { clock >= shownUntil ? [] : [(ObjectIdentifier(clock >= replacedAt ? b : a), 1)] },
                      read: { _ in reads.append(clock); return left.isEmpty ? nil : left.removeFirst() },
                      screenAttached: { screen }, after: later) { rebuilds.append(clock) }
        runClock()
        return (ms(reads), ms(rebuilds))
    }
    // Regression: the drawing layer is armed just before the mic starts in the same turn; a turn held past 0.2 s put the
    // first look ahead of the order-in, and a panel that was fine was built again.
    check("off at the first look, on 0.1 s later (before the order-in): not built again", watch("race", [false, true]) == ([200, 300], []))
    check("off at both looks: built again once, at the second, then looked at once more", watch("off", [false, false, true]) == ([200, 300, 500], [300]))
    check("off, then no answer: not built again", watch("unknown", [false, nil]) == ([200, 300], []))
    check("still off after the rebuild: never built twice", watch("stuck", [false, false, false]) == ([200, 300, 500], [300]))
    check("on at the first look: one look only", watch("on", [true]) == ([200], []))
    check("hidden before the second look: it does nothing", watch("hidden", [false, false], shownUntil: 0.25) == ([200], []))
    check("replaced before the second look (a display-change rebuild): it does nothing", watch("replaced", [false, false], replacedAt: 0.25) == ([200], []))
    check("no display attached: one look, nothing built", watch("asleep", [false], screen: false) == ([200], []))
    clock = 0
    let shown = NSObject()
    var earlierReads = 0, earlierRebuilds = 0, newerRebuilds = 0
    watchOnScreen("again", { [(ObjectIdentifier(shown), 1)] }, read: { _ in earlierReads += 1; return false }, screenAttached: { true }, after: later) { earlierRebuilds += 1 }
    later(0.25) { watchOnScreen("again", { [(ObjectIdentifier(shown), 1)] }, read: { _ in true }, screenAttached: { true }, after: later) { newerRebuilds += 1 } }
    runClock()
    check("a newer show before the second look: the earlier show's look does nothing", earlierReads == 1 && earlierRebuilds == 0 && newerRebuilds == 0)
    check("window 0 is never a window: no answer", windowOnScreen(0) == nil)
    check("a negative number: no answer", windowOnScreen(-1) == nil)
    check("past a window id's range: no answer", windowOnScreen(Int(UInt32.max) + 1) == nil)
    check("a window number nobody has: no answer", windowOnScreen(0x7fff_fff0) == nil)
    exit(bad == 0 ? 0 : 1)
}
// --test-mics: which mics a take tries when the first won't open; exits 1 on a failure.
if args.contains("--test-mics") {
    var bad = 0
    func check(_ name: String, _ ok: Bool) { print("\(ok ? "ok" : "FAIL") \(name)"); if !ok { bad += 1 } }
    check("a picked mic is the only one tried", InputDevice.tries(picked: 7, current: 3, builtIn: 4) == [7])
    check("automatic: the system's choice, then the default by name, then the built-in", InputDevice.tries(picked: nil, current: 3, builtIn: 4) == [nil, 3, 4])
    check("the default is the built-in: tried once by name", InputDevice.tries(picked: nil, current: 4, builtIn: 4) == [nil, 4])
    check("no live default: straight to the built-in", InputDevice.tries(picked: nil, current: nil, builtIn: 4) == [nil, 4])
    check("nothing else to try", InputDevice.tries(picked: nil, current: nil, builtIn: nil) == [nil])
    exit(bad == 0 ? 0 : 1)
}
// --test-clicks: which clicks count as changing the screen, with made-up element roles; exits 1 on a failure.
if args.contains("--test-clicks") {
    var bad = 0
    func check(_ name: String, _ ok: Bool) { print("\(ok ? "ok" : "FAIL") \(name)"); if !ok { bad += 1 } }
    check("a link in a web page", ClickTarget.acts(roles: ["AXStaticText", "AXLink", "AXGroup", "AXWebArea"], count: 1))
    check("a button", ClickTarget.acts(roles: ["AXButton", "AXToolbar", "AXWindow"], count: 1))
    check("a menu item", ClickTarget.acts(roles: ["AXMenuItem", "AXMenu"], count: 1))
    check("a tab", ClickTarget.acts(roles: ["AXRadioButton", "AXTabGroup", "AXWindow"], count: 1))
    check("plain text in a page doesn't", !ClickTarget.acts(roles: ["AXStaticText", "AXGroup", "AXWebArea", "AXScrollArea"], count: 1))
    check("one click on a list row doesn't", !ClickTarget.acts(roles: ["AXStaticText", "AXCell", "AXRow", "AXOutline"], count: 1))
    check("a double-click on a list row opens it", ClickTarget.acts(roles: ["AXStaticText", "AXCell", "AXRow", "AXOutline"], count: 2))
    check("a double-click on page text doesn't (it selects a word)", !ClickTarget.acts(roles: ["AXStaticText", "AXWebArea"], count: 2))
    check("a link inside a list still counts", ClickTarget.acts(roles: ["AXLink", "AXCell", "AXRow", "AXTable"], count: 1))
    exit(bad == 0 ? 0 : 1)
}
// --bench <set dir> [--out readings.jsonl]: the wake phrase and sleep word on the recorded set (benchwake.swift).
if let i = args.firstIndex(of: "--bench"), i + 1 < args.count {
    let out = args.firstIndex(of: "--out").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
    WakeBench.run(dir: args[i + 1], out: out)
}
// --wake-file <wav>: a recording through the real recogniser (with the mic boost) and the wake matcher, as live
// listening would hear it. Prints one JSON line: whether it woke, what followed the phrase, the closest name.
if let i = args.firstIndex(of: "--wake-file"), i + 1 < args.count {
    let url = URL(fileURLWithPath: args[i + 1])
    guard let file = try? AVAudioFile(forReading: url) else { emit(["type": "wake_file", "error": "can't read \(url.path)"]); exit(2) }
    var heard = "", woke = false, closest: Int?
    let report = {
        emit(["type": "wake_file", "file": url.lastPathComponent, "woke": woke, "rest": woke ? WakeWord.match(heard) ?? "" : "", "distance": closest ?? -1, "heard": heard])
        exit(0)
    }
    let cb = RecognizerCallbacks(
        onText: { text in
            heard = text
            let (rest, d, _) = WakeWord.scan(text)
            if rest != nil { woke = true }
            if let d { closest = min(closest ?? d, d) }
        },
        onDone: { report() },
        onError: { e in log("recognition: \(e.localizedDescription)"); report() }
    )
    var r: Recognizer?
    if #available(macOS 26, *), SpeechTranscriber.isAvailable { r = AnalyzerRecognizer(cb) } else { r = LegacyRecognizer(cb) }
    guard let r else { emit(["type": "wake_file", "error": "speech recognition unavailable"]); exit(2) }
    let gain = AutoGain()
    while let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 1024), (try? file.read(into: buf)) != nil, buf.frameLength > 0 {
        if let x = buf.floatChannelData?[0] {
            var sum: Float = 0
            for k in 0 ..< Int(buf.frameLength) { sum += x[k] * x[k] }
            gain.apply(buf, rms: sqrt(sum / Float(buf.frameLength)))
        }
        r.append(buf)
    }
    r.end()
    DispatchQueue.main.asyncAfter(deadline: .now() + 60) { report() }
    dispatchMain()
}
if args.contains("--perms") { emit(permStatus()); exit(0) }
if let i = args.firstIndex(of: "--request"), i + 1 < args.count {
    let done = DispatchSemaphore(value: 0)
    switch args[i + 1] {
    case "mic": AVCaptureDevice.requestAccess(for: .audio) { _ in done.signal() }; done.wait()
    case "speech": SFSpeechRecognizer.requestAuthorization { _ in done.signal() }; done.wait()
    case "screen": _ = CGRequestScreenCaptureAccess()
    default: break
    }
    emit(permStatus()); exit(0)
}

var signalSources: [DispatchSourceSignal] = []
let voice = Voice()
OutputMute.hydraPlaying = { voice.out.busy }
Cue.volume = { voice.out.volume }
Cue.speaking = { voice.out.busy }
if let i = args.firstIndex(of: "--sounds"), i + 1 < args.count { Cue.dir = URL(fileURLWithPath: args[i + 1], isDirectory: true) }
voice.out.onBands = { emit(["type": "bands", "b": $0.map { ($0 * 1000).rounded() / 1000 }]) }
voice.out.onFail = { emit(["type": "play_failed", "why": $0]) }
voice.out.onPlayed = { emit(["type": "played", "id": $0, "mark": $1]) }
if args.contains("--no-mute") { OutputMute.enabled = false }
if let i = args.firstIndex(of: "--chord"), i + 1 < args.count { voice.setChord(args[i + 1].components(separatedBy: ",")) }
if LiveTest.url != nil { OutputMute.enabled = false; voice.setWake(true); LiveTest.start() }
let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { _ in voice.tick() }
// The Mac's default input changing (headset in or out): barge-in gets another try with echo cancellation.
var defaultInputAddr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &defaultInputAddr, DispatchQueue.main) { _, _ in voice.micChanged() }
RunLoop.main.add(timer, forMode: .common)
Thread.detachNewThread {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
        switch msg["cmd"] as? String {
        case "cancel": let onlyAsk = msg["only"] as? String == "ask"; DispatchQueue.main.async { voice.externalCancel(onlyAsk: onlyAsk) }
        case "listen":
            let wait = msg["wait"] as? Double, via = (msg["via"] as? String).flatMap { ["orb", "wake"].contains($0) ? $0 : nil } ?? "listen"
            let after = msg["afterVoice"] as? Bool == true, ask = msg["via"] as? String == "ask"
            DispatchQueue.main.async { if after { voice.listenAfterVoice(wait: wait, via: via) } else { voice.listenNow(wait: wait, via: via, ask: ask) } }
        case "finish": DispatchQueue.main.async { voice.externalFinish() }
        // Hydra's cues (cue.swift): the wake chime, and the soft loop while it works.
        case "cue": if let n = msg["name"] as? String, ["wake", "listen"].contains(n) { DispatchQueue.main.async { Cue.play(n) } }
        case "pending": if let on = msg["on"] as? Bool { DispatchQueue.main.async { Cue.pending(on) } }
        // The sidekick is answering (it appears where the cursor is): the listening pill can go.
        case "handoff": DispatchQueue.main.async { voice.wave.handoff() }
        // The sidekick following the cursor in its cursor form, drawn here (buddy.swift) until the page takes it back.
        case "buddy": DispatchQueue.main.async { if msg["on"] as? Bool == true { voice.buddy.show(msg) } else { voice.buddy.hide() } }
        case "buddy_alpha": if let a = msg["a"] as? Double { DispatchQueue.main.async { voice.buddy.setHidden(a < 0.5) } }
        case "chord": if let mods = msg["mods"] as? [String] { DispatchQueue.main.async { voice.setChord(mods) } }
        case "watch_clicks": let on = msg["on"] as? Bool == true; DispatchQueue.main.async { voice.watchClicks = on }
        case "sound": if let on = msg["on"] as? Bool { DispatchQueue.main.async { SnapCue.soundOn = on; Cue.soundOn = on; if !on { Cue.pending(false) } } }
        // The listening pill beside the cursor: off while the notch capsule shows it instead.
        case "pill": if let on = msg["on"] as? Bool { DispatchQueue.main.async { voice.wave.off = !on; if !on { voice.wave.hide() } } }
        case "wake": if let on = msg["on"] as? Bool { DispatchQueue.main.async { voice.setWake(on) } }
        // Hydra is asleep: listen for a double clap only ({"cmd":"clap","on":true,"sensitivity":0.5}).
        // Awake, with clap-to-talk on: a double clap starts a take ({"asleep":false,"talk":true}).
        case "clap":
            let on = msg["on"] as? Bool == true, k = msg["sensitivity"] as? Double, asleep = msg["asleep"] as? Bool, talk = msg["talk"] as? Bool
            // The owner's own claps ("Clap twice"): {"cal": {"peakDb": -24, "riseDb": 30}}; null or missing: none.
            let cal: ClapDetector.Calibration?? = msg.keys.contains("cal") ? (msg["cal"] as? [String: Any]).flatMap { c in
                (c["peakDb"] as? Double).flatMap { p in (c["riseDb"] as? Double).map { ClapDetector.Calibration(peakDb: p, riseDb: $0) } } } : nil
            DispatchQueue.main.async { voice.setClap(on, asleep: asleep, talk: talk, sensitivity: k, calibration: cal) }
        // The panel's "Clap twice", and its live clap level ({"cmd":"clap_meter","on":true}).
        case "clap_calibrate": DispatchQueue.main.async { voice.calibrateClaps() }
        case "clap_meter": let on = msg["on"] as? Bool == true; DispatchQueue.main.async { voice.clapMeter = on }
        // Interrupt by talking (a setting), and whether Hydra is speaking now (from the overlay's player).
        case "barge": let on = msg["on"] as? Bool != false; DispatchQueue.main.async { voice.setBarge(on) }
        case "speaking": let on = msg["on"] as? Bool == true; DispatchQueue.main.async { voice.setSpeaking(on) }
        // Hydra's voice, played here (W5 contract 6): 16-bit mono PCM chunks of a reply, stop, pause, volume.
        case "play":
            let id = msg["id"] as? String ?? "", rate = msg["rate"] as? Double ?? HydraOut.rate
            if let b64 = msg["pcm"] as? String, let pcm = Data(base64Encoded: b64) { DispatchQueue.main.async { voice.play(id: id, pcm: pcm, rate: rate) } }
        case "play_stop": DispatchQueue.main.async { voice.out.stop() }
        // After an ask's question (W5): "played" comes back once all of it has played.
        case "play_mark": if let id = msg["id"] as? String, let m = msg["mark"] as? String { DispatchQueue.main.async { voice.out.mark(id: id, mark: m) } }
        case "play_pause": let on = msg["on"] as? Bool == true; DispatchQueue.main.async { voice.out.pause(on) }
        case "play_volume": if let v = msg["v"] as? Double { DispatchQueue.main.async { voice.out.volume = Float(max(0, min(1, v))) } }
        // Hydra's wake phrase (agent_settings.wake_phrase). Only whether it was taken is logged, never the words.
        // Set again with every settings message: logged only when it changes.
        case "wake_phrase":
            let p = msg["phrase"] as? String ?? ""
            DispatchQueue.main.async { let was = WakeWord.signature; let ok = WakeWord.setPhrase(p); if !ok { log("wake phrase refused") } else if WakeWord.signature != was { log("wake phrase set") } }
        case "sleep_word": let p = msg["phrase"] as? String ?? ""; DispatchQueue.main.async { if SleepWord.set(p) { log("sleep word set") } }
        // The name after "Hey" (empty: Roamies). Only whether it's custom is logged, never the word.
        case "wake_name":
            let word = msg["word"] as? String ?? ""
            DispatchQueue.main.async { let was = WakeWord.signature; let ok = WakeWord.setName(word); if !ok { log("wake name refused") } else if WakeWord.signature != was { log("wake name: \(WakeWord.custom == nil ? "Hydra" : "custom")") } }
        // Roamies is answering or speaking: don't listen for the phrase (it mustn't wake itself).
        case "wake_hold": let on = msg["on"] as? Bool == true; DispatchQueue.main.async { voice.wakeHold = on }
        case "mute": if let on = msg["on"] as? Bool { DispatchQueue.main.async { OutputMute.enabled = on; if !on { OutputMute.end() } } }
        // The speech language for takes: a locale id such as "ar-SA", or "auto" / "" for the Mac's own languages.
        case "lang": let id = msg["id"] as? String ?? ""; DispatchQueue.main.async { voice.setSpeechLang(id) }
        // The panel's mic picker: the list, and a pick (a UID from it; none or "" is automatic).
        case "mics": DispatchQueue.main.async { emit(InputDevice.list()) }
        case "mic":
            let id = (msg["id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            DispatchQueue.main.async { if InputDevice.chosen != id { InputDevice.chosen = id; log("mic: \(id ?? "automatic")"); voice.micChanged() } }
        default: break
        }
    }
    // Roamies quit: never leave the Mac muted.
    DispatchQueue.main.sync { OutputMute.end() }
    exit(0)
}
// Killed (Quit, crash restart): restore output on the way out too.
for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { OutputMute.end(); exit(0) }
    src.resume()
    signalSources.append(src)
}
emit(["type": "ready", "engine": voice.engineName, "dryRun": dryRun])
// An app run loop (no Dock icon) so the drawing panels get mouse events.
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
