import AVFoundation
import CoreAudio
import Foundation

// Hydra never mutes or reconfigures a sound device it doesn't own: no system mute, volume, sample rate, default device
// or hog mode, ever, not even an unmute (owner, 2026-11-26: "make sure that when hydra agent triggers or talks it doesnt
// disable my mic on other apps like discord or make it so that I cant hear other audio sources"). The one way it can
// still turn other apps down is Apple's echo cancellation (voice processing), which on macOS always ducks other audio
// (.min is the least; there is no off). It runs only with "Interrupt by talking" on, which is off by default and says
// so (Voice.bargeDefault, hydraout.swift). Builds before that muted the default output during each take; an owner they
// may have left muted is told once how to unmute (sidecar nosystemmute.mjs). This file holds only the read-only check
// below, and the helpers hold no CoreAudio property write at all (test/nosystemmute.test.mjs).

// ---------- --test-audio-hygiene: on a real Mac, Hydra's mic leaves every shared device setting alone ----------
// Opens the real mic (plain, as wake, clap and takes use it, then with echo cancellation, as while Hydra speaks) and
// reads, before, during and after: the default input and output, and on each their mute, volume (main and channels 1-2),
// nominal sample rate and hog mode. Any change exits 1. Needs the mic permission; run it on the owner's Mac, never in CI.
enum AudioHygiene {
    private static func get<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope, _ el: UInt32 = kAudioObjectPropertyElementMain, _ zero: T) -> T? {
        var a = AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: el)
        guard AudioObjectHasProperty(obj, &a) else { return nil }
        var v = zero, size = UInt32(MemoryLayout<T>.size)
        return AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &v) == noErr ? v : nil
    }
    static func snapshot() -> [String: String] {
        var s: [String: String] = [:]
        let sys = AudioObjectID(kAudioObjectSystemObject)
        let devs: [(String, AudioObjectPropertySelector, AudioObjectPropertyScope)] = [
            ("output", kAudioHardwarePropertyDefaultOutputDevice, kAudioDevicePropertyScopeOutput),
            ("input", kAudioHardwarePropertyDefaultInputDevice, kAudioDevicePropertyScopeInput)]
        for (name, sel, scope) in devs {
            let dev = get(sys, sel, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain, AudioDeviceID(0)) ?? 0
            s["\(name) default"] = "\(dev)"
            guard dev != 0 else { continue }
            s["\(name) mute"] = get(dev, kAudioDevicePropertyMute, scope, kAudioObjectPropertyElementMain, UInt32(0)).map { "\($0)" } ?? "-"
            for el in [kAudioObjectPropertyElementMain, 1, 2] {
                s["\(name) volume \(el)"] = get(dev, kAudioDevicePropertyVolumeScalar, scope, el, Float32(0)).map { String(format: "%.4f", $0) } ?? "-"
            }
            s["\(name) sample rate"] = get(dev, kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain, Float64(0)).map { "\($0)" } ?? "-"
            s["\(name) hog"] = get(dev, kAudioDevicePropertyHogMode, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain, pid_t(0)).map { "\($0)" } ?? "-"
        }
        return s
    }
    static func diff(_ a: [String: String], _ b: [String: String]) -> [String] {
        Set(a.keys).union(b.keys).sorted().compactMap { k in a[k] == b[k] ? nil : "\(k): \(a[k] ?? "-") -> \(b[k] ?? "-")" }
    }
    static func run() -> Int32 {
        var bad = 0
        func step(_ name: String, _ base: [String: String]) {
            RunLoop.main.run(until: Date().addingTimeInterval(1.5))
            let d = diff(base, snapshot())
            print("\(d.isEmpty ? "ok" : "FAIL") \(name)\(d.isEmpty ? "" : ": " + d.joined(separator: "; "))")
            if !d.isEmpty { bad += 1 }
        }
        let before = snapshot()
        print("before: \(before.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))")
        let hub = MicHub()
        hub.add("hygiene") { _ in }
        check: do {
            guard hub.open(device: nil, echoCancel: false) else { print("FAIL the mic didn't open (permission?)"); bad += 1; break check }
            step("plain mic open (wake, clap, a take): nothing shared changed", before)
            if #available(macOS 14, *) {
                // Echo cancellation is what "Interrupt by talking" (off by default) uses. Its ducking of other apps is not
                // a device setting, so this can't see it; it fails here only when echo cancellation never started.
                if hub.open(device: nil, echoCancel: true) && hub.echoCancel {
                    step("mic with echo cancellation (Interrupt by talking on): nothing shared changed", before)
                } else { print("FAIL echo cancellation didn't start, so it wasn't checked"); bad += 1 }
            }
        }
        hub.close(why: "hygiene test")
        step("mic closed: nothing shared changed", before)
        return bad == 0 ? 0 : 1
    }
}
