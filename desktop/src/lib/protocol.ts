import { meshNodeIdForTag, meshReplyOwner, type MeshNodeId } from "./operationalGraph";

export type DeviceKey =
  | "garland"
  | "redLed"
  | "bedside"
  | "lamp"
  | "powerLed"
  | "humidifier"
  | "pump"
  | "flow"
  | "ionizer"
  | "heater"
  | "heaterRotation"
  | "eggCooker";

export type SensorKey =
  | "speed"
  | "ppm"
  | "temperatureC"
  | "humidityPercent"
  | "lux"
  | "pressure"
  | "pm1"
  | "pm25"
  | "pm10";

export type LegacyNotificationKey = "notification.eggCookerCompleted";

export type MeshCommandErrorCode = "OFFLINE" | "POWER_OFF" | "REJECTED" | "TIMEOUT";

export interface MeshCommandError {
  code: MeshCommandErrorCode;
  owner: string;
}

export interface MeshNodeActivity {
  lastSeenAt: number | null;
  lastError: MeshCommandErrorCode | null;
}

export interface LegacyState {
  online: boolean;
  lastSeenAt: number | null;
  lastLine: string;
  devices: Record<DeviceKey, boolean | null>;
  sensors: {
    speed: number | null;
    ppm: number | null;
    temperatureC: number | null;
    humidityPercent: number | null;
    lux: number | null;
    pressure: number | null;
    pm1: number | null;
    pm25: number | null;
    pm10: number | null;
  };
  controls: {
    redMode: number;
    redBrightness: number;
    turboMode: number;
    humidifierColor: number;
    humidifierWaterLevel: number;
    heaterMode: number;
    heaterTargetC: number;
  };
  sensorUpdatedAt: Partial<Record<SensorKey, number>>;
  nodeActivity: Partial<Record<MeshNodeId, MeshNodeActivity>>;
  notificationKey: LegacyNotificationKey | null;
  commandError: MeshCommandError | null;
}

export const initialLegacyState: LegacyState = {
  online: false,
  lastSeenAt: null,
  lastLine: "",
  devices: {
    garland: null,
    redLed: null,
    bedside: null,
    lamp: null,
    powerLed: null,
    humidifier: null,
    pump: null,
    flow: null,
    ionizer: null,
    heater: null,
    heaterRotation: null,
    eggCooker: null,
  },
  sensors: {
    speed: null,
    ppm: null,
    temperatureC: null,
    humidityPercent: null,
    lux: null,
    pressure: null,
    pm1: null,
    pm25: null,
    pm10: null,
  },
  sensorUpdatedAt: {},
  nodeActivity: {},
  controls: {
    redMode: 0,
    redBrightness: 0,
    turboMode: 0,
    humidifierColor: 0,
    humidifierWaterLevel: 0,
    heaterMode: 0,
    heaterTargetC: 27.1,
  },
  notificationKey: null,
  commandError: null,
};

const levelMap = new Map<number, number>([
  [0, 0],
  [26, 1],
  [51, 2],
  [77, 3],
  [102, 4],
  [128, 5],
  [153, 6],
  [179, 7],
  [204, 8],
  [230, 9],
  [255, 10],
]);

