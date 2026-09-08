import { describe, expect, it } from "vitest";
import { initialLegacyState, parseLegacyLine } from "./protocol";
import { commandExpectation } from "./commandFeedback";

describe("independent lamp schedule", () => {
  it("routes schedule commands only to lampk", () => {
    for (const command of ["LSQ", "LSD", "LSB1234ABCD111", "LSP1234ABCD0116817F", "LSC1234ABCD"])
      expect(commandExpectation(command)?.owner).toBe("lampk");
    expect(commandExpectation("PSQ")?.owner).toBe("kPowerLed");
  });
  it("keeps lamp metadata, points and outputs separate from Power LED", () => {
    const power = parseLegacyLine(initialLegacyState, "PSM1234ABCD11110F1");
    const lamp = parseLegacyLine(power, "LSM1234ABCE11110F0");
    const point = parseLegacyLine(lamp, "LSP1234ABCE0116817F");
    expect(point.devices.lamp).toBe(false);
    expect(point.devices.powerLed).toBe(true);
    expect(point.controls.lampSchedule.points[0]?.minuteOfDay).toBe(360);
    expect(point.controls.powerLedSchedule).toEqual(power.controls.powerLedSchedule);
    expect(point.controls.lampSchedule.generation).toBe(0x1234abce);
  });
});
