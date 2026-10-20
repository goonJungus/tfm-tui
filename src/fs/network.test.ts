import { afterEach, describe, expect, test } from "bun:test";
import {
  buildMountArgs,
  buildUnmountArgs,
  gvfsRoot,
  darwinMountUri,
  isNetworkPath,
  parseGvfsName,
  parseMountTable,
  parseServerInput,
  takeGioPrompt,
} from "./network";

const oldRuntime = process.env.XDG_RUNTIME_DIR;
afterEach(() => {
  if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = oldRuntime;
});

describe("parseServerInput", () => {
  test("accepts a gvfs URI and derives a host label", () => {
    expect(parseServerInput("sftp://bob@example.com/srv")).toEqual({
      uri: "sftp://bob@example.com/srv",
      label: "example.com/srv",
    });
    expect(parseServerInput("smb://nas/pub")).toEqual({ uri: "smb://nas/pub", label: "nas/pub" });
  });

  test("accepts scp-like [user@]host:/path as sftp", () => {
    expect(parseServerInput("bob@example.com:/srv")).toEqual({
      uri: "sftp://bob@example.com/srv",
      label: "example.com",
    });
    expect(parseServerInput("host:relative")).toEqual({ uri: "sftp://host/relative", label: "host" });
    expect(parseServerInput("host:")).toEqual({ uri: "sftp://host/", label: "host" });
  });

  test("rejects unknown schemes, file://, whitespace and empty input", () => {
    expect(parseServerInput("file:///etc")).toBeNull();
    expect(parseServerInput("gopher://x")).toBeNull();
    expect(parseServerInput("")).toBeNull();
    expect(parseServerInput("  sftp://a b/")).toBeNull();
    expect(parseServerInput("sftp://host/\x07")).toBeNull();
  });
});

describe("gio argv builders", () => {
  test("mount/unmount pass the URI as one argv element, never a shell string", () => {
    expect(buildMountArgs("sftp://bob@example.com/srv")).toEqual(["mount", "sftp://bob@example.com/srv"]);
    expect(buildUnmountArgs("sftp://bob@example.com/srv")).toEqual(["mount", "-u", "sftp://bob@example.com/srv"]);
  });
});

describe("gvfsRoot / isNetworkPath", () => {
  test("honors $XDG_RUNTIME_DIR", () => {
    process.env.XDG_RUNTIME_DIR = "/run/user/4242";
    expect(gvfsRoot()).toBe("/run/user/4242/gvfs");
    expect(isNetworkPath("/run/user/4242/gvfs/sftp:host=a/foo", "linux")).toBe(true);
    expect(isNetworkPath("/run/user/4242/gvfs", "linux")).toBe(true);
    expect(isNetworkPath("/run/user/4242/gvfs-other", "linux")).toBe(false);
    expect(isNetworkPath("/home/bob", "linux")).toBe(false);
  });
});

describe("parseGvfsName", () => {
  test("decodes an sftp fuse dir into a disconnectable URI", () => {
    const m = parseGvfsName("sftp:host=example.com,user=bob,port=2222");
    expect(m).not.toBeNull();
    expect(m!.scheme).toBe("sftp");
    expect(m!.uri).toBe("sftp://bob@example.com:2222/");
    expect(m!.label).toBe("example.com");
  });

  test("decodes smb-share (server/share) and keeps a human label", () => {
    const m = parseGvfsName("smb-share:server=nas,share=pub,user=bob");
    expect(m!.scheme).toBe("smb");
    expect(m!.uri).toBe("smb://bob@nas/pub");
    expect(m!.label).toBe("nas/pub");
  });

  test("returns null without a host", () => {
    expect(parseGvfsName("not-a-mount")).toBeNull();
    expect(parseGvfsName("sftp:user=bob")).toBeNull();
  });
});

