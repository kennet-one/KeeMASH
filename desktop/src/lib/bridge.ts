import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { CccDaemonStatus, GpuResidencySnapshot, GraphicsRuntimeStatus, KeeMashBridge, KenUltraCatalogEnvelope, LocalUpdateStatus, MemoryTestStatus, ResourceSample, SerialStatus, WeatherSnapshot } from "../types";
import type { RuntimeAction, RuntimeHistoryPage, RuntimeSnapshot } from "../core/runtimeTypes";

let mockStatus: SerialStatus = { connected: false, path: null, baudRate: 115200, error: null };

function eventSubscription<T>(event: string, listener: (payload: T) => void): () => void {
  let active = true;
  let unlisten: UnlistenFn | undefined;
  void listen<T>(event, ({ payload }) => {
    if (active) listener(payload);
  }).then((stop) => {
    if (active) unlisten = stop;
    else stop();
  });
  return () => {
    active = false;
    unlisten?.();
  };
}

const tauriBridge: KeeMashBridge = {
  runtime: {
    bootstrap: () => invoke("runtime_bootstrap"),
    apply: (action: RuntimeAction, expectedRevision: number) => invoke("runtime_apply_action", { action, expectedRevision }),
    history: (kind?: string, cursor = 0, limit = 100) => invoke("runtime_history", { kind, cursor, limit }),
    onSnapshot: (listener) => eventSubscription("runtime-snapshot", listener),
  },
  graphics: {
    status: () => invoke("graphics_runtime_status"),
    setMaster: (luid) => invoke("admin_graphics_set_master", { luid }),
    restart: () => invoke("admin_graphics_restart"),
    onStatus: (listener) => eventSubscription("graphics-runtime-status", listener),
  },
  serial: {
    list: () => dispatch("serial.list"),
    open: (path) => dispatch("serial.open", { path }),
    close: () => dispatch("serial.close"),
    send: (message) => dispatch("serial.send", { message }),
    status: () => dispatch("serial.status"),
    onLine: (listener) => eventSubscription("serial-line", listener),
    onStatus: (listener) => eventSubscription("serial-status", listener),
  },
  resources: {
    sample: () => dispatch("resources.sample"),
    onSample: (listener) => eventSubscription("resources-sample", listener),
  },
  ccc: {
    status: () => dispatch("ccc.status"),
    start: () => dispatch("ccc.start", { timeoutMs: 15_000 }),
    stop: () => dispatch("ccc.stop", { timeoutMs: 15_000 }),
    restart: () => dispatch("ccc.restart", { timeoutMs: 20_000 }),
  },
  gpuResidency: {
    snapshot: () => dispatch("gpu.residency.snapshot"),
    setProcessPolicy: (settings) => dispatch("gpu.residency.setProcessPolicy", settings),
    undoProcessPolicy: (identity) => dispatch("gpu.residency.undoProcessPolicy", { identity }),
    removeRule: (executablePath) => dispatch("gpu.residency.removeRule", { executablePath }),
    attachAgent: (identity) => dispatch("gpu.residency.attachAgent", { identity }),
    detachAgent: (identity) => dispatch("gpu.residency.detachAgent", { identity }),
  },
  process: {
    close: (identity) => dispatch("process.close", { identity }),
    terminate: (identity) => dispatch("process.terminate", { identity }),
    terminateTree: (identity) => dispatch("process.terminateTree", { identity }),
  },
  memory: {
    status: () => dispatch("memory.test.status"),
    start: (memoryMiB, durationSeconds, threads = 0) => dispatch("memory.test.start", { memoryMiB, durationSeconds, threads }),
    stop: () => dispatch("memory.test.stop"),
    openWindowsDiagnostic: () => dispatch("memory.diagnostic.open"),
  },
  weather: {
    refresh: () => dispatch("weather.refresh"),
    onSnapshot: (listener) => eventSubscription("weather-snapshot", listener),
  },
  kenultra: { load: () => dispatch("kenultra.load") },
  updates: {
    check: () => dispatch("updates.check"),
    install: () => dispatch("updates.install"),
    onStatus: (listener) => eventSubscription("update-status", listener),
  },
  system: {
    rebootToFirmware: () => dispatch("system.rebootToFirmware"),
    restart: () => dispatch("system.restart"),
    shutdown: () => dispatch("system.shutdown"),
    cancelPower: () => dispatch("system.cancelPower"),
  },
};

