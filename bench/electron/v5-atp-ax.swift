// bench/electron/v5-atp-ax.swift — probe-activation (0.2.0 stage 2e): an accessibility "press" (AXPress, what
// VoiceOver sends for VO-Space and Voice Control for "click") on an element of a TEST instance of MDReader.
//
//   swiftc -O bench/electron/v5-atp-ax.swift -o <scratch>/v5-atp-ax
//   <scratch>/v5-atp-ax <pid> tree [maxLines]                 print the web area's elements
//   <scratch>/v5-atp-ax <pid> info  <role|*> <text|*> [nth]   print one element's attributes
//   <scratch>/v5-atp-ax <pid> press <role|*> <text|*> [nth] [up]   AXPress on it (or on its ancestor `up` levels
//                                                               up), then print it again
// <text> matches (substring; a leading "=" asks for equality) the element's AXTitle, AXDescription, AXValue, AXDOMIdentifier or AXDOMClassList;
// nth counts the matches in tree order from 0.
//
// Safety, built in: refuses unless AXIsProcessTrusted() (no prompt is ever shown); refuses any pid whose executable
// does not lie under /Users/zyx/LocalDocuments/MDReader/node_modules/ (the project's own Electron binary: the
// user's app under /Applications is never touched, not even read); uses only AXUIElementCreateApplication(pid),
// attribute reads, AXUIElementPerformAction(kAXPressAction) and setting AXManualAccessibility = true on the
// application element (how an Electron app is asked to build its tree). Posts no keyboard or mouse event,
// changes no system setting, starts nothing. Global timeout 60 s.
import ApplicationServices
import Foundation
import Darwin

let allowedRoot = "/Users/zyx/LocalDocuments/MDReader/node_modules"

func out(_ s: String) { FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!) }
func fail(_ s: String) -> Never { FileHandle.standardError.write(("v5-atp-ax: " + s + "\n").data(using: .utf8)!); exit(2) }

signal(SIGALRM) { _ in _exit(3) }
alarm(60)

let argv = CommandLine.arguments
guard argv.count >= 3, let pid = Int32(argv[1]), pid > 1 else { fail("usage: v5-atp-ax <pid> tree|info|press ...") }
guard AXIsProcessTrusted() else { fail("not trusted: nothing done") }

// ---- the process must run the project's own Electron binary
var pathBuf = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
let plen = proc_pidpath(pid, &pathBuf, UInt32(pathBuf.count))
guard plen > 0 else { fail("refused: no executable path for pid \(pid)") }
let exe = String(cString: pathBuf)
let exeReal = URL(fileURLWithPath: exe).resolvingSymlinksInPath().path
let rootReal = URL(fileURLWithPath: allowedRoot).resolvingSymlinksInPath().path + "/"
guard exeReal.hasPrefix(rootReal), !exeReal.contains("/Applications/"), !exe.contains("/Applications/") else {
  fail("refused: pid \(pid) runs \(exe), not under \(allowedRoot)/")
}

let appEl = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(appEl, 5.0)

func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
  var v: CFTypeRef?
  let err = AXUIElementCopyAttributeValue(e, name as CFString, &v)
  return err == .success ? (v as AnyObject?) : nil
}
func str(_ e: AXUIElement, _ name: String) -> String {
  guard let v = attr(e, name) else { return "" }
  if let s = v as? String { return s }
  if let n = v as? NSNumber { return n.stringValue }
  if let a = v as? [String] { return a.joined(separator: " ") }
  if CFGetTypeID(v) == AXValueGetTypeID() {
    let av = v as! AXValue
    switch AXValueGetType(av) {
    case .cgPoint: var p = CGPoint.zero; AXValueGetValue(av, .cgPoint, &p); return "\(p.x),\(p.y)"
    case .cgSize: var s = CGSize.zero; AXValueGetValue(av, .cgSize, &s); return "\(s.width)x\(s.height)"
    default: return "axvalue"
    }
  }
  return String(describing: v)
}
func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute as String) as? [AXUIElement]) ?? [] }

