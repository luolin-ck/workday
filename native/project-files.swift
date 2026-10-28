import Foundation
import Darwin
import CryptoKit

struct Failure: Error { let code: String; let message: String }
func require(_ value: Bool, _ message: String, _ code: String = "SECURITY") throws { if !value { throw Failure(code: code, message: message) } }
func systemFailure() -> Failure { Failure(code: errno == ENOENT ? "CONFLICT" : "SECURITY", message: "项目路径或文件状态已变化，未提交修改") }
struct Identity: Codable, Equatable { let dev: Int64; let ino: UInt64 }
struct Root: Codable, Equatable { let root: String; let dev: Int64; let ino: UInt64; var identity: Identity { Identity(dev: dev, ino: ino) } }
struct Parent: Codable, Equatable { let path: String; let dev: Int64; let ino: UInt64; var identity: Identity { Identity(dev: dev, ino: ino) } }
struct Evidence: Codable { let root: Root; let path: String; let text: String; let hash: String; let identity: Identity; let parents: [Parent] }
struct Prepared: Codable { let root: Root; let path: String; let before: String?; let after: String; let beforeHash: String?; let afterHash: String; let fileIdentity: Identity?; let parents: [Parent] }
struct Request: Decodable { let operation: String; let root: Root?; let path: String?; let content: String?; let expected: Evidence?; let prepared: Prepared?; let recover: Bool? }
func identity(_ value: stat) -> Identity { Identity(dev: Int64(value.st_dev), ino: UInt64(value.st_ino)) }
func statFD(_ fd: Int32) throws -> stat { var result = stat(); guard fstat(fd, &result) == 0 else { throw systemFailure() }; return result }
func statAt(_ fd: Int32, _ name: String) throws -> stat? { var result = stat(); if fstatat(fd, name, &result, AT_SYMLINK_NOFOLLOW) == 0 { return result }; if errno == ENOENT { return nil }; throw systemFailure() }
func directory(_ value: stat) -> Bool { value.st_mode & S_IFMT == S_IFDIR }
func ordinary(_ value: stat) throws { try require(value.st_mode & S_IFMT == S_IFREG && value.st_nlink == 1 && value.st_mode & 0o111 == 0, "仅可修改非可执行、非硬链接的普通文本文件"); try require(value.st_size <= 16384, "文件最多 16 KiB", "LIMIT") }
func sameSnapshot(_ lhs: stat, _ rhs: stat) -> Bool { identity(lhs) == identity(rhs) && lhs.st_size == rhs.st_size && lhs.st_mtimespec.tv_sec == rhs.st_mtimespec.tv_sec && lhs.st_mtimespec.tv_nsec == rhs.st_mtimespec.tv_nsec && lhs.st_ctimespec.tv_sec == rhs.st_ctimespec.tv_sec && lhs.st_ctimespec.tv_nsec == rhs.st_ctimespec.tv_nsec }
func hash(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
let excluded = Set(["node_modules", "vendor", "build", "dist", "target", "coverage", "out", "__pycache__"])
func matching(_ pattern: String, _ value: String) -> Bool { value.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil }
func relative(_ value: String) throws -> [String] {
 try require(!value.isEmpty && value.utf16.count <= 512 && !value.hasPrefix("/") && !matching("^[A-Za-z]:|[\\\\\\x00-\\x1f\\x7f?#]", value), "项目相对路径无效")
 let parts = value.components(separatedBy: "/")
 try require(parts.count <= 10 && parts.allSatisfy { !$0.isEmpty && !$0.hasPrefix(".") && !excluded.contains($0.lowercased()) && !matching("(?:^|[-_.])(?:secrets?|credentials?|passwords?|tokens?)(?:[-_.]|$)|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\\.|$)|^env(?:\\.|$)|\\.(?:pem|key|p12|pfx|keystore|kdbx)$", $0) }, "项目路径属于隐藏、敏感或不可操作范围")
 return parts
}
func text(_ data: Data) throws -> String {
 try require(data.count <= 16384, "内容最多 16 KiB", "LIMIT")
 guard let value = String(data: data, encoding: .utf8) else { throw Failure(code: "FILE", message: "文件不是有效 UTF-8 文本") }
 try require(value.utf16.count <= 12000, "内容最多 12,000 字符", "LIMIT")
 try require(!matching("[\\x00-\\x08\\x0e-\\x1f]", value), "文件包含二进制内容", "FILE")
 try require(!value.hasPrefix("version https://git-lfs.github.com/spec/v1"), "不操作 Git LFS 指针", "FILE")
 try require(!matching("-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----|\\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{30,})\\b|(?:api[_-]?key|access[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key|authorization)[\"']?\\s*[:=]\\s*[\"']?(?:Bearer\\s+)?[A-Za-z0-9_./+-]{20,}", value), "文件含常见凭证格式，已拒绝", "FILE")
 return value
}
func checkedText(_ value: String) throws -> Data { let data = Data(value.utf8); _ = try text(data); return data }

final class Chain {
 struct Link { let parent: Int32; let name: String; let fd: Int32; let identity: Identity }
 var links: [Link] = []
 var fds: [Int32] = []
 let root: Root
 let relativePath: String
 var parents: [Parent] = []
 var parentFD: Int32 = -1
 var name = ""
 init(_ root: Root, _ value: String) throws {
  self.root = root; relativePath = value
  let parts = try relative(value)
  try require(root.root.hasPrefix("/") && root.root != "/" && !root.root.contains("\0") && !root.root.hasSuffix("/"), "项目根无效")
  let absolute = root.root.dropFirst().components(separatedBy: "/")
  try require(absolute.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }, "项目根路径无效")
  let slash = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
  guard slash >= 0 else { throw systemFailure() }; fds.append(slash)
  var current = slash
  for part in absolute { current = try descend(current, part) }
  try require(identity(try statFD(current)) == root.identity, "项目根身份已变化", "CONFLICT")
  parents.append(Parent(path: "", dev: root.dev, ino: root.ino))
  var relativeParent = ""
  for part in parts.dropLast() { current = try descend(current, part); relativeParent = relativeParent.isEmpty ? part : relativeParent + "/" + part; let id = identity(try statFD(current)); parents.append(Parent(path: relativeParent, dev: id.dev, ino: id.ino)) }
  parentFD = current; name = parts.last!
  try verify()
 }
 deinit { for fd in fds.reversed() { close(fd) } }
 func descend(_ parent: Int32, _ name: String) throws -> Int32 {
  guard let before = try statAt(parent, name), directory(before) else { throw systemFailure() }
  let fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
  guard fd >= 0 else { throw systemFailure() }; fds.append(fd)
  let opened = try statFD(fd)
  try require(directory(opened) && identity(opened) == identity(before), "项目父目录身份已变化", "CONFLICT")
  links.append(Link(parent: parent, name: name, fd: fd, identity: identity(opened)))
  return fd
 }
 func verify(_ expected: [Parent]? = nil) throws {
  for link in links { guard let now = try statAt(link.parent, link.name) else { throw systemFailure() }; try require(directory(now) && identity(now) == link.identity && identity(try statFD(link.fd)) == link.identity, "项目根或父目录已被移动或替换", "CONFLICT") }
  if let expected { try require(expected == parents, "项目父目录身份已变化", "CONFLICT") }
 }
 func read() throws -> (String, Identity, String) {
  guard let before = try statAt(parentFD, name) else { throw Failure(code: "CONFLICT", message: "待修改文件已不存在") }
  try ordinary(before)
  let fd = openat(parentFD, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
  guard fd >= 0 else { throw systemFailure() }; defer { close(fd) }
  let opened = try statFD(fd); try ordinary(opened)
  try require(sameSnapshot(before, opened), "打开的文件身份已变化", "CONFLICT"); try verify()
  guard let named = try statAt(parentFD, name) else { throw systemFailure() }
  try require(sameSnapshot(named, opened), "读取前文件已被替换", "CONFLICT")
  var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
  while true { let count = Darwin.read(fd, &buffer, buffer.count); if count < 0 { if errno == EINTR { continue }; throw systemFailure() }; if count == 0 { break }; data.append(contentsOf: buffer.prefix(count)); try require(data.count <= 16384, "文件实际内容超过 16 KiB", "LIMIT") }
  let after = try statFD(fd); try ordinary(after)
  guard let final = try statAt(parentFD, name) else { throw systemFailure() }
  try require(sameSnapshot(opened, after) && sameSnapshot(final, after), "读取期间文件发生变化", "CONFLICT"); try verify()
  return (try text(data), identity(after), hash(data))
 }
}
#if PROJECT_FILES_TESTING
func checkpoint(_ name: String) {
 let env = ProcessInfo.processInfo.environment
 if env["WORKDAY_FILE_TEST_CHECKPOINT"] == name {
  FileHandle.standardError.write(Data(("CHECKPOINT:" + name + "\n").utf8))
  var byte: UInt8 = 0
  _ = Darwin.read(3, &byte, 1)
 }
}
#else
func checkpoint(_ name: String) {}
#endif
func readEvidence(_ root: Root, _ path: String) throws -> Evidence { let chain = try Chain(root, path); checkpoint("beforeRead"); try chain.verify(); let (value, id, digest) = try chain.read(); return Evidence(root: root, path: path, text: value, hash: digest, identity: id, parents: chain.parents) }
func prepare(_ root: Root, _ path: String, _ content: String, _ expected: Evidence?) throws -> Prepared {
 let bytes = try checkedText(content), chain = try Chain(root, path)
 var before: String? = nil, beforeHash: String? = nil, fileIdentity: Identity? = nil
 if let expected {
  try require(expected.root == root && expected.path == path && hash(try checkedText(expected.text)) == expected.hash, "文件读取证据无效")
  try chain.verify(expected.parents)
  let (value, id, digest) = try chain.read()
  try require(digest == expected.hash && id == expected.identity && value == expected.text, "文件已在读取后修改，请重新读取", "CONFLICT")
  before = value; beforeHash = digest; fileIdentity = id
 } else { try require(try statAt(chain.parentFD, chain.name) == nil, "新文件路径已存在", "CONFLICT") }
 try chain.verify()
 return Prepared(root: root, path: path, before: before, after: content, beforeHash: beforeHash, afterHash: hash(bytes), fileIdentity: fileIdentity, parents: chain.parents)
}
func validateCurrent(_ chain: Chain, _ prepared: Prepared, _ recover: Bool) throws -> Bool {
 try chain.verify(prepared.parents)
 if let current = try statAt(chain.parentFD, chain.name) {
  try ordinary(current)
  let (value, id, digest) = try chain.read()
  if recover && digest == prepared.afterHash && value == prepared.after { return true }
  try require(prepared.before != nil && digest == prepared.beforeHash && id == prepared.fileIdentity && value == prepared.before, "文件已变更，未覆盖现有内容", "CONFLICT")
 } else { try require(prepared.before == nil, "待修改文件已不存在", "CONFLICT") }
 return false
}
func apply(_ prepared: Prepared, _ recover: Bool) throws -> Bool {
 let bytes = try checkedText(prepared.after)
 try require(hash(bytes) == prepared.afterHash, "变更内容校验失败")
 if let before = prepared.before { try require(hash(try checkedText(before)) == prepared.beforeHash && prepared.fileIdentity != nil, "原文件证据校验失败") } else { try require(prepared.beforeHash == nil && prepared.fileIdentity == nil, "新文件证据无效") }
 let chain = try Chain(prepared.root, prepared.path)
 if try validateCurrent(chain, prepared, recover) { return true }
 let temporary = ".workday-" + UUID().uuidString + ".tmp"
 let fd = openat(chain.parentFD, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
 guard fd >= 0 else { throw systemFailure() }
 let temporaryIdentity = identity(try statFD(fd))
 var committed = false
 defer {
  close(fd)
  if !committed, let item = try? statAt(chain.parentFD, temporary), identity(item) == temporaryIdentity { _ = unlinkat(chain.parentFD, temporary, 0) }
 }
 let mode: mode_t
 if prepared.before != nil { guard let old = try statAt(chain.parentFD, chain.name) else { throw systemFailure() }; try ordinary(old); mode = old.st_mode & 0o666 } else { mode = 0o644 }
 try require(fchmod(fd, mode) == 0, "无法设置新文件权限", "FILE")
 try bytes.withUnsafeBytes { raw in
  var offset = 0
  while offset < raw.count { let written = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset); if written < 0 { if errno == EINTR { continue }; throw systemFailure() }; try require(written > 0, "文件写入失败", "FILE"); offset += written }
 }
 try require(fsync(fd) == 0, "文件同步失败，未提交", "FILE")
 let stagedSnapshot = try statFD(fd)
 checkpoint("beforeCommit")
 if try validateCurrent(chain, prepared, false) { throw Failure(code: "CONFLICT", message: "文件状态无效") }
 guard let namedTemporary = try statAt(chain.parentFD, temporary) else { throw systemFailure() }
 try ordinary(namedTemporary)
 try require(identity(namedTemporary) == temporaryIdentity && sameSnapshot(stagedSnapshot, namedTemporary) && sameSnapshot(namedTemporary, try statFD(fd)), "临时文件已被替换，未提交", "CONFLICT")
 // POSIX has no atomic hash-compare-and-rename; external edits after this check remain a narrow race.
 let flags: UInt32 = prepared.before == nil ? UInt32(RENAME_EXCL) : 0
 guard renameatx_np(chain.parentFD, temporary, chain.parentFD, chain.name, flags) == 0 else { throw systemFailure() }
 committed = true
 try require(fsync(chain.parentFD) == 0, "文件已写入但目录同步失败，请恢复确认", "FILE")
 return false
}
func emit<T: Encodable>(_ value: T) throws { FileHandle.standardOutput.write(try JSONEncoder().encode(value)) }
struct Success<T: Encodable>: Encodable { let ok = true; let value: T }
struct Applied: Encodable { let alreadyApplied: Bool }
struct ErrorResult: Encodable { let ok = false; let code: String; let message: String }
do {
 var bytes = Data()
 while let next = try FileHandle.standardInput.read(upToCount: 8192), !next.isEmpty { bytes.append(next); try require(bytes.count <= 131072, "文件操作请求过大", "LIMIT") }
 let request = try JSONDecoder().decode(Request.self, from: bytes)
 switch request.operation {
 case "read": guard let root = request.root, let path = request.path else { throw Failure(code: "INVALID", message: "缺少文件参数") }; try emit(Success(value: readEvidence(root, path)))
 case "prepare": guard let root = request.root, let path = request.path, let content = request.content else { throw Failure(code: "INVALID", message: "缺少变更参数") }; try emit(Success(value: prepare(root, path, content, request.expected)))
 case "apply": guard let prepared = request.prepared else { throw Failure(code: "INVALID", message: "缺少变更证据") }; try emit(Success(value: Applied(alreadyApplied: apply(prepared, request.recover == true))))
 default: throw Failure(code: "INVALID", message: "未知文件操作")
 }
} catch {
 let failure = error as? Failure ?? Failure(code: "INVALID", message: "文件操作参数或状态无效")
 try? emit(ErrorResult(code: failure.code, message: failure.message)); exit(1)
}
