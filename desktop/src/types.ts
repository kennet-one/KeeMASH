export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
}

export interface SerialStatus {
  connected: boolean;
  path: string | null;
  baudRate: number;
  error: string | null;
}

export interface ResourceSample {
  timestamp: number;
  advancedSensorsAvailable: boolean;
  sensorBackend: string;
  cpu: {
    loadPercent: number;
    temperatureC: number | null;
    hotspotC: number | null;
    powerW: number | null;
    cores: number[];
  };
  memory: {
    usedBytes: number;
    totalBytes: number;
    activeBytes: number;
    busAvailable: boolean;
    busLoadPercent: number | null;
    readMiBs: number | null;
    writeMiBs: number | null;
    busSource: string;
    modules: Array<{
      slot: string;
      bank: string;
      name: string;
      manufacturer: string;
      partNumber: string;
      serialNumber: string;
      capacityBytes: number;
      speedMts: number;
      configuredSpeedMts: number;
      configuredVoltageMv: number;
      minVoltageMv: number;
      maxVoltageMv: number;
      dataWidthBits: number;
      totalWidthBits: number;
      formFactor: string;
      memoryType: string;
      temperatureC: number | null;
    }>;
    spdProfiles: Array<{
      address: string;
      memoryType: string;
      manufacturer: string;
      dramManufacturer: string;
      partNumber: string;
      serialNumber: string;
      capacityGiB: number;
      dataRateMts: number;
      casLatencies: number[];
      timings: Array<{
        name: string;
        group: string;
        cycles: number;
        nanoseconds: number;
        source: string;
      }>;
    }>;
    spdError: string;
    activeTimings: Array<{
      name: string;
      group: string;
      cycles: number;
      nanoseconds: number;
      source: string;
    }>;
    activeTimingSource: string;
    activeTimingError: string;
  };
  gpu: {
    available: boolean;
    name: string;
    loadPercent: number | null;
    temperatureC: number | null;
    hotspotC: number | null;
    memoryTemperatureC: number | null;
    graphicsClockMhz: number | null;
    memoryClockMhz: number | null;
    memoryUsedMiB: number | null;
    memoryTotalMiB: number | null;
    powerW: number | null;
    memoryChipsAvailable: boolean;
    memoryChipSource: string;
    memoryChipUpdatedAt: number;
    memoryChipError: string;
    memoryChips: Array<{
      channel: number;
      label: string;
      temperatureC: number;
      minimumC: number | null;
      maximumC: number | null;
      averageC: number | null;
    }>;
  };
  pcie: {
    available: boolean;
    rxMiBs: number | null;
    txMiBs: number | null;
    loadPercent: number | null;
    currentGen: number | null;
    currentWidth: number | null;
    maxGen: number | null;
    maxWidth: number | null;
  };
  network: {
    rxBytesPerSecond: number;
    txBytesPerSecond: number;

  };
}

export interface MemoryTestStatus {
  state: "idle" | "allocating" | "running" | "passed" | "failed" | "stopped" | "error";
  stage: string;
  requestedMiB: number;
  allocatedMiB: number;
  durationSeconds: number;
  elapsedSeconds: number;
  threads: number;
  passes: number;
  errors: number;
  testedBytes: number;
  throughputMiBs: number;
  startedAt: number;
  lastError: string | null;
  wheaCount24h: number | null;
  wheaLastEventId: number | null;
  wheaCapped: boolean;
  wheaError: string | null;
}

export type CccDaemonState = "running" | "stopped" | "stale_pid" | "identity_mismatch" | "unavailable" | "unsupported";

export interface CccDaemonStatus {
  state: CccDaemonState;
  runtimeRoot: string;
  pidFile: string;
  cliPath: string;
  cliAvailable: boolean;
  pid: number | null;
  pidFileValue: number | null;
  pidSource: "none" | "pid_file" | "recovered_process_scan";
  identityValid: boolean;
  process: null | {
    pid: number;
    name: string;
    executablePath: string;
    commandLine: string;
    workingSetBytes: number;
    privateBytes: number;
    threadCount: number;
    startedAt: string | null;
    gpuMemory: { dedicatedBytes: number; sharedBytes: number; instanceCount: number };
  };
  message: string;
}

