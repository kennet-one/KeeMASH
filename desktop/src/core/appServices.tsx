import { createContext, type ReactNode, useContext } from "react";
import type { ConsoleEntry } from "../components/ControlsView";
import type { LegacyState } from "../lib/protocol";
import type {
  LocalUpdateStatus,
  MemoryTestStatus,
  ResourceSample,
  SerialPortInfo,
  SerialStatus,
  WeatherSnapshot,
} from "../types";

export interface AppServices {
  ports: SerialPortInfo[];
  selectedPort: string;
  serialStatus: SerialStatus;
  legacyState: LegacyState;
  weather: WeatherSnapshot | null;
  weatherLoading: boolean;
  resources: ResourceSample[];
  entries: ConsoleEntry[];
  busy: boolean;
  autoRefresh: boolean;
  autoRefreshMinutes: number;
  debugEnabled: boolean;
  updateStatus: LocalUpdateStatus | null;
  updateBusy: boolean;
  updateError: string | null;
  memoryTest: MemoryTestStatus | null;
  setSelectedPort: (value: string) => void;
  refreshPorts: () => void;
  openSerial: () => void;
  closeSerial: () => void;
  refreshAll: () => void;
  setAutoRefresh: (value: boolean) => void;
  setAutoRefreshMinutes: (value: number) => void;
  setDebugEnabled: (value: boolean) => void;
  refreshWeather: () => void;
  sendCommand: (command: string) => void;
  checkUpdate: () => void;
  installUpdate: () => void;
  rebootToFirmware: () => void;
  startMemoryTest: (memoryMiB: number, durationSeconds: number, threads?: number) => void;
  stopMemoryTest: () => void;
  openWindowsMemoryDiagnostic: () => void;
}

const AppServicesContext = createContext<AppServices | null>(null);

export function AppServicesProvider({ value, children }: { value: AppServices; children: ReactNode }) {
  return <AppServicesContext.Provider value={value}>{children}</AppServicesContext.Provider>;
}

export function useAppServices(): AppServices {
  const value = useContext(AppServicesContext);
  if (!value) throw new Error("useAppServices must be used inside AppServicesProvider");
  return value;
}
