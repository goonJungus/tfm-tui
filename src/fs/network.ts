import { execFileSync } from "node:child_process";
import path from "node:path";
import { isWithinOrEqual } from "./fsutil";
import { isDarwin } from "./platform";

// --- Network locations: primitives for the gvfs bridge (Linux) and the
// /Volumes mount model (macOS). tfm does not implement a remote VFS — the
// platform mounter (gio/GVFS, Finder) mounts the share and its path is an
// ordinary local directory, so every fs module (listing, transfer, preview)
// works unchanged. Everything here is pure input parsing / argv building /
// name mapping, except mountTableSync — the one platform-fact read, kept
// next to its parser like fsutil's /proc/mounts read. ---

// schemes `gio mount` can handle out of the box
export const NETWORK_SCHEMES = ["sftp", "ssh", "ftp", "smb", "dav", "davs", "nfs", "afp", "mtp", "gphoto2"] as const;

export type ServerInput = { uri: string; label: string };

export type GvfsMountName = {
  scheme: string;
  host: string;
  user?: string;
  share?: string;
  uri: string;
  label: string;
};

export const gvfsRoot = (): string => {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) return path.join(runtime, "gvfs");
  // process.getuid is undefined on Windows; tfm is Linux-only but keep tsc happy
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  return `/run/user/${uid}/gvfs`;
};

// --- macOS mount table (BSD `mount` output) ---
// Lines look like: `//user@host/share on /Volumes/share (smbfs, nodev, …)`.
// The mountpoint may contain spaces; the source may not contain " on ".
export type MountTableEntry = { source: string; mountpoint: string; fstype: string };

export const parseMountTable = (text: string): MountTableEntry[] => {
  const out: MountTableEntry[] = [];
  for (const line of text.split("\n")) {
    const on = line.indexOf(" on ");
    if (on < 0) continue;
    const paren = line.lastIndexOf(" (");
    if (paren < 0) continue;
    const source = line.slice(0, on);
    const mountpoint = line.slice(on + 4, paren);
    const fstype = line.slice(paren + 2).split(",")[0]?.trim() ?? "";
    if (source && mountpoint && fstype) out.push({ source, mountpoint, fstype });
  }
  return out;
};

// filesystem types that mean "this /Volumes mount is a network share"
export const NETWORK_FSTYPES: ReadonlySet<string> = new Set(["smbfs", "nfs", "afpfs", "webdav"]);

export const mountTableSync = (): string => {
  try {
    return execFileSync("/sbin/mount", [], { encoding: "utf8", timeout: 2000 });
  } catch {
    return "";
  }
};

// best-effort inverse of a mount: the server URI a mountpoint came from.
// smbfs sources are `//user@host/share`; nfs sources are `host:/export`.
// afp sources are opaque ids — no URI (null), the mount is label-only.
export const darwinMountUri = (source: string, fstype: string): string | null => {
  if (fstype === "smbfs" && source.startsWith("//")) return `smb:${source}`;
  if (fstype === "nfs") {
    const colon = source.indexOf(":");
    if (colon > 0) return `nfs://${source.slice(0, colon)}${source.slice(colon + 1)}`;
  }
  if (source.startsWith("afp://")) return source;
  return null;
};

// Linux: a path is network iff it lives under the gvfs FUSE root. macOS:
// iff it lives under a network-typed mount (the mount table is the only
// authority — /Volumes also holds local disks). mountText is the test seam
// for the darwin branch.
export const isNetworkPath = (p: string, platform: string = process.platform, mountText?: string): boolean => {
  if (isDarwin(platform)) {
    const entries = parseMountTable(mountText ?? mountTableSync());
    return entries.some((e) => NETWORK_FSTYPES.has(e.fstype) && isWithinOrEqual(p, e.mountpoint));
  }
  return isWithinOrEqual(p, gvfsRoot());
};

const prettify = (uri: string): string => {
  const withoutScheme = uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
  const userless = withoutScheme.includes("@") ? withoutScheme.slice(withoutScheme.indexOf("@") + 1) : withoutScheme;
  return userless || uri;
};

