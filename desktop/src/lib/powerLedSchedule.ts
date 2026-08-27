import { minuteToTime, timeToMinute } from "./heaterSchedule";
import { parseScheduleDiagnostics, type ScheduleDiagnostics } from "./scheduleDiagnostics";

export const POWER_LED_SCHEDULE_MAX_POINTS = 8;
export const POWER_LED_SCHEDULE_ALL_DAYS = 0x7f;

export interface PowerLedSchedulePoint {
  enabled: boolean;
  minuteOfDay: number;
  stateOn: boolean;
  daysMask: number;
}

export interface PowerLedScheduleState {
  generation: number;
  enabled: boolean;
  persistenceEnabled: boolean;
  clockValid: boolean;
  activeIndex: number | null;
  nextIndex: number | null;
  outputOn: boolean;
  diagnostics: ScheduleDiagnostics | null;
  points: Array<PowerLedSchedulePoint | null>;
}

export const emptyPowerLedScheduleState: PowerLedScheduleState = {
  generation: 0,
  enabled: false,
  persistenceEnabled: false,
  clockValid: false,
  activeIndex: null,
  nextIndex: null,
  outputOn: false,
  diagnostics: null,
  points: [],
};

export function defaultPowerLedSchedulePoints(): PowerLedSchedulePoint[] {
  return [
    { enabled: false, minuteOfDay: 360, stateOn: true, daysMask: POWER_LED_SCHEDULE_ALL_DAYS },
    { enabled: false, minuteOfDay: 1380, stateOn: false, daysMask: POWER_LED_SCHEDULE_ALL_DAYS },
  ];
}

function hex(value: number, digits: number): string {
  if (!Number.isInteger(value) || value < 0 || value >= 16 ** digits) throw new Error("schedule value is out of range");
  return value.toString(16).toUpperCase().padStart(digits, "0");
}

export function encodePowerLedScheduleTransaction(
  generation: number,
  enabled: boolean,
  persistenceEnabled: boolean,
  points: PowerLedSchedulePoint[],
): string[] {
  if (!Number.isInteger(generation) || generation <= 0 || generation > 0xffffffff) throw new Error("invalid schedule generation");
  if (points.length > POWER_LED_SCHEDULE_MAX_POINTS) throw new Error("too many schedule points");
  const encoded = points.map((point, index) => {
    if (!Number.isInteger(point.minuteOfDay) || point.minuteOfDay < 0 || point.minuteOfDay >= 1440) throw new Error("invalid schedule time");
    if (!Number.isInteger(point.daysMask) || point.daysMask <= 0 || point.daysMask > POWER_LED_SCHEDULE_ALL_DAYS) throw new Error("invalid schedule days");
    return `PSP${hex(generation, 8)}${hex(index, 1)}${point.enabled ? "1" : "0"}${hex(point.minuteOfDay, 3)}${point.stateOn ? "1" : "0"}${hex(point.daysMask, 2)}`;
  });
  return [
    `PSB${hex(generation, 8)}${hex(points.length, 1)}${enabled ? "1" : "0"}${persistenceEnabled ? "1" : "0"}`,
    ...encoded,
    `PSC${hex(generation, 8)}`,
  ];
}

export function parsePowerLedScheduleMeta(token: string): Omit<PowerLedScheduleState, "points" | "diagnostics"> & { count: number } | null {
  const match = /^PSM([0-9A-Fa-f]{8})([0-8])([01])([01])([01])([0-9A-Fa-f])([0-9A-Fa-f])([01])$/.exec(token);
  if (!match) return null;
  const index = (value: string) => value.toLowerCase() === "f" ? null : Number.parseInt(value, 16);
  return {
    generation: Number.parseInt(match[1], 16),
    count: Number.parseInt(match[2], 16),
    enabled: match[3] === "1",
    persistenceEnabled: match[4] === "1",
    clockValid: match[5] === "1",
    activeIndex: index(match[6]),
    nextIndex: index(match[7]),
    outputOn: match[8] === "1",
  };
}

export function parsePowerLedScheduleDiagnostics(token: string): ScheduleDiagnostics | null {
  return parseScheduleDiagnostics(token, "PSD");
}

export function parsePowerLedSchedulePoint(token: string): { generation: number; index: number; point: PowerLedSchedulePoint } | null {
  const match = /^PSP([0-9A-Fa-f]{8})([0-7])([01])([0-9A-Fa-f]{3})([01])([0-9A-Fa-f]{2})$/.exec(token);
  if (!match) return null;
  const minuteOfDay = Number.parseInt(match[4], 16);
  const daysMask = Number.parseInt(match[6], 16);
  if (minuteOfDay >= 1440 || daysMask <= 0 || daysMask > POWER_LED_SCHEDULE_ALL_DAYS) return null;
  return {
    generation: Number.parseInt(match[1], 16),
    index: Number.parseInt(match[2], 16),
    point: {
      enabled: match[3] === "1",
      minuteOfDay,
      stateOn: match[5] === "1",
      daysMask,
    },
  };
}

export function validatePowerLedSchedulePoints(points: PowerLedSchedulePoint[]): string | null {
  if (points.length > POWER_LED_SCHEDULE_MAX_POINTS) return "tooMany";
  for (let left = 0; left < points.length; left += 1) {
    const point = points[left];
    if (!Number.isInteger(point.minuteOfDay) || point.minuteOfDay < 0 || point.minuteOfDay >= 1440
      || !Number.isInteger(point.daysMask) || point.daysMask <= 0 || point.daysMask > POWER_LED_SCHEDULE_ALL_DAYS) return "invalid";
    for (let right = left + 1; right < points.length; right += 1) {
      if (point.enabled && points[right].enabled
        && point.minuteOfDay === points[right].minuteOfDay
        && (point.daysMask & points[right].daysMask) !== 0) return "overlap";
    }
  }
  return null;
}

export { minuteToTime, timeToMinute };
