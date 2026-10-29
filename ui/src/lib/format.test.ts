import { describe, expect, it } from "vitest";
import { basename, clamp, contrastText, hexToRgb, pct, shade } from "./format";

describe("format helpers", () => {
  it("clamps percentages into 0..100", () => {
    expect(pct(0.5)).toBe(50);
    expect(pct(1.4)).toBe(100);
    expect(pct(-1)).toBe(0);
  });

  it("clamps numeric ranges", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });

  it("reads hex colours for contrast decisions", () => {
    expect(hexToRgb("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb("#2f5d62")).toEqual({ r: 47, g: 93, b: 98 });
    expect(contrastText("#f4ecd8")).toBe("#241a12");
    expect(contrastText("#1b2530")).toBe("#f6ead0");
  });

  it("shades towards and away from white", () => {
    expect(shade("#000000", 1)).toBe("#ffffff");
    expect(shade("#ffffff", -1)).toBe("#000000");
    expect(shade("#2f5d62", 0)).toBe("#2f5d62");
  });

  it("extracts the file name from a path", () => {
    expect(basename("/home/me/Books/novel.epub")).toBe("novel.epub");
    expect(basename("novel.pdf")).toBe("novel.pdf");
  });
});