// Accepts a gvfs URI (`sftp://user@host/path`) or scp-like `[user@]host:/path`
// (→ sftp). Rejects whitespace/control chars so a pasted shell line can never
// smuggle a second argument (argv is array-passed anyway, but bad input should
// fail loudly at parse time).
export const parseServerInput = (raw: string): ServerInput | null => {
  const s = raw.trim();
  if (!s) return null;
  if (/\s/.test(s)) return null;
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return null;
  }
  const schemeMatch = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    const scheme = schemeMatch[1]?.toLowerCase();
    if (scheme === undefined || !(NETWORK_SCHEMES as readonly string[]).includes(scheme)) return null;
    return { uri: s, label: prettify(s) };
  }
  // scp-like `[user@]host:/path` — assume ssh/sftp
  const scp = s.match(/^([^@/]+@)?([^:/]+):(.*)$/);
  if (!scp) return null;
  const user = scp[1] ? scp[1].slice(0, -1) : "";
  const host = scp[2];
  if (host === undefined) return null;
  let rest = scp[3] ?? "";
  if (rest && !rest.startsWith("/")) rest = `/${rest}`;
  return { uri: `sftp://${user ? `${user}@` : ""}${host}${rest || "/"}`, label: host };
};

export const buildMountArgs = (uri: string): string[] => ["mount", uri];

export const buildUnmountArgs = (uri: string): string[] => ["mount", "-u", uri];

// gvfs names the FUSE dir by the connection: `sftp:host=H,user=U,port=P`,
// `smb-share:server=H,share=S`. Decode it back into a URI + display label so a
// mount made outside tfm is still navigable/disconnectable.
export const parseGvfsName = (name: string): GvfsMountName | null => {
  const colon = name.indexOf(":");
  if (colon <= 0) return null;
  let scheme = name.slice(0, colon).toLowerCase();
  const kv: Record<string, string> = {};
  for (const pair of name.slice(colon + 1).split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).toLowerCase();
    let val = pair.slice(eq + 1);
    try {
      val = decodeURIComponent(val);
    } catch {}
    if (!(key in kv)) kv[key] = val;
  }
  if (scheme.endsWith("-share")) scheme = scheme.slice(0, -"-share".length);
  const host = kv.host ?? kv.server ?? "";
  const user = kv.user;
  const share = kv.share;
  const port = kv.port;
  if (!host) return null;
  const auth = user ? `${encodeURIComponent(user)}@` : "";
  const authority = port ? `${host}:${port}` : host;
  const pathPart = share ? `/${encodeURIComponent(share)}` : "/";
  const uri = `${scheme}://${auth}${authority}${pathPart}`;
  return { scheme, host, user, share, uri, label: share ? `${host}/${share}` : host };
};

// --- gio credential prompts ---
// `gio mount` (glib gio-tool-mount.c ask_password_cb / ask_question_cb) prints
// a message line, then a prompt with NO trailing newline, then fgets-blocks on
// stdin — one line per prompt, in User, Domain, Password order (or a numbered
// Choice for a question). Output is flushed via the glib log writer even when
// stdout is a pipe, so a streaming reader can drive it. Labels are forced to
// English by spawning with LC_ALL=C.
export type GioPrompt = {
  kind: "user" | "domain" | "password" | "choice";
  title: string;
  default?: string;
  password: boolean;
  // message printed before the prompt (question text for Choice), trimmed
  message?: string;
  consumed: number;
};

const GIO_PROMPT_RE = /^(User|Domain|Password|Choice)(?: \[([^\]]*)\])?: $/;

// If `buf` ends on a gio prompt, return it; otherwise null. A chunk can carry
// the message + prompt together, so scan only the final line.
export const takeGioPrompt = (buf: string): GioPrompt | null => {
  const nl = buf.lastIndexOf("\n");
  const tail = buf.slice(nl + 1);
  const m = GIO_PROMPT_RE.exec(tail);
  if (!m) return null;
  const raw = m[1];
  if (raw === undefined) return null;
  const kind = raw.toLowerCase() as GioPrompt["kind"];
  const message = buf.slice(0, nl + 1).trim();
  return {
    kind,
    title: kind === "user" ? "User name" : raw,
    default: m[2],
    password: kind === "password",
    ...(message ? { message } : {}),
    consumed: buf.length,
  };
};
