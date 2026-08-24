import { meshNodeIdForTag, meshReplyOwner, type MeshNodeId } from "./operationalGraph";
import { emptyHeaterScheduleState, parseScheduleMeta, parseSchedulePoint, type HeaterScheduleState } from "./heaterSchedule";

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

export type HeaterStopReason =
  | "none"
  | "command"
  | "temperatureStale"
  | "temperatureInvalid"
  | "manualTimeout"
  | "boot";

export interface HeaterOperationalStatus {
  autoEnabled: boolean | null;
  fanOn: boolean | null;
  lowHeatOn: boolean | null;
  highHeatOn: boolean | null;
  rotationOn: boolean | null;
  temperatureValid: boolean | null;
  cooldownActive: boolean | null;
  stopReason: HeaterStopReason | null;
  acceptedTemperatureC: number | null;
  setpointPersistent: boolean | null;
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
    heaterStatus: HeaterOperationalStatus;
    heaterSchedule: HeaterScheduleState;
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
    heaterTargetC: 26.7,
    heaterStatus: {
      autoEnabled: null,
      fanOn: null,
      lowHeatOn: null,
      highHeatOn: null,
      rotationOn: null,
      temperatureValid: null,
      cooldownActive: null,
      stopReason: null,
      acceptedTemperatureC: null,
      setpointPersistent: null,
    },
    heaterSchedule: { ...emptyHeaterScheduleState, points: [] },
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
    controls: {
      ...state.controls,
      heaterStatus: { ...state.controls.heaterStatus },
      heaterSchedule: { ...state.controls.heaterSchedule, points: [...state.controls.heaterSchedule.points] },
    },
    notificationKey: null,
    commandError: null,
  };
}

export function normalizeLegacyToken(rawLine: string): string {
  const token = rawLine
    .split(",")
    .map((token) => token.trim())
    .find(Boolean);
  if (!token) return "";
  // CRC is normally stripped by Blueto_bridge_A, but accepting the wire suffix
  // keeps sensor telemetry readable when a bridge forwards the body unchanged.
  return token.replace(/\*[0-9A-Fa-f]{2}$/, "");
}

export function parseLegacyLine(
  state: LegacyState,
  rawLine: string,
  ownerHint: MeshNodeId | null = null,
): LegacyState {
  const line = normalizeLegacyToken(rawLine);
  if (!line) return state;

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
    case "garl1":
      setDevice("garland", true);
      break;
    case "garl0":
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
    case "bedsi_on":
      setDevice("bedside", true);
      break;
    case "bedsi_off":
      setDevice("bedside", false);
      break;
    case "feedpowled1":
      setDevice("powerLed", true);
      break;
    case "feedpowled0":
      setDevice("powerLed", false);
      break;
    case "powled1":
      // bedside_light also emits this historical alias. Only consume it when
      // the pending command identifies kPowerLed as the reply owner.
      if (ownerHint === "kPowerLed") setDevice("powerLed", true);
      break;
    case "powled0":
      if (ownerHint === "kPowerLed") setDevice("powerLed", false);
      break;
    case "jajo_start":
      setDevice("eggCooker", true);
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
    if (modeMap[rawMode] !== undefined) {
      next.controls.heaterMode = modeMap[rawMode];
      if (rawMode === 4) next.devices.heater = false;
    }
  }
  if (prefix === "R5") {
    const target = finiteNumber(payload);
    if (target !== null) next.controls.heaterTargetC = target;
  }
  if (prefix === "A5") {
    next.controls.heaterMode = 5;
    next.controls.heaterStatus.autoEnabled = true;
  }
  const heaterStatus = /^H5m([0-5])a([01])f([01])l([01])h([01])r([01])v([01])c([01])s([0-5])t(-?\d+|\?)(?:p([01]))?$/.exec(line);
  if (heaterStatus) {
    const stopReasons: HeaterStopReason[] = [
      "none",
      "command",
      "temperatureStale",
      "temperatureInvalid",
      "manualTimeout",
      "boot",
    ];
    const temperatureValid = heaterStatus[7] === "1";
    const acceptedX10 = heaterStatus[10] === "?" ? null : Number.parseInt(heaterStatus[10], 10);
    next.controls.heaterMode = Number.parseInt(heaterStatus[1], 10);
    next.controls.heaterStatus = {
      autoEnabled: heaterStatus[2] === "1",
      fanOn: heaterStatus[3] === "1",
      lowHeatOn: heaterStatus[4] === "1",
      highHeatOn: heaterStatus[5] === "1",
      rotationOn: heaterStatus[6] === "1",
      temperatureValid,
      cooldownActive: heaterStatus[8] === "1",
      stopReason: stopReasons[Number.parseInt(heaterStatus[9], 10)] ?? null,
      acceptedTemperatureC: temperatureValid && acceptedX10 !== null ? acceptedX10 / 10 : null,
      setpointPersistent: heaterStatus[11] === undefined
        ? next.controls.heaterStatus.setpointPersistent
        : heaterStatus[11] === "1",
    };
    next.devices.heater = heaterStatus[4] === "1" || heaterStatus[5] === "1";
    next.devices.heaterRotation = heaterStatus[6] === "1";
  }

  const scheduleMeta = parseScheduleMeta(line);
  if (scheduleMeta) {
    const existing = next.controls.heaterSchedule.generation === scheduleMeta.generation
      ? next.controls.heaterSchedule.points.slice(0, scheduleMeta.count)
      : [];
    while (existing.length < scheduleMeta.count) existing.push(null);
    next.controls.heaterSchedule = {
      generation: scheduleMeta.generation,
      enabled: scheduleMeta.enabled,
      persistenceEnabled: scheduleMeta.persistenceEnabled,
      clockValid: scheduleMeta.clockValid,
      activeIndex: scheduleMeta.activeIndex,
      nextIndex: scheduleMeta.nextIndex,
      points: existing,
    };
  }
  const schedulePoint = parseSchedulePoint(line);
  if (schedulePoint) {
    const current = next.controls.heaterSchedule;
    const points = current.generation === schedulePoint.generation ? [...current.points] : [];
    while (points.length <= schedulePoint.index) points.push(null);
    points[schedulePoint.index] = schedulePoint.point;
    next.controls.heaterSchedule = { ...current, generation: schedulePoint.generation, points };
  }

  const owner = meshReplyOwner(line);
  if (owner) next.nodeActivity[owner] = { lastSeenAt: Date.now(), lastError: null };
  return next;
}
