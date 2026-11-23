// bench/electron/verify-os-handler.swift — VERIFIER: which application macOS LaunchServices would
// actually open each Markdown extension with. Run: swift bench/electron/verify-os-handler.swift
import AppKit
import UniformTypeIdentifiers

let exts = ["md", "markdown", "mdown", "mkd", "mkdn", "txt"]
let dir = FileManager.default.temporaryDirectory.appendingPathComponent("mdr-handler-\(UUID().uuidString)")
try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: dir) }

print("UTI net.daringfireball.markdown default app:")
if let t = UTType("net.daringfireball.markdown"),
   let u = NSWorkspace.shared.urlForApplication(toOpen: t) {
    print("  \(u.path)  [\(Bundle(url: u)?.bundleIdentifier ?? "?")]")
} else { print("  <none>") }

print("\nper-extension resolution for a real file on disk:")
for e in exts {
    let f = dir.appendingPathComponent("probe.\(e)")
    FileManager.default.createFile(atPath: f.path, contents: "# probe\n".data(using: .utf8))
    let type = (try? f.resourceValues(forKeys: [.contentTypeKey]).contentType)?.identifier ?? "?"
    if let u = NSWorkspace.shared.urlForApplication(toOpen: f) {
        print("  .\(e.padding(toLength: 9, withPad: " ", startingAt: 0)) type=\(type.padding(toLength: 34, withPad: " ", startingAt: 0)) → \(Bundle(url: u)?.bundleIdentifier ?? "?")  \(u.path)")
    } else {
        print("  .\(e) type=\(type) → <none>")
    }
    let all = NSWorkspace.shared.urlsForApplications(toOpen: f).compactMap { Bundle(url: $0)?.bundleIdentifier }
    print("      candidates: \(all.prefix(6).joined(separator: ", "))")
}
