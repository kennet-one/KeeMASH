export const CHOINKA_STALE_MS = 45_000;
export const choinkaStatusPattern = /^exec=(\d{1,10}) level=(dry|wet|unknown) pump=([01])(?: block=([01]))? mv=(-?\d{1,5})\/(-?\d{1,5}) cal=([01]) cd=(\d{1,10}) stop=(none|boot_pulse|level_wet|sensor_unknown|safety_timeout|hardware_block|driver_error) tout=(\d{1,10})$/;

export interface ChoinkaStatus {
  executionCount: number;
  level: "dry" | "wet" | "unknown";
  pumpOn: boolean;
  hardwareBlocked: boolean | null;
  voltageAbMv: number;
  voltageBaMv: number;
  calibrated: boolean;
  cooldownMs: number;
  stopReason: "none" | "boot_pulse" | "level_wet" | "sensor_unknown" | "safety_timeout" | "hardware_block" | "driver_error";
  timeoutCount: number;
  receivedAt: number;
}

export function parseChoinkaStatus(line: string, now = Date.now()): ChoinkaStatus | null {
  const match = choinkaStatusPattern.exec(line);
  if (!match) return null;
  const [executionCount, cooldownMs, timeoutCount] = [match[1], match[8], match[10]].map(Number);
  if ([executionCount, cooldownMs, timeoutCount].some((n) => n > 0xffffffff)) return null;
  return {
    executionCount, level: match[2] as ChoinkaStatus["level"], pumpOn: match[3] === "1",
    hardwareBlocked: match[4] === undefined ? null : match[4] === "1",
    voltageAbMv: Number(match[5]), voltageBaMv: Number(match[6]), calibrated: match[7] === "1",
    cooldownMs, stopReason: match[9] as ChoinkaStatus["stopReason"], timeoutCount, receivedAt: now,
  };
}
