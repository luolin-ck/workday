import Foundation
import EventKit
import CryptoKit

let targetCalendar = "我的日历（钉钉）"
func targetStatus(_ titles: [String]) -> String {
    let count = titles.filter { $0 == targetCalendar }.count
    return count == 1 ? "ready" : count == 0 ? "notFound" : "ambiguous"
}
func accessStatus(_ raw: Int) -> String {
    switch raw {
    case 0: return "notDetermined"
    case 1: return "restricted"
    case 3: return "ready" // authorized and fullAccess share the same raw value.
    default: return "denied"
    }
}
func civilFormatter(_ timezone: TimeZone) -> DateFormatter {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.timeZone = timezone
    formatter.dateFormat = "yyyy-MM-dd"
    formatter.isLenient = false
    return formatter
}
func queryRange(_ start: String, _ end: String, _ zone: String) -> (Date, Date)? {
    guard let timezone = TimeZone(identifier: zone) else { return nil }
    let formatter = civilFormatter(timezone)
    guard start.count == 10, end.count == 10,
          let first = formatter.date(from: start), let last = formatter.date(from: end),
          formatter.string(from: first) == start, formatter.string(from: last) == end else { return nil }
    var calendar = Calendar(identifier: .gregorian); calendar.timeZone = timezone
    guard let days = calendar.dateComponents([.day], from: first, to: last).day, days > 0, days <= 42 else { return nil }
    return (first, last)
}
func overlaps(_ start: Date, _ end: Date, _ first: Date, _ last: Date, cancelled: Bool) -> Bool {
    !cancelled && end > start && start < last && end > first
}
func emit(_ status: String, _ meetings: [[String: Any]] = []) -> Never {
    let value: [String: Any] = ["status": status, "meetings": meetings]
    guard let data = try? JSONSerialization.data(withJSONObject: value), data.count <= 512 * 1024 else {
        print("{\"status\":\"error\",\"meetings\":[]}"); exit(0)
    }
    FileHandle.standardOutput.write(data)
    exit(0)
}

#if CALENDAR_TESTS
func check(_ condition: Bool, _ message: String) { if !condition { fputs("FAIL: \(message)\n", stderr); exit(1) } }
check(targetStatus(["个人", targetCalendar]) == "ready", "select only the exact target")
check(targetStatus(["我的日历", "钉钉"]) == "notFound", "no fallback calendar")
check(targetStatus([targetCalendar, targetCalendar]) == "ambiguous", "duplicate target names are ambiguous")
check(accessStatus(0) == "notDetermined" && accessStatus(1) == "restricted" && accessStatus(2) == "denied" && accessStatus(3) == "ready" && accessStatus(4) == "denied", "only full access can read, never writeOnly")
check(queryRange("2026-10-01", "2026-11-12", "America/New_York") != nil, "42 civil days across DST")
check(queryRange("2026-10-01", "2026-11-13", "America/New_York") == nil, "43 days are rejected")
check(queryRange("2026-02-30", "2026-03-05", "UTC") == nil, "invalid date")
let first = Date(timeIntervalSince1970: 100), last = Date(timeIntervalSince1970: 200)
check(!overlaps(first, last, last, Date(timeIntervalSince1970: 300), cancelled: false), "exclusive end")
check(!overlaps(first, last, first, last, cancelled: true), "cancelled meetings are excluded")
check(overlaps(first, last, Date(timeIntervalSince1970: 150), last, cancelled: false), "cross-day overlap")
print("Native calendar contract tests passed")
#else
let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count == 4, let range = queryRange(arguments[0], arguments[1], arguments[2]), ["true", "false"].contains(arguments[3]) else { emit("error") }
var store = EKEventStore()
var authorization = EKEventStore.authorizationStatus(for: .event)
if arguments[3] == "true" && (authorization.rawValue == 0 || authorization.rawValue == 4) {
    var completed = false
    let completion: (Bool, Error?) -> Void = { _, _ in DispatchQueue.main.async { completed = true } }
    if #available(macOS 14.0, *) { store.requestFullAccessToEvents(completion: completion) }
    else { store.requestAccess(to: .event, completion: completion) }
    let deadline = Date().addingTimeInterval(110)
    while !completed && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
    guard completed else { emit("error") }
    authorization = EKEventStore.authorizationStatus(for: .event)
    store = EKEventStore() // Do not reuse a store initialized before permission was granted.
}
let permission = accessStatus(authorization.rawValue)
guard permission == "ready" else { emit(permission) }
let calendars = store.calendars(for: .event)
let selection = targetStatus(calendars.map { $0.title })
guard selection == "ready", let calendar = calendars.first(where: { $0.title == targetCalendar }) else { emit(selection) }
let predicate = store.predicateForEvents(withStart: range.0, end: range.1, calendars: [calendar])
let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
var seen = Set<String>(), meetings = [[String: Any]]()
for event in store.events(matching: predicate) {
    guard let start = event.startDate, let end = event.endDate,
          overlaps(start, end, range.0, range.1, cancelled: event.status == .canceled) else { continue }
    let startString = iso.string(from: start), endString = iso.string(from: end)
    let identity = event.calendarItemIdentifier + "|" + startString
    let id = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
    guard seen.insert(id).inserted else { continue }
    let civil = civilFormatter(event.timeZone ?? .current)
    let title = (event.title ?? "未命名会议").components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
    meetings.append(["id": id, "title": String(title.prefix(500)), "start": startString, "end": endString, "allDay": event.isAllDay,
                     "startDate": event.isAllDay ? civil.string(from: start) as Any : NSNull(),
                     "endDate": event.isAllDay ? civil.string(from: end) as Any : NSNull()])
    if meetings.count > 2000 { emit("error") }
}
emit("ready", meetings)
#endif
