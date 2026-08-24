export const HEATER_SCHEDULE_MAX_POINTS = 8;
export const HEATER_SCHEDULE_ALL_DAYS = 0x7f;

export type HeaterScheduleAction = "unchanged" | "off" | "auto" | "fan" | "low" | "high" | "max";

export interface HeaterSchedulePoint {
  enabled: boolean;
  minuteOfDay: number;
  targetC: number;
  action: HeaterScheduleAction;
  daysMask: number;
}

export interface HeaterScheduleState {
  generation: number;
  enabled: boolean;
  persistenceEnabled: boolean;
  clockValid: boolean;
  activeIndex: number | null;
  nextIndex: number | null;
  points: Array<HeaterSchedulePoint | null>;
}

export const emptyHeaterScheduleState: HeaterScheduleState = {
  generation: 0,
  enabled: false,
  persistenceEnabled: false,
  clockValid: false,
  activeIndex: null,
  nextIndex: null,
  points: [],
};

export function defaultSchedulePoints(targetC: number): HeaterSchedulePoint[] {
  const safeTarget = Number.isFinite(targetC) ? Math.min(35, Math.max(5, targetC)) : 26.7;
  return [
    { enabled: false, minuteOfDay: 360, targetC: safeTarget, action: "unchanged", daysMask: HEATER_SCHEDULE_ALL_DAYS },
    { enabled: false, minuteOfDay: 1380, targetC: safeTarget, action: "unchanged", daysMask: HEATER_SCHEDULE_ALL_DAYS },
  ];
}

const actionNames: HeaterScheduleAction[] = ["unchanged", "off", "auto", "fan", "low", "high", "max"];

function hex(value: number, digits: number): string {
  if (!Number.isInteger(value) || value < 0 || value >= 16 ** digits) throw new Error("schedule value is out of range");
  return value.toString(16).toUpperCase().padStart(digits, "0");
}

export function encodeScheduleTransaction(
  generation: number,
  enabled: boolean,
  persistenceEnabled: boolean,
  points: HeaterSchedulePoint[],
): string[] {
  if (!Number.isInteger(generation) || generation <= 0 || generation > 0xffffffff) throw new Error("invalid schedule generation");
  if (points.length > HEATER_SCHEDULE_MAX_POINTS) throw new Error("too many schedule points");
  const normalized = points.map((point, index) => {
    const targetX10 = Math.round(point.targetC * 10);
    const action = actionNames.indexOf(point.action);
    if (!Number.isInteger(point.minuteOfDay) || point.minuteOfDay < 0 || point.minuteOfDay >= 1440) throw new Error("invalid schedule time");
    if (targetX10 < 50 || targetX10 > 350) throw new Error("invalid schedule temperature");
    if (action < 0 || point.daysMask <= 0 || point.daysMask > HEATER_SCHEDULE_ALL_DAYS) throw new Error("invalid schedule point");
    return `S5P${hex(generation, 8)}${hex(index, 1)}${point.enabled ? "1" : "0"}${hex(point.minuteOfDay, 3)}${hex(targetX10, 3)}${hex(action, 1)}${hex(point.daysMask, 2)}`;
  });
  return [
    `S5B${hex(generation, 8)}${hex(points.length, 1)}${enabled ? "1" : "0"}${persistenceEnabled ? "1" : "0"}`,
    ...normalized,
    `S5C${hex(generation, 8)}`,
  ];
}

export function parseScheduleMeta(token: string): Omit<HeaterScheduleState, "points"> & { count: number } | null {
  const match = /^S5M([0-9A-Fa-f]{8})([0-8])([01])([01])([01])([0-9A-Fa-f])([0-9A-Fa-f])$/.exec(token);
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
  };
}

export function parseSchedulePoint(token: string): { generation: number; index: number; point: HeaterSchedulePoint } | null {
  const match = /^S5P([0-9A-Fa-f]{8})([0-7])([01])([0-9A-Fa-f]{3})([0-9A-Fa-f]{3})([0-6])([0-9A-Fa-f]{2})$/.exec(token);
  if (!match) return null;
  const minuteOfDay = Number.parseInt(match[4], 16);
  const targetX10 = Number.parseInt(match[5], 16);
  const daysMask = Number.parseInt(match[7], 16);
  if (minuteOfDay >= 1440 || targetX10 < 50 || targetX10 > 350 || daysMask <= 0 || daysMask > HEATER_SCHEDULE_ALL_DAYS) return null;
  return {
    generation: Number.parseInt(match[1], 16),
    index: Number.parseInt(match[2], 16),
    point: {
      enabled: match[3] === "1",
      minuteOfDay,
      targetC: targetX10 / 10,
      action: actionNames[Number.parseInt(match[6], 16)],
      daysMask,
    },
  };
}

export function minuteToTime(minute: number): string {
  return `${Math.floor(minute / 60).toString().padStart(2, "0")}:${(minute % 60).toString().padStart(2, "0")}`;
}

export function timeToMinute(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

export function validateSchedulePoints(points: HeaterSchedulePoint[]): string | null {
  if (points.length > HEATER_SCHEDULE_MAX_POINTS) return "tooMany";
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      if (points[left].enabled && points[right].enabled
        && points[left].minuteOfDay === points[right].minuteOfDay
        && (points[left].daysMask & points[right].daysMask) !== 0) return "overlap";
    }
  }
  return null;
}
