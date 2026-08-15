#!/usr/bin/env swift
// Transkoduje materiał promocyjny do H.264/MP4 dla przeglądarek i zapisuje plakat (pierwszą klatkę).
//
// Źródło z kamery/montażu bywa w HEVC (.mov) — Safari to odtworzy, Chrome i Firefox nie.
// Presety `avconvert` nie pozwalają ustawić bitrate'u (Preset1280x720 daje ~6,6 Mb/s), więc
// enkodujemy przez AVAssetWriter z własnymi parametrami.
//
// Użycie:
//   swift scripts/transcode-promo.swift <źródło.mov> <wyjście.mp4> [bitrate w kb/s]

import AVFoundation
import Foundation
import CoreImage

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("użycie: transcode-promo.swift <źródło> <wyjście.mp4> [kbps]\n".data(using: .utf8)!)
    exit(1)
}
let sourceURL = URL(fileURLWithPath: args[1])
let outputURL = URL(fileURLWithPath: args[2])
let videoBitrate = (args.count > 3 ? Int(args[3]) : nil).map { $0 * 1000 } ?? 2_200_000

let asset = AVAsset(url: sourceURL)
guard let videoTrack = asset.tracks(withMediaType: .video).first else {
    FileHandle.standardError.write("brak ścieżki wideo w źródle\n".data(using: .utf8)!)
    exit(1)
}
let audioTrack = asset.tracks(withMediaType: .audio).first

// naturalSize opisuje piksele przed obrotem; po transformacie wymiary mogą się zamienić
let transformed = videoTrack.naturalSize.applying(videoTrack.preferredTransform)
let width = Int(abs(transformed.width).rounded())
let height = Int(abs(transformed.height).rounded())

try? FileManager.default.removeItem(at: outputURL)
let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
writer.shouldOptimizeForNetworkUse = true  // moov atom na początku pliku — odtwarzanie startuje bez pobrania całości

let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: width,
    AVVideoHeightKey: height,
    AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: videoBitrate,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoAllowFrameReorderingKey: true,
        AVVideoMaxKeyFrameIntervalDurationKey: 2,
    ],
])
videoInput.expectsMediaDataInRealTime = false
writer.add(videoInput)

var audioInput: AVAssetWriterInput?
if audioTrack != nil {
    let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVNumberOfChannelsKey: 2,
        AVSampleRateKey: 48_000,
        AVEncoderBitRateKey: 128_000,
    ])
    input.expectsMediaDataInRealTime = false
    writer.add(input)
    audioInput = input
}

let reader = try AVAssetReader(asset: asset)
// Kompozycja renderuje klatki już obrócone, więc plik wyjściowy nie potrzebuje transformaty.
let videoComposition = AVMutableVideoComposition()
videoComposition.renderSize = CGSize(width: width, height: height)
videoComposition.frameDuration = CMTime(value: 1, timescale: CMTimeScale(max(videoTrack.nominalFrameRate.rounded(), 30)))
let instruction = AVMutableVideoCompositionInstruction()
instruction.timeRange = CMTimeRange(start: .zero, duration: asset.duration)
let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
layer.setTransform(videoTrack.preferredTransform, at: .zero)
instruction.layerInstructions = [layer]
videoComposition.instructions = [instruction]

let videoOutput = AVAssetReaderVideoCompositionOutput(videoTracks: [videoTrack], videoSettings: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
])
videoOutput.videoComposition = videoComposition
videoOutput.alwaysCopiesSampleData = false
reader.add(videoOutput)

var audioOutput: AVAssetReaderTrackOutput?
if let audioTrack {
    let output = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
    ])
    output.alwaysCopiesSampleData = false
    reader.add(output)
    audioOutput = output
}

guard reader.startReading() else {
    FileHandle.standardError.write("nie udało się odczytać źródła: \(reader.error?.localizedDescription ?? "?")\n".data(using: .utf8)!)
    exit(1)
}
writer.startWriting()
writer.startSession(atSourceTime: .zero)

let group = DispatchGroup()

func pump(_ input: AVAssetWriterInput, from output: AVAssetReaderOutput, label: String) {
    group.enter()
    input.requestMediaDataWhenReady(on: DispatchQueue(label: "transcode.\(label)")) {
        while input.isReadyForMoreMediaData {
            guard let buffer = output.copyNextSampleBuffer() else {
                input.markAsFinished()
                group.leave()
                return
            }
            input.append(buffer)
        }
    }
}

pump(videoInput, from: videoOutput, label: "video")
if let audioInput, let audioOutput { pump(audioInput, from: audioOutput, label: "audio") }

group.wait()

guard reader.status != .failed else {
    FileHandle.standardError.write("błąd odczytu: \(reader.error?.localizedDescription ?? "?")\n".data(using: .utf8)!)
    exit(1)
}

let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()

guard writer.status == .completed else {
    FileHandle.standardError.write("błąd zapisu: \(writer.error?.localizedDescription ?? "?")\n".data(using: .utf8)!)
    exit(1)
}

// Plakat: pierwsza klatka jako JPEG obok pliku wideo — wyświetla się zanim wideo zacznie płynąć.
let posterURL = outputURL.deletingPathExtension().appendingPathExtension("jpg")
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.maximumSize = CGSize(width: width, height: height)
if let cgImage = try? generator.copyCGImage(at: CMTime(value: 1, timescale: 10), actualTime: nil) {
    let context = CIContext()
    let ciImage = CIImage(cgImage: cgImage)
    try? context.writeJPEGRepresentation(
        of: ciImage,
        to: posterURL,
        colorSpace: ciImage.colorSpace ?? CGColorSpaceCreateDeviceRGB(),
        options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.72]
    )
}

let bytes = (try? FileManager.default.attributesOfItem(atPath: outputURL.path)[.size] as? Int) ?? 0
print("gotowe: \(outputURL.lastPathComponent) — \(width)×\(height), \(String(format: "%.1f", Double(bytes ?? 0) / 1_048_576)) MB")
