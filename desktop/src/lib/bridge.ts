import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { KeeMashBridge, ResourceSample, SerialStatus, WeatherSnapshot } from "../types";

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
  serial: {
    list: () => invoke("serial_list"),
    open: (path) => invoke("serial_open", { path }),
    close: () => invoke("serial_close"),
    send: (message) => invoke("serial_send", { message }),
    status: () => invoke("serial_status"),
    onLine: (listener) => eventSubscription("serial-line", listener),
    onStatus: (listener) => eventSubscription("serial-status", listener),
  },
  resources: {
    setEnabled: (enabled) => invoke("resources_set_enabled", { enabled }),
    sample: () => invoke("resources_sample"),
    onSample: (listener) => eventSubscription("resources-sample", listener),
  },
  weather: { refresh: () => invoke("weather_refresh") },
};

function mockResourceSample(): ResourceSample {
  const phase = Date.now() / 2_500;
  return {
    timestamp: Date.now(),
    advancedSensorsAvailable: true,
    sensorBackend: "LibreHardwareMonitor + PawnIO",
    cpu: { loadPercent: 28 + Math.sin(phase) * 12, temperatureC: 58, hotspotC: 66, cores: Array.from({ length: 12 }, (_, index) => 18 + Math.sin(phase + index) * 14) },
    memory: {
      usedBytes: 12.7 * 1024 ** 3,
      totalBytes: 23.8 * 1024 ** 3,
      activeBytes: 10.9 * 1024 ** 3,
      modules: [
        { slot: "Controller0-ChannelA-DIMM0", name: "Kingston KF3200C20S4/16G", capacityBytes: 16 * 1024 ** 3, temperatureC: 43 },
        { slot: "Controller1-ChannelA-DIMM0", name: "Micron 4ATF1G64HZ-3G2E2", capacityBytes: 8 * 1024 ** 3, temperatureC: null },
      ],
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
    },
    pcie: { available: true, rxMiBs: 24 + Math.sin(phase) * 8, txMiBs: 640 + Math.cos(phase) * 310, loadPercent: 8.6 + Math.cos(phase) * 3, currentGen: 4, currentWidth: 8, maxGen: 4, maxWidth: 8 },
    network: { rxBytesPerSecond: 2.4 * 1024 ** 2, txBytesPerSecond: 380 * 1024 },
  };
}

const mockWeather: WeatherSnapshot = {
  updatedAt: Date.now(),
  current: { temperatureC: 18.4, apparentC: 17.6, humidityPercent: 63, windKmh: 11.2, precipitationMm: 0, cloudPercent: 38 },
  air: { pm25: 7.4, pm10: 12.1, carbonDioxide: 418, ozone: 66, dust: 3.2, aerosolOpticalDepth: 0.08 },
  daily: { sunrise: "2026-07-16T04:42", sunset: "2026-07-16T20:52", temperatureMaxC: 23.8, temperatureMinC: 13.2, precipitationSumMm: 0.4, precipitationHours: 1, shortwaveRadiationSum: 21.8 },
};

const mockBridge: KeeMashBridge = {
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
    setEnabled: async () => undefined,
    sample: async () => mockResourceSample(),
    onSample: (listener) => {
      const timer = window.setInterval(() => listener(mockResourceSample()), 2_000);
      listener(mockResourceSample());
      return () => window.clearInterval(timer);
    },
  },
  weather: { refresh: async () => mockWeather },
};

export const bridge: KeeMashBridge = "__TAURI_INTERNALS__" in window ? tauriBridge : mockBridge;
