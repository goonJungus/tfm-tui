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
