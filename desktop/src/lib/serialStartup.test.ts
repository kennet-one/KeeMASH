import { describe, expect, it } from "vitest";
import type { SerialPortInfo } from "../types";
import { preferredStartupPort } from "./serialStartup";

const port = (path: string): SerialPortInfo => ({
  path,
});

describe("serial startup selection", () => {
  it("prefers a saved available port", () => {
    expect(preferredStartupPort([port("COM4"), port("COM8")], "COM8")).toBe("COM8");
  });

  it("falls back only to COM4", () => {
    expect(preferredStartupPort([port("COM4"), port("COM8")], "COM9")).toBe("COM4");
    expect(preferredStartupPort([port("COM8")], null)).toBeNull();
  });
});
