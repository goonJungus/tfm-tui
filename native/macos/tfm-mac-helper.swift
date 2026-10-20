// tfm-mac-helper — the macOS-native bits tfm can't reach from Bun:
// LaunchServices handler enumeration (the Open With… picker) and
// FileManager trashing (so Finder offers Put Back on tfm-trashed files).
// One-shot CLI: tfm spawns it per operation and reads stdout; nothing links
// it, and it must stay dependency-free (Foundation + AppKit only).
//
//   tfm-mac-helper handlers <file>  → JSON [{id, name, path, default}],
//                                     default handler first
//   tfm-mac-helper trash <path>     → prints the resulting path in the trash
import Foundation
import AppKit

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(Data((msg + "\n").utf8))
    exit(1)
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "handlers":
    guard args.count == 3 else { fail("usage: tfm-mac-helper handlers <file>") }
    let url = URL(fileURLWithPath: args[2])
    let ws = NSWorkspace.shared
    let defPath = ws.urlForApplication(toOpen: url)?.path
    var seen = Set<String>()
    var out: [[String: Any]] = []
    for app in ws.urlsForApplications(toOpen: url) {
        let p = app.path
        if seen.contains(p) { continue }
        seen.insert(p)
        out.append([
            "id": Bundle(path: p)?.bundleIdentifier ?? "",
            "name": FileManager.default.displayName(atPath: p),
            "path": p,
            "default": defPath == p,
        ])
    }
    // default first, the rest in LaunchServices order (matches the Linux
    // picker's default-first list)
    if let i = out.firstIndex(where: { ($0["default"] as? Bool) == true }), i != 0 {
        out.insert(out.remove(at: i), at: 0)
    }
    do {
        let data = try JSONSerialization.data(withJSONObject: out)
        print(String(data: data, encoding: .utf8)!)
    } catch {
        fail("handlers failed: \(error.localizedDescription)")
    }
case "trash":
    guard args.count == 3 else { fail("usage: tfm-mac-helper trash <path>") }
    let url = URL(fileURLWithPath: args[2])
    var result: NSURL?
    do {
        try FileManager.default.trashItem(at: url, resultingItemURL: &result)
    } catch {
        fail("trash failed: \(error.localizedDescription)")
    }
    guard let r = result as URL? else { fail("trash failed: no resulting URL") }
    print(r.path)
default:
    fail("usage: tfm-mac-helper <handlers|trash> …")
}
