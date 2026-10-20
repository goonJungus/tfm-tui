// --- Platform seam: the ONE place platform differences are named. Every
// darwin/linux branch in the port routes through here (directly, or through
// the per-domain tool tables in clipboard/places/elevate), so call sites stay
// platform-free. Functions take `platform` as an injectable parameter
// (defaulting to process.platform) so tests can pin either side. ---

export const isDarwin = (platform: string = process.platform): boolean => platform === "darwin";

// default-application opener: `open` on macOS, `xdg-open` on Linux — same
// fire-and-forget, detached semantics and argv shape ([target]) on both.
export const openerCommand = (platform: string = process.platform): string =>
  platform === "darwin" ? "open" : "xdg-open";

// device spawn: everything above this seam (ui-chrome's eject chain and its
// tests) speaks udisksctl argv — ["mount"|"unmount"|"power-off", "-b", dev].
// Linux spawns udisksctl as-is. macOS translates to diskutil, which takes
// the device path directly (no -b); `eject` is the power-off analogue (it
// unmounts every volume on the disk, then severs/spins it down).
export const deviceSpawn = (
  args: string[],
  platform: string = process.platform,
): { cmd: string; args: string[] } => {
  if (platform !== "darwin") return { cmd: "udisksctl", args };
  const [verb, , device] = args;
  switch (verb) {
    case "mount":
      return { cmd: "diskutil", args: ["mount", device ?? ""] };
    case "unmount":
      return { cmd: "diskutil", args: ["unmount", device ?? ""] };
    case "power-off":
      return { cmd: "diskutil", args: ["eject", device ?? ""] };
    default:
      return { cmd: "diskutil", args };
  }
};
