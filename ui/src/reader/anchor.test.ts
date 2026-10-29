// Pure anchor resolution: a highlight must find its text again after the
// chapter is re-rendered, even if offsets shift (font change, re-flow).

import { describe, expect, it } from "vitest";
import { locateQueryNear, resolveAnchor, type AnchorData } from "./anchor";

const text = "It was the best of times, it was the worst of times, it was the age of wisdom.";

function anchorAt(start: number, end: number, extra: Partial<AnchorData> = {}): AnchorData {
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - 12), start),
    suffix: text.slice(end, end + 12),
    start,
    end,
    ...extra,
  };
}

describe("resolveAnchor", () => {
  it("returns the stored offsets when the quote still matches", () => {
    const anchor = anchorAt(8, 25);
    expect(resolveAnchor(text, anchor)).toEqual({ start: 8, end: 25 });
  });

  it("re-finds the quote when offsets shifted", () => {
    const anchor = anchorAt(8, 25);
    const shifted = `Preamble. ${text}`;
    const found = resolveAnchor(shifted, anchor);
    expect(found).not.toBeNull();
    expect(shifted.slice(found!.start, found!.end)).toBe(anchor.quote);
    expect(found!.start).toBe(18);
  });

  it("prefers the match whose context matches over the first occurrence", () => {
    const duplicated = `${text} …and again: ${text}`;
    const anchor = anchorAt(41, 58); // "the age of wisdom" in the first copy
    const found = resolveAnchor(duplicated, anchor);
    expect(found).not.toBeNull();
    expect(found!.start).toBe(41);
  });

  it("falls back to a case-insensitive search", () => {
    const anchor = anchorAt(8, 25, { quote: "IT WAS THE BEST" });
    const found = resolveAnchor(text, anchor);
    expect(found).not.toBeNull();
    expect(text.slice(found!.start, found!.end)).toBe("It was the best");
  });

  it("returns null when the quote is gone entirely", () => {
    const anchor: AnchorData = {
      quote: "a phrase that never existed",
      prefix: "",
      suffix: "",
      start: 3,
      end: 30,
    };
    expect(resolveAnchor(text, anchor)).toBeNull();
  });
});

describe("locateQueryNear", () => {
  it("finds the occurrence closest to the estimated offset", () => {
    const many = `${"word ".repeat(50)}needle ${"word ".repeat(50)}needle`;
    const nearEnd = locateQueryNear(many, "needle", many.length - 10);
    expect(nearEnd).not.toBeNull();
    expect(nearEnd!.start).toBe(many.lastIndexOf("needle"));
  });

  it("ignores case", () => {
    const found = locateQueryNear(text, "BEST OF TIMES", 0);
    expect(found).not.toBeNull();
    expect(text.slice(found!.start, found!.end)).toBe("best of times");
  });

  it("returns null when there is no match", () => {
    expect(locateQueryNear(text, "kangaroo", 0)).toBeNull();
    expect(locateQueryNear(text, "   ", 0)).toBeNull();
  });
});
