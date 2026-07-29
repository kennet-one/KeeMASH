import type { ResponsiveLayouts } from "react-grid-layout";
import type { ModuleCapability, ModuleId, RuntimeState, WorkspaceId } from "./moduleTypes";

export type AppBreakpoint = "lg" | "md" | "sm" | "xs";
export type SidebarMode = "expanded" | "rail" | "hidden";
export type MotionLevel = "full" | "calm" | "off";
export type HubEdge = "left" | "right" | "top" | "bottom";
export type WorkspacePreset = "default" | "compact" | "monitoring";

export interface WidgetInstance {
  instanceId: string;
  widgetId: string;
  visible: boolean;
  keepAlive: boolean;
}

export interface HubDock {
  edge: HubEdge;
  offset: number;
}

export interface WorkspaceProfileV2 {
  schemaVersion: 2;
  revision: number;
  activeWorkspace: WorkspaceId;
  sidebarMode: SidebarMode;
  sidebarRestoreMode: Exclude<SidebarMode, "hidden">;
  topbarVisible: boolean;
  statusbarVisible: boolean;
  immersiveChrome: boolean;
  motionLevel: MotionLevel;
  consoleAutoScroll: boolean;
  telemetryIntervalMs: number;
  hubDock: HubDock;
  enabledModules: Record<ModuleId, boolean>;
  grants: Record<ModuleId, ModuleCapability[]>;
  instances: Record<WorkspaceId, WidgetInstance[]>;
  layouts: Record<WorkspaceId, ResponsiveLayouts<AppBreakpoint>>;
  preset: WorkspacePreset;
}

export interface RuntimeSnapshot {
  profile: WorkspaceProfileV2;
  moduleStates: Array<{ moduleId: ModuleId; state: RuntimeState }>;
  canUndo: boolean;
  lastAction: string | null;
  historyCursor: number;
  startedAt: number;
}

export type RuntimeAction =
  | { type: "setActiveWorkspace"; workspace: WorkspaceId }
  | { type: "setSidebarMode"; mode: SidebarMode }
  | { type: "setTopbarVisible"; visible: boolean }
  | { type: "setStatusbarVisible"; visible: boolean }
  | { type: "setImmersiveChrome"; enabled: boolean }
  | { type: "setMotionLevel"; level: MotionLevel }
  | { type: "setConsoleAutoScroll"; enabled: boolean }
  | { type: "setTelemetryInterval"; intervalMs: number }
  | { type: "setHubDock"; edge: HubEdge; offset: number }
  | { type: "setLayout"; workspace: WorkspaceId; layouts: ResponsiveLayouts<AppBreakpoint> }
  | { type: "setWidgetVisible"; workspace: WorkspaceId; instanceId: string; visible: boolean }
  | { type: "setWidgetKeepAlive"; workspace: WorkspaceId; instanceId: string; keepAlive: boolean }
  | { type: "addWidget"; workspace: WorkspaceId; widgetId: string }
  | { type: "setModuleEnabled"; moduleId: ModuleId; enabled: boolean }
  | { type: "setCapability"; moduleId: ModuleId; capability: ModuleCapability; enabled: boolean }
  | { type: "applyPreset"; preset: WorkspacePreset }
  | { type: "undo" };

export interface RuntimeHistoryEntry {
  cursor: number;
  timestamp: number;
  kind: string;
  payload: unknown;
}

export interface RuntimeHistoryPage {
  entries: RuntimeHistoryEntry[];
  nextCursor: number;
}