function dispatch<T>(operation: string, payload: Record<string, unknown> = {}): Promise<T> {
  const adminCommand = ADMIN_COMMANDS[operation];
  return adminCommand
    ? invoke(adminCommand, { payload })
    : invoke("runtime_dispatch", { request: { operation, payload } });
}

const ADMIN_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  "gpu.residency.setProcessPolicy": "admin_gpu_set_process_policy",
  "gpu.residency.undoProcessPolicy": "admin_gpu_undo_process_policy",
  "gpu.residency.removeRule": "admin_gpu_remove_rule",
  "process.close": "admin_process_close",
  "process.terminate": "admin_process_terminate",
  "process.terminateTree": "admin_process_terminate_tree",
  "ccc.start": "admin_ccc_start",
  "ccc.stop": "admin_ccc_stop",
  "ccc.restart": "admin_ccc_restart",
  "memory.test.start": "admin_memory_test_start",
  "memory.test.stop": "admin_memory_test_stop",
  "memory.diagnostic.open": "admin_memory_diagnostic_open",
  "updates.install": "admin_update_install",
  "system.rebootToFirmware": "admin_system_reboot_to_firmware",
  "system.restart": "admin_system_restart",
  "system.shutdown": "admin_system_shutdown",
  "system.cancelPower": "admin_system_cancel_power",
});

