export type HeaterClimateSource = "none" | "internal" | "zone";
export type HeaterClimateFallback = "none" | "externalUnavailable" | "confirmingExternal" | "noUsableSource";

export interface HeaterClimateStatus {
  actualSource: HeaterClimateSource;
  fallback: HeaterClimateFallback;
  zoneEnabled: boolean;
  appliedRevision: number;
  configuredSourceMac: string | null;
  internalTemperatureC: number | null;
  internalHumidityPercent: number | null;
  internalAgeSeconds: number | null;
  externalTemperatureC: number | null;
  externalAgeSeconds: number | null;
  effectiveTemperatureC: number | null;
  receivedAt: number;
}

export interface HeaterSourceStatus {
  saved: boolean;
  applied: boolean;
  revision: number;
  enabled: boolean;
  sourceMac: string | null;
  error: number;
  receivedAt: number;
}

export interface HeaterRelayStatus {
  intervalSeconds: 10 | 30 | 60;
  holdSeconds: number;
  hysteresisC: number;
  receivedAt: number;
}

export function parseHeaterRelay(line: string, receivedAt = Date.now()): HeaterRelayStatus | null {
  const match = /^HP1 interval=(10|30|60) hold=(\d+) hysteresis=(\d+)$/.exec(line);
  if (!match || Number(match[2]) > 60 || Number(match[3]) > 100) return null;
  return { intervalSeconds: Number(match[1]) as 10 | 30 | 60, holdSeconds: Number(match[2]), hysteresisC: Number(match[3]) / 100, receivedAt };
}

function keyValues(line: string, prefix: string): Record<string, string> | null {
  if (!line.startsWith(`${prefix} `)) return null;
  const result: Record<string, string> = {};
  for (const token of line.slice(prefix.length + 1).trim().split(/\s+/)) {
    const match = /^([a-z]+)=([^\s=]+)$/i.exec(token);
    if (!match || result[match[1]] !== undefined) return null;
    result[match[1]] = match[2];
  }
  return result;
}

function decimal(value: string | undefined, min: number, max: number): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function hex32(value: string | undefined): number | null {
  return value && /^[0-9a-f]{8}$/i.test(value) ? Number.parseInt(value, 16) : null;
}

function mac(value: string | undefined): string | null | undefined {
  if (!value || !/^[0-9a-f]{12}$/i.test(value)) return undefined;
  const normalized = value.toLowerCase();
  return normalized === "000000000000" ? null : normalized;
}

function hundredths(value: string | undefined): number | null | undefined {
  const parsed = value && /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < -32768 || parsed > 32767) return undefined;
  return parsed === 32767 ? null : parsed / 100;
}

function age(value: string | undefined): number | null | undefined {
  const parsed = decimal(value, 0, 65535);
  return parsed === null ? undefined : parsed === 65535 ? null : parsed;
}

export function parseHeaterClimate(line: string, receivedAt = Date.now()): HeaterClimateStatus | null {
  const fields = keyValues(line, "HC1");
  if (!fields) return null;
  const source = decimal(fields.s, 0, 2);
  const reason = decimal(fields.r, 0, 3);
  const zone = decimal(fields.z, 0, 1);
  const revision = hex32(fields.v);
  const sourceMac = mac(fields.m);
  const internalTemperature = hundredths(fields.i);
  const humidity = hundredths(fields.h);
  const internalAge = age(fields.ia);
  const externalTemperature = hundredths(fields.e);
  const externalAge = age(fields.ea);
  const effectiveTemperature = hundredths(fields.t);
  if (source === null || reason === null || zone === null || revision === null || sourceMac === undefined ||
      internalTemperature === undefined || humidity === undefined || internalAge === undefined ||
      externalTemperature === undefined || externalAge === undefined || effectiveTemperature === undefined) return null;
  if (humidity !== null && (humidity < 0 || humidity > 100)) return null;
  return {
    actualSource: (["none", "internal", "zone"] as const)[source],
    fallback: (["none", "externalUnavailable", "confirmingExternal", "noUsableSource"] as const)[reason],
    zoneEnabled: zone === 1,
    appliedRevision: revision,
    configuredSourceMac: sourceMac,
    internalTemperatureC: internalTemperature,
    internalHumidityPercent: humidity,
    internalAgeSeconds: internalAge,
    externalTemperatureC: externalTemperature,
    externalAgeSeconds: externalAge,
    effectiveTemperatureC: effectiveTemperature,
    receivedAt,
  };
}

export function parseHeaterSourceStatus(line: string, receivedAt = Date.now()): HeaterSourceStatus | null {
  const fields = keyValues(line, "HZ1");
  if (!fields) return null;
  const saved = decimal(fields.saved, 0, 1);
  const applied = decimal(fields.applied, 0, 1);
  const revision = hex32(fields.rev);
  const enabled = decimal(fields.enabled, 0, 1);
  const sourceMac = mac(fields.source);
  const error = decimal(fields.err, 0, 0xffffffff);
  if (saved === null || applied === null || revision === null || enabled === null || sourceMac === undefined || error === null) return null;
  return { saved: saved === 1, applied: applied === 1, revision, enabled: enabled === 1, sourceMac, error, receivedAt };
}
