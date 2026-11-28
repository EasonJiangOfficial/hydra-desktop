import AVFoundation
import Foundation
import SoundAnalysis

/// The mono audio around a temporal candidate. Keep only enough to cover the pair and the detector's quiet tail.
struct ClapCandidateAudio {
    static let duration = 0.5
    private let rate: Double
    private var ring: [Float]
    private var end = 0

    init(rate: Double) {
        self.rate = rate
        let gap = ClapDetector.maxGap
        let retention = gap + ClapDetector.quietAfter(gap: gap) + Self.duration / 2 + 0.12
        ring = [Float](repeating: 0, count: Int((retention * rate).rounded(.up)))
    }

    mutating func append(_ samples: UnsafePointer<Float>, count: Int) {
        let retained = min(ring.count, count)
        let start = (end + count - retained) % ring.count
        let first = min(retained, ring.count - start)
        let source = samples + count - retained
        ring.withUnsafeMutableBufferPointer { ring in
            ring.baseAddress!.advanced(by: start).update(from: source, count: first)
            ring.baseAddress!.update(from: source + first, count: retained - first)
        }
        end += count
    }

    func window(center: Double) -> [Float]? {
        let length = Int((Self.duration * rate).rounded())
        let start = Int(((center - Self.duration / 2) * rate).rounded())
        let at = max(0, start)
        guard at >= end - ring.count, start + length <= end else { return nil }
        let index = at % ring.count
        let count = start + length - at
        let beforeWrap = min(count, ring.count - index)
        var audio = [Float](repeating: 0, count: at - start)
        audio.reserveCapacity(length)
        audio.append(contentsOf: ring[index ..< index + beforeWrap])
        audio.append(contentsOf: ring.prefix(count - beforeWrap))
        return audio
    }
}

/// SoundAnalysis v1 confirms a window centered on each of the two detector peaks.
/// Create and use this on one worker queue. No classifier work runs on the mic tap or the main queue.
final class AppleClapClassifier {
    static let label = "clapping"
    static let minimumConfidence = 0.02
    static let timeout = 0.5

    enum Failure: LocalizedError {
        case unavailable, missingLabel, unsupportedWindow, noResult, timeout

        var errorDescription: String? {
            switch self {
            case .unavailable: return "SoundAnalysis v1 requires macOS 12 or later"
            case .missingLabel: return "SoundAnalysis v1 has no clapping label"
            case .unsupportedWindow: return "SoundAnalysis v1 did not accept the clap analysis window"
            case .noResult: return "SoundAnalysis v1 returned no clap analysis window"
            case .timeout: return "SoundAnalysis v1 timed out"
            }
        }
    }

    private lazy var request = Result<SNClassifySoundRequest, Error> {
        guard #available(macOS 12, *) else { throw Failure.unavailable }
        let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
        guard request.knownClassifications.contains(Self.label) else { throw Failure.missingLabel }
        request.windowDuration = CMTime(seconds: ClapCandidateAudio.duration, preferredTimescale: 16000)
        request.overlapFactor = 0
        guard abs(request.windowDuration.seconds - ClapCandidateAudio.duration) < 0.001 else { throw Failure.unsupportedWindow }
        return request
    }

    func prepare() { _ = request }

    func score(_ samples: [Float], rate: Double, deadline: DispatchTime) throws -> Double {
        guard DispatchTime.now() < deadline else { throw Failure.timeout }
        let request = try request.get()
        // Add converter headroom after the one full window. There is still only one full analysis window.
        let padding = Int((0.03 * rate).rounded(.up))
        guard let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count + padding)),
              let channel = buffer.floatChannelData?[0] else { throw Failure.noResult }
        buffer.frameLength = buffer.frameCapacity
        samples.withUnsafeBufferPointer { channel.update(from: $0.baseAddress!, count: $0.count) }
        (channel + samples.count).update(repeating: 0, count: padding)

        let observer = Observer()
        let analyzer = SNAudioStreamAnalyzer(format: format)
        try analyzer.add(request, withObserver: observer)
        defer { analyzer.removeAllRequests() }
        analyzer.analyze(buffer, atAudioFramePosition: 0)
        analyzer.completeAnalysis()
        guard observer.completed.wait(timeout: deadline) == .success, DispatchTime.now() <= deadline else { throw Failure.timeout }
        if let error = observer.error { throw error }
        guard let score = observer.score else { throw Failure.noResult }
        return score
    }

    private final class Observer: NSObject, SNResultsObserving {
        let completed = DispatchSemaphore(value: 0)
        private(set) var score: Double?, error: Error?

        func request(_ request: SNRequest, didProduce result: SNResult) {
            guard let result = result as? SNClassificationResult,
                  abs(result.timeRange.start.seconds) < 0.01,
                  abs(result.timeRange.duration.seconds - ClapCandidateAudio.duration) < 0.01 else { return }
            score = result.classifications.first { $0.identifier == AppleClapClassifier.label }?.confidence ?? 0
        }
        func request(_ request: SNRequest, didFailWithError error: Error) { self.error = error; completed.signal() }
        func requestDidComplete(_ request: SNRequest) { completed.signal() }
    }
}
