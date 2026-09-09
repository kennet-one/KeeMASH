import { meshNodeIdForTag, type LiveMeshInventory } from "./operationalGraph";
import type { LegacyState, SensorKey } from "./protocol";
import type { MeshEvent } from "../types";

export interface TypedSensorMetric {
  value: number | null;
  valid: boolean;
  stale: boolean;
  error: boolean;
  calibrated: boolean;
  generation: number;
  sampleUptimeMs: number;
  messageId: number;
  receivedAt: number;
  ageAtReceiptMs: number | null;
}

export interface TypedSensorSource {
  mac: string;
  nodeId: string | null;
  tag: string | null;
  session: number | null;
  connected: boolean;
  reconnectCount: number;
  lastSampleUptimeMs: number;
  metrics: Partial<Record<SensorKey, TypedSensorMetric>>;
}

const metricKeys = {
  1: "ppm",
  2: "temperatureC",
  3: "humidityPercent",
  4: "lux",
} as const;

export function normalizeMeshMac(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const compact = value.replace(/[:-]/g, "").toLowerCase();
  return /^[0-9a-f]{12}$/.test(compact) && compact !== "000000000000" ? compact : null;
}

function inventoryNode(inventory: unknown, mac: string): Record<string, unknown> | null {
  if (!inventory || typeof inventory !== "object") return null;
  const nodes = (inventory as LiveMeshInventory).nodes;
  if (!Array.isArray(nodes)) return null;
  return (nodes.find((node) => normalizeMeshMac(node.mac) === mac) as unknown as Record<string, unknown> | undefined) ?? null;
}

