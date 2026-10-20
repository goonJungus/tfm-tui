import path from "node:path";
import { readdir } from "node:fs/promises";
import { errMessage } from "../lib/uiutil";
import { darwinMountUri, gvfsRoot, NETWORK_FSTYPES, parseGvfsName, parseMountTable, parseServerInput } from "./network";
import type { NotifyLevel } from "../lib/notify-level";

// --- Network location orchestration: connect/disconnect through `gio mount`
// and enumerate active gvfs mounts. All process/fs access is injected (sink),
// so the unit is testable without a server or a desktop session. Connecting
// goes through GVFS so the mount becomes an ordinary local FUSE path. ---

export type GioResult = { code: number; stdout: string; stderr: string };

export type NetworkSink = {
  gvfsRoot(): string;
  // mount a URI through gio, driving any credential prompts; unmount is
  // non-interactive. Both resolve the exit code + captured output.
  mount(uri: string): Promise<GioResult>;
  unmount(uri: string): Promise<GioResult>;
  readdir(dir: string): Promise<string[]>;
  notify(msg: string, title?: string, level?: NotifyLevel): void;
  log?(msg: string): void;
};

export type NetworkMount = { path: string; uri: string; label: string; scheme: string };

const lastLine = (s: string): string =>
  s
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() ?? "";

// active gvfs mounts under the runtime dir; unreadable/missing root = none
export const listNetworkMounts = async (
  readdirImpl: (dir: string) => Promise<string[]> = (d) => readdir(d),
): Promise<NetworkMount[]> => {
  try {
    const dir = gvfsRoot();
    const names = await readdirImpl(dir);
    const out: NetworkMount[] = [];
    for (const name of names) {
      const parsed = parseGvfsName(name);
      if (!parsed) continue;
      out.push({ path: path.join(dir, name), uri: parsed.uri, label: parsed.label, scheme: parsed.scheme });
    }
    return out;
  } catch {
    return [];
  }
};

const nameMatchesUri = (name: string, uri: string): boolean => {
  const n = parseGvfsName(name);
  if (!n) return false;
  try {
    const u = new URL(uri);
    return n.scheme === u.protocol.replace(":", "") && n.host.toLowerCase() === u.hostname.toLowerCase();
  } catch {
    return false;
  }
};

// --- macOS: mounts live under /Volumes and the mount table is the source
// of truth (no gvfs root to readdir). The sink's mount goes through Finder
// (its credential UI, not tfm's), unmount is `umount` on the path. ---

export type DarwinNetworkSink = {
  mount(uri: string): Promise<GioResult>;
  unmount(mountPath: string): Promise<GioResult>;
  readMounts(): Promise<string>;
  notify(msg: string, title?: string, level?: NotifyLevel): void;
  log?(msg: string): void;
};

// schemes Finder can mount. sftp/ftp/mtp/gphoto2 have no stock macOS
// mounter — refused honestly at connect time instead of failing in Finder.
export const DARWIN_CONNECT_SCHEMES: ReadonlySet<string> = new Set(["smb", "afp", "nfs", "dav", "davs"]);

const darwinNetworkEntries = async (sink: DarwinNetworkSink): Promise<NetworkMount[]> => {
  try {
    return parseMountTable(await sink.readMounts())
      .filter((e) => NETWORK_FSTYPES.has(e.fstype) && e.mountpoint.startsWith("/Volumes/"))
      .map((e) => ({
        path: e.mountpoint,
        uri: darwinMountUri(e.source, e.fstype) ?? "",
        label: path.basename(e.mountpoint),
        scheme: e.fstype === "smbfs" ? "smb" : e.fstype === "afpfs" ? "afp" : e.fstype,
      }));
  } catch {
    return [];
  }
};

// sidebar enumeration (places calls this on darwin)
export const listNetworkMountsDarwin = (readMounts: () => Promise<string>): Promise<NetworkMount[]> =>
  darwinNetworkEntries({ readMounts } as DarwinNetworkSink);

