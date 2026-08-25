import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../components/ControlsView.tsx", import.meta.url), "utf8");

describe("operational device layout", () => {
  it("renders Power LED as one operational console without a duplicate device tile", () => {
    expect(source).toContain("operational-device-console power-led-console");
    expect(source).toContain('onClick={() => onSend("powled")}');
    expect(source).toContain("heater-schedule power-led-schedule");
    expect(source).not.toMatch(/<DeviceAction[^>]+textKey="controls\.powerLed"/);
  });

  it("keeps authoritative schedule status inside the Power LED console", () => {
    const consoleStart = source.indexOf("operational-device-console power-led-console");
    const scheduleStart = source.indexOf("heater-schedule power-led-schedule", consoleStart);
    const consoleEnd = source.indexOf("export function ClimateWidget", consoleStart);
    expect(consoleStart).toBeGreaterThan(-1);
    expect(scheduleStart).toBeGreaterThan(consoleStart);
    expect(scheduleStart).toBeLessThan(consoleEnd);
  });
});
