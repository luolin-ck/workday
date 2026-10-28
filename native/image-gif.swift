import Foundation
import ImageIO
import CoreGraphics
import UniformTypeIdentifiers
import CryptoKit
import Darwin

struct MediaFailure: Error { let code: String }
func fail(_ code: String) throws -> Never { throw MediaFailure(code: code) }
let files = FileManager.default
let maxBytes = 64 * 1024 * 1024
let maxPixels = 40_000_000
func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
func integer(_ request: [String: Any], _ key: String, _ fallback: Int) throws -> Int {
    guard let value = request[key] else { return fallback }
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
          number.doubleValue == Double(number.intValue) else { try fail("INVALID") }
    return number.intValue
}
func attributes(_ path: String, directory: Bool) throws {
    var info = stat()
    guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == (directory ? S_IFDIR : S_IFREG) else { try fail("PATH_TYPE") }
    if !directory { guard info.st_size > 0, info.st_size <= maxBytes else { try fail("LIMIT") } }
}
func absolutePath(_ path: String) -> Bool {
    let components = path.split(separator: "/", omittingEmptySubsequences: false)
    return path.hasPrefix("/") && path.utf8.count <= 4096 && !path.utf8.contains(0) && components.dropFirst().allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
}
func directory(_ path: String) throws {
    // Foundation standardization folds /private/var into /var, which is a system symlink.
    guard absolutePath(path) else { try fail("PATH_ROOT") }
    var part = ""
    for component in path.split(separator: "/") { part += "/" + component; try attributes(part, directory: true) }
}
func sourcePath(_ source: String, _ root: String) throws {
    guard source.hasPrefix(root + "/"), absolutePath(source) else { try fail("PATH_SOURCE") }
    let relative = String(source.dropFirst(root.count + 1))
    guard relative.range(of: "^(?:[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}\\.(?:png|gif)|frames/frame-(?:00[1-9]|01[0-9]|02[0-4])\\.png)$", options: .regularExpression) != nil else { try fail("PATH_NAME") }
    if relative.hasPrefix("frames/") { try attributes(root + "/frames", directory: true) }
    try attributes(source, directory: false)
}
struct Decoded {
    let data: Data
    let source: CGImageSource
    let width: Int
    let height: Int
    let count: Int
    let mime: String
}
func decode(_ path: String) throws -> Decoded {
    try attributes(path, directory: false)
    let data = try Data(contentsOf: URL(fileURLWithPath: path), options: [.mappedIfSafe])
    guard data.count <= maxBytes, let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
          CGImageSourceGetStatus(source) == .statusComplete, let type = CGImageSourceGetType(source) as String?,
          [UTType.png.identifier, UTType.gif.identifier].contains(type) else { try fail("IMAGE") }
    let count = CGImageSourceGetCount(source)
    guard count > 0, count <= 24, type != UTType.png.identifier || count == 1 else { try fail("LIMIT") }
    var width = 0, height = 0, pixels = 0
    for index in 0..<count {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any],
              let w = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let h = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              w > 0, h > 0, w <= 8192, h <= 8192, w <= maxPixels / h else { try fail("LIMIT") }
        pixels += w * h
        guard pixels <= maxPixels else { try fail("LIMIT") }
        if index == 0 { width = w; height = h }
        guard w == width, h == height, let image = CGImageSourceCreateImageAtIndex(source, index, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
              image.width == width, image.height == height else { try fail("IMAGE") }
    }
    return Decoded(data: data, source: source, width: width, height: height, count: count, mime: type == UTType.png.identifier ? "image/png" : "image/gif")
}
func gifTiming(_ image: Decoded) throws -> (Int, Int) {
    let properties = CGImageSourceCopyProperties(image.source, nil) as? [CFString: Any]
    let global = properties?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
    let loop = (global?[kCGImagePropertyGIFLoopCount] as? NSNumber)?.intValue ?? 1
    var delay: Int? = nil
    for index in 0..<image.count {
        let properties = CGImageSourceCopyPropertiesAtIndex(image.source, index, nil) as? [CFString: Any]
        let gif = properties?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
        guard let seconds = (gif?[kCGImagePropertyGIFUnclampedDelayTime] as? NSNumber)?.doubleValue ?? (gif?[kCGImagePropertyGIFDelayTime] as? NSNumber)?.doubleValue,
              seconds.isFinite, seconds > 0, seconds <= 10 else { try fail("IMAGE") }
        let milliseconds = Int((seconds * 1000).rounded())
        guard delay == nil || delay == milliseconds else { try fail("IMAGE") }
        delay = milliseconds
    }
    return (delay ?? 100, loop)
}
func inspect(_ path: String) throws -> [String: Any] {
    let image = try decode(path)
    var result: [String: Any] = ["ok": true, "mime": image.mime, "bytes": image.data.count, "sha256": digest(image.data), "width": image.width, "height": image.height, "frameCount": image.count]
    if image.mime == "image/gif" { let (delay, loop) = try gifTiming(image); result["delayMs"] = delay; result["loop"] = loop }
    return result
}
func pixels(_ image: CGImage) throws -> Data {
    let count = image.width * image.height * 4
    var data = Data(count: count)
    let valid = data.withUnsafeMutableBytes { pointer -> Bool in
        guard let context = CGContext(data: pointer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return true
    }
    guard valid else { try fail("IMAGE") }
    return data
}
func blank(_ data: Data) -> Bool {
    let bytes = [UInt8](data)
    var same = true, visible = false
    for index in stride(from: 0, to: bytes.count, by: 4) {
        if bytes[index + 3] > 2 { visible = true }
        if bytes[index] != bytes[0] || bytes[index + 1] != bytes[1] || bytes[index + 2] != bytes[2] || bytes[index + 3] != bytes[3] { same = false }
    }
    return same || !visible
}
func errorDistance(_ a: Data, _ b: Data) -> Int64 {
    a.withUnsafeBytes { left in b.withUnsafeBytes { right in
        let x = left.bindMemory(to: UInt8.self), y = right.bindMemory(to: UInt8.self)
        var difference: Int64 = 0
        for index in 0..<x.count { difference += Int64(abs(Int(x[index]) - Int(y[index]))) }
        return difference
    } }
}
func writeImage(_ image: CGImage, _ path: String) throws {
    guard let target = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil) else { try fail("ENCODE") }
    CGImageDestinationAddImage(target, image, nil)
    guard CGImageDestinationFinalize(target) else { try fail("ENCODE") }
    _ = try decode(path)
}
func compose(_ source: String, _ root: String, _ request: [String: Any]) throws -> [String: Any] {
    let columns = try integer(request, "columns", 6), rows = try integer(request, "rows", 4), count = try integer(request, "frameCount", 24)
    let delay = try integer(request, "delayMs", 100), loop = try integer(request, "loop", 0)
    guard columns == 6, rows == 4, count == 24, delay >= 20, delay <= 1000, delay % 10 == 0, loop >= 0, loop <= 65535 else { try fail("INVALID") }
    let sheet = try decode(source)
    guard sheet.mime == "image/png", sheet.count == 1, sheet.width % columns == 0, sheet.height % rows == 0,
          let original = CGImageSourceCreateImageAtIndex(sheet.source, 0, nil) else { try fail("GEOMETRY") }
    let width = sheet.width / columns, height = sheet.height / rows
    guard width > 0, height > 0 else { try fail("GEOMETRY") }
    let finalFrames = root + "/frames", finalGif = root + "/animation.gif"
    guard !files.fileExists(atPath: finalFrames), !files.fileExists(atPath: finalGif) else { try fail("EXISTS") }
    let temporary = root + "/.image-gif-" + UUID().uuidString
    try files.createDirectory(atPath: temporary, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    var publishedFrames = false, publishedGif = false
    defer {
        try? files.removeItem(atPath: temporary)
        if publishedFrames && !publishedGif { try? files.removeItem(atPath: finalFrames) }
    }
    try files.createDirectory(atPath: temporary + "/frames", withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    var images: [CGImage] = [], rawFrames: [Data] = [], hashes = Set<String>(), frames: [[String: Any]] = []
    for index in 0..<count {
        let x = (index % columns) * width, y = (index / columns) * height
        guard let frame = original.cropping(to: CGRect(x: x, y: y, width: width, height: height)), frame.width == width, frame.height == height else { try fail("GEOMETRY") }
        let raw = try pixels(frame), hash = digest(raw)
        guard !blank(raw) else { try fail("BLANK") }
        guard hashes.insert(hash).inserted else { try fail("DUPLICATE") }
        let name = String(format: "frame-%03d.png", index + 1), file = temporary + "/frames/" + name
        try writeImage(frame, file)
        let encoded = try Data(contentsOf: URL(fileURLWithPath: file))
        frames.append(["index": index + 1, "path": finalFrames + "/" + name, "sha256": digest(encoded), "bytes": encoded.count, "x": x, "y": y, "width": width, "height": height])
        images.append(frame); rawFrames.append(raw)
    }
    let stagedGif = temporary + "/animation.gif"
    guard let target = CGImageDestinationCreateWithURL(URL(fileURLWithPath: stagedGif) as CFURL, UTType.gif.identifier as CFString, count, nil) else { try fail("ENCODE") }
    CGImageDestinationSetProperties(target, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: loop]] as CFDictionary)
    for frame in images { CGImageDestinationAddImage(target, frame, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: Double(delay) / 1000, kCGImagePropertyGIFUnclampedDelayTime: Double(delay) / 1000]] as CFDictionary) }
    guard CGImageDestinationFinalize(target) else { try fail("ENCODE") }
    let encoded = try decode(stagedGif), timing = try gifTiming(encoded)
    guard encoded.count == count, encoded.width == width, encoded.height == height, timing.0 == delay, timing.1 == loop else { try fail("VERIFY") }
    // GIF quantizes colors. Compare decoded pixels to every source frame to verify their temporal order.
    for index in 0..<count {
        guard let decodedFrame = CGImageSourceCreateImageAtIndex(encoded.source, index, nil) else { try fail("VERIFY") }
        let raw = try pixels(decodedFrame), expected = errorDistance(raw, rawFrames[index])
        guard expected <= Int64(raw.count) * 40 else { try fail("VERIFY") }
        for other in 0..<count where other != index { guard errorDistance(raw, rawFrames[other]) > expected else { try fail("ORDER") } }
    }
    let gif: [String: Any] = ["path": finalGif, "sha256": digest(encoded.data), "bytes": encoded.data.count, "width": width, "height": height, "frameCount": count, "delayMs": delay, "loop": loop]
    try files.moveItem(atPath: temporary + "/frames", toPath: finalFrames); publishedFrames = true
    try files.moveItem(atPath: stagedGif, toPath: finalGif); publishedGif = true
    return ["ok": true, "source": ["path": source, "width": sheet.width, "height": sheet.height, "bytes": sheet.data.count, "sha256": digest(sheet.data)], "frames": frames, "gif": gif]
}
do {
    var input = Data()
    while true { let part = FileHandle.standardInput.readData(ofLength: 4096); if part.isEmpty { break }; guard input.count + part.count <= 16384 else { try fail("LIMIT") }; input.append(part) }
    guard CommandLine.arguments.count == 1, let request = try JSONSerialization.jsonObject(with: input) as? [String: Any],
          Set(request.keys).isSubset(of: Set(["operation", "sourcePath", "outputDir", "columns", "rows", "frameCount", "delayMs", "loop"])),
          let operation = request["operation"] as? String, ["inspect", "compose"].contains(operation),
          let source = request["sourcePath"] as? String, let root = request["outputDir"] as? String else { try fail("INVALID") }
    try directory(root); try sourcePath(source, root)
    let result = try operation == "inspect" ? inspect(source) : compose(source, root, request)
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
} catch {
    let result: [String: Any] = ["ok": false, "code": (error as? MediaFailure)?.code ?? "IO"]
    FileHandle.standardOutput.write((try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])) ?? Data())
    exit(1)
}
