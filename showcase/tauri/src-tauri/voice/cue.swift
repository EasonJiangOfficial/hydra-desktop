// Hydra's cues, played here in the voice helper (build 4 E4, recon-sounds fix). The helper is the one process that
// sees every trigger with its source. Listen and wake are the overlay's own rendered chimes (showcase/roamies/sounds,
// bundled as resources, --sounds <dir>), and pending is the soft loop while Hydra works. All follow
// the sound switch ('sound') and Hydra's volume (play_volume).
import AVFoundation
import Foundation

enum Cue {
    static var soundOn = true
    static var dir: URL?
    static var volume: () -> Float = { 1 }
    /// Hydra's own voice is playing (the progress lines): the pending loop ducks under it.
    static var speaking: () -> Bool = { false }
    private static var players: [String: AVAudioPlayer] = [:]
    private static var missing = Set<String>()
    /// When the last one-shot cue ends (uptime): a take's empty-silence check waits for it (Voice.chimeCovers).
    private(set) static var until = 0.0

    /// Which takes chime as they open: the owner's own triggers (a double clap, the key phrase, the talk keys, an orb
    /// tap). Not an auto-listen follow-up or an area snap ('listen'), barge-in, or the take a wake opens ('wake': the
    /// wake chime already played).
    static func audible(via: String) -> Bool { ["clap", "phrase", "keys", "orb"].contains(via) }

    static func player(_ name: String) -> AVAudioPlayer? {
        if let p = players[name] { return p }
        guard let dir, !missing.contains(name) else { return nil }
        guard let p = try? AVAudioPlayer(contentsOf: dir.appendingPathComponent("\(name).wav")) else {
            missing.insert(name); log("cue: no \(name).wav in \(dir.path)"); return nil
        }
        p.prepareToPlay()
        players[name] = p
        return p
    }

    /// A one-shot chime (listen, wake).
    static func play(_ name: String) {
        guard soundOn, volume() > 0, let p = player(name) else { return }
        p.numberOfLoops = 0; p.volume = volume(); p.currentTime = 0; p.play()
        until = uptime() + p.duration
    }

    // ---- pending: while Hydra thinks or runs tools in a spoken turn (the sidecar's 'pending') ----
    static let pendingDelay = 0.6, pendingFadeIn = 0.4, pendingFadeOut = 0.15
    /// The loop's level: Hydra's volume, ducked to a quarter under its own voice (the progress lines).
    static func pendingLevel(volume: Float, speaking: Bool) -> Float { volume * (speaking ? 0.25 : 1) }
    /// The loop's next level while it plays, or nil when the one applied still holds: Hydra's voice starting or
    /// stopping, and the owner's volume or mute (play_volume) changing meanwhile, all move it.
    static func pendingRetarget(applied: Float, volume: Float, speaking: Bool) -> Float? {
        let want = pendingLevel(volume: volume, speaking: speaking)
        return abs(want - applied) < 0.001 ? nil : want
    }
    private static var pendingGen = 0
    private static var duck: Timer?
    private(set) static var pendingOn = false
    /// On: fades in after 0.6 s of work. Off (the answer starts, an ask is said, the owner talks, the turn ends): a
    /// 150 ms fade out.
    static func pending(_ on: Bool) {
        guard on != pendingOn else { return }
        pendingOn = on
        pendingGen += 1
        let gen = pendingGen
        duck?.invalidate(); duck = nil
        guard let p = player("pending") else { return }
        if !on {
            guard p.isPlaying else { return }
            p.setVolume(0, fadeDuration: pendingFadeOut)
            DispatchQueue.main.asyncAfter(deadline: .now() + pendingFadeOut + 0.02) { if pendingGen == gen { p.stop() } }
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + pendingDelay) {
            guard pendingGen == gen, soundOn else { return }
            var applied = pendingLevel(volume: volume(), speaking: speaking())
            p.numberOfLoops = -1; p.volume = 0
            if !p.isPlaying { p.currentTime = 0; p.play() }
            p.setVolume(applied, fadeDuration: pendingFadeIn)
            let t = Timer(timeInterval: 0.1, repeats: true) { _ in
                guard pendingGen == gen, let next = pendingRetarget(applied: applied, volume: volume(), speaking: speaking()) else { return }
                applied = next
                p.setVolume(next, fadeDuration: pendingFadeOut)
            }
            RunLoop.main.add(t, forMode: .common)
            duck = t
        }
    }
}

