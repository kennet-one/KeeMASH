import { describe, expect, it } from "vitest";
import {
  defaultSchedulePoints, encodeScheduleTransaction, HEATER_SCHEDULE_ALL_DAYS,
  parseHeaterScheduleDiagnostics, parseScheduleMeta, parseSchedulePoint, validateSchedulePoints,
} from "./heaterSchedule";

describe("heater schedule protocol", () => {
  it("encodes a bounded transaction and parses its authoritative replies", () => {
    const commands = encodeScheduleTransaction(0x1234abcd, true, true, [{
      enabled: true,
      minuteOfDay: 360,
      targetC: 21.5,
      action: "auto",
      daysMask: HEATER_SCHEDULE_ALL_DAYS,
    }]);
    expect(commands).toEqual([
      "S5B1234ABCD111",
      "S5P1234ABCD011680D727F",
      "S5C1234ABCD",
    ]);
    expect(commands.every((command) => command.length <= 32)).toBe(true);
    expect(parseScheduleMeta("S5M1234ABCD11110F")).toMatchObject({ generation: 0x1234abcd, count: 1, enabled: true, persistenceEnabled: true, clockValid: true, activeIndex: 0, nextIndex: null });
    expect(parseSchedulePoint(commands[1])).toMatchObject({ generation: 0x1234abcd, index: 0, point: { minuteOfDay: 360, targetC: 21.5, action: "auto", daysMask: 0x7f } });
  });

  it("parses pending catch-up and callback errors", () => {
    expect(parseHeaterScheduleDiagnostics("S5D1234ABCD0F2FFFF10107FFFF")).toMatchObject({
      generation: 0x1234abcd,
      clockValid: true,
      enabled: true,
      persistenceEnabled: true,
      catchUpPending: true,
      lastApplyValid: false,
      localWeekday: 2,
      localMinute: null,
      lastIndex: null,
      lastKind: "catchUp",
      lastError: 0x0107,
      lastApplyAgeSeconds: null,
    });
  });

  it("rejects overlapping enabled points but allows disjoint day masks", () => {
    const point = { enabled: true, minuteOfDay: 360, targetC: 21, action: "unchanged" as const, daysMask: 1 };
    expect(validateSchedulePoints([point, { ...point }])).toBe("overlap");
    expect(validateSchedulePoints([point, { ...point, daysMask: 2 }])).toBeNull();
  });

  it("keeps two safe disabled templates when firmware has no saved points", () => {
    expect(defaultSchedulePoints(19.7)).toEqual([
      { enabled: false, minuteOfDay: 360, targetC: 19.7, action: "unchanged", daysMask: 0x7f },
      { enabled: false, minuteOfDay: 1380, targetC: 19.7, action: "unchanged", daysMask: 0x7f },
    ]);
    expect(defaultSchedulePoints(Number.NaN)[0].targetC).toBe(26.7);
  });
});