function mockResourceSample(): ResourceSample {
  const phase = Date.now() / 2_500;
  return {
    timestamp: Date.now(),
    advancedSensorsAvailable: true,
    sensorBackend: "LibreHardwareMonitor + PawnIO",
    cpu: { loadPercent: 28 + Math.sin(phase) * 12, temperatureC: 58, hotspotC: 66, powerW: 38 + Math.sin(phase) * 7, cores: Array.from({ length: 12 }, (_, index) => 18 + Math.sin(phase + index) * 14) },
    memory: {
      usedBytes: 12.7 * 1024 ** 3,
      totalBytes: 23.8 * 1024 ** 3,
      activeBytes: 10.9 * 1024 ** 3,
      busAvailable: true,
      busLoadPercent: 36 + Math.sin(phase) * 18,
      readMiBs: 9_600 + Math.sin(phase) * 2_200,
      writeMiBs: 4_200 + Math.cos(phase) * 1_100,
      busSource: "Mock IMC telemetry",
      modules: [
        { slot: "Controller0-ChannelA-DIMM0", bank: "BANK 0", name: "Kingston KF3200C20S4/16G", manufacturer: "Kingston", partNumber: "KF3200C20S4/16G", serialNumber: "A1B2C3D4", capacityBytes: 16 * 1024 ** 3, speedMts: 3200, configuredSpeedMts: 3200, configuredVoltageMv: 1250, minVoltageMv: 1200, maxVoltageMv: 1250, dataWidthBits: 64, totalWidthBits: 64, formFactor: "SODIMM", memoryType: "DDR4", temperatureC: 43 },
        { slot: "Controller1-ChannelA-DIMM0", bank: "BANK 2", name: "Kingston KF3200C20S4/16G", manufacturer: "Kingston", partNumber: "KF3200C20S4/16G", serialNumber: "E5F6A7B8", capacityBytes: 16 * 1024 ** 3, speedMts: 3200, configuredSpeedMts: 3200, configuredVoltageMv: 1250, minVoltageMv: 1200, maxVoltageMv: 1250, dataWidthBits: 64, totalWidthBits: 64, formFactor: "SODIMM", memoryType: "DDR4", temperatureC: null },
      ],
      spdProfiles: [{ address: "0x50", memoryType: "DDR4", manufacturer: "Kingston", dramManufacturer: "SK hynix", partNumber: "KF3200C20S4/16G", serialNumber: "A1B2C3D4", capacityGiB: 16, dataRateMts: 3200, casLatencies: [10, 12, 14, 16, 18, 20, 22], timings: [
        { name: "tCL", group: "primary", cycles: 22, nanoseconds: 13.75, source: "SPD minimum" },
        { name: "tRCD", group: "primary", cycles: 22, nanoseconds: 13.75, source: "SPD minimum" },
        { name: "tRP", group: "primary", cycles: 22, nanoseconds: 13.75, source: "SPD minimum" },
        { name: "tRAS", group: "primary", cycles: 52, nanoseconds: 32.5, source: "SPD minimum" },
        { name: "tRC", group: "secondary", cycles: 74, nanoseconds: 46.25, source: "SPD minimum" },
        { name: "tRFC1", group: "secondary", cycles: 560, nanoseconds: 350, source: "SPD minimum" },
      ] }],
      spdError: "",
      activeTimings: [
        { name: "tCL", group: "primary", cycles: 16, nanoseconds: 10, source: "AIDA64 active IMC" },
        { name: "tRCD", group: "primary", cycles: 17, nanoseconds: 10.625, source: "AIDA64 active IMC" },
        { name: "tRP", group: "primary", cycles: 17, nanoseconds: 10.625, source: "AIDA64 active IMC" },
        { name: "CR", group: "primary", cycles: 1, nanoseconds: 0.625, source: "AIDA64 active IMC" },
        { name: "tRFC1", group: "secondary", cycles: 520, nanoseconds: 325, source: "AIDA64 active IMC" },
        { name: "tCWL", group: "secondary", cycles: 18, nanoseconds: 11.25, source: "AIDA64 active IMC" },
      ],
      activeTimingSource: "AIDA64 active IMC",
      activeTimingError: "",
    },
    gpu: {
      available: true,
      name: "NVIDIA GeForce RTX 3050 Ti Laptop GPU",
      loadPercent: 42 + Math.cos(phase) * 18,
      temperatureC: 61,
      hotspotC: 72,
      memoryTemperatureC: null,
      graphicsClockMhz: 1485,
      memoryClockMhz: 6001,
      memoryUsedMiB: 2180,
      memoryTotalMiB: 4096,
      powerW: 47,
      memoryChipsAvailable: false,
      memoryChipSource: "Experimental per-chip providers",
      memoryChipUpdatedAt: 0,
      memoryChipError: "Exact per-chip providers are unavailable",
      memoryChipExperimentalSupported: true,
      memoryChipProviders: [
        { id: "native-nvapi", label: "Native NVIDIA NVAPI", state: "no-exact-channels", active: true, exactChannelCount: 0, candidateCount: 9, lastUpdateUnixS: 0, detail: "9 driver thermal channels; no driver-classified memory channel" },
        { id: "afterburner-hotspot", label: "MSI Afterburner / Hotspot plugin", state: "unavailable", active: false, exactChannelCount: 0, candidateCount: 0, lastUpdateUnixS: 0, detail: "Shared memory is unavailable" },
        { id: "hwinfo", label: "HWiNFO shared memory", state: "unavailable", active: false, exactChannelCount: 0, candidateCount: 0, lastUpdateUnixS: 0, detail: "Shared memory is unavailable" },
      ],
      memoryChips: [],
      thermalChannelSource: "Native NVIDIA NVAPI",
      thermalChannelError: "",
      thermalChannels: [
        { gpuIndex: 0, channelIndex: 0, channelClass: 1, channelType: 0, relativeLocation: 0, targetGpu: 0, temperatureC: 51.0, primaryMemory: false },
        { gpuIndex: 0, channelIndex: 1, channelClass: 1, channelType: 1, relativeLocation: 0, targetGpu: 0, temperatureC: 59.3, primaryMemory: false },
        { gpuIndex: 0, channelIndex: 2, channelClass: 1, channelType: 255, relativeLocation: 0, targetGpu: 0, temperatureC: 51.0, primaryMemory: false },
      ],
    },
    pcie: { available: true, rxMiBs: 24 + Math.sin(phase) * 8, txMiBs: 640 + Math.cos(phase) * 310, loadPercent: 8.6 + Math.cos(phase) * 3, currentGen: 4, currentWidth: 8, maxGen: 4, maxWidth: 8 },
    network: { rxBytesPerSecond: 2.4 * 1024 ** 2, txBytesPerSecond: 380 * 1024 },
  };
}