function inventorySession(node: Record<string, unknown> | null): number | null {
  if (!node) return null;
  for (const key of ["node_session", "nodeSession", "v2_session", "v2Session", "session"]) {
    const value = Number(node[key]);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return null;
}

function sampleAgeFromInventory(inventory: unknown, mac: string, sampleUptimeMs: number, now: number): number | null {
  const node = inventoryNode(inventory, mac);
  const anchorAt = inventory && typeof inventory === "object" ? Number((inventory as Record<string, unknown>).__receivedAt) : NaN;
  const elapsed = now - anchorAt;
  if (node?.uptime_valid !== true || !Number.isFinite(elapsed) || elapsed < 0 || elapsed > 120_000 ||
      typeof node.uptime_s !== "number" || !Number.isFinite(node.uptime_s) || node.uptime_s < 0) return null;
  // Integer-second uptime is rounded down; use the conservative upper age bound.
  const upperUptime = node.uptime_s * 1000 + 999 + elapsed;
  return upperUptime >= sampleUptimeMs ? upperUptime - sampleUptimeMs : null;
}

function sourceIdentity(inventory: unknown, mac: string): { nodeId: string | null; tag: string | null; session: number | null } {
  const node = inventoryNode(inventory, mac);
  const tag = typeof node?.tag === "string" && node.tag.length > 0 ? node.tag : null;
  return { nodeId: tag ? meshNodeIdForTag(tag) : null, tag, session: inventorySession(node) };
}

export function typedSensorSourceForNode(state: LegacyState, nodeId: string): TypedSensorSource | null {
  return Object.values(state.typedSensors).find((source) => source.nodeId === nodeId) ?? null;
}

export function typedSensorMetricForNode(
  state: LegacyState,
  nodeId: string,
  metric: SensorKey,
): TypedSensorMetric | null {
  return typedSensorSourceForNode(state, nodeId)?.metrics[metric] ?? null;
}

export function markTypedSensorsDisconnected(state: LegacyState): LegacyState {
  if (!Object.values(state.typedSensors).some((source) => source.connected) &&
      !state.controls.heaterClimate && !state.controls.heaterSource?.applied) return state;
  return {
    ...state,
    controls: { ...state.controls, heaterClimate: null,
      heaterSource: state.controls.heaterSource ? { ...state.controls.heaterSource, applied: false } : null },
    typedSensors: Object.fromEntries(Object.entries(state.typedSensors).map(([mac, source]) => [
      mac,
      { ...source, connected: false },
    ])),
  };
}

export function reconcileTypedSensorInventory(state: LegacyState, inventory: unknown): LegacyState {
  let changed = false;
  let heaterReset = false;
  const typedSensors = { ...state.typedSensors };
  for (const [mac, previous] of Object.entries(state.typedSensors)) {
    const node = inventoryNode(inventory, mac);
    const identity = sourceIdentity(inventory, mac);
    const nextSession = identity.session ?? previous.session;
    const sessionChanged = previous.session !== null && identity.session !== null && previous.session !== identity.session;
    const connected = node ? node.offline !== true : previous.connected;
    if (sessionChanged) {
      heaterReset ||= previous.nodeId === "Kheater" || identity.nodeId === "Kheater";
      typedSensors[mac] = {
        ...previous,
        ...identity,
        connected,
        reconnectCount: previous.reconnectCount + 1,
        lastSampleUptimeMs: 0,
        metrics: {},
      };
      changed = true;
    } else if (previous.nodeId !== (identity.nodeId ?? previous.nodeId) ||
        previous.tag !== (identity.tag ?? previous.tag) || previous.session !== nextSession ||
        previous.connected !== connected) {
      typedSensors[mac] = {
        ...previous,
        nodeId: identity.nodeId ?? previous.nodeId,
        tag: identity.tag ?? previous.tag,
        session: nextSession,
        connected,
      };
      changed = true;
    }
    if (!sessionChanged && connected && previous.session !== null && previous.session === identity.session) {
      const source = typedSensors[mac];
      const metrics = { ...source.metrics };
      let anchored = false;
      for (const key of Object.keys(metrics) as SensorKey[]) {
        const metric = metrics[key];
        if (!metric || metric.ageAtReceiptMs !== null) continue;
        const now = Date.now();
        const age = sampleAgeFromInventory(inventory, mac, metric.sampleUptimeMs, now);
        if (age !== null) {
          metrics[key] = { ...metric, ageAtReceiptMs: age, receivedAt: now };
          anchored = true;
        }
      }
      if (anchored) { typedSensors[mac] = { ...source, metrics }; changed = true; }
    }
  }
  return changed ? { ...state, typedSensors, controls: heaterReset ? {
    ...state.controls, heaterClimate: null,
    heaterSource: state.controls.heaterSource ? { ...state.controls.heaterSource, applied: false } : null,
  } : state.controls } : state;
}

export function applyTypedSensorEvent(
  current: LegacyState,
  event: MeshEvent,
  inventory: unknown,
  now = Date.now(),
): LegacyState {
  if (event.channel !== 5 || !event.data) return current;
  if (!["id", "status", "generation", "sampleUptimeMs", "scale10", "value"].every((key) => typeof event.data![key] === "number")) return current;
  const mac = normalizeMeshMac(event.fields.targetMac);
  if (!mac) return current;
  const metricId = Number(event.data.id);
  const key = metricKeys[metricId as keyof typeof metricKeys];
  const status = Number(event.data.status);
  const generation = Number(event.data.generation);
  const sampleUptimeMs = Number(event.data.sampleUptimeMs);
  const scale10 = Number(event.data.scale10);
  const rawValue = Number(event.data.value);
  if (!key || !Number.isInteger(status) || status < 0 || status > 255 ||
      !Number.isInteger(generation) || generation < 0 || generation > 0xffffffff ||
      !Number.isInteger(sampleUptimeMs) || sampleUptimeMs < 0 || sampleUptimeMs > 0xffffffff || !Number.isInteger(scale10) ||
      scale10 < -9 || scale10 > 9) return current;

  const identity = sourceIdentity(inventory, mac);
  const previous = current.typedSensors[mac];
  const sessionChanged = Boolean(previous && previous.session !== null && identity.session !== null && previous.session !== identity.session);
  const reconnected = sessionChanged;
  if (!previous && Object.keys(current.typedSensors).length >= 64) return current;
  const base: TypedSensorSource = reconnected || !previous
    ? {
        mac,
        nodeId: identity.nodeId,
        tag: identity.tag,
        session: identity.session,
        connected: true,
        reconnectCount: (previous?.reconnectCount ?? 0) + (previous ? 1 : 0),
        lastSampleUptimeMs: sampleUptimeMs,
        metrics: {},
      }
    : {
        ...previous,
        nodeId: identity.nodeId ?? previous.nodeId,
        tag: identity.tag ?? previous.tag,
        session: identity.session ?? previous.session,
        connected: true,
      };
  const oldMetric = base.metrics[key];
  if (!reconnected && oldMetric && generation === oldMetric.generation &&
      sampleUptimeMs === oldMetric.sampleUptimeMs) {
    // A duplicate may invalidate a sample, but never renew its acquisition age.
    if ((status & 7) === 1) return current;
    const stale = (status & 2) !== 0;
    const error = (status & 4) !== 0;
    if (oldMetric.stale === stale && oldMetric.error === error && !oldMetric.valid) return current;
    const value = stale && !error ? oldMetric.value : null;
    return { ...current,
      sensors: base.nodeId === "esp_mixer" ? { ...current.sensors, [key]: value } : current.sensors,
      typedSensors: { ...current.typedSensors, [mac]: {
      ...base, metrics: { ...base.metrics, [key]: { ...oldMetric, value, valid: false, stale, error } },
    } } };
  }
  if (!reconnected && oldMetric && sampleUptimeMs < oldMetric.sampleUptimeMs) return current;
  if (!reconnected && oldMetric && ((generation - oldMetric.generation) | 0) <= 0) return current;

  const validFlag = (status & 1) !== 0;
  const stale = (status & 2) !== 0;
  const error = (status & 4) !== 0;
  const numericValid = Number.isFinite(rawValue) && Number.isFinite(rawValue * (10 ** scale10));
  const valid = validFlag && !stale && !error && numericValid;
  const metric: TypedSensorMetric = {
    value: validFlag && !error && numericValid ? rawValue * (10 ** scale10) : null,
    valid,
    stale,
    error: error || (validFlag && !numericValid),
    calibrated: (status & 8) !== 0,
    generation,
    sampleUptimeMs,
    messageId: event.messageId,
    receivedAt: now,
    ageAtReceiptMs: sampleAgeFromInventory(inventory, mac, sampleUptimeMs, now),
  };
  const source: TypedSensorSource = {
    ...base,
    lastSampleUptimeMs: Math.max(base.lastSampleUptimeMs, sampleUptimeMs),
    metrics: { ...base.metrics, [key]: metric },
  };
  const next: LegacyState = {
    ...current,
    online: true,
    lastSeenAt: now,
    typedSensors: { ...current.typedSensors, [mac]: source },
  };
  if (source.nodeId) {
    next.nodeActivity = {
      ...current.nodeActivity,
      [source.nodeId]: { lastSeenAt: now, lastError: null },
    };
  }
  if (source.nodeId === "esp_mixer") {
    next.sensors = { ...current.sensors, [key]: metric.value };
    next.sensorUpdatedAt = { ...current.sensorUpdatedAt, [key]: now };
  }
  return next;
}