describe("takeGioPrompt", () => {
  test("detects a User prompt with its default", () => {
    const p = takeGioPrompt("Password required for bob@host\nUser [bob]: ");
    expect(p).not.toBeNull();
    expect(p!.kind).toBe("user");
    expect(p!.title).toBe("User name");
    expect(p!.default).toBe("bob");
    expect(p!.password).toBe(false);
    expect(p!.message).toBe("Password required for bob@host");
    expect(p!.consumed).toBe("Password required for bob@host\nUser [bob]: ".length);
  });

  test("marks a Password prompt for masking and carries no default", () => {
    const p = takeGioPrompt("User [bob]: \n");
    expect(p).toBeNull(); // trailing newline = not a pending prompt
    const pw = takeGioPrompt("Password: ");
    expect(pw!.kind).toBe("password");
    expect(pw!.password).toBe(true);
    expect(pw!.default).toBeUndefined();
  });

  test("detects a numbered host-key question", () => {
    const p = takeGioPrompt("The identity of host is unknown.\n[1] Yes\n[2] No\nChoice: ");
    expect(p!.kind).toBe("choice");
    expect(p!.title).toBe("Choice");
    expect(p!.message).toBe("The identity of host is unknown.\n[1] Yes\n[2] No");
  });

  test("returns null for ordinary output", () => {
    expect(takeGioPrompt("")).toBeNull();
    expect(takeGioPrompt("Mounting...\n")).toBeNull();
    expect(takeGioPrompt("User: notatail")).toBeNull();
  });
});

const MOUNT_TABLE = [
  "/dev/disk3s1 on / (apfs, local, journaled)",
  "//jana@junguspc/C on /Volumes/junguspc (smbfs, nodev, nosuid, mounted by jana)",
  "nas.local:/export/media on /Volumes/media (nfs, nodev, nosuid, mounted by jana)",
  "/dev/disk4s1 on /Volumes/USBSTICK (exfat, local, nodev, nosuid)",
  "//guest@files.local/My Share on /Volumes/My Share (smbfs, nodev, nosuid)",
].join("\n");

describe("darwin mount table", () => {
  test("parseMountTable splits source / mountpoint / fstype (spaces survive)", () => {
    const entries = parseMountTable(MOUNT_TABLE);
    expect(entries).toHaveLength(5);
    expect(entries[1]).toEqual({ source: "//jana@junguspc/C", mountpoint: "/Volumes/junguspc", fstype: "smbfs" });
    expect(entries[4]!.mountpoint).toBe("/Volumes/My Share");
  });

  test("isNetworkPath on darwin keys off network fstypes only", () => {
    expect(isNetworkPath("/Volumes/junguspc/Users/x", "darwin", MOUNT_TABLE)).toBe(true);
    expect(isNetworkPath("/Volumes/media/film.mkv", "darwin", MOUNT_TABLE)).toBe(true);
    expect(isNetworkPath("/Volumes/My Share/f", "darwin", MOUNT_TABLE)).toBe(true);
    // a local USB volume under /Volumes is NOT network
    expect(isNetworkPath("/Volumes/USBSTICK/f", "darwin", MOUNT_TABLE)).toBe(false);
    expect(isNetworkPath("/Users/jana/f", "darwin", MOUNT_TABLE)).toBe(false);
    // a sibling prefix is not inside the mount
    expect(isNetworkPath("/Volumes/junguspc-other/f", "darwin", MOUNT_TABLE)).toBe(false);
  });

  test("darwinMountUri reconstructs smb/nfs URIs, gives up on opaque sources", () => {
    expect(darwinMountUri("//jana@junguspc/C", "smbfs")).toBe("smb://jana@junguspc/C");
    expect(darwinMountUri("nas.local:/export/media", "nfs")).toBe("nfs://nas.local/export/media");
    expect(darwinMountUri("afp_0TV7kp0TV7kp0TV7kp0TV-1.2.3.4", "afpfs")).toBeNull();
  });
});