const mockWeather: WeatherSnapshot = {
  updatedAt: Date.now(),
  current: { temperatureC: 18.4, apparentC: 17.6, humidityPercent: 63, windKmh: 11.2, precipitationMm: 0, precipitationProbabilityPercent: 18, rainMm: 0, snowfallCm: 0, weatherCode: 2, isDay: true, cloudPercent: 38 },
  air: { pm25: 7.4, pm10: 12.1, carbonDioxide: 418, ozone: 66, dust: 3.2, aerosolOpticalDepth: 0.08 },
  daily: { sunrise: "2026-07-16T04:42", sunset: "2026-07-16T20:52", temperatureMaxC: 23.8, temperatureMinC: 13.2, precipitationSumMm: 0.4, precipitationProbabilityMaxPercent: 42, snowfallSumCm: 0, weatherCode: 61, precipitationHours: 1, shortwaveRadiationSum: 21.8 },
};

const mockKenUltra: KenUltraCatalogEnvelope = {
  sourcePath: "mock://KenULTRABIOS/mash-bridge.json",
  catalog: {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    safety: { mode: "read-only-simulation", firmwareWrite: false, rawFirmwareIncluded: false, privateInventoryIncluded: false },
    stats: { forms: 181, questions: 4076, options: 7758, varStores: 16 },
    nodes: [
      { id: "memory", kind: "form", label: "Memory Configuration", domain: "memory", status: "raw", risk: "low", confidence: "ifr-fact", aliases: [] },
      { id: "power-down", kind: "question", label: "Power Down Mode", help: "CKE Power Down Mode Control", domain: "memory", status: "strong-signal", risk: "medium", confidence: "observed", aliases: [], formTitle: "Memory Configuration", questionId: "0x140E", varStoreName: "SaSetup", varOffset: "0x14F" },
      { id: "aida", kind: "evidence", label: "AIDA Power Down result: 86.5 ns", domain: "memory", status: "strong-signal", risk: "low", confidence: "observed", aliases: [] },
    ],
    edges: [
      { id: "e1", from: "memory", to: "power-down", kind: "contains", label: "contains question", confidence: "ifr-fact" },
      { id: "e2", from: "power-down", to: "aida", kind: "measured_by", label: "measured by AIDA", confidence: "observed" },
    ],
  },
};

const mockUpdate: LocalUpdateStatus = {
  currentVersion: "0.2.0",
  available: true,
  version: "0.3.0",
  publishedAt: new Date().toISOString(),
  installerName: "KeeMASH_0.3.0_x64-setup.exe",
  bytes: 18_500_000,
  message: "Fresh local build is ready",
};

const mockGraphicsStatus: GraphicsRuntimeStatus = {
  adapters: [
    { luid: "0x00000000_0x0000a001", name: "Intel UHD Graphics", vendorId: 0x8086, deviceId: 0, dedicatedVideoBytes: 0, sharedSystemBytes: 8 * 1024 ** 3, preference: "minimumPower", preferenceRank: 0, available: true },
    { luid: "0x00000000_0x00012ecb", name: "NVIDIA GeForce RTX 3050 Ti Laptop GPU", vendorId: 0x10de, deviceId: 0, dedicatedVideoBytes: 4 * 1024 ** 3, sharedSystemBytes: 8 * 1024 ** 3, preference: "highPerformance", preferenceRank: 0, available: true },
  ],
  selected: { luid: null, name: "Auto (Windows)", available: true },
  activeNativeLuid: null,
  observedLuids: ["0x00000000_0x00012ecb"],
  observedNames: ["NVIDIA GeForce RTX 3050 Ti Laptop GPU"],
  webviewPreference: "system",
  registryPreference: null,
  restartRequired: false,
  fallbackReason: null,
};

