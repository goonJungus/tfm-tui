import { describe, expect, test } from "bun:test";
import { deviceSpawn, isDarwin, openerCommand } from "./platform";

describe("platform seam", () => {
  test("opener command per platform", () => {
    expect(openerCommand("darwin")).toBe("open");
    expect(openerCommand("linux")).toBe("xdg-open");
  });

  test("isDarwin", () => {
    expect(isDarwin("darwin")).toBe(true);
    expect(isDarwin("linux")).toBe(false);
    expect(isDarwin("win32")).toBe(false);
  });
});

describe("deviceSpawn", () => {
  test("linux passes udisksctl argv through untouched", () => {
    expect(deviceSpawn(["unmount", "-b", "/dev/sdb1"], "linux")).toEqual({
      cmd: "udisksctl",
      args: ["unmount", "-b", "/dev/sdb1"],
    });
  });

  test("darwin translates the verbs to diskutil (power-off = eject)", () => {
    expect(deviceSpawn(["mount", "-b", "/dev/disk2s1"], "darwin")).toEqual({
      cmd: "diskutil",
      args: ["mount", "/dev/disk2s1"],
    });
    expect(deviceSpawn(["unmount", "-b", "/dev/disk2s1"], "darwin")).toEqual({
      cmd: "diskutil",
      args: ["unmount", "/dev/disk2s1"],
    });
    expect(deviceSpawn(["power-off", "-b", "/dev/disk2"], "darwin")).toEqual({
      cmd: "diskutil",
      args: ["eject", "/dev/disk2"],
    });
  });
});
