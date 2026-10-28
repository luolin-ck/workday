import Foundation
import PDFKit
import ImageIO
import CoreGraphics
import UniformTypeIdentifiers

struct AttachmentFailure: Error { let code: String }
func fail(_ code: String) throws -> Never { throw AttachmentFailure(code: code) }
func image(_ data: Data) throws -> [String: Any] {
    guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
          let type = CGImageSourceGetType(source) as String?,
          [UTType.png.identifier, UTType.jpeg.identifier, UTType.webP.identifier].contains(type),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
          let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue,
          width.isFinite, height.isFinite, width > 0, height > 0 else { try fail("INVALID") }
    guard width <= 40_000_000, height <= 40_000_000, width * height <= 40_000_000 else { try fail("LIMIT") }
    let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 2048, kCGImageSourceShouldCacheImmediately: true]
    guard let frame = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary), frame.width <= 2048, frame.height <= 2048 else { try fail("INVALID") }
    // Re-render into a new bitmap so embedded profiles, EXIF and source metadata are not copied.
    guard let context = CGContext(data: nil, width: frame.width, height: frame.height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { try fail("INVALID") }
    context.draw(frame, in: CGRect(x: 0, y: 0, width: frame.width, height: frame.height))
    guard let clean = context.makeImage() else { try fail("INVALID") }
    let mime = type == UTType.jpeg.identifier ? "image/jpeg" : "image/png"
    let encoded = NSMutableData()
    guard let target = CGImageDestinationCreateWithData(encoded, (mime == "image/jpeg" ? UTType.jpeg.identifier : UTType.png.identifier) as CFString, 1, nil) else { try fail("INVALID") }
    CGImageDestinationAddImage(target, clean, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
    guard CGImageDestinationFinalize(target) else { try fail("INVALID") }
    guard encoded.length <= 4 * 1024 * 1024 else { try fail("LIMIT") }
    return ["ok": true, "mime": mime, "data": (encoded as Data).base64EncodedString()]
}
func pdf(_ data: Data) throws -> [String: Any] {
    guard let document = PDFDocument(data: data) else { try fail("INVALID") }
    guard !document.isEncrypted else { try fail("ENCRYPTED") }
    guard document.pageCount > 0 else { try fail("NO_TEXT") }
    guard document.pageCount <= 50 else { try fail("LIMIT") }
    var text = ""
    for index in 0..<document.pageCount {
        let pageText = document.page(at: index)?.string ?? ""
        let addition = (index > 0 ? "\n\n" : "") + pageText
        guard text.utf16.count + addition.utf16.count <= 30000 else { try fail("LIMIT") }
        text += addition
    }
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { try fail("NO_TEXT") }
    return ["ok": true, "mime": "application/pdf", "text": text]
}
do {
    var input = Data()
    while true {
        let part = FileHandle.standardInput.readData(ofLength: 65536)
        if part.isEmpty { break }
        guard input.count + part.count <= 14 * 1024 * 1024 else { try fail("LIMIT") }
        input.append(part)
    }
    guard CommandLine.arguments.count == 1,
          let request = try JSONSerialization.jsonObject(with: input) as? [String: Any],
          Set(request.keys) == Set(["kind", "data"]),
          let kind = request["kind"] as? String, ["pdf", "image"].contains(kind),
          let encoded = request["data"] as? String, let data = Data(base64Encoded: encoded),
          data.count <= 10 * 1024 * 1024 else { try fail("INVALID") }
    let result = try kind == "pdf" ? pdf(data) : image(data)
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
} catch {
    let result: [String: Any] = ["ok": false, "code": (error as? AttachmentFailure)?.code ?? "INVALID"]
    FileHandle.standardOutput.write((try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])) ?? Data())
    exit(1)
}
