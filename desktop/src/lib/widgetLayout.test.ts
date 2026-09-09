import { describe, expect, it } from "vitest";
import { fitWidgetLayout } from "./widgetLayout";

describe("content-sized layout", () => {
  const items = [{ i: "a", x: 0, y: 0, w: 6, h: 2 }, { i: "b", x: 6, y: 0, w: 6, h: 2 }, { i: "c", x: 0, y: 2, w: 6, h: 2 }];
  it("grows content and pushes only overlapping rows", () => {
    const fit = fitWidgetLayout(items, { a: 530 }, 12);
    expect(fit[0]).toMatchObject({ h: 11, minH: 11 });
    expect(fit[1].y).toBe(0);
    expect(fit[2].y).toBe(11);
    expect(items[0].h).toBe(2);
  });
  it("is stable across repeated measurement and respects a larger manual height", () => {
    const once = fitWidgetLayout(items, { a: 530 }, 12);
    expect(fitWidgetLayout(once, { a: 530 }, 12)).toEqual(once);
    expect(fitWidgetLayout([{ ...items[0], h: 20 }], { a: 530 }, 12)[0].h).toBe(20);
  });
});
