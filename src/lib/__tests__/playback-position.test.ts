import { expect, it } from "vitest";
import { relativeSeekPosition } from "../playback-position";
it("wraps exact positive and negative fractional-duration multiples to the start in Repeat", () => {
  for (const delta of [10, -10]) expect(relativeSeekPosition({ position: 0, duration: .1, repeat: true }, delta)).toBe(0);
  expect(relativeSeekPosition({ position: .025, duration: .1, repeat: true }, 10)).toBeCloseTo(.025, 12);
  expect(relativeSeekPosition({ position: 0, duration: .1, repeat: false }, 10)).toBe(.1);
});
