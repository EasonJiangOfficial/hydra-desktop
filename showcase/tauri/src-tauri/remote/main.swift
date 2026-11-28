// roamies-remote: the phone's live view of this Mac and its hands (RV plan, units D1 and section 5).
// stdin: JSON lines from the sidecar (remoteview.mjs): start, next, shields, input, hit, display, pause, resume, state,
// quit. stdout: frames of [u32 big-endian payload length][u8 type][payload]: type 1 a JSON event, type 2 one `scr`
// data-channel message, ready to forward. The pill shows before any pixel is read; stdin closing (the sidecar died),
// quit, or End on the pill ends it: a held button goes up, capture stops, the pill goes, the wake hold is dropped.
// --self-test runs the pure parts (patches, header, chunks, blackout in pixels, pacing, input mapping) and reads no
// screen. --probe says whether Screen Recording and Accessibility are granted.
import AppKit
import ApplicationServices
import IOKit.pwr_mgt

enum Out {
    static let q = DispatchQueue(label: "remote.out")
    static func frame(_ type: UInt8, _ payload: Data) {
        var d = Data(count: 5)
        let n = UInt32(payload.count)
        d[0] = UInt8(n >> 24); d[1] = UInt8((n >> 16) & 0xff); d[2] = UInt8((n >> 8) & 0xff); d[3] = UInt8(n & 0xff); d[4] = type
        d.append(payload)
        q.async {
            d.withUnsafeBytes { b in
                var off = 0
                while off < b.count {
                    let w = write(1, b.baseAddress! + off, b.count - off)
                    if w <= 0 { if errno == EINTR { continue }; exit(0) } // the sidecar is gone
                    off += w
                }
            }
        }
    }
    static func event(_ o: [String: Any]) {
        if let d = try? JSONSerialization.data(withJSONObject: o) { frame(1, d) }
    }
    static func scr(_ d: Data) { frame(2, d) }
    static func flush() { q.sync {} }
}

let clock = { ProcessInfo.processInfo.systemUptime }
/// Shields in display points to frame pixels.
func shieldPixels(_ r: [CGRect], k: CGFloat) -> [CGRect] { r.map { CGRect(x: $0.minX * k, y: $0.minY * k, width: $0.width * k, height: $0.height * k) } }

@available(macOS 14.0, *)
final class Remote {
    let cap = Capture()
    var pill: Pill?
    var frame: CGImage?
    var dirty: [CGRect] = [], wholeDirty = false, needKey = true, blacked = false
    // What the sidecar asked for: credits frames (at most 2, its acknowledge window), at this quality and scale.
    var pending: (q: Double, scale: Double, key: Bool)?, credits = 0
    var lastSent = -1.0, lastChange = 0.0, lastQ = 0.6, refine = Refine()
    // A display switch is under way: no frame is kept or encoded until the new stream's geometry and shields are in.
    var switching = false, displaysItem: DispatchWorkItem?
    var captureRevision = 0
    var captureCheck: CaptureCheck?
    var startingCapture = false
    var resumeID: Int?
    var windowsGen = 0, shieldsGen = 0, windowsAt = 0.0, windowsKey = ""
    // Window id to owner pid, from the last list (for a key focus held by a password app's window).
    var windowPids: [Int: Int] = [:]
    // Display points, as the sidecar sends them: turned into frame pixels at paint time, so shields that came before
    // the capture's size was known (the first window list goes out before `ready`) are not scaled by zero.
    var shields: [CGRect] = []
    var geomGen: UInt8 = 0, frameId: UInt32 = 0
    var held = false, paused = false, started = false, encoding = false
    var heldButton: CGMouseButton = .left
    var heldTarget: Hit.Target?
    var dragged = false
    var displayID: CGDirectDisplayID = CGMainDisplayID()
    var focusKey = "", lockedNow = false
    var pumpItem: DispatchWorkItem?
    var leaseUntil: Double = 0
    let continuousClock = ContinuousClock()
    var leaseLimit: ContinuousClock.Instant?
    var leaseWatchdog: Timer?
    var leaseMs = 0.0, approvalMs = 0.0
    var finishing = false
    struct Approval {
        let target: Hit.Target
        let point: CGPoint?
        let buttons: Bool
        let expires: ContinuousClock.Instant
        var verified = false
    }
    var approvals: [Int: Approval] = [:]
    var wake: IOPMAssertionID = 0
    let enc = DispatchQueue(label: "remote.encode")

    var displayFrame: CGRect { CGDisplayBounds(displayID) }
    /// Display points to frame pixels.
    var k: CGFloat { cap.size.width / max(1, displayFrame.width) }

    func leaseValid() -> Bool {
        guard !finishing, let leaseLimit else { return false }
        return continuousClock.now < leaseLimit && Date().timeIntervalSince1970 * 1_000 < leaseUntil
    }

    func leaseActive() -> Bool {
        if leaseValid() { return true }
        finish(by: "heartbeat")
        return false
    }

    func setLease(_ until: Double) {
        let remaining = min(leaseMs, until - Date().timeIntervalSince1970 * 1_000)
        guard remaining.isFinite, remaining > 0, leaseLimit == nil || until > leaseUntil else { return }
        leaseUntil = until
        leaseLimit = continuousClock.now.advanced(by: .seconds(remaining / 1_000))
        leaseWatchdog?.invalidate()
        leaseWatchdog = Timer.scheduledTimer(withTimeInterval: remaining / 1_000, repeats: false) { [weak self] _ in
            _ = self?.leaseActive()
        }
    }

