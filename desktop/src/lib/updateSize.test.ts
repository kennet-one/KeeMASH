import { describe, expect, it } from "vitest";
import { updateDownloadSize } from "./updateSize";

describe("installer download size", () => {
  it("uses MiB and retains the exact byte count", () => {
    expect(updateDownloadSize(9421308, "en-US")).toEqual({ compact: "9.0 MiB", exact: "9,421,308 B" });
    expect(updateDownloadSize(9421308, "uk-UA")?.compact).toBe("9,0 MiB");
  });
  it("does not turn unknown or malformed sizes into zero", () => {
    for (const value of [null, undefined, 0, -1, NaN, Infinity, 1.5]) expect(updateDownloadSize(value, "en-US")).toBeNull();
  });
});