let mockMemoryStartedAt = 0;
const mockMemoryStatus = (): MemoryTestStatus => {
  const elapsed = mockMemoryStartedAt ? Math.floor((Date.now() - mockMemoryStartedAt) / 1_000) : 0;
  return { state: mockMemoryStartedAt ? "running" : "idle", stage: mockMemoryStartedAt ? "Seeded random" : "Ready", requestedMiB: 4096, allocatedMiB: mockMemoryStartedAt ? 4096 : 0, durationSeconds: 900, elapsedSeconds: elapsed, threads: 8, passes: Math.floor(elapsed / 12), errors: 0, testedBytes: elapsed * 8_200 * 1024 ** 2, throughputMiBs: mockMemoryStartedAt ? 8200 : 0, startedAt: mockMemoryStartedAt ? Math.floor(mockMemoryStartedAt / 1_000) : 0, lastError: null, wheaCount24h: 0, wheaLastEventId: null, wheaCapped: false, wheaError: null };
};
const mockCccStatus = (): CccDaemonStatus => ({
  state: "running", runtimeRoot: "C:\\Users\\kennet\\.cocoindex_code", pidFile: "daemon.pid", cliPath: "ccc.exe", cliAvailable: true,
  pid: 4242, pidFileValue: 4242, pidSource: "pid_file", identityValid: true, message: "Verified shared CocoIndex daemon is running",
  process: { pid: 4242, name: "python.exe", executablePath: "python.exe", commandLine: "python -m cocoindex_code.cli run-daemon", workingSetBytes: 710 * 1024 ** 2, privateBytes: 7.2 * 1024 ** 3, threadCount: 59, startedAt: new Date().toISOString(), gpuMemory: { dedicatedBytes: 3.3 * 1024 ** 3, sharedBytes: 640 * 1024 ** 2, instanceCount: 3 } },
});

const mockGpuResidency = (): GpuResidencySnapshot => ({
  timestamp: Date.now(),
  source: "Windows PDH GPU Process Memory + GPU Engine",
  sourceWarning: "Process totals are live; D3D agent is detached",
  physicalUsedBytes: 3.5 * 1024 ** 3,
  physicalTotalBytes: 4 * 1024 ** 3,
  trackedDedicatedBytes: 3.2 * 1024 ** 3,
  trackedSharedBytes: 780 * 1024 ** 2,
  unaccountedBytes: 300 * 1024 ** 2,
  pressurePercent: 87.5,
  agentAvailable: false,
  agentProtocol: 1,
  rules: [],
  processes: [
    { identity: { pid: 19812, startedAt: 1_781_000_000, executablePath: "C:\\Python313\\python.exe", executableHash: "" }, name: "python.exe", dedicatedBytes: 2.7 * 1024 ** 3, sharedBytes: 78 * 1024 ** 2, gpuPercent: 72, engines: ["compute_0"], adapters: ["0x00012ecb_phys_0"], descendantCount: 2, gpuPriority: 2, ramPriority: 5, protected: false, manageable: true, agentState: "detached", agentMessage: "D3D agent is not attached", appliedRule: null, resourceGroups: [] },
    { identity: { pid: 1700, startedAt: 1_781_000_100, executablePath: "C:\\Windows\\System32\\dwm.exe", executableHash: "" }, name: "dwm.exe", dedicatedBytes: 520 * 1024 ** 2, sharedBytes: 410 * 1024 ** 2, gpuPercent: 12, engines: ["3d"], adapters: ["0x00012ecb_phys_0"], descendantCount: 0, gpuPriority: 2, ramPriority: 5, protected: true, manageable: false, agentState: "blocked", agentMessage: "Protected system process", appliedRule: null, resourceGroups: [] },
  ],
});

