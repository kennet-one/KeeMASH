export type ScheduleApplyKind = "none" | "catchUp" | "scheduled";

export interface ScheduleDiagnostics {
  generation: number;
  clockValid: boolean;
  enabled: boolean;
  persistenceEnabled: boolean;
  catchUpPending: boolean;
  lastApplyValid: boolean;
  timeSyncStale: boolean;
  localWeekday: number | null;
  localMinute: number | null;
  lastIndex: number | null;
  lastKind: ScheduleApplyKind;
  lastError: number;
  lastApplyAgeSeconds: number | null;
  receivedAt: number;
}

const applyKinds: ScheduleApplyKind[] = ["none", "catchUp", "scheduled"];

export function parseScheduleDiagnostics(token: string, prefix: "PSD" | "S5D"): ScheduleDiagnostics | null {
  const expression = new RegExp(`^${prefix}([0-9A-Fa-f]{8})([0-9A-Fa-f]{2})([0-9A-Fa-f])([0-9A-Fa-f]{3})([0-9A-Fa-f])([0-9A-Fa-f])([0-9A-Fa-f]{4})([0-9A-Fa-f]{4})$`);
  const match = expression.exec(token);
  if (!match) return null;

  const flags = Number.parseInt(match[2], 16);
  const weekday = Number.parseInt(match[3], 16);
  const minute = Number.parseInt(match[4], 16);
  const lastIndex = Number.parseInt(match[5], 16);
  const kind = Number.parseInt(match[6], 16);
  const age = Number.parseInt(match[8], 16);
  if ((weekday > 6 && weekday !== 0xf)
    || (minute >= 1440 && minute !== 0xfff)
    || (lastIndex > 7 && lastIndex !== 0xf)
    || kind >= applyKinds.length) return null;

  return {
    generation: Number.parseInt(match[1], 16),
    clockValid: (flags & 0x01) !== 0,
    enabled: (flags & 0x02) !== 0,
    persistenceEnabled: (flags & 0x04) !== 0,
    catchUpPending: (flags & 0x08) !== 0,
    lastApplyValid: (flags & 0x10) !== 0,
    timeSyncStale: (flags & 0x20) !== 0,
    localWeekday: weekday === 0xf ? null : weekday,
    localMinute: minute === 0xfff ? null : minute,
    lastIndex: lastIndex === 0xf ? null : lastIndex,
    lastKind: applyKinds[kind],
    lastError: Number.parseInt(match[7], 16),
    lastApplyAgeSeconds: age === 0xffff ? null : age,
    receivedAt: Date.now(),
  };
}
