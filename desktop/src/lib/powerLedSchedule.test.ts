import { describe, expect, it } from "vitest";
import {
  defaultPowerLedSchedulePoints, encodePowerLedScheduleTransaction,
  parsePowerLedScheduleMeta, parsePowerLedSchedulePoint,
  POWER_LED_SCHEDULE_ALL_DAYS, validatePowerLedSchedulePoints,
} from "./powerLedSchedule";

describe("power LED schedule protocol", () => {
  it("encodes bounded ON/OFF transactions and parses authoritative replies", () => {
    const commands = encodePowerLedScheduleTransaction(0x1234abcd, true, true, [{
      enabled: true,
      minuteOfDay: 360,
      stateOn: true,
      daysMask: POWER_LED_SCHEDULE_ALL_DAYS,
    }]);
    expect(commands).toEqual([
      "PSB1234ABCD111",
      "PSP1234ABCD0116817F",
      "PSC1234ABCD",
    ]);
    expect(commands.every((command) => command.length <= 32)).toBe(true);
    expect(parsePowerLedScheduleMeta("PSM1234ABCD11110F1")).toMatchObject({
      generation: 0x1234abcd,
      count: 1,
      enabled: true,
      persistenceEnabled: true,
      clockValid: true,
      activeIndex: 0,
      nextIndex: null,
      outputOn: true,
    });
    expect(parsePowerLedSchedulePoint(commands[1])).toMatchObject({
      generation: 0x1234abcd,
      index: 0,
      point: { minuteOfDay: 360, stateOn: true, daysMask: 0x7f },
    });
  });

  it("rejects overlapping active points and accepts disjoint weekdays", () => {
    const point = { enabled: true, minuteOfDay: 360, stateOn: true, daysMask: 1 };
    expect(validatePowerLedSchedulePoints([point, { ...point, stateOn: false }])).toBe("overlap");
    expect(validatePowerLedSchedulePoints([point, { ...point, daysMask: 2 }])).toBeNull();
  });

  it("provides disabled morning ON and night OFF templates", () => {
    expect(defaultPowerLedSchedulePoints()).toEqual([
      { enabled: false, minuteOfDay: 360, stateOn: true, daysMask: 0x7f },
      { enabled: false, minuteOfDay: 1380, stateOn: false, daysMask: 0x7f },
    ]);
  });
});