    func handle(_ line: String) {
        guard let d = line.data(using: .utf8), let m = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], let cmd = m["cmd"] as? String else { return }
        if cmd != "start" && cmd != "quit" && !leaseActive() { return }
        switch cmd {
        case "start": start(m)
        case "lease":
            if let until = m["until"] as? Double { setLease(until) }
        case "next":
            credits = min(2, credits + 1)
            pending = ((m["q"] as? Double) ?? 0.6, (m["scale"] as? Double) ?? 1, (pending?.key ?? false) || ((m["key"] as? Bool) ?? false))
            pump()
        case "shields":
            let gen = (m["gen"] as? Int) ?? 0
            guard gen == windowsGen, gen >= shieldsGen else { return }
            shieldsGen = gen
            shields = ((m["rects"] as? [[Double]]) ?? []).filter { $0.count == 4 }.map { CGRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) }
            cap.setExclude(Set(((m["exclude"] as? [Int]) ?? []) + [pill?.windowID ?? -1]))
            startWhenShielded()
            if blacked { blacked = false; needKey = true }
            pump()
        case "input": input(m)
        case "hit":
            readTarget(m, point: point(m), buttons: false)
        case "focus":
            // Read now, for Return, Space or a newline (the 200 ms poll may be behind a Tab), with the window's buttons.
            readTarget(m, point: nil, buttons: (m["buttons"] as? Bool) ?? true)
        case "display":
            if let id = m["id"] as? Int { switchTo(CGDirectDisplayID(id)) }
        case "pause":
            paused = true
            resumeID = nil
            resetCapture()
        case "resume":
            guard paused, let id = m["id"] as? Int else { return }
            paused = false
            resumeID = id
            restartCapture(displayID)
        case "state": pill?.say(m["text"] as? String ?? "")
        case "quit": finish(by: "sidecar")
        default: break
        }
    }

    func point(_ m: [String: Any]) -> CGPoint {
        let f = displayFrame, x = min(1, max(0, (m["x"] as? Double) ?? 0)), y = min(1, max(0, (m["y"] as? Double) ?? 0))
        return CGPoint(x: f.minX + x * f.width, y: f.minY + y * f.height)
    }

    func target(at point: CGPoint?, buttons: Bool) -> ([String: Any], Hit.Target?) {
        var identity: Hit.Target?
        let record: (AXUIElement, AXUIElement, [Hit.LabelledElement]) -> Void = { [self] control, window, related in
            identity = Hit.Target(control, window: window, related: related, screen: displayID, point: point)
        }
        let event = point.map { Hit.at($0, target: record) } ?? Hit.focus(buttons: buttons, target: record)
        return (event, identity)
    }

    func readTarget(_ m: [String: Any], point: CGPoint?, buttons: Bool) {
        guard let id = m["id"] as? Int else { return }
        let (event, identity) = target(at: point, buttons: buttons)
        if point == nil { invalidateFocusApprovals(for: identity?.control.element) }
        let now = continuousClock.now
        var proved = false
        if let identity, inputDisplayMatches(shieldsGen), !Hit.locked() {
            if let verify = m["verify"] as? Int {
                if var original = approvals.removeValue(forKey: verify), !original.verified,
                   now < original.expires, original.point == point, original.buttons == buttons,
                   original.target.matches(identity) {
                    original.verified = true
                    approvals[verify] = original
                    proved = true
                }
            } else {
                approvals = approvals.filter { now < $0.value.expires }
                if approvals.count >= 64, let oldest = approvals.keys.min() { approvals.removeValue(forKey: oldest) }
                approvals[id] = Approval(target: identity, point: point, buttons: buttons, expires: now.advanced(by: .seconds(approvalMs / 1_000)))
                proved = true
            }
        }
        if !proved, let verify = m["verify"] as? Int { approvals.removeValue(forKey: verify) }
        Out.event(["ev": "hit", "id": id, "proved": proved].merging(event) { a, _ in a })
    }

    func displays() -> [[String: Any]] {
        var ids = [CGDirectDisplayID](repeating: 0, count: 16), n: UInt32 = 0
        CGGetActiveDisplayList(16, &ids, &n)
        return ids.prefix(Int(n)).map { id in
            let b = CGDisplayBounds(id)
            let name = NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id }?.localizedName ?? "Display"
            return ["id": Int(id), "name": name, "x": b.minX, "y": b.minY, "w": b.width, "h": b.height, "main": id == CGMainDisplayID()]
        }
    }

    func start(_ m: [String: Any]) {
        guard !started else { return }
        leaseMs = m["leaseMs"] as? Double ?? 0
        approvalMs = m["approvalMs"] as? Double ?? 0
        setLease(m["until"] as? Double ?? 0)
        guard leaseActive() else { return }
        started = true
        cap.maxLong = (m["maxLong"] as? Int) ?? 1920
        if let id = m["display"] as? Int { displayID = CGDirectDisplayID(id) }
        // The pill first: it is on screen before any frame is read (T-D1-5).
        let p = Pill { [weak self] in self?.finish(by: "pill") }
        p.show()
        pill = p
        Out.event(["ev": "pill", "at": clock()])
        IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), "Hydra Phone View" as CFString, &wake)
        cap.exclude = [p.windowID]
        cap.onFrame = { [weak self] img, rects in self?.arrived(img, rects) }
        cap.onStop = { [weak self] why in Out.event(["ev": "error", "why": String(why.prefix(200))]); self?.finish(by: "capture") }
        pollWindows()
        Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            if let self, self.leaseActive() { self.pollWindows() }
        }
        Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            if let self, self.leaseActive() { self.pollFocus() }
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in self?.pollWindows() }
        // Displays added, removed, moved or scaled: the sidecar gets the list again (its shields and the input points use it).
        CGDisplayRegisterReconfigurationCallback({ _, flags, info in
            guard !flags.contains(.beginConfigurationFlag), let info else { return }
            let me = Unmanaged<Remote>.fromOpaque(info).takeUnretainedValue()
            DispatchQueue.main.async { me.displaysChanged() }
        }, Unmanaged.passUnretained(self).toOpaque())
        restartCapture(displayID, first: true)
    }

    /// One callback per display and phase: sent once, 300 ms after the last. The window list goes again with it, so
    /// no pixel is encoded until the sidecar has shields for the new layout (it reads the displays first).
    func displaysChanged() {
        approvals.removeAll()
        if !paused, let expected = captureCheck,
           CGDisplayIsActive(displayID) == 0 || expected.bounds != displayFrame {
            restartCapture(displayID)
            return
        }
        displaysItem?.cancel()
        let w = DispatchWorkItem { [weak self] in
            guard let me = self else { return }
            Out.event(["ev": "displays", "list": me.displays()])
            me.pollWindows(force: true)
        }
        displaysItem = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: w)
    }

    func switchTo(_ id: CGDirectDisplayID) {
        guard id != displayID else { return }
        if paused { displayID = id; return }
        restartCapture(id)
    }

    func resetCapture() {
        approvals.removeAll()
        cancelPress()
        captureRevision += 1; captureCheck = nil; startingCapture = false
        switching = true
        cap.stop()
        credits = 0; pending = nil
        frame = nil; dirty = []; wholeDirty = false; refine = Refine()
    }

    func restartCapture(_ id: CGDirectDisplayID, first: Bool = false) {
        resetCapture()
        displayID = id
        let attempt = captureRevision
        guard CGDisplayIsActive(id) != 0 else { return displayFailed() }
        cap.prepare(displayID: id) { [self] size in
            guard attempt == captureRevision, leaseActive() else { return }
            guard let size, CGDisplayIsActive(id) != 0 else { return displayFailed() }
            if !first { geomGen &+= 1 }
            Out.event(["ev": "displays", "list": displays()])
            var geometry: [String: Any] = ["ev": first ? "ready" : "geom", "gen": Int(geomGen), "display": Int(id), "w": size.width, "h": size.height]
            if let resumeID { geometry["resume"] = resumeID; self.resumeID = nil }
            Out.event(geometry)
            pollWindows(force: true)
            captureCheck = CaptureCheck(display: id, bounds: displayFrame, size: size, shields: windowsGen)
        }
    }

    func startWhenShielded() {
        guard switching, !paused, !startingCapture, let expected = captureCheck,
              shieldsGen == windowsGen, shieldsGen >= expected.shields else { return }
        startingCapture = true
        let attempt = captureRevision, installingShields = shieldsGen
        cap.start(expected) { [self] ok in
            guard attempt == captureRevision, leaseActive() else { return }
            startingCapture = false
            guard ok, displayMatches(expected) else { return displayFailed() }
            if installingShields != windowsGen {
                cap.stop()
                startWhenShielded()
                return
            }
            switching = false; needKey = true
        }
    }

    func displayFailed() {
        Out.event(["ev": "error", "why": "display"])
        finish(by: "display")
    }

    func displayMatches(_ expected: CaptureCheck) -> Bool {
        CGDisplayIsActive(displayID) != 0 &&
            expected.matches(display: cap.display?.displayID, bounds: displayFrame, size: cap.size, shields: shieldsGen)
    }

    func captureReady() -> Bool {
        guard !paused, !switching, let expected = captureCheck else { return false }
        guard displayMatches(expected) else { displayFailed(); return false }
        return shieldsGen == windowsGen && cap.readyForFrames
    }

    func inputDisplayMatches(_ generation: Int?) -> Bool {
        guard !paused, !switching, let expected = captureCheck, generation == windowsGen, shieldsGen == windowsGen else { return false }
        return displayMatches(expected)
    }

    func pollWindows(force: Bool = false) {
        let list = Windows.list(skip: [pill?.windowID ?? -1])
        let key = Windows.key(list)
        guard force || key != windowsKey else { return }
        approvals.removeAll()
        frame = nil; dirty = []; wholeDirty = false; needKey = true
        windowPids = Dictionary(list.compactMap { w in (w["id"] as? Int).flatMap { id in (w["pid"] as? Int).map { (id, $0) } } }) { a, _ in a }
        windowsKey = key
        windowsGen += 1
        windowsAt = clock()
        Out.event(["ev": "windows", "gen": windowsGen, "list": list])
    }

    func pollFocus() {
        let f = Hit.focus(observe: invalidateFocusApprovals)
        let key = Windows.key([f])
        if key != focusKey { focusKey = key; Out.event(["ev": "focus"].merging(f) { a, _ in a }) }
        let l = Hit.locked()
        if l != lockedNow { approvals.removeAll(); lockedNow = l; Out.event(["ev": "locked", "locked": l]) }
    }

    func invalidateFocusApprovals(for current: AXUIElement?) {
        approvals = approvals.filter { _, approval in
            approval.point != nil || current.map { CFEqual(approval.target.control.element, $0) } == true
        }
    }

    func arrived(_ img: CGImage, _ rects: [CGRect]?) {
        guard leaseActive(), captureReady() else { return }
        frame = img
        if let rects { guard !rects.isEmpty else { return }; dirty += rects } else { wholeDirty = true }
        lastChange = clock()
        pump()
    }

    func pump() {
        pumpItem?.cancel(); pumpItem = nil
        guard leaseActive(), captureReady(), !encoding, credits > 0, let p = pending, let img = frame else { return }
        let now = clock()
        let decide = { [self] in Pace.next(now: now, lastSent: lastSent, lastChange: lastChange, windowsGen: windowsGen, shieldsGen: shieldsGen, windowsAt: windowsAt,
                                           wantKey: p.key || needKey, dirty: wholeDirty || !dirty.isEmpty, lastQ: lastQ, refined: !refine.pending) }
        let act = decide()
        // Pixels are about to go: read the window list now, after this frame was captured. A vault window that opened
        // (or a tab that switched to one) since the last 100 ms poll then holds the pixels until it has its shield.
        let sends: Bool = { if case .wait = act { return false }; return act != .black }()
        if sends {
            let g = windowsGen
            pollWindows()
            if windowsGen != g { return }
        }
        let whole = CGRect(x: 0, y: 0, width: img.width, height: img.height)
        var rects = [whole], flags = Patches.key, q = p.q, all = false
        switch act {
        case let .wait(s):
            if s >= 0 { let w = DispatchWorkItem { [weak self] in self?.pump() }; pumpItem = w; DispatchQueue.main.asyncAfter(deadline: .now() + s, execute: w) }
            return
        case .black:
            guard !blacked else { return }
            blacked = true; all = true
        case .key: break
        case .patches:
            if !wholeDirty { rects = Patches.merge(dirty, in: whole); flags = 0 }
        case .refine:
            rects = refine.take(in: whole); q = Pace.refineQ
            flags = Patches.refine | (rects == [whole] ? Patches.key : 0)
        }
        if act != .refine && act != .black { lastQ = q; refine.sent(rects, q: q, in: whole) }
        credits -= 1; pending = credits > 0 ? (p.q, p.scale, false) : nil
        lastSent = now; dirty = []; wholeDirty = false
        if act != .black { needKey = false }
        frameId &+= 1
        let kk = k, id = frameId, gen = geomGen, sh = shieldPixels(shields, k: kk), scale = p.scale
        let capture = captureRevision, appliedShields = shieldsGen
        encoding = true
        let fl = flags
        enc.async { [weak self] in
            let msgs = Patches.paint(img, shields: sh, all: all).flatMap { painted in
                Patches.frame(rects, gen: gen, frame: id, flags: fl) { Patches.jpeg(painted, rect: $0, quality: q, scale: scale) }
            }
            DispatchQueue.main.async {
                guard let me = self, me.leaseActive() else { return }
                let current = me.captureRevision == capture
                if current && !me.paused { me.pollWindows() }
                let allowed = current && me.captureReady() && me.shieldsGen == appliedShields
                if allowed { for m in msgs ?? [] { Out.scr(m) } }
                // Nothing encoded: the credit goes back (the sidecar still waits for this frame) and the next try is whole.
                if current && (!allowed || msgs == nil) { me.credits = min(2, me.credits + 1); me.pending = me.pending ?? (p.q, p.scale, true); me.wholeDirty = true; me.needKey = true }
                me.encoding = false; me.pump()
            }
        }
    }

    func refuse(_ n: Any, _ why: String) { Out.event(["ev": "refused", "n": n, "why": why]) }

    func input(_ m: [String: Any]) {
        // A lease expiring inside a sent key pair must let its balancing release finish before the process exits.
        defer { _ = leaseActive() }
        let n = m["n"] ?? 0, t = m["t"] as? String ?? ""
        let needsTarget = ["key", "text", "click", "down", "up", "scroll"].contains(t)
        // The window list as it is now, not as the last 100 ms poll saw it: a cmd+tab to a password manager just
        // before this key moves the generation, and the key is refused 'changed' until the sidecar has its shields.
        if needsTarget { pollWindows() }
        let approval = (m["proof"] as? Int).flatMap { approvals.removeValue(forKey: $0) }
        if t == "up" && !held { return Out.event(["ev": "done", "n": n]) }
        // Even an unproved release must clear a held press, without delivering a click or drop to a new target.
        var completed = false
        defer { if !completed && (t == "up" || t == "click") { cancelPress() } }
        let generation = m["shieldsGen"] as? Int
        // The window list changed after the sidecar checked this input (or a display switch is under way): its
        // shields may be stale.
        if !inputDisplayMatches(generation) { return refuse(n, "changed") }
        if Hit.locked() { return refuse(n, "locked") }
        let p = point(m)
        let pointTarget: CGPoint? = t == "key" || t == "text" ? nil : p
        let approved = (m["approved"] as? Bool) == true
        if needsTarget {
            guard let approval, approval.verified == approved, approval.point == pointTarget else { return refuse(n, "changed") }
        }
        // What is under a click or a press, read once for the checks below.
        let h: [String: Any]? = (t == "click" || t == "down" || t == "up") ? Hit.at(p) : nil
        if t == "up" && (h?["secure"] as? Bool) == true { return refuse(n, "credential") }
        let pasteItem = h.map { ($0["paste"] as? Bool) == true || (($0["labels"] as? [String]) ?? []).contains(where: Hit.pasteLabel) } ?? false
        // A password manager's fill item (a browser extension's context menu) fills the page's login wherever focus is.
        if let h, Hit.pmFill(labels: (h["labels"] as? [String]) ?? [], roles: (h["roles"] as? [String]) ?? []) { return refuse(n, "credential") }
        // Backstop for the sidecar's rule: never text, a paste (any cmd+v chord, or the Paste menu item) or a typed key
        // into a secure field or under secure input.
        if t == "text" || t == "key" || t == "click" || t == "down" {
            let f = Hit.focus()
            let secret = (f["secure"] as? Bool) == true || (f["secureInput"] as? Bool) == true || Hit.credential(f["label"] as? String ?? "")
            if secret && (t == "text" || t == "key") && Input.typing(t, (m["k"] as? String ?? "").lowercased()) { return refuse(n, "credential") }
            if secret && t == "key" && Input.autofill(m["k"] as? String ?? "") { return refuse(n, "credential") }
            if t == "key" && Input.fillChord(m["k"] as? String ?? "") { return refuse(n, "credential") }
            // Key focus in a password app's window (its Quick Access panel) while another app is front.
            if (t == "text" || t == "key") && Hit.focusExcluded(f["pid"] as? Int, exclude: cap.exclude, pids: windowPids) { return refuse(n, "secret") }
            if secret, let h, pasteItem || Hit.keyboard(h["app"] as? String ?? "") { return refuse(n, "credential") }
        }
        // A concealed clipboard (a password manager's Copy) is never pasted from the phone: a cmd+v chord, or a click
        // on a Paste menu item, anywhere.
        if t == "key" || t == "click" || t == "down", Hit.clipboardSecret() {
            if t == "key" ? Input.pastes(m["k"] as? String ?? "") : pasteItem { return refuse(n, "credential") }
        }
        // The card rule's backstop (card.swift): the field's own value after this edit, or a paste's clipboard text,
        // holds no card number it did not hold.
        var pasted: String? = nil
        if t == "text" || t == "key" || pasteItem {
            let k = m["k"] as? String ?? ""
            let clip = (t == "key" && Input.pastes(k)) || pasteItem ? Card.clipboard() : nil
            if Card.refuses(t: t, key: k, text: m["s"] as? String ?? "", paste: clip, field: Card.field(), tail: m["tail"] as? String ?? "", moved: m["moved"] as? Bool ?? false) { return refuse(n, "card") }
            pasted = clip.map(Card.digitString)
        }
        if ["click", "down"].contains(t), pill?.quartzFrame.contains(p) == true { return Out.event(["ev": "done", "n": n, "dropped": true]) }
        guard let steps = Input.plan(m, frame: displayFrame, held: held) else { return refuse(n, "changed") }
        let permit = { [self] in
            guard leaseValid() else { return false }
            if needsTarget { pollWindows() }
            guard inputDisplayMatches(generation), !Hit.locked() else { return false }
            guard let approval else { return !needsTarget }
            let (_, current) = target(at: pointTarget, buttons: approval.buttons)
            guard let current, approval.target.matches(current), continuousClock.now < approval.expires else { return false }
            if t == "up", !dragged, heldTarget?.matches(current) != true { return false }
            if pointTarget == nil && NSWorkspace.shared.frontmostApplication?.processIdentifier != current.pid { return false }
            return inputDisplayMatches(generation) && !Hit.locked() && leaseValid()
        }
        // A single left click on a focused app's native button can invoke the exact verified element.
        // Other pointer gestures keep normal dispatch but re-read the hit after every hover/down delay.
        var partial = false, postedChars = 0
        if t == "click", !held, (m["b"] as? String) == "l", (m["c"] as? Int) == 1,
           let control = approval?.target.control, control.role == "AXButton",
           NSWorkspace.shared.frontmostApplication?.processIdentifier == approval?.target.pid,
           Hit.canPress(control.element) {
            guard permit(), AXUIElementPerformAction(control.element, kAXPressAction as CFString) == .success else { return refuse(n, "changed") }
        } else {
            let keyboardPID = pointTarget == nil ? approval?.target.pid : nil
            let result = Input.post(steps, pid: keyboardPID, permit: { _ in permit() }, keyboardCleanup: {
                guard let target = approval?.target, keyboardPID == target.pid,
                      NSRunningApplication(processIdentifier: target.pid)?.launchDate == target.launched,
                      let window = Hit.attr(AXUIElementCreateApplication(target.pid), kAXFocusedWindowAttribute) else { return false }
                return CFEqual(window, target.window.element)
            }, emitted: { [self] step in
                if case let .text(text) = step { postedChars += text.unicodeScalars.count }
                guard case let .mouse(kind, _, button, _) = step else { return }
                if kind == .leftMouseDown || kind == .rightMouseDown {
                    held = true; heldButton = button
                    heldTarget = approval?.target
                    dragged = false
                } else if kind == .leftMouseUp || kind == .rightMouseUp {
                    held = false; heldTarget = nil; dragged = false
                } else if kind == .leftMouseDragged { dragged = true }
            })
            if result == .refused { return refuse(n, "changed") }
            partial = result == .partial
        }
        completed = true
        var done: [String: Any] = ["ev": "done", "n": n]
        if partial {
            done["partial"] = true
            if t == "text" { done["postedChars"] = postedChars }
        }
        if let pasted { done["pasted"] = pasted }
        Out.event(done)
    }

    func cancelPress() {
        guard held else { return }
        held = false; dragged = false
        // Balance the event in the original process, at a point outside the desktop and every control.
        if let target = heldTarget, NSRunningApplication(processIdentifier: target.pid)?.launchDate == target.launched {
            Input.release(at: CGPoint(x: -1_000_000, y: -1_000_000), button: heldButton, pid: target.pid)
        }
        heldTarget = nil
    }

    func finish(by: String) {
        guard !finishing else { return }
        finishing = true
        leaseWatchdog?.invalidate()
        cancelPress()
        cap.stop()
        pill?.hide()
        if wake != 0 { IOPMAssertionRelease(wake); wake = 0 }
        Out.event(["ev": "end", "by": by])
        Out.flush()
        exit(0)
    }
}