export interface CccDaemonActionResult {
  action: "start" | "stop" | "restart";
  success: boolean;
  forced: boolean;
  message: string;
  cliStdout: string;
  cliStderr: string;
  status: CccDaemonStatus;
}
export interface WeatherSnapshot {
  updatedAt: number;
  current: {
    temperatureC: number | null;
    apparentC: number | null;
    humidityPercent: number | null;
    windKmh: number | null;
    precipitationMm: number | null;
    precipitationProbabilityPercent: number | null;
    rainMm: number | null;
    snowfallCm: number | null;
    weatherCode: number | null;
    isDay: boolean | null;
    cloudPercent: number | null;
  };
  air: {
    pm25: number | null;
    pm10: number | null;
    carbonDioxide: number | null;
    ozone: number | null;
    dust: number | null;
    aerosolOpticalDepth: number | null;
  };
  daily: {
    sunrise: string | null;
    sunset: string | null;
    temperatureMaxC: number | null;
    temperatureMinC: number | null;
    precipitationSumMm: number | null;
    precipitationProbabilityMaxPercent: number | null;
    snowfallSumCm: number | null;
    weatherCode: number | null;
    precipitationHours: number | null;
    shortwaveRadiationSum: number | null;
  };
}

export type KenUltraNodeKind = "formset" | "form" | "question" | "option" | "varstore" | "module" | "evidence" | "risk" | "recovery" | "hypothesis";

export interface KenUltraNode {
  id: string;
  kind: KenUltraNodeKind;
  label: string;
  help?: string;
  domain: string;
  status: string;
  risk: "low" | "medium" | "high" | "regulatory";
  confidence: "ifr-fact" | "observed" | "inference" | "hypothesis" | "unknown";
  aliases: string[];
  formTitle?: string;
  questionId?: string;
  questionType?: string;
  varStoreName?: string;
  varOffset?: string;
  value?: string | number;
  default?: boolean;
  patched?: boolean;
  performanceExcluded?: boolean;
}

export interface KenUltraEdge {
  id: string;
  from: string;
  to: string;
  kind: string;
  label: string;
  confidence: KenUltraNode["confidence"];
  risk?: KenUltraNode["risk"];
  speculative?: boolean;
}

export interface KenUltraCatalog {
  schemaVersion: 1;
  generatedAt: string;
  safety: {
    mode: "read-only-simulation";
    firmwareWrite: false;
    rawFirmwareIncluded: false;
    privateInventoryIncluded: false;
  };
  stats: { forms: number; questions: number; options: number; varStores: number };
  nodes: KenUltraNode[];
  edges: KenUltraEdge[];
}

export interface KenUltraCatalogEnvelope {
  catalog: KenUltraCatalog;
  sourcePath: string;
}

export interface LocalUpdateStatus {
  currentVersion: string;
  available: boolean;
  version: string | null;
  publishedAt: string | null;
  installerName: string | null;
  bytes: number | null;
  message: string;
}

export interface KeeMashBridge {
  runtime: {
    bootstrap: () => Promise<RuntimeSnapshot>;
    apply: (action: RuntimeAction, expectedRevision: number) => Promise<RuntimeSnapshot>;
    history: (kind?: string, cursor?: number, limit?: number) => Promise<RuntimeHistoryPage>;
    onSnapshot: (listener: (snapshot: RuntimeSnapshot) => void) => () => void;
  };
  serial: {
    list: () => Promise<SerialPortInfo[]>;
    open: (path: string) => Promise<SerialStatus>;
    close: () => Promise<SerialStatus>;
    send: (message: string) => Promise<void>;
    status: () => Promise<SerialStatus>;
    onLine: (listener: (line: string) => void) => () => void;
    onStatus: (listener: (status: SerialStatus) => void) => () => void;
  };
  resources: {
    sample: () => Promise<ResourceSample>;
    onSample: (listener: (sample: ResourceSample) => void) => () => void;
  };
  weather: {
    refresh: () => Promise<WeatherSnapshot>;
    onSnapshot: (listener: (snapshot: WeatherSnapshot) => void) => () => void;
  };
  kenultra: {
    load: () => Promise<KenUltraCatalogEnvelope>;
  };
  updates: {
    check: () => Promise<LocalUpdateStatus>;
    install: () => Promise<void>;
    onStatus: (listener: (status: LocalUpdateStatus) => void) => () => void;
  };
  ccc: {
    status: () => Promise<CccDaemonStatus>;
    start: () => Promise<CccDaemonActionResult>;
    stop: () => Promise<CccDaemonActionResult>;
    restart: () => Promise<CccDaemonActionResult>;
  };
  memory: {
    status: () => Promise<MemoryTestStatus>;
    start: (memoryMiB: number, durationSeconds: number, threads?: number) => Promise<MemoryTestStatus>;
    stop: () => Promise<MemoryTestStatus>;
    openWindowsDiagnostic: () => Promise<void>;
  };
  system: {
    rebootToFirmware: () => Promise<void>;
    restart: () => Promise<{ action: string; delaySeconds: number }>;
    shutdown: () => Promise<{ action: string; delaySeconds: number }>;
    cancelPower: () => Promise<void>;
  };
};
import type { RuntimeAction, RuntimeHistoryPage, RuntimeSnapshot } from "./core/runtimeTypes";
