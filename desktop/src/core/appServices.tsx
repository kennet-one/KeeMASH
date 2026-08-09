import { createContext, type ReactNode, useContext } from "react";
import type { ConsoleEntry } from "../components/ControlsView";
import type { LegacyState } from "../lib/protocol";
import type { CommandFeedback } from "../lib/commandFeedback";
import type {
  CccDaemonStatus,
  GpuPolicyApplyResult,
  GpuPolicyPreset,
  GpuResidencySnapshot,
  LocalUpdateStatus,
  MemoryTestStatus,
  ResourceSample,
  ProcessActionResult,
  ProcessIdentity,
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
  commandFeedback: Record<string, CommandFeedback>;
  busy: boolean;
  autoRefresh: boolean;
  autoRefreshMinutes: number;
  debugEnabled: boolean;
  updateStatus: LocalUpdateStatus | null;
  updateBusy: boolean;
  updateError: string | null;
  memoryTest: MemoryTestStatus | null;
  cccStatus: CccDaemonStatus | null;
  cccBusy: boolean;
  gpuResidency: GpuResidencySnapshot | null;
  gpuResidencyBusy: boolean;
  gpuResidencyError: string | null;
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
  scheduleSystemPower: (action: "restart" | "shutdown") => void;
  cancelSystemPower: () => void;
  systemPowerPending: "restart" | "shutdown" | null;
  startMemoryTest: (memoryMiB: number, durationSeconds: number, threads?: number) => void;
  stopMemoryTest: () => void;
  openWindowsMemoryDiagnostic: () => void;
  refreshCcc: () => void;
  manageCcc: (action: "start" | "stop" | "restart") => void;
  refreshGpuResidency: () => void;
  applyGpuPolicy: (settings: { identity: ProcessIdentity; preset: GpuPolicyPreset; gpuPriority: number; ramPriority: number; persist: boolean; autoAttach: boolean; agentAllowed: boolean }) => Promise<GpuPolicyApplyResult>;
  undoGpuPolicy: (identity: ProcessIdentity) => Promise<GpuPolicyApplyResult>;
  removeGpuRule: (executablePath: string) => Promise<boolean>;
  closeProcess: (identity: ProcessIdentity) => Promise<ProcessActionResult>;
  terminateProcess: (identity: ProcessIdentity) => Promise<ProcessActionResult>;
  terminateProcessTree: (identity: ProcessIdentity) => Promise<ProcessActionResult>;
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
