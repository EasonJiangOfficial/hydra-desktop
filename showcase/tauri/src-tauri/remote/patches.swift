// The pure parts of the phone view's frames (RV plan section 5): dirty rects merged into at most 12 patches, shields
// painted black in the pixels before encode, JPEG with ImageIO, 48,000-byte chunks behind a 16-byte header, and when
// the next frame may go. No screen is read here: the self-test drives every function with made-up images.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum Patches {
    static let chunk = 48_000
    static let maxPatches = 12
    // header flags
    static let lastChunk: UInt16 = 1, lastPatch: UInt16 = 2, key: UInt16 = 4, refine: UInt16 = 8

    /// `u8 ver=1, u8 geomGen, u16 flags, u32 frameId, u16 x, u16 y, u16 w, u16 h`, big-endian (network order, the
    /// default of the phone's DataView).
    static func header(gen: UInt8, flags: UInt16, frame: UInt32, rect: CGRect) -> Data {
        var d = Data([1, gen])
        func u16(_ v: UInt16) { d.append(UInt8(v >> 8)); d.append(UInt8(v & 0xff)) }
        u16(flags)
        for s in [24, 16, 8, 0] { d.append(UInt8((frame >> UInt32(s)) & 0xff)) }
        for v in [rect.minX, rect.minY, rect.width, rect.height] { u16(UInt16(clamping: Int(v.rounded()))) }
        return d
    }

    /// One patch's JPEG as `scr` messages: header + at most 48,000 bytes each; the last one carries `lastChunk`
    /// (and `lastPatch` when it is the frame's last patch).
    static func messages(_ jpeg: Data, gen: UInt8, frame: UInt32, rect: CGRect, flags: UInt16) -> [Data] {
        var out: [Data] = []
        var at = 0
        repeat {
            let end = min(jpeg.count, at + chunk)
            let last = end == jpeg.count
            var f = flags & ~(lastChunk | lastPatch)
            if last { f |= lastChunk | (flags & lastPatch) }
            out.append(header(gen: gen, flags: f, frame: frame, rect: rect) + jpeg.subdata(in: at ..< end))
            at = end
        } while at < jpeg.count
        return out
    }

    /// The changed areas as at most `max` whole-pixel rects inside bounds that cover every input rect. Overlapping or
    /// touching ones join first; then the pair whose union adds the least area, until few enough.
    static func merge(_ rects: [CGRect], in bounds: CGRect, max n: Int = maxPatches) -> [CGRect] {
        var rs = rects.map { $0.integral.intersection(bounds) }.filter { !$0.isNull && $0.width >= 1 && $0.height >= 1 }
        // ponytail: O(n³) pair search; past 64 rects the frame is busy anyway, so one bounding box.
        if rs.count > 64 { return [rs.dropFirst().reduce(rs[0]) { $0.union($1) }] }
        var joined = true
        while joined {
            joined = false
            outer: for i in rs.indices { for j in rs.indices where j > i && rs[i].insetBy(dx: -4, dy: -4).intersects(rs[j]) {
                rs[i] = rs[i].union(rs[j]); rs.remove(at: j); joined = true; break outer
            } }
        }
        while rs.count > n {
            var best = (0, 1, CGFloat.infinity)
            for i in rs.indices { for j in rs.indices where j > i {
                let u = rs[i].union(rs[j]), cost = u.width * u.height - rs[i].width * rs[i].height - rs[j].width * rs[j].height
                if cost < best.2 { best = (i, j, cost) }
            } }
            rs[best.0] = rs[best.0].union(rs[best.1]); rs.remove(at: best.1)
        }
        return rs
    }

    /// The frame with every shield (top-left frame pixels) filled black, or all of it black. A copy: the capture's
    /// own buffer is never written.
    static func paint(_ img: CGImage, shields: [CGRect], all: Bool = false) -> CGImage? {
        let w = img.width, h = img.height
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
        if all { ctx.fill(CGRect(x: 0, y: 0, width: w, height: h)); return ctx.makeImage() }
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        // CG draws bottom-up; shields are top-left. Grown by 1 px so a JPEG block edge never shows a sliver.
        for r in shields { ctx.fill(CGRect(x: r.minX, y: CGFloat(h) - r.maxY, width: r.width, height: r.height).insetBy(dx: -1, dy: -1)) }
        return ctx.makeImage()
    }

    /// One patch of an already painted frame as JPEG, scaled by `scale` (the phone draws it back at the rect's size).
    static func jpeg(_ frame: CGImage, rect: CGRect, quality: Double, scale: Double) -> Data? {
        guard var part = frame.cropping(to: rect) else { return nil }
        if scale < 0.999 {
            let w = max(1, Int((rect.width * scale).rounded())), h = max(1, Int((rect.height * scale).rounded()))
            guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
            ctx.interpolationQuality = .medium
            ctx.draw(part, in: CGRect(x: 0, y: 0, width: w, height: h))
            guard let small = ctx.makeImage() else { return nil }
            part = small
        }
        let data = NSMutableData()
        guard let dst = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dst, part, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(dst) ? data as Data : nil
    }
}

/// What to do when the phone has asked for a frame (`next`). Pure: the helper passes the clock and its state.
enum Pace {
    static let gap = 0.066, refineAfter = 0.4, refineQ = 0.85, blackAfter = 1.0
    enum Act: Equatable { case wait(Double), black, key, patches, refine }
    /// windowsGen > shieldsGen: the window list changed and the sidecar has not said what to hide yet, so no pixels
    /// go; after 1 s the whole frame goes black. Otherwise a key frame when asked, the changed patches, or one refine
    /// pass at 0.85 when the screen has been still 400 ms.
    static func next(now: Double, lastSent: Double, lastChange: Double, windowsGen: Int, shieldsGen: Int, windowsAt: Double,
                     wantKey: Bool, dirty: Bool, lastQ: Double, refined: Bool) -> Act {
        if now - lastSent < gap { return .wait(gap - (now - lastSent)) }
        if windowsGen > shieldsGen { return now - windowsAt >= blackAfter ? .black : .wait(blackAfter - (now - windowsAt)) }
        if wantKey { return .key }
        if dirty { return .patches }
        if !refined && lastQ < refineQ { return now - lastChange >= refineAfter ? .refine : .wait(refineAfter - (now - lastChange)) }
        return .wait(-1) // nothing until the screen changes
    }
}

/// What a refine pass sends again at 0.85: only the areas that went out below it since the last refine (a blinking
/// caret refines the caret, not the whole frame).
struct Refine {
    var rects: [CGRect] = []
    var pending: Bool { !rects.isEmpty }
    mutating func sent(_ rs: [CGRect], q: Double, in bounds: CGRect) {
        guard q < Pace.refineQ else { return }
        rects = Patches.merge(rects + rs, in: bounds)
    }
    mutating func take(in bounds: CGRect) -> [CGRect] { defer { rects = [] }; return Patches.merge(rects, in: bounds) }
}

extension Patches {
    /// One frame's patches as `scr` messages. The last patch that encodes carries lastPatch, so a patch that fails
    /// never leaves the frame without its end (the phone acks only an ended frame). nil: none encoded.
    static func frame(_ rects: [CGRect], gen: UInt8, frame: UInt32, flags: UInt16, jpeg: (CGRect) -> Data?) -> [Data]? {
        let parts = rects.compactMap { r in jpeg(r).map { (r, $0) } }
        guard !parts.isEmpty else { return nil }
        return parts.enumerated().flatMap { i, p in messages(p.1, gen: gen, frame: frame, rect: p.0, flags: flags | (i == parts.count - 1 ? lastPatch : 0)) }
    }
}
