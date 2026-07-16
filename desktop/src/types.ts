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
  cpu: {
    loadPercent: number;
    temperatureC: number | null;
    cores: number[];
  };
  memory: {
    usedBytes: number;
    totalBytes: number;
    activeBytes: number;
  };
  gpu: {
    available: boolean;
    name: string;
    loadPercent: number | null;
    temperatureC: number | null;
    memoryUsedMiB: number | null;
    memoryTotalMiB: number | null;
    powerW: number | null;
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

export interface WeatherSnapshot {
  updatedAt: number;
  current: {
    temperatureC: number | null;
    apparentC: number | null;
    humidityPercent: number | null;
    windKmh: number | null;
    precipitationMm: number | null;
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
    precipitationHours: number | null;
    shortwaveRadiationSum: number | null;
  };
}

export interface KeeMashBridge {
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
    setEnabled: (enabled: boolean) => Promise<void>;
    sample: () => Promise<ResourceSample>;
    onSample: (listener: (sample: ResourceSample) => void) => () => void;
  };
  weather: {
    refresh: () => Promise<WeatherSnapshot>;
  };
};