enum SelfTest {
    static var failed = 0
    static func check(_ ok: Bool, _ what: String) { if !ok { failed += 1; FileHandle.standardError.write("FAIL \(what)\n".data(using: .utf8)!) } }

    static func image(_ w: Int, _ h: Int, rgb: (CGFloat, CGFloat, CGFloat)) -> CGImage {
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.setFillColor(CGColor(red: rgb.0, green: rgb.1, blue: rgb.2, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage()!
    }
    /// RGBA bytes of a decoded JPEG, top row first.
    static func pixels(_ jpeg: Data) -> (Int, Int, [UInt8])? {
        guard let s = CGImageSourceCreateWithData(jpeg as CFData, nil), let img = CGImageSourceCreateImageAtIndex(s, 0, nil) else { return nil }
        var buf = [UInt8](repeating: 0, count: img.width * img.height * 4)
        let ctx = CGContext(data: &buf, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: img.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
        return (img.width, img.height, buf)
    }

    static func run() -> Bool {
        // Patches: at most 12, every changed rect covered, inside the frame.
        let bounds = CGRect(x: 0, y: 0, width: 1920, height: 1080)
        var seed: UInt64 = 7
        func rnd(_ n: Int) -> CGFloat { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return CGFloat(Int(seed >> 33) % n) }
        for count in [1, 5, 13, 40, 90] {
            let input = (0 ..< count).map { _ in CGRect(x: rnd(1900), y: rnd(1060), width: 1 + rnd(300), height: 1 + rnd(200)) }
            let out = Patches.merge(input, in: bounds)
            check(out.count <= 12 && !out.isEmpty, "merge \(count) gives 1 to 12 patches (\(out.count))")
            check(input.allSatisfy { r in let c = r.integral.intersection(bounds); return out.contains { $0.contains(c) } }, "merge \(count) covers every rect")
            check(out.allSatisfy { bounds.contains($0) }, "merge \(count) stays in the frame")
        }
        check(Patches.merge([CGRect(x: 0, y: 0, width: 10, height: 10), CGRect(x: 5, y: 5, width: 10, height: 10)], in: bounds).count == 1, "overlapping rects join")
        // Header bytes (section 5), big-endian.
        let h = Patches.header(gen: 3, flags: 6, frame: 0x0102_0304, rect: CGRect(x: 10, y: 20, width: 300, height: 400))
        check([UInt8](h) == [1, 3, 0, 6, 1, 2, 3, 4, 0, 10, 0, 20, 1, 44, 1, 144], "header bytes")
        // Chunks: 48,000 bytes of JPEG at most; only the last carries lastChunk, and lastPatch when asked.
        let msgs = Patches.messages(Data(count: 100_000), gen: 0, frame: 9, rect: bounds, flags: Patches.lastPatch | Patches.key)
        check(msgs.map(\.count) == [48_016, 48_016, 4_016], "chunk sizes")
        let fl = msgs.map { UInt16($0[2]) << 8 | UInt16($0[3]) }
        check(fl == [Patches.key, Patches.key, Patches.key | Patches.lastChunk | Patches.lastPatch], "chunk flags \(fl)")
        check(Patches.messages(Data(count: 10), gen: 0, frame: 1, rect: bounds, flags: 0).count == 1, "a small patch is one message")
        // Blackout in the pixels before encode: a "vault window" in a marker green on a white screen; the shield
        // covers it. No pixel anywhere in the sent JPEG may read as that green (edges blur to grey, never to green).
        let marker = image(400, 300, rgb: (1, 1, 1)), shield = CGRect(x: 100, y: 50, width: 120, height: 80)
        let vault: CGImage = {
            let c = CGContext(data: nil, width: 400, height: 300, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
            c.draw(marker, in: CGRect(x: 0, y: 0, width: 400, height: 300))
            c.setFillColor(CGColor(red: 0, green: 1, blue: 0, alpha: 1))
            c.fill(CGRect(x: shield.minX, y: 300 - shield.maxY, width: shield.width, height: shield.height))
            return c.makeImage()!
        }()
        let green = { (px: [UInt8], i: Int) in Int(px[i + 1]) > Int(px[i]) + 40 && Int(px[i + 1]) > Int(px[i + 2]) + 40 }
        if let raw = Patches.jpeg(vault, rect: CGRect(x: 0, y: 0, width: 400, height: 300), quality: 0.6, scale: 1), let (_, _, px) = pixels(raw) {
            check(green(px, ((90) * 400 + 160) * 4), "the fixture shows its marker unshielded")
        }
        for (q, scale) in [(0.6, 1.0), (0.3, 0.5), (0.85, 1.0)] {
            guard let painted = Patches.paint(vault, shields: [shield]), let j = Patches.jpeg(painted, rect: CGRect(x: 0, y: 0, width: 400, height: 300), quality: q, scale: scale),
                  let (w, hh, px) = pixels(j) else { check(false, "encode q\(q)"); continue }
            let leaked = stride(from: 0, to: px.count, by: 4).filter { green(px, $0) }.count
            check(leaked == 0 && hh == Int((300 * scale).rounded()), "shield is black at q\(q) scale \(scale) (\(leaked) marker pixels)")
            let o = (10 * w + 10) * 4, c = (Int(90 * scale) * w + Int(160 * scale)) * 4
            check(px[o] > 200 && px[o + 1] > 200 && px[o + 2] > 200, "outside the shield stays as it was")
            check(px[c] < 30 && px[c + 1] < 30 && px[c + 2] < 30, "inside the shield is black")
        }
        // A patch that cuts through a shield: its part of the shield is black too.
        if let painted = Patches.paint(vault, shields: [shield]), let j = Patches.jpeg(painted, rect: CGRect(x: 150, y: 0, width: 100, height: 100), quality: 0.6, scale: 1), let (w, _, px) = pixels(j) {
            check(px[(70 * w + 30) * 4] < 40, "a patch's share of a shield is black")
        } else { check(false, "patch through a shield") }
        if let all = Patches.paint(marker, shields: [], all: true), let j = Patches.jpeg(all, rect: CGRect(x: 0, y: 0, width: 400, height: 300), quality: 0.6, scale: 1), let (_, _, px) = pixels(j) {
            check(stride(from: 0, to: px.count, by: 4).allSatisfy { px[$0] < 30 && px[$0 + 2] < 30 }, "all black is all black")
        } else { check(false, "all black") }
        // Pacing.
        func pace(_ now: Double, lastSent: Double = 0, lastChange: Double = 0, wg: Int = 1, sg: Int = 1, wAt: Double = 0, key: Bool = false, dirty: Bool = false, q: Double = 0.6, refined: Bool = false) -> Pace.Act {
            Pace.next(now: now, lastSent: lastSent, lastChange: lastChange, windowsGen: wg, shieldsGen: sg, windowsAt: wAt, wantKey: key, dirty: dirty, lastQ: q, refined: refined)
        }
        if case let .wait(s) = pace(10.03, lastSent: 10, dirty: true) { check(abs(s - 0.036) < 0.001, "15 fps cap waits out the 66 ms") } else { check(false, "15 fps cap") }
        check(pace(10.07, lastSent: 10, dirty: true) == .patches, "after 66 ms the patches go")
        if case .wait = pace(10.5, lastSent: 10, wg: 2, sg: 1, wAt: 10, dirty: true) {} else { check(false, "no pixels before shields") }
        check(pace(11.01, lastSent: 10, wg: 2, sg: 1, wAt: 10, dirty: true) == .black, "black after 1 s with no shields")
        check(pace(11, lastSent: 10, key: true) == .key, "a key frame when asked")
        check(pace(11, lastSent: 10.9, lastChange: 10.5) == .refine, "refine after 400 ms still")
        if case .wait = pace(11, lastSent: 10.9, lastChange: 10.8) {} else { check(false, "no refine before 400 ms") }
        check(pace(11, lastSent: 10.9, lastChange: 10, refined: true) == .wait(-1), "one refine only")
        check(pace(11, lastSent: 10.9, lastChange: 10, q: 0.85) == .wait(-1), "no refine of a fine frame")
        // Typed text in whole characters (CU-16): an emoji at position 16 is not split.
        for s in ["abcdefghijklmno😀p", "abcdefghijklmnop😀", "🇨🇦🇨🇦🇨🇦🇨🇦🇨🇦x", String(repeating: "é", count: 40)] {
            let c = Input.chunks(s)
            check(c.joined() == s && c.allSatisfy { $0.utf16.count <= 16 && $0.unicodeScalars.count > 0 && !(UTF16.isLeadSurrogate($0.utf16.last!)) }, "chunks keep \(s) whole")
        }
        // Input mapping: 0 to 1 of the viewed display, in global points.
        let f = CGRect(x: 100, y: 0, width: 1000, height: 800)
        let click = Input.plan(["t": "click", "x": 0.5, "y": 0.5, "b": "l", "c": 1], frame: f, held: false) ?? []
        check(click == [.mouse(.mouseMoved, CGPoint(x: 600, y: 400), .left, 0), .mouse(.leftMouseDown, CGPoint(x: 600, y: 400), .left, 1), .mouse(.leftMouseUp, CGPoint(x: 600, y: 400), .left, 1)], "tap is a left click at the point")
        for race in ["target", "lease", "display"] {
            var target = 1, display = 1, time = 0, delivered: [Input.Step] = []
            let finished = Input.dispatch(click, permit: { _ in target == 1 && display == 1 && time < 1 }) { step in
                delivered.append(step)
                if race == "target" { target = 2 }
                if race == "lease" { time = 1 }
                if race == "display" { display = 2 }
                return true
            }
            check(!finished && delivered == Array(click.prefix(1)), "\(race) changing after hover blocks the press and release")
        }
        for sameWindow in [true, false] {
            var events: [Bool] = []
            let result = Input.keyboardPair(emit: { events.append($0); return true }, current: { false }, canRelease: { sameWindow })
            check(result == .partial && events == (sameWindow ? [true, false] : [true]), "balance a sent key only in its original window")
        }
        var triedRelease = false
        check(Input.keyboardPair(emit: { _ in false }, current: { false }, canRelease: { triedRelease = true; return true }) == .refused && !triedRelease,
              "a key-down that was never sent needs no release")
        let capture = CaptureCheck(display: 1, bounds: f, size: f.size, shields: 5)
        check(capture.matches(display: 1, bounds: f, size: f.size, shields: 5), "capture matches the exact display and current shield mapping")
        check(!capture.matches(display: 2, bounds: f, size: f.size, shields: 5), "capture rejects a fallback display of the same size")
        check(!capture.matches(display: 1, bounds: f.offsetBy(dx: 1, dy: 0), size: f.size, shields: 5), "capture rejects a moved display")
        check(!capture.matches(display: 1, bounds: f, size: f.size, shields: 4), "capture rejects stale shields")
        let dbl = Input.plan(["t": "click", "x": 0.0, "y": 1.0, "b": "l", "c": 2], frame: f, held: false) ?? []
        // The phone's first tap already went as c:1, so c:2 is only the count-2 click (not 1 + 2 = three clicks).
        check(dbl == [.mouse(.mouseMoved, CGPoint(x: 100, y: 800), .left, 0), .mouse(.leftMouseDown, CGPoint(x: 100, y: 800), .left, 2), .mouse(.leftMouseUp, CGPoint(x: 100, y: 800), .left, 2)], "a double tap's second click is one count-2 click")
        // Typing, for the secure-field backstop: a paste is any chord of cmd and v, whatever else is held.
        for k in ["cmd+v", "shift+cmd+v", "cmd+shift+v", "cmd+opt+shift+v", "ctrl+cmd+v"] { check(Input.typing("key", k), "\(k) pastes") }
        check(Input.typing("text", "") && Input.typing("key", "a") && Input.typing("key", "shift+a"), "text and plain keys type")
        check(!Input.typing("key", "tab") && !Input.typing("key", "cmd+c") && !Input.typing("key", "return"), "tab, a copy and return do not type")
        // Refine: only what went out below 0.85 since the last refine, never the whole frame for a blinking caret.
        var rf = Refine()
        rf.sent([CGRect(x: 0, y: 0, width: 1920, height: 1080)], q: 0.6, in: bounds)
        check(rf.take(in: bounds) == [bounds], "a key frame at 0.6 is refined whole")
        check(rf.take(in: bounds).isEmpty && !rf.pending, "once")
        let caret = CGRect(x: 400, y: 300, width: 2, height: 18)
        rf.sent([caret], q: 0.6, in: bounds)
        check(rf.pending && rf.take(in: bounds) == [caret], "a caret blink refines the caret only")
        rf.sent([caret], q: 0.85, in: bounds)
        check(!rf.pending, "a patch sent fine needs no refine")
        // A frame whose last patch fails still ends with lastPatch (the phone acks it); none encoding gives nil.
        let three = [CGRect(x: 0, y: 0, width: 10, height: 10), CGRect(x: 20, y: 0, width: 10, height: 10), CGRect(x: 40, y: 0, width: 10, height: 10)]
        let fr = Patches.frame(three, gen: 1, frame: 5, flags: 0) { r in r.minX == 40 ? nil : Data(count: 8) } ?? []
        let ff = fr.map { UInt16($0[2]) << 8 | UInt16($0[3]) }
        check(fr.count == 2 && ff.last.map { $0 & Patches.lastPatch != 0 } == true && ff.first.map { $0 & Patches.lastPatch == 0 } == true, "the last patch that encodes ends the frame (\(ff))")
        check(Patches.frame(three, gen: 1, frame: 5, flags: 0) { _ in nil } == nil, "no patch: no frame (the credit goes back)")
        let right = Input.plan(["t": "click", "x": 0.25, "y": 0.25, "b": "r", "c": 1], frame: f, held: false) ?? []
        check(right.count == 3 && right[1] == .mouse(.rightMouseDown, CGPoint(x: 350, y: 200), .right, 1), "hold is a right click")
        check(Input.plan(["t": "move", "x": 0.1, "y": 0.1], frame: f, held: true) == [.mouse(.leftMouseDragged, CGPoint(x: 200, y: 80), .left, 1)], "a move while held drags")
        check(Input.plan(["t": "scroll", "x": 0.5, "y": 0.5, "dx": 0.0, "dy": -300.0], frame: f, held: false)?.last == .scroll(CGPoint(x: 600, y: 400), -300, 0), "scroll at a point, in pixels")
        check(Input.plan(["t": "key", "k": "cmd+shift+z"], frame: f, held: false) == [.key(6, [.maskCommand, .maskShift])], "a key carries all its modifiers")
        check(Input.plan(["t": "key", "k": "cmd+nope"], frame: f, held: false) == nil, "an unknown key is not pressed")
        check(Input.plan(["t": "text", "s": String(repeating: "a", count: 500)], frame: f, held: false)?.count == 13, "text is capped at 200 characters")
        check(Input.plan(["t": "click", "x": 7.0, "y": -3.0, "c": 1], frame: f, held: false)?.first == .mouse(.mouseMoved, CGPoint(x: 1100, y: 0), .left, 0), "points stay on the display")
        // Shields stay in display points and become frame pixels at paint time (k = 2 on a Retina capture).
        check(shieldPixels([CGRect(x: 100, y: 100, width: 600, height: 400)], k: 2) == [CGRect(x: 200, y: 200, width: 1200, height: 800)], "shields in points scale at paint time")
        // A front app with only a floating panel (layer 3): that panel is the front window.
        var wl: [[String: Any]] = [["id": 1, "pid": 5, "layer": 0], ["id": 2, "pid": 9, "layer": 3]]
        Windows.markFront(&wl, pid: 9)
        check(wl[1]["front"] as? Bool == true && wl[0]["front"] == nil, "a floating panel of the front app is the front window")
        // The secure-field backstop: credential labels and Paste in other languages.
        check(Hit.credential("CVC") && Hit.credential("One-time code") && Hit.credential("Contraseña") && !Hit.credential("Name on card"), "credential labels")
        check(["Recovery code", "Backup code", "Seed phrase", "Recovery phrase", "Security answer", "Enter the 6-digit code", "Social Security number", "MM / YY", "Passkey"].allSatisfy(Hit.credential), "A3's credential labels")
        check(Hit.credential("Expiry date") && Hit.credential("Kartennummer") && !Hit.credential("Search"), "A3's card expiry (cardForm) and other languages")
        check(["Enter your PIN", "Transaction PIN", "API token", "Bot token", "Personal token", "Webhook secret", "Shared secret", "API secret", "Security question", "Digit code"].allSatisfy(Hit.credential) && !Hit.credential("Pin title") && !Hit.credential("Token name"), "release review: PINs, tokens and secrets")
        check(Input.autofill("cmd+\\") && Input.autofill("cmd+shift+l") && Input.autofill("ctrl+y") && Input.autofill("down") && !Input.autofill("cmd+l") && !Input.autofill("return"), "password manager fill chords")
        check(Input.fillChord("cmd+\\") && Input.fillChord("ctrl+shift+l") && Input.fillChord("cmd+shift+space") && Input.fillChord("cmd+shift+x") && !Input.fillChord("down") && !Input.fillChord("cmd+l"), "fill chords on every key")
        check(Hit.focusExcluded(90, exclude: [9, 4], pids: [9: 90, 2: 20]) && !Hit.focusExcluded(20, exclude: [9, 4], pids: [9: 90, 2: 20]) && !Hit.focusExcluded(nil, exclude: [9], pids: [9: 90]), "key focus in a password app's window")
        check(Hit.pasteLabel("Paste") && Hit.pasteLabel("Einsetzen") && Hit.pasteLabel("粘贴") && Hit.pasteLabel("Paste and Match Style") && !Hit.pasteLabel("Pasted text"), "paste labels")
        check(Hit.keyboard("AssistiveControl") && !Hit.keyboard("Safari"), "on-screen keyboards")
        // A password manager's Copy marks the clipboard: no paste from the phone then.
        check(Hit.concealed(["public.utf8-plain-text", "org.nspasteboard.ConcealedType"]) && Hit.concealed(["org.nspasteboard.TransientType"]) && !Hit.concealed(["public.utf8-plain-text"]) && !Hit.concealed([]), "a concealed clipboard")
        // The card backstop reads the field's own value: the last digits first, then a tap at the start.
        func sel(_ v: String, _ at: Int, _ len: Int = 0) -> (String, NSRange) { (v, NSRange(location: at, length: len)) }
        check(Card.has("4111 1111 1111 1111") && Card.has("4111a1111a1111a1111") && Card.has("٤١١١ ١١١١ ١١١١ ١١١١") && Card.has("４１１１１１１１１１１１１１１１") && !Card.has("4111 1111 1111 1112") && !Card.has("see you at 10:30 on 2026-11-27"), "card numbers")
        check(["6212345678901232", "2200123456789019", "6759649826438453", "6071234567890120"].allSatisfy(Card.has), "A3's brands: UnionPay, Mir, Maestro, RuPay")
        check(Card.refuses(t: "text", key: "", text: "621234567890", paste: nil, field: sel("1232", 0), tail: "1232", moved: true), "a UnionPay card typed after a cursor move")
        check(Card.refuses(t: "text", key: "", text: "411111111111", paste: nil, field: sel("1111", 0), tail: "1111"), "digits typed before the last four")
        check(!Card.refuses(t: "text", key: "", text: "41111111111", paste: nil, field: sel("1111", 0), tail: ""), "one digit short")
        check(Card.refuses(t: "key", key: "4", text: "", paste: nil, field: sel("111111111111111", 0), tail: ""), "the first digit typed last")
        check(!Card.refuses(t: "key", key: "cmd+4", text: "", paste: nil, field: sel("111111111111111", 0), tail: ""), "a chord types nothing")
        check(Card.refuses(t: "key", key: "fwddelete", text: "", paste: nil, field: sel("42111111111111111", 1), tail: ""), "a forward delete that leaves a card")
        check(Card.refuses(t: "key", key: "ctrl+d", text: "", paste: nil, field: sel("42111111111111111", 1), tail: ""), "ctrl+d too")
        check(Card.refuses(t: "key", key: "alt+delete", text: "", paste: nil, field: sel("4111 1111 1111 221111", 17), tail: ""), "a word delete that joins a card")
        // Release round 2: a card is read the way A3 reads one (grouped, one separator kind), never every digit in the
        // field joined: three phone numbers typed key by key into a note are no card.
        let notes = ["Mom 312-555-0199, Dad 773-555-0123, Work 312 555 0100", "Mom 415-555-0142, Dad 650-555-0187, Work 408 555 0163", "Call 212-555-0188 or 646-555-0110 or 917 555 0134"]
        check(notes.allSatisfy { n in let a = Array(n); return a.indices.allSatisfy { i in !Card.refuses(t: "text", key: "", text: String(a[i]), paste: nil, field: sel(String(a[..<i]), (String(a[..<i]) as NSString).length), tail: "") } }, "phone numbers typed into a note")
        check(!Card.has("4 111111111111111") && !Card.has("312-555-0199, 773-555-0123") && Card.has("4111-1111-1111-1111") && Card.has("3782 822463 10005") && Card.has("4111\u{2060} 1111\u{200d}1111\u{00ad}1111"), "A3's grouped reading")
        check(Card.refuses(t: "key", key: "delete", text: "", paste: nil, field: sel("41111111211111111", 9), tail: ""), "a Delete in the middle")
        check(!Card.refuses(t: "key", key: "delete", text: "", paste: nil, field: sel("hello 1234", 10), tail: ""), "an ordinary Delete")
        check(!Card.refuses(t: "text", key: "", text: "1", paste: nil, field: sel("4111 1111 1111 1111", 19), tail: ""), "a card already there is not this input's")
        check(Card.refuses(t: "key", key: "cmd+v", text: "", paste: "4111 1111 1111 1111", field: sel("", 0), tail: ""), "a pasted card")
        check(Card.refuses(t: "key", key: "cmd+v", text: "", paste: "1111", field: sel("411111111111", 12), tail: ""), "a paste that completes one")
        check(Card.refuses(t: "key", key: "cmd+v", text: "", paste: "1111", field: nil, tail: "411111111111"), "a paste with the tail when the value cannot be read")
        check(!Card.refuses(t: "key", key: "cmd+v", text: "", paste: "see you at 10:30", field: nil, tail: ""), "an ordinary paste")
        check(Card.digitString("ref 4111-1111 ab") == "41111111", "a paste's digits only")
        // After a cursor move the field's own value decides: a date, a time or a phone number and one more digit go.
        check(!Card.refuses(t: "text", key: "", text: "5", paste: nil, field: sel("Meeting 2026-11-27 at 10:30", 8), tail: "Meeting 2026-11-27 at 10:305", moved: true), "a digit in a note with a date and a time")
        check(!Card.refuses(t: "key", key: "0", text: "", paste: nil, field: sel("Invoice 2026-114 due 11/30, total 4,250", 37), tail: "Invoice 2026-114 due 11/30, total 4,2500", moved: true), "a digit after Left in an invoice")
        check(Card.refuses(t: "text", key: "", text: "411111111111", paste: nil, field: sel("1111", 0), tail: "1111411111111111", moved: true), "the field's value still refuses a card")
        // Unreadable: the 13-digit count, once moved; before a move the sidecar's rule had it.
        check(Card.refuses(t: "text", key: "", text: "5", paste: nil, field: nil, tail: "Meeting 2026-11-27 at 10:305", moved: true), "unreadable and moved: 13 digits refuse")
        check(!Card.refuses(t: "text", key: "", text: "5", paste: nil, field: nil, tail: "at 10:305", moved: true), "unreadable and moved: fewer go")
        check(!Card.refuses(t: "text", key: "", text: "a", paste: nil, field: nil, tail: "Meeting 2026-11-27 at 10:30a", moved: true), "unreadable and moved: letters go")
        check(!Card.refuses(t: "text", key: "", text: "5", paste: nil, field: nil, tail: "Meeting 2026-11-27 at 10:305"), "unreadable, not moved: the sidecar's rule")
        // A password manager's fill item, on every click (PM_FILL in remotepolicy.mjs).
        let menu = ["AXMenuItem", "AXMenu"], page = ["AXLink", "AXGroup", "AXWebArea"]
        check(["Autofill", "Auto-fill login", "Fill Username and Password", "Passwords…", "Select a password", "Use Strong Password"].allSatisfy { Hit.pmFill(labels: [$0], roles: page) }
            && ["Bitwarden", "1Password"].allSatisfy { Hit.pmFill(labels: ["github.com", $0], roles: menu) } && Hit.pmFill(labels: ["1Password"], roles: ["AXPopUpButton", "AXGroup", "AXToolbar"])
            && !["Fill", "Copy", "Forgot password?", "Bookkeeper"].contains { Hit.pmFill(labels: [$0], roles: menu) }, "fill items")
        // A manager's bare name off a menu or a toolbar is an ordinary click: a link, a message, a file, a group's title.
        check(!Hit.pmFill(labels: ["Bitwarden review 2026", "", ""], roles: page) && !Hit.pmFill(labels: ["Keychain notes.txt"], roles: ["AXTextField", "AXCell", "AXRow"])
            && !Hit.pmFill(labels: ["Next", "LastPass setup"], roles: ["AXButton", "AXGroup", "AXWebArea"]), "a password manager's name in a page")
        check(["cmd+v", "shift+cmd+v", "cmd+opt+shift+v"].allSatisfy(Input.pastes) && !Input.pastes("v") && !Input.pastes("ctrl+v") && !Input.pastes("cmd+c"), "paste chords")
        check(Input.parseKey("fwddelete")?.0 == 117 && Input.parseKey("forwarddelete")?.0 == 117, "forward delete by both names")
        // The pill: centred, 8 px under the menu bar.
        check(Pill.frame(screen: CGRect(x: 0, y: 0, width: 1512, height: 982), visible: CGRect(x: 0, y: 0, width: 1512, height: 949)) == CGRect(x: 616, y: 913, width: 280, height: 28), "pill frame")
        // The pill can never be hidden (Hide Others, cmd+opt+H from the phone): the Mac always shows it is viewed.
        check(Pill(onEnd: {}).panel.canHide == false, "the pill cannot be hidden")
        FileHandle.standardError.write((failed == 0 ? "remote self-test ok\n" : "remote self-test: \(failed) failed\n").data(using: .utf8)!)
        return failed == 0
    }
}

signal(SIGPIPE, SIG_IGN)
let argv = CommandLine.arguments
if argv.contains("--self-test") { exit(SelfTest.run() ? 0 : 1) }
if argv.contains("--probe") {
    print("{\"screen\":\(CGPreflightScreenCaptureAccess()),\"ax\":\(AXIsProcessTrusted())}")
    exit(0)
}
@available(macOS 14.0, *)
func serve() {
    // A hung app answers no AX call for about 6 s by default, which would freeze the pill's End, quit and input:
    // every AX call here waits 0.25 s at most (as the hands and voice helpers do).
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.25)
    let remote = Remote()
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    Thread.detachNewThread {
        while let line = readLine() { DispatchQueue.main.async { remote.handle(line) } }
        DispatchQueue.main.async { remote.finish(by: "sidecar") } // stdin closed: the sidecar is gone (T-D1-8)
    }
    app.run()
}
if #available(macOS 14.0, *) { serve() } else { Out.event(["ev": "end", "by": "unsupported"]); Out.flush(); exit(2) }