const mockBridge: KeeMashBridge = {
  runtime: {
    bootstrap: async () => { throw new Error("Browser preview owns its local runtime"); },
    apply: async (_action: RuntimeAction, _expectedRevision: number) => { throw new Error("Browser preview owns its local runtime"); },
    history: async (): Promise<RuntimeHistoryPage> => ({ entries: [], nextCursor: 0 }),
    onSnapshot: () => () => undefined,
  },
  graphics: {
    status: async () => mockGraphicsStatus,
    setMaster: async (luid) => ({
      ...mockGraphicsStatus,
      selected: luid
        ? { luid, name: mockGraphicsStatus.adapters.find((adapter) => adapter.luid === luid)?.name ?? "Unavailable adapter", available: mockGraphicsStatus.adapters.some((adapter) => adapter.luid === luid) }
        : { luid: null, name: "Auto (Windows)", available: true },
      activeNativeLuid: luid,
      restartRequired: true,
    }),
    restart: async () => undefined,
    onStatus: () => () => undefined,
  },
  serial: {
    list: async () => [{ path: "COM4", manufacturer: "Bluetooth serial" }, { path: "COM10", manufacturer: "USB serial" }],
    open: async (path) => (mockStatus = { connected: true, path, baudRate: 115200, error: null }),
    close: async () => (mockStatus = { connected: false, path: null, baudRate: 115200, error: null }),
    send: async () => undefined,
    status: async () => mockStatus,
    onLine: () => () => undefined,
    onStatus: () => () => undefined,
  },
  resources: {
    sample: async () => mockResourceSample(),
    onSample: (listener) => {
      const timer = window.setInterval(() => listener(mockResourceSample()), 2_000);
      listener(mockResourceSample());
      return () => window.clearInterval(timer);
    },
  },
  ccc: {
    status: async () => mockCccStatus(),
    start: async () => ({ action: "start", success: true, forced: false, message: "started", cliStdout: "", cliStderr: "", status: mockCccStatus() }),
    stop: async () => ({ action: "stop", success: true, forced: false, message: "stopped", cliStdout: "", cliStderr: "", status: { ...mockCccStatus(), state: "stopped", pid: null, process: null } }),
    restart: async () => ({ action: "restart", success: true, forced: false, message: "restarted", cliStdout: "", cliStderr: "", status: mockCccStatus() }),
  },
  gpuResidency: {
    snapshot: async () => mockGpuResidency(),
    setProcessPolicy: async (settings) => ({ success: true, pid: settings.identity.pid, previousGpuPriority: 2, previousRamPriority: 5, gpuPriority: settings.gpuPriority, ramPriority: settings.ramPriority, persisted: settings.persist, message: "Policy applied" }),
    undoProcessPolicy: async (identity) => ({ success: true, pid: identity.pid, previousGpuPriority: 2, previousRamPriority: 5, gpuPriority: 2, ramPriority: 5, persisted: true, message: "Previous policy restored" }),
    removeRule: async () => true,
    attachAgent: async () => { throw new Error("D3D agent is not installed in preview mode"); },
    detachAgent: async () => undefined,
  },
  process: {
    close: async (identity) => ({ action: "close", success: false, pid: identity.pid, requestedCount: 1, completedCount: 0, failedCount: 0, stillRunning: true, windowCount: 1, message: "Preview process remains open", errors: [] }),
    terminate: async (identity) => ({ action: "terminate", success: true, pid: identity.pid, requestedCount: 1, completedCount: 1, failedCount: 0, stillRunning: false, windowCount: 0, message: "Preview process terminated", errors: [] }),
    terminateTree: async (identity) => ({ action: "terminate_tree", success: true, pid: identity.pid, requestedCount: 3, completedCount: 3, failedCount: 0, stillRunning: false, windowCount: 0, message: "Preview process tree terminated", errors: [] }),
  },
  memory: {
    status: async () => mockMemoryStatus(),
    start: async () => { mockMemoryStartedAt = Date.now(); return mockMemoryStatus(); },
    stop: async () => { mockMemoryStartedAt = 0; return { ...mockMemoryStatus(), state: "stopped", stage: "Stopped" }; },
    openWindowsDiagnostic: async () => undefined,
  },
  weather: { refresh: async () => mockWeather, onSnapshot: () => () => undefined },
  kenultra: { load: async () => mockKenUltra },
  updates: {
    check: async () => mockUpdate,
    install: async () => undefined,
    onStatus: () => () => undefined,
  },
  system: {
    rebootToFirmware: async () => undefined,
    restart: async () => ({ action: "restart", delaySeconds: 15 }),
    shutdown: async () => ({ action: "shutdown", delaySeconds: 15 }),
    cancelPower: async () => undefined,
  },
};

export const bridge: KeeMashBridge = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? tauriBridge : mockBridge;
