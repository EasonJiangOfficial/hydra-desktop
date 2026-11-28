// The live screen: one SCStream on one display, 15 fps at most, cursor shown, 1 pixel per point, long side capped.
// The filter leaves out the pill and the windows the sidecar names (password apps), by window id. Each complete frame
// is kept as a copy with the rects that changed since the last one sent.
import AppKit
import CoreMedia
import ScreenCaptureKit

struct CaptureCheck {
    let display: CGDirectDisplayID
    let bounds: CGRect
    let size: CGSize
    let shields: Int

    func matches(display actual: CGDirectDisplayID?, bounds actualBounds: CGRect, size actualSize: CGSize, shields current: Int) -> Bool {
        actual == display && actualBounds == bounds && actualSize == size && current >= shields
    }
}

@available(macOS 14.0, *)
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    var stream: SCStream?
    var display: SCDisplay?
    var size = CGSize.zero          // frame pixels
    var exclude: Set<Int> = []
    var maxLong = 1920
    /// On the main queue: (frame, changed rects in frame pixels). Rects nil: the whole frame changed.
    var onFrame: ((CGImage, [CGRect]?) -> Void)?
    var onStop: ((String) -> Void)?
    private var revision = 0
    private var updatingFilter = false
    private var framesAfter: UInt64?
    var readyForFrames: Bool { framesAfter != nil }
    private let q = DispatchQueue(label: "remote.capture")

    static func content(_ done: @escaping (SCShareableContent?) -> Void) {
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { c, _ in DispatchQueue.main.async { done(c) } }
    }

    static func frameSize(_ d: SCDisplay, maxLong: Int) -> CGSize {
        var w = Double(d.width), h = Double(d.height)
        if max(w, h) > Double(maxLong) { let k = Double(maxLong) / max(w, h); w *= k; h *= k }
        return CGSize(width: w.rounded(), height: h.rounded())
    }

    func prepare(displayID: CGDirectDisplayID, done: @escaping (CGSize?) -> Void) {
        Capture.content { [self] c in
            let display = c?.displays.first { $0.displayID == displayID }
            done(display.map { Capture.frameSize($0, maxLong: maxLong) })
        }
    }

    func start(_ expected: CaptureCheck, done: @escaping (Bool) -> Void) {
        let attempt = revision
        Capture.content { [self] c in
            guard attempt == revision else { return }
            guard let c, let d = c.displays.first(where: { $0.displayID == expected.display }),
                  CGDisplayIsActive(d.displayID) != 0,
                  expected.matches(display: d.displayID, bounds: CGDisplayBounds(d.displayID),
                                   size: Capture.frameSize(d, maxLong: maxLong), shields: expected.shields) else { return done(false) }
            display = d
            size = Capture.frameSize(d, maxLong: maxLong)
            let cfg = SCStreamConfiguration()
            cfg.width = Int(size.width); cfg.height = Int(size.height)
            cfg.minimumFrameInterval = CMTime(value: 1, timescale: 15)
            cfg.showsCursor = true
            cfg.pixelFormat = kCVPixelFormatType_32BGRA
            cfg.queueDepth = 3
            let s = SCStream(filter: filter(c, d), configuration: cfg, delegate: self)
            do { try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: q) } catch { return done(false) }
            stream = s
            s.startCapture { [weak self] err in
                DispatchQueue.main.async {
                    guard let self, self.stream === s, self.revision == attempt else { return }
                    if err == nil && !self.updatingFilter { self.framesAfter = mach_absolute_time() }
                    done(err == nil)
                }
            }
        }
    }

    func filter(_ c: SCShareableContent, _ d: SCDisplay) -> SCContentFilter {
        SCContentFilter(display: d, excludingWindows: c.windows.filter { exclude.contains(Int($0.windowID)) })
    }

    /// New windows to leave out (the pill, password apps): the filter is swapped on the running stream.
    func setExclude(_ ids: Set<Int>) {
        guard ids != exclude else { return }
        exclude = ids
        framesAfter = nil
        updateFilter()
    }

    private func updateFilter() {
        guard !updatingFilter else { return }
        guard let s = stream, let d = display else { return }
        updatingFilter = true
        Capture.content { [self] c in
            guard stream === s else { return }
            guard let c else { onStop?("filter"); return }
            let request = exclude
            s.updateContentFilter(filter(c, d)) { [weak self] err in
                DispatchQueue.main.async {
                    guard let self, self.stream === s else { return }
                    self.updatingFilter = false
                    if err != nil { self.onStop?("filter"); return }
                    if self.exclude == request { self.framesAfter = mach_absolute_time() }
                    else { self.updateFilter() }
                }
            }
        }
    }

    func stop() {
        revision += 1; framesAfter = nil; updatingFilter = false
        stream?.stopCapture { _ in }
        stream = nil
        display = nil
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async { if self.stream === stream { self.onStop?(error.localizedDescription) } }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sb.isValid,
              let att = (CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
              let raw = att[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
              let displayed = att[.displayTime] as? UInt64,
              let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        let dirty = (att[.dirtyRects] as? [NSDictionary])?.compactMap { CGRect(dictionaryRepresentation: $0) }
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb), width: CVPixelBufferGetWidth(pb), height: CVPixelBufferGetHeight(pb),
                                  bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
              let img = ctx.makeImage() else { return }
        DispatchQueue.main.async {
            guard self.stream === stream, let framesAfter = self.framesAfter, displayed >= framesAfter else { return }
            self.onFrame?(img, dirty)
        }
    }
}
