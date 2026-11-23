// scripts/set-default-md.swift — makes MDReader (or any bundle id given as the first argument) the
// default application for the Markdown UTI `net.daringfireball.markdown`.
//
//   swift scripts/set-default-md.swift              # set MDReader as the default
//   swift scripts/set-default-md.swift --show       # only print the current handler (changes nothing)
//   swift scripts/set-default-md.swift com.apple.TextEdit   # revert to another app
//
// `public.plain-text` is deliberately NOT touched: .txt, .json, source files and everything else that
// conforms to plain text keep their own default application.
//
// macOS 26 note: the old `LSSetDefaultRoleHandlerForContentType` still returns noErr here but no
// longer changes anything, so this uses NSWorkspace.setDefaultApplication(at:toOpen:) (macOS 12+)
// and verifies the result by reading the handler back instead of trusting the return value.
import AppKit
import Foundation
import UniformTypeIdentifiers

let contentTypeId = "net.daringfireball.markdown"
let defaultBundleId = "com.zyx.mdreader"
let fallbackBundleId = "com.apple.TextEdit"   // suggested revert target when there is nothing better

guard let contentType = UTType(contentTypeId) else {
    FileHandle.standardError.write("无法解析 UTI \(contentTypeId)\n".data(using: .utf8)!)
    exit(1)
}

/// Bundle id of the app macOS would currently use for the Markdown UTI.
func currentHandler() -> String? {
    guard let url = NSWorkspace.shared.urlForApplication(toOpen: contentType) else { return nil }
    return Bundle(url: url)?.bundleIdentifier
}

func appURL(for bundleId: String) -> URL? {
    NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId)
}

let args = Array(CommandLine.arguments.dropFirst())
let showOnly = args.first == "--show" || args.first == "-s"
let bundleId = (showOnly || args.isEmpty) ? defaultBundleId : args[0]

let previous = currentHandler()
print("UTI            : \(contentTypeId)")
print("当前默认打开方式 : \(previous ?? "（未设置）")")

if showOnly {
    if let p = previous, let u = appURL(for: p) { print("应用位置        : \(u.path)") }
    exit(0)
}

guard let target = appURL(for: bundleId) else {
    FileHandle.standardError.write("找不到已安装的应用：\(bundleId)\n".data(using: .utf8)!)
    FileHandle.standardError.write("请确认它在 /Applications 中，并已执行 lsregister -f。\n".data(using: .utf8)!)
    exit(1)
}
print("目标应用        : \(target.path)")

// NSWorkspace answers on a background queue; wait for it rather than firing and forgetting.
let done = DispatchSemaphore(value: 0)
var setError: Error?
NSWorkspace.shared.setDefaultApplication(at: target, toOpen: contentType) { error in
    setError = error
    done.signal()
}
if done.wait(timeout: .now() + 20) == .timedOut {
    FileHandle.standardError.write("设置超时：LaunchServices 没有在 20 秒内回应。\n".data(using: .utf8)!)
    exit(1)
}
if let error = setError {
    FileHandle.standardError.write("设置失败：\(error.localizedDescription)\n".data(using: .utf8)!)
    exit(1)
}

// LaunchServices updates its database asynchronously: read the handler back until it agrees.
var applied: String?
for _ in 0..<40 {
    applied = currentHandler()
    if applied == bundleId { break }
    Thread.sleep(forTimeInterval: 0.25)
}
guard applied == bundleId else {
    FileHandle.standardError.write("设置未生效：当前仍然是 \(applied ?? "（未设置）")。\n".data(using: .utf8)!)
    exit(1)
}

print("新的默认打开方式 : \(applied ?? bundleId)")
print("")
// A revert hint that points back at the app we just set would be useless.
let revertTo = (previous == nil || previous == bundleId) ? fallbackBundleId : previous!
if previous == nil || previous == bundleId {
    print("还原方法（之前没有其他默认应用，下面是一个常见选择）：")
} else {
    print("还原方法：")
}
print("  swift scripts/set-default-md.swift \(revertTo)")
print("（public.plain-text 未被修改，.txt 等文件的默认应用保持不变）")