func findWebArea(_ e: AXUIElement, _ depth: Int) -> AXUIElement? {
  if depth > 40 { return nil }
  if str(e, kAXRoleAttribute as String) == "AXWebArea" { return e }
  for c in children(e) { if let w = findWebArea(c, depth + 1) { return w } }
  return nil
}

// ---- ask the Electron app to build its tree, wait until the web area has children
AXUIElementSetAttributeValue(appEl, "AXManualAccessibility" as CFString, kCFBooleanTrue)
var web: AXUIElement? = nil
for _ in 0..<80 {
  if let w = findWebArea(appEl, 0), children(w).count > 0 { web = w; break }
  usleep(100_000)
}
guard let webArea = web else { fail("no web area with children after 8 s") }

func describe(_ e: AXUIElement) -> String {
  let keys = ["AXRole", "AXSubrole", "AXRoleDescription", "AXTitle", "AXDescription", "AXValue", "AXHelp",
              "AXDOMIdentifier", "AXDOMClassList", "AXFocused", "AXEnabled", "AXPosition", "AXSize"]
  var parts: [String] = []
  for k in keys {
    var s = str(e, k)
    if s.isEmpty { continue }
    if s.count > 80 { s = String(s.prefix(80)) + "..." }
    s = s.replacingOccurrences(of: "\n", with: " ")
    parts.append("\(k)=\(s)")
  }
  return parts.joined(separator: " | ")
}

var walked: [(AXUIElement, Int)] = []
func walk(_ e: AXUIElement, _ depth: Int) {
  if walked.count > 4000 || depth > 60 { return }
  walked.append((e, depth))
  for c in children(e) { walk(c, depth + 1) }
}
walk(webArea, 0)

let cmd = argv[2]
if cmd == "tree" {
  let maxLines = argv.count > 3 ? (Int(argv[3]) ?? 400) : 400
  for (i, (e, d)) in walked.enumerated() where i < maxLines {
    out(String(repeating: " ", count: min(d, 30)) + "#\(i) " + describe(e))
  }
  exit(0)
}
guard cmd == "info" || cmd == "press", argv.count >= 5 else { fail("usage: info|press <role|*> <text|*> [nth]") }
let role = argv[3], text = argv[4]
let nth = argv.count > 5 ? (Int(argv[5]) ?? 0) : 0
let matches = walked.map { $0.0 }.filter { e in
  if role != "*" && str(e, "AXRole") != role { return false }
  if text == "*" { return true }
  let exact = text.hasPrefix("=")
  let want = exact ? String(text.dropFirst()) : text
  for k in ["AXTitle", "AXDescription", "AXValue", "AXDOMIdentifier", "AXDOMClassList"] {
    let v = str(e, k)
    if exact ? (v == want) : v.contains(want) { return true }
  }
  return false
}
guard nth < matches.count else { fail("no match \(role) \(text) #\(nth) (\(matches.count) matches)") }
// optional 6th argument: act on the match's ancestor this many levels up (AXParent reads)
let up = argv.count > 6 ? (Int(argv[6]) ?? 0) : 0
var target = matches[nth]
for _ in 0..<up {
  guard let p = attr(target, kAXParentAttribute as String), CFGetTypeID(p) == AXUIElementGetTypeID() else { fail("no parent") }
  target = (p as! AXUIElement)
}
func valueRaw(_ e: AXUIElement) -> String {
  var v: CFTypeRef?
  let err = AXUIElementCopyAttributeValue(e, "AXValue" as CFString, &v)
  return "AXValue(raw)=err\(err.rawValue) type=\(v.map { String(describing: CFCopyTypeIDDescription(CFGetTypeID($0))!) } ?? "-") value=\(v.map { String(describing: $0) } ?? "-")"
}
out("before: " + describe(target) + " | " + valueRaw(target))
if cmd == "press" {
  let err = AXUIElementPerformAction(target, kAXPressAction as CFString)
  out("press: AXError \(err.rawValue)")
  usleep(400_000)
  out("after: " + describe(target) + " | " + valueRaw(target))
}
exit(0)
