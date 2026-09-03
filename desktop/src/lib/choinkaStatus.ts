export const CHOINKA_STALE_MS = 45_000;
const legacyPattern = /^exec=(\d{1,10}) level=(dry|wet|unknown) pump=([01])(?: block=([01]))? mv=(-?\d{1,5})\/(-?\d{1,5}) cal=([01]) cd=(\d{1,10}) stop=(none|boot_pulse|level_wet|sensor_unknown|safety_timeout|hardware_block|driver_error) tout=(\d{1,10})(?: last=(-1|\d{1,13}))?(?: st=(\d{1,2}) low=(-1|\d{1,5})\/(-1|\d{1,5}))?$/;
const compactPattern = /^C6 exec=(\d{1,10}) l=([012]) p=([01]) b=([01]) v=(-1|\d{1,5})\/(-1|\d{1,5}) c=([01]) d=(\d{1,10}) s=([0-6]) t=(\d{1,10}) a=(-1|\d{1,13}) x=([0-9]|1[0-5]) z=(-1|\d{1,5})\/(-1|\d{1,5})(?: m=([01]))?$/;
export const choinkaStatusPattern = new RegExp(`(?:${legacyPattern.source})|(?:${compactPattern.source})`);

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
  lastStartAgeSeconds: number | null;
  electrodeTestFlags: number | null;
  electrodeTestEnforced: boolean | null;
  lowAbMv: number | null;
  lowBaMv: number | null;
  receivedAt: number;
}

export function parseChoinkaStatus(line: string, now = Date.now()): ChoinkaStatus | null {
  const compact = compactPattern.exec(line);
  const match = compact ?? legacyPattern.exec(line);
  if (!match) return null;
  const levels = ["unknown", "dry", "wet"] as const;
  const stops = ["none", "boot_pulse", "level_wet", "sensor_unknown", "safety_timeout", "hardware_block", "driver_error"] as const;
  const [executionCount, cooldownMs, timeoutCount] = [match[1], match[8], match[10]].map(Number);
  if ([executionCount, cooldownMs, timeoutCount].some((n) => n > 0xffffffff)) return null;
  if (match[12] !== undefined && Number(match[12]) > 15) return null;
  return {
    executionCount, level: compact ? levels[Number(match[2])] : match[2] as ChoinkaStatus["level"], pumpOn: match[3] === "1",
    hardwareBlocked: match[4] === undefined ? null : match[4] === "1",
    voltageAbMv: Number(match[5]), voltageBaMv: Number(match[6]), calibrated: match[7] === "1",
    cooldownMs, stopReason: compact ? stops[Number(match[9])] : match[9] as ChoinkaStatus["stopReason"], timeoutCount,
    lastStartAgeSeconds: match[11] === undefined ? null : Number(match[11]), receivedAt: now,
    electrodeTestFlags: match[12] === undefined ? null : Number(match[12]),
    electrodeTestEnforced: compact?.[15] === undefined ? null : compact[15] === "1",
    lowAbMv: match[13] === undefined ? null : Number(match[13]),
    lowBaMv: match[14] === undefined ? null : Number(match[14]),
  };
}

export function electrodeFaultKeys(flags: number) {
  return (["controls.choinkaTestIo", "controls.choinkaTestNotLow",
    "controls.choinkaTestAsymmetry", "controls.choinkaTestUncertain"] as const)
    .filter((_, index) => (flags & (1 << index)) !== 0);
}

export function formatPumpStartAge(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return [hours, minutes, seconds % 60].map(value => String(value).padStart(2, "0")).join(":");
}
