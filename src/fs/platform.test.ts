import { describe, expect, test } from "bun:test";
import { isDarwin, openerCommand } from "./platform";

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