export const makeNetworkActionsDarwin = (sink: DarwinNetworkSink) => {
  const uriByPath = new Map<string, string>();

  const connect = async (raw: string): Promise<string | null> => {
    const parsed = parseServerInput(raw);
    if (!parsed) {
      sink.notify("Unsupported server address", "network", "error");
      return null;
    }
    const scheme = parsed.uri.split(":")[0]?.toLowerCase() ?? "";
    if (!DARWIN_CONNECT_SCHEMES.has(scheme)) {
      sink.notify(`Can't connect to ${scheme}:// on macOS`, "network", "error");
      return null;
    }
    const before = new Set((await darwinNetworkEntries(sink)).map((m) => m.path));
    let res: GioResult;
    try {
      res = await sink.mount(parsed.uri);
    } catch (err) {
      sink.notify(`Connect failed · ${errMessage(err)}`, "network", "error");
      return null;
    }
    if (res.code !== 0) {
      const why = lastLine(res.stderr) || lastLine(res.stdout) || "unknown error";
      sink.notify(`Connect failed · ${why}`, "network", "error");
      sink.log?.(`finder mount ${parsed.uri} exit ${res.code}: ${why}`);
      return null;
    }
    // Finder returns once the mount exists, but the mount table can lag a
    // beat — poll like the gvfs resolver does
    let host = "";
    try {
      host = new URL(parsed.uri).hostname.toLowerCase();
    } catch {}
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 250));
      const entries = await darwinNetworkEntries(sink);
      const fresh = entries.filter((m) => !before.has(m.path));
      const picked = fresh.find((m) => m.uri.toLowerCase().includes(host)) ?? fresh[0];
      if (picked) {
        uriByPath.set(picked.path, parsed.uri);
        sink.notify(`Connected to ${parsed.label}`, "network", "success");
        return picked.path;
      }
    }
    sink.notify(`Connected to ${parsed.label} · no mount path`, "network", "error");
    return null;
  };

  const disconnect = async (mountPath: string): Promise<boolean> => {
    let res: GioResult;
    try {
      res = await sink.unmount(mountPath);
    } catch (err) {
      sink.notify(`Disconnect failed · ${errMessage(err)}`, "network", "error");
      return false;
    }
    if (res.code !== 0) {
      const why = lastLine(res.stderr) || lastLine(res.stdout) || "unknown error";
      sink.notify(`Disconnect failed · ${why}`, "network", "error");
      sink.log?.(`umount ${mountPath} exit ${res.code}: ${why}`);
      return false;
    }
    uriByPath.delete(mountPath);
    sink.notify(`Disconnected ${path.basename(mountPath)}`, "network", "success");
    return true;
  };

  return {
    connect,
    disconnect,
    rememberUri: (mountPath: string, uri: string): void => {
      uriByPath.set(mountPath, uri);
    },
    uriForPath: (mountPath: string): string | undefined => uriByPath.get(mountPath),
  };
};

export const makeNetworkActions = (sink: NetworkSink) => {
  // in-session uri per mount path (a gvfs dir name can be ambiguous to
  // reverse); falls back to reconstructing from the dir name
  const uriByPath = new Map<string, string>();

  const readNames = async (): Promise<string[]> => {
    try {
      return await sink.readdir(sink.gvfsRoot());
    } catch {
      return [];
    }
  };

  const resolveName = async (uri: string, before: Set<string>): Promise<string | null> => {
    // gio returns after the mount exists, but readdir can lag by a beat —
    // poll with a delay (back-to-back readdirs all fire within milliseconds
    // and a slow FUSE arrival deterministically reads "mount path not found"
    // after a SUCCESSFUL mount, orphaning it)
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 250));
      const names = await readNames();
      const fresh = names.filter((n) => !before.has(n));
      const picked = fresh[0] ?? names.find((n) => nameMatchesUri(n, uri));
      if (picked) return picked;
    }
    return null;
  };

  const connect = async (raw: string): Promise<string | null> => {
    const parsed = parseServerInput(raw);
    if (!parsed) {
      sink.notify("Unsupported server address", "network", "error");
      return null;
    }
    const before = new Set(await readNames());
    let res: GioResult;
    try {
      res = await sink.mount(parsed.uri);
    } catch (err) {
      sink.notify(`Connect failed · ${errMessage(err)}`, "network", "error");
      return null;
    }
    if (res.code !== 0) {
      const why = lastLine(res.stderr) || lastLine(res.stdout) || "unknown error";
      sink.notify(`Connect failed · ${why}`, "network", "error");
      sink.log?.(`gio mount ${parsed.uri} exit ${res.code}: ${why}`);
      return null;
    }
    const name = await resolveName(parsed.uri, before);
    if (!name) {
      sink.notify(`Connected to ${parsed.label} · no mount path`, "network", "error");
      return null;
    }
    const mountPath = path.join(sink.gvfsRoot(), name);
    uriByPath.set(mountPath, parsed.uri);
    sink.notify(`Connected to ${parsed.label}`, "network", "success");
    return mountPath;
  };

  const disconnect = async (mountPath: string, fallbackUri?: string): Promise<boolean> => {
    const name = path.basename(mountPath);
    const uri = uriByPath.get(mountPath) ?? fallbackUri ?? parseGvfsName(name)?.uri;
    if (!uri) {
      sink.notify("Can't find mount to disconnect", "network", "error");
      return false;
    }
    let res: GioResult;
    try {
      res = await sink.unmount(uri);
    } catch (err) {
      sink.notify(`Disconnect failed · ${errMessage(err)}`, "network", "error");
      return false;
    }
    if (res.code !== 0) {
      const why = lastLine(res.stderr) || lastLine(res.stdout) || "unknown error";
      sink.notify(`Disconnect failed · ${why}`, "network", "error");
      sink.log?.(`gio mount -u ${uri} exit ${res.code}: ${why}`);
      return false;
    }
    uriByPath.delete(mountPath);
    sink.notify(`Disconnected ${parseGvfsName(name)?.label ?? uri}`, "network", "success");
    return true;
  };

  return {
    connect,
    disconnect,
    rememberUri: (mountPath: string, uri: string): void => {
      uriByPath.set(mountPath, uri);
    },
    uriForPath: (mountPath: string): string | undefined => uriByPath.get(mountPath),
  };
};