// --test-cue [<sounds dir>]: which takes chime, the pending loop's ducking, the sound switch, and (with a folder) that
// the chimes load. Nothing is played. Exits 1 on a failure.
enum CueTest {
    static func run(dir: String?) -> Int32 {
        var bad = 0
        func check(_ name: String, _ ok: Bool) { if !ok { bad += 1; print("FAIL: \(name)") } }
        for via in ["clap", "phrase", "keys", "orb"] { check("a take from \(via) chimes", Cue.audible(via: via)) }
        for via in ["listen", "barge", "wake", ""] { check("a take from '\(via)' opens silently", !Cue.audible(via: via)) }
        check("pending at full volume", Cue.pendingLevel(volume: 1, speaking: false) == 1)
        check("pending ducks under Hydra's voice", Cue.pendingLevel(volume: 1, speaking: true) == 0.25)
        check("pending follows the volume", Cue.pendingLevel(volume: 0.5, speaking: true) == 0.125 && Cue.pendingLevel(volume: 0, speaking: false) == 0)
        check("pending fades out in 150 ms", Cue.pendingFadeOut == 0.15 && Cue.pendingDelay == 0.6)
        check("pending holds its level while nothing changes", Cue.pendingRetarget(applied: 1, volume: 1, speaking: false) == nil)
        check("a mute mid-loop silences the loop", Cue.pendingRetarget(applied: 1, volume: 0, speaking: false) == 0)
        check("a volume change mid-loop moves it", Cue.pendingRetarget(applied: 1, volume: 0.5, speaking: false) == 0.5)
        check("Hydra's voice still ducks it", Cue.pendingRetarget(applied: 1, volume: 1, speaking: true) == 0.25)
        check("ask take: waits for the voice to start", Voice.afterVoiceDue(started: false, quietFor: 0, waited: 1) == nil)
        check("ask take: no voice in 4 s, it listens", Voice.afterVoiceDue(started: false, quietFor: 0, waited: 4.1) == true)
        check("ask take: waits while the voice plays", Voice.afterVoiceDue(started: true, quietFor: 0.1, waited: 2) == nil)
        check("ask take: listens 0.4 s after the voice", Voice.afterVoiceDue(started: true, quietFor: 0.45, waited: 3) == true)
        check("ask take: still speaking after 30 s, none", Voice.afterVoiceDue(started: true, quietFor: 0, waited: 31) == false)
        if let dir {
            Cue.dir = URL(fileURLWithPath: dir, isDirectory: true)
            for (n, len) in [("listen", 0.5), ("wake", 0.9), ("pending", 2.4), ("startup", 1.2)] {
                let p = Cue.player(n)
                check("\(n).wav loads", p != nil)
                check("\(n).wav is \(len) s", abs((p?.duration ?? 0) - len) < 0.02)
            }
            check("a missing file is no cue", Cue.player("nope") == nil)
            // The startup tone (the app plays it at launch, main.rs) heard by the mic (clap-to-talk is on by default and
            // is not told Hydra is speaking) is no double clap: at every sensitivity, 16 and 48 kHz, from 6 dB under the
            // file to 20 dB over it (0 dBFS).
            if let (x, r) = ClapBench.read(URL(fileURLWithPath: dir).appendingPathComponent("startup.wav")) {
                var rng = ClapTest.Rng(s: 2026), fired = 0
                for rate in [48000.0, 16000.0] { for gain: Float in [0.5, 1, 3, 10] { for k in [0.2, 0.5, 0.8] {
                    var b = ClapTest.room(2.5, rate: rate, rng: &rng)
                    let y = ClapBench.resample(x, from: r, to: rate), at = Int(0.5 * rate)
                    for i in 0 ..< y.count where at + i < b.count { b[at + i] += y[i] * gain }
                    let d = ClapDetector(rate: rate, sensitivity: k)
                    var i = 0
                    while i < b.count { let j = min(b.count, i + 1024); if d.feed(Array(b[i ..< j])) { fired += 1 }; i = j }
                } } }
                check("the startup tone in the mic is no double clap (\(fired) of 24 fired)", fired == 0)
            } else { check("startup.wav reads", false) }
            // Sound off: nothing plays (and nothing is started here either way).
            Cue.soundOn = false
            let before = Cue.until
            Cue.play("listen")
            check("sound off: no chime", Cue.until == before)
        }
        print(bad == 0 ? "cue: all passed" : "cue: \(bad) failed")
        return bad == 0 ? 0 : 1
    }
}