function finiteNumber(value: string): number | null {
  const normalized = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function cloneState(state: LegacyState, line: string): LegacyState {
  return {
    ...state,
    lastLine: line,
    lastSeenAt: Date.now(),
    devices: { ...state.devices },
    sensors: { ...state.sensors },
    sensorUpdatedAt: { ...state.sensorUpdatedAt },
    nodeActivity: { ...state.nodeActivity },
    controls: { ...state.controls },
    notificationKey: null,
    commandError: null,
  };
}

export function parseLegacyLine(state: LegacyState, rawLine: string): LegacyState {
  const token = rawLine
    .split(",")
    .map((token) => token.trim())
    .find(Boolean);
  if (!token) return state;
  // CRC is normally stripped by Blueto_bridge_A, but accepting the wire suffix
  // keeps sensor telemetry readable when a bridge forwards the body unchanged.
  const line = token.replace(/\*[0-9A-Fa-f]{2}$/, "");

  const next = cloneState(state, line);
  const commandError = /^ERR:(OFFLINE|POWER_OFF|REJECTED|TIMEOUT):([A-Za-z0-9_-]{1,15})$/.exec(line);
  if (commandError) {
    next.commandError = {
      code: commandError[1] as MeshCommandErrorCode,
      owner: commandError[2],
    };
    const owner = meshNodeIdForTag(commandError[2]);
    if (owner) {
      next.nodeActivity[owner] = {
        lastSeenAt: next.nodeActivity[owner]?.lastSeenAt ?? null,
        lastError: commandError[1] as MeshCommandErrorCode,
      };
    }
    return next;
  }
  const setDevice = (key: DeviceKey, value: boolean): void => {
    next.devices[key] = value;
  };
  const setSensor = (key: SensorKey, value: number): void => {
    next.sensors[key] = value;
    next.sensorUpdatedAt[key] = Date.now();
  };

  switch (line) {
    case "hello":
    case "kyy":
      next.online = true;
      break;
    case "jajo_on":
      setDevice("eggCooker", true);
      next.notificationKey = "notification.eggCookerCompleted";
      break;
    case "jaeh":
      setDevice("eggCooker", true);
      break;
    case "pimpa":
      setDevice("pump", true);
      break;
    case "garland_on":
      setDevice("garland", true);
      break;
    case "garland_off":
      setDevice("garland", false);
      break;
    case "redled_on":
      setDevice("redLed", true);
      break;
    case "redled_off":
      setDevice("redLed", false);
      break;
    case "bdsdl1":
      setDevice("bedside", true);
      break;
    case "bdsdl0":
      setDevice("bedside", false);
      break;
    case "feedpowled1":
      setDevice("powerLed", true);
      break;
    case "feedpowled0":
      setDevice("powerLed", false);
      break;
  }

  const prefix = line.slice(0, 2);
  const payload = line.slice(2);
  const numeric = finiteNumber(payload);

  if (numeric !== null) {
    if (prefix === "03") setSensor("speed", numeric);
    if (prefix === "04") setSensor("ppm", numeric);
    if (prefix === "05") setSensor("temperatureC", numeric);
    if (prefix === "06") setSensor("humidityPercent", numeric);
    if (prefix === "07") setSensor("lux", numeric);
    if (prefix === "08") setSensor("pressure", numeric);
    if (prefix === "10") setSensor("pm1", numeric);
    if (prefix === "11") setSensor("pm25", numeric);
    if (prefix === "12") setSensor("pm10", numeric);
  }

  if (prefix === "09") setDevice("heaterRotation", payload === "1");
  if (prefix === "13") setDevice("pump", payload === "1");
  if (prefix === "16") setDevice("flow", payload === "1");
  if (prefix === "17") setDevice("ionizer", payload === "1");
  if (prefix === "La") setDevice("lamp", payload === "1");

  if (prefix === "01") {
    const mode = Number.parseInt(line.slice(-1), 10);
    if (Number.isInteger(mode) && mode >= 0 && mode <= 9) next.controls.redMode = mode;
  }
  if (prefix === "02") {
    const mapped = levelMap.get(Number.parseInt(payload, 10));
    if (mapped !== undefined) next.controls.redBrightness = mapped;
  }
  if (prefix === "20") {
    const mapped = levelMap.get(Number.parseInt(payload, 10));
    if (mapped !== undefined) next.controls.humidifierWaterLevel = mapped;
  }
  if (prefix === "21") {
    const color = Number.parseInt(line.slice(-1), 10);
    if (Number.isInteger(color) && color >= 0 && color <= 3) next.controls.humidifierColor = color;
  }

  if (prefix === "14") {
    const turbo = Number.parseInt(payload.slice(0, 1), 10);
    if (Number.isInteger(turbo) && turbo >= 0 && turbo <= 3) next.controls.turboMode = turbo;
  }
  if (prefix === "15" && payload.length >= 4) {
    next.devices.humidifier = true;
    const turbo = Number.parseInt(payload[0], 10);
    if (Number.isInteger(turbo) && turbo >= 0 && turbo <= 3) next.controls.turboMode = turbo;
    next.devices.pump = payload[1] === "0";
    next.devices.flow = payload[2] === "0";
    next.devices.ionizer = payload[3] === "0";
  }
  if (prefix === "25") {
    const rawMode = Number.parseInt(payload.slice(0, 1), 10);
    const modeMap: Record<number, number> = { 0: 1, 1: 2, 2: 3, 3: 4, 4: 0 };
    if (modeMap[rawMode] !== undefined) next.controls.heaterMode = modeMap[rawMode];
  }
  if (prefix === "R5") {
    const target = finiteNumber(payload);
    if (target !== null) {
      next.controls.heaterTargetC = target;
      next.devices.heater = true;
    }
  }
  if (prefix === "A5") {
    next.controls.heaterMode = 5;
    next.devices.heater = true;
  }

  const owner = meshReplyOwner(line);
  if (owner) next.nodeActivity[owner] = { lastSeenAt: Date.now(), lastError: null };
  return next;
}
