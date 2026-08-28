import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Layout, LayoutItem, ResponsiveLayouts } from "react-grid-layout";
import { bridge } from "../lib/bridge";
import type { ModuleCapability, ModuleId, RuntimeState, WorkspaceId } from "./moduleTypes";
import type {
  AppBreakpoint,
  HubDock,
  HubEdge,
  MotionLevel,
  RuntimeAction,
  RuntimeSnapshot,
  SidebarMode,
  WidgetInstance,
  WorkspacePreset,
  WorkspaceProfileV2,
} from "./runtimeTypes";

export type { AppBreakpoint, WidgetInstance, WorkspaceProfileV2 as WorkspaceProfile } from "./runtimeTypes";

const BROWSER_STORE_KEY = "keemash.workspace.v2";
export const CURRENT_WORKSPACE_EPOCH = 1;
const SENSITIVE_CAPABILITIES = new Set<ModuleCapability>(["hardware.lowlevel", "process.control", "process.inject", "updates.manage"]);

const allGrants: Record<ModuleId, ModuleCapability[]> = {
  main: ["mesh.read", "mesh.command", "serial.read", "serial.command", "weather.read", "network.external", "background.run"],
  monitor: ["resources.read", "hardware.lowlevel", "process.control", "process.inject", "background.run"],
  enjoy: [
    "mesh.read", "mesh.command", "serial.read", "serial.command", "resources.read", "weather.read", "knowledge.read",
    "network.external", "hardware.lowlevel", "firmware.manage", "updates.manage", "background.run",
  ],
};

type WidgetDefault = [widgetId: string, keepAlive: boolean, visible?: boolean];

const widgets: Record<WorkspaceId, WidgetDefault[]> = {
  home: [
    ["main.connection", false], ["monitor.summary", false], ["main.weather", false],
    ["monitor.pcie", false], ["main.console", true],
  ],
  main: [
    ["main.connection", false], ["main.weather", false],
    ["main.node.esp_mixer", false], ["main.node.humidifier", false],
    ["main.node.kpowerled", false], ["main.node.kheater", false],
    ["main.node.garland", false], ["main.node.bedside_light", false],
    ["main.node.lampk", false], ["main.node.jajowar", false],
    ["main.node.choinka", false], ["main.console", true],
    ["main.sensors", false, false], ["main.lighting", false, false], ["main.climate", false, false],
  ],
  monitor: [
    ["monitor.summary", false], ["monitor.thermals", false], ["monitor.pcie", true],
    ["monitor.vram", true], ["monitor.residency", true], ["monitor.compute", true], ["monitor.details", false], ["monitor.ccc", true],
  ],
  enjoy: [["enjoy.search", false], ["enjoy.graph", false], ["enjoy.inspector", false]],
};

const sizes: Record<string, Record<AppBreakpoint, [number, number]>> = {
  "main.connection": { lg: [12, 2], md: [8, 3], sm: [4, 4], xs: [1, 5] },
  "main.weather": { lg: [12, 3], md: [8, 3], sm: [4, 4], xs: [1, 5] },
  "main.sensors": { lg: [12, 2], md: [8, 3], sm: [4, 4], xs: [1, 6] },
  "main.lighting": { lg: [6, 5], md: [4, 6], sm: [4, 6], xs: [1, 8] },
  "main.climate": { lg: [6, 6], md: [4, 7], sm: [4, 7], xs: [1, 10] },
  "main.node.esp_mixer": { lg: [6, 4], md: [8, 4], sm: [4, 5], xs: [1, 7] },
  "main.node.humidifier": { lg: [6, 6], md: [8, 7], sm: [4, 8], xs: [1, 11] },
  "main.node.kpowerled": { lg: [6, 9], md: [8, 9], sm: [4, 10], xs: [1, 14] },
  "main.node.kheater": { lg: [6, 10], md: [8, 10], sm: [4, 12], xs: [1, 16] },
  "main.node.garland": { lg: [3, 3], md: [4, 3], sm: [2, 4], xs: [1, 5] },
  "main.node.bedside_light": { lg: [3, 3], md: [4, 3], sm: [2, 4], xs: [1, 5] },
  "main.node.lampk": { lg: [3, 3], md: [4, 3], sm: [2, 4], xs: [1, 5] },
  "main.node.jajowar": { lg: [3, 3], md: [4, 3], sm: [2, 4], xs: [1, 5] },
  "main.node.choinka": { lg: [6, 3], md: [4, 3], sm: [4, 4], xs: [1, 5] },
  "main.console": { lg: [6, 6], md: [8, 6], sm: [4, 6], xs: [1, 8] },
  "monitor.summary": { lg: [12, 3], md: [8, 4], sm: [4, 6], xs: [1, 9] },
  "monitor.thermals": { lg: [12, 5], md: [8, 6], sm: [4, 8], xs: [1, 12] },
  "monitor.vram": { lg: [12, 7], md: [8, 8], sm: [4, 10], xs: [1, 14] },
  "monitor.residency": { lg: [12, 9], md: [8, 10], sm: [4, 12], xs: [1, 16] },
  "monitor.pcie": { lg: [12, 5], md: [8, 6], sm: [4, 7], xs: [1, 9] },
  "monitor.compute": { lg: [12, 7], md: [8, 6], sm: [4, 7], xs: [1, 9] },
  "monitor.details": { lg: [12, 5], md: [8, 5], sm: [4, 6], xs: [1, 8] },
  "monitor.ccc": { lg: [12, 5], md: [8, 6], sm: [4, 8], xs: [1, 10] },
  "enjoy.search": { lg: [3, 9], md: [3, 9], sm: [4, 6], xs: [1, 8] },
  "enjoy.graph": { lg: [6, 9], md: [5, 9], sm: [4, 8], xs: [1, 10] },
  "enjoy.inspector": { lg: [3, 9], md: [8, 7], sm: [4, 7], xs: [1, 10] },
};

function makeInstances(workspace: WorkspaceId): WidgetInstance[] {
  return widgets[workspace].map(([widgetId, keepAlive, visible = true], index) => ({
    instanceId: `${workspace}:${widgetId}:${index}`,
    widgetId,
    visible,
    keepAlive,
  }));
}

function makeLayout(workspace: WorkspaceId, breakpoint: AppBreakpoint, source = widgets[workspace]): Layout {
  const columns = { lg: 12, md: 8, sm: 4, xs: 1 }[breakpoint];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  return source.map(([widgetId], index): LayoutItem => {
    const [rawWidth, height] = sizes[widgetId]?.[breakpoint] ?? [columns, 4];
    const width = Math.min(columns, rawWidth);
    if (x + width > columns) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    const item = { i: `${workspace}:${widgetId}:${index}`, x, y, w: width, h: height, minW: 1, minH: 2 };
    x += width;
    rowHeight = Math.max(rowHeight, height);
    return item;
  });
}

function layoutsFor(workspace: WorkspaceId, source = widgets[workspace]): ResponsiveLayouts<AppBreakpoint> {
  return {
    lg: makeLayout(workspace, "lg", source),
    md: makeLayout(workspace, "md", source),
    sm: makeLayout(workspace, "sm", source),
    xs: makeLayout(workspace, "xs", source),
  };
}

export function createDefaultProfile(preset: WorkspacePreset = "default"): WorkspaceProfileV2 {
  const instances = Object.fromEntries((Object.keys(widgets) as WorkspaceId[]).map((id) => [id, makeInstances(id)])) as WorkspaceProfileV2["instances"];
  const layouts = Object.fromEntries((Object.keys(widgets) as WorkspaceId[]).map((id) => [id, layoutsFor(id)])) as WorkspaceProfileV2["layouts"];

  if (preset === "compact") {
    instances.home = instances.home.map((instance) => ({ ...instance, visible: !["main.console", "monitor.pcie"].includes(instance.widgetId) }));
  } else if (preset === "monitoring") {
    const source = widgets.monitor;
    instances.home = source.map(([widgetId], index) => ({ instanceId: `home:${widgetId}:${index}`, widgetId, visible: true, keepAlive: true }));
    layouts.home = layoutsFor("home", source);
  }

  return {
    schemaVersion: 2,
    capabilityEpoch: 1,
    workspaceEpoch: CURRENT_WORKSPACE_EPOCH,
    revision: 0,
    activeWorkspace: "home",
    sidebarMode: "expanded",
    sidebarRestoreMode: "expanded",
    topbarVisible: true,
    statusbarVisible: true,
    immersiveChrome: false,
    motionLevel: "full",
    consoleAutoScroll: true,
    telemetryIntervalMs: 1_000,
    masterGpuLuid: null,
    signalBindings: {
      "Kheater.inputTemperature": {
        consumerEndpointId: "Kheater.inputTemperature",
        providerEndpointId: "esp_mixer.temperatureC",
      },
    },
    hubDock: { edge: "right", offset: 0.7 },
    enabledModules: { main: true, monitor: true, enjoy: true },
    grants: allGrants,
    instances,
    layouts,
    preset,
  };
}

function isWorkspaceId(value: unknown): value is WorkspaceId {
  return value === "home" || value === "main" || value === "monitor" || value === "enjoy";
}

function safeInstances(value: unknown, fallback: WidgetInstance[]): WidgetInstance[] {
  if (!Array.isArray(value)) return fallback;
  const valid = value.slice(0, 64).filter((item): item is WidgetInstance => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Partial<WidgetInstance>;
    return typeof candidate.instanceId === "string" && candidate.instanceId.length <= 160
      && typeof candidate.widgetId === "string" && candidate.widgetId.length <= 160
      && typeof candidate.visible === "boolean" && typeof candidate.keepAlive === "boolean";
  });
  if (!valid.length) return fallback;
  const existing = new Set(valid.map((item) => item.widgetId));
  return [...valid, ...fallback.filter((item) => !existing.has(item.widgetId)).map((item) => ({ ...item, instanceId: `${item.instanceId}:added` }))];
}

function safeLayouts(value: unknown, fallback: ResponsiveLayouts<AppBreakpoint>): ResponsiveLayouts<AppBreakpoint> {
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<ResponsiveLayouts<AppBreakpoint>>;
  const merge = (current: Layout | undefined, defaults: Layout | undefined): Layout => {
    const safeDefaults = defaults ?? [];
    if (!Array.isArray(current)) return safeDefaults;
    const existingWidgets = new Set(current.map((item) => item.i.split(":")[1]));
    let bottom = current.reduce((value, item) => Math.max(value, item.y + item.h), 0);
    const added = safeDefaults.filter((item) => !existingWidgets.has(item.i.split(":")[1])).map((item) => {
      const next = { ...item, i: `${item.i}:added`, x: 0, y: bottom };
      bottom += item.h;
      return next;
    });
    return [...current.slice(0, 64), ...added].slice(0, 64);
  };
  return { lg: merge(candidate.lg, fallback.lg), md: merge(candidate.md, fallback.md), sm: merge(candidate.sm, fallback.sm), xs: merge(candidate.xs, fallback.xs) };
}

export function normalizeProfile(value: unknown): WorkspaceProfileV2 {
  const fallback = createDefaultProfile();
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<Omit<WorkspaceProfileV2, "schemaVersion">> & { sidebarCollapsed?: boolean; schemaVersion?: number };
  if (candidate.schemaVersion !== 1 && candidate.schemaVersion !== 2) return fallback;
  const instances = Object.fromEntries((Object.keys(fallback.instances) as WorkspaceId[]).map((workspace) => [
    workspace,
    safeInstances(candidate.instances?.[workspace], fallback.instances[workspace]),
  ])) as WorkspaceProfileV2["instances"];
  const layouts = Object.fromEntries((Object.keys(fallback.layouts) as WorkspaceId[]).map((workspace) => [
    workspace,
    safeLayouts(candidate.layouts?.[workspace], fallback.layouts[workspace]),
  ])) as WorkspaceProfileV2["layouts"];
  const sidebarMode: SidebarMode = candidate.schemaVersion === 1
    ? candidate.sidebarCollapsed ? "rail" : "expanded"
    : ["expanded", "rail", "hidden"].includes(candidate.sidebarMode ?? "") ? candidate.sidebarMode as SidebarMode : "expanded";
  const hub = candidate.hubDock as Partial<HubDock> | undefined;
  const edge: HubEdge = ["left", "right", "top", "bottom"].includes(hub?.edge ?? "") ? hub?.edge as HubEdge : "right";
  const motion: MotionLevel = ["full", "calm", "off"].includes(candidate.motionLevel ?? "") ? candidate.motionLevel as MotionLevel : "full";
  const telemetryIntervalMs = [1_000, 5_000, 10_000, 30_000, 60_000].includes(candidate.telemetryIntervalMs ?? 0)
    ? candidate.telemetryIntervalMs as number
    : 1_000;
  const capabilityEpoch = typeof candidate.capabilityEpoch === "number" && candidate.capabilityEpoch >= 0
    ? Math.floor(candidate.capabilityEpoch)
    : 0;
  const grants = { ...fallback.grants, ...candidate.grants };
  if (capabilityEpoch < 1) {
    grants.main = Array.from(new Set([...(grants.main ?? []), "mesh.read", "mesh.command"]));
    grants.enjoy = Array.from(new Set([...(grants.enjoy ?? []), "mesh.read", "mesh.command"]));
  }
  grants.monitor = Array.from(new Set([...(grants.monitor ?? []), "hardware.lowlevel", "process.control", "process.inject"]));
  grants.enjoy = Array.from(new Set([...(grants.enjoy ?? []), "hardware.lowlevel", "updates.manage"]));
  const workspaceEpoch = typeof candidate.workspaceEpoch === "number" && candidate.workspaceEpoch >= 0
    ? Math.floor(candidate.workspaceEpoch)
    : 0;
  const result: WorkspaceProfileV2 = {
    ...fallback,
    capabilityEpoch: Math.max(1, capabilityEpoch),
    workspaceEpoch: Math.max(CURRENT_WORKSPACE_EPOCH, workspaceEpoch),
    revision: typeof candidate.revision === "number" ? candidate.revision : 0,
    activeWorkspace: isWorkspaceId(candidate.activeWorkspace) ? candidate.activeWorkspace : fallback.activeWorkspace,
    sidebarMode,
    sidebarRestoreMode: candidate.sidebarRestoreMode === "rail" ? "rail" : "expanded",
    topbarVisible: candidate.topbarVisible ?? true,
    statusbarVisible: candidate.statusbarVisible ?? true,
    immersiveChrome: candidate.immersiveChrome ?? false,
    motionLevel: motion,
    consoleAutoScroll: candidate.consoleAutoScroll ?? true,
    telemetryIntervalMs,
    masterGpuLuid: typeof candidate.masterGpuLuid === "string" && candidate.masterGpuLuid.length <= 64
      ? candidate.masterGpuLuid
      : null,
    signalBindings: Object.fromEntries(Object.entries(candidate.signalBindings ?? fallback.signalBindings)
      .filter(([consumer, binding]) => consumer.length <= 160
        && binding && typeof binding === "object"
        && typeof binding.consumerEndpointId === "string" && binding.consumerEndpointId === consumer
        && typeof binding.providerEndpointId === "string"
        && binding.providerEndpointId.length > 0 && binding.providerEndpointId.length <= 160)),
    hubDock: { edge, offset: Math.min(0.92, Math.max(0.08, Number(hub?.offset) || 0.7)) },
    enabledModules: { ...fallback.enabledModules, ...candidate.enabledModules },
    grants,
    instances,
    layouts,
    preset: candidate.preset === "compact" || candidate.preset === "monitoring" ? candidate.preset : "default",
  };
  if (workspaceEpoch < CURRENT_WORKSPACE_EPOCH) {
    result.instances.main = fallback.instances.main;
    result.layouts.main = fallback.layouts.main;
  }
  return result;
}

function computeRuntimeState(profile: WorkspaceProfileV2, moduleId: ModuleId): RuntimeState {
  if (!profile.enabledModules[moduleId]) return "disabled";
  if (profile.activeWorkspace === moduleId) return "active";
  if (profile.instances[profile.activeWorkspace].some((item) => item.visible && item.widgetId.startsWith(`${moduleId}.`))) return "active";
  return Object.values(profile.instances).flat().some((item) => item.keepAlive && item.widgetId.startsWith(`${moduleId}.`)) ? "background" : "idle";
}

function mutateInstances(profile: WorkspaceProfileV2, workspace: WorkspaceId, mapper: (items: WidgetInstance[]) => WidgetInstance[]): WorkspaceProfileV2 {
  return { ...profile, instances: { ...profile.instances, [workspace]: mapper(profile.instances[workspace]) } };
}

export function projectProfile(profile: WorkspaceProfileV2, action: RuntimeAction): WorkspaceProfileV2 {
  switch (action.type) {
    case "setActiveWorkspace": return { ...profile, activeWorkspace: action.workspace };
    case "setSidebarMode": return { ...profile, sidebarMode: action.mode, sidebarRestoreMode: action.mode === "hidden" ? profile.sidebarRestoreMode : action.mode };
    case "setTopbarVisible": return { ...profile, topbarVisible: action.visible };
    case "setStatusbarVisible": return { ...profile, statusbarVisible: action.visible };
    case "setImmersiveChrome": return { ...profile, immersiveChrome: action.enabled };
    case "setMotionLevel": return { ...profile, motionLevel: action.level };
    case "setConsoleAutoScroll": return { ...profile, consoleAutoScroll: action.enabled };
    case "setTelemetryInterval": return { ...profile, telemetryIntervalMs: action.intervalMs };
    case "setSignalBinding": return {
      ...profile,
      signalBindings: {
        ...profile.signalBindings,
        [action.consumerEndpointId]: {
          consumerEndpointId: action.consumerEndpointId,
          providerEndpointId: action.providerEndpointId,
        },
      },
    };
    case "setHubDock": return { ...profile, hubDock: { edge: action.edge, offset: Math.min(0.92, Math.max(0.08, action.offset)) } };
    case "setLayout": return { ...profile, layouts: { ...profile.layouts, [action.workspace]: action.layouts } };
    case "setWidgetVisible": return mutateInstances(profile, action.workspace, (items) => items.map((item) => item.instanceId === action.instanceId ? { ...item, visible: action.visible } : item));
    case "setWidgetKeepAlive": return mutateInstances(profile, action.workspace, (items) => items.map((item) => item.instanceId === action.instanceId ? { ...item, keepAlive: action.keepAlive } : item));
    case "addWidget": return mutateInstances(profile, action.workspace, (items) => {
      const existing = items.find((item) => item.widgetId === action.widgetId);
      return existing
        ? items.map((item) => item.instanceId === existing.instanceId ? { ...item, visible: true } : item)
        : [...items, { instanceId: `${action.workspace}:${action.widgetId}:${Date.now()}`, widgetId: action.widgetId, visible: true, keepAlive: false }];
    });
    case "setModuleEnabled": return { ...profile, enabledModules: { ...profile.enabledModules, [action.moduleId]: action.enabled }, activeWorkspace: !action.enabled && profile.activeWorkspace === action.moduleId ? "home" : profile.activeWorkspace };
    case "setCapability": return { ...profile, grants: { ...profile.grants, [action.moduleId]: action.enabled ? Array.from(new Set([...profile.grants[action.moduleId], action.capability])) : profile.grants[action.moduleId].filter((item) => item !== action.capability) } };
    case "applyPreset": {
      const fresh = createDefaultProfile(action.preset);
      return { ...profile, preset: action.preset, instances: fresh.instances, layouts: fresh.layouts };
    }
    case "undo": return profile;
  }
}

interface WorkspaceContextValue {
  profile: WorkspaceProfileV2;
  hydrated: boolean;
  canUndo: boolean;
  lastAction: string | null;
  runtimeError: string | null;
  setActiveWorkspace: (workspace: WorkspaceId) => void;
  setSidebarMode: (mode: SidebarMode) => void;
  setTopbarVisible: (visible: boolean) => void;
  setStatusbarVisible: (visible: boolean) => void;
  setImmersiveChrome: (enabled: boolean) => void;
  setMotionLevel: (level: MotionLevel) => void;
  setConsoleAutoScroll: (enabled: boolean) => void;
  setTelemetryInterval: (intervalMs: number) => void;
  setSignalBinding: (consumerEndpointId: string, providerEndpointId: string) => void;
  setHubDock: (dock: HubDock) => void;
  setLayout: (workspace: WorkspaceId, layouts: ResponsiveLayouts<AppBreakpoint>) => void;
  setWidgetVisible: (workspace: WorkspaceId, instanceId: string, visible: boolean) => void;
  setWidgetKeepAlive: (workspace: WorkspaceId, instanceId: string, keepAlive: boolean) => void;
  addWidget: (workspace: WorkspaceId, widgetId: string) => void;
  setModuleEnabled: (moduleId: ModuleId, enabled: boolean) => void;
  setCapability: (moduleId: ModuleId, capability: ModuleCapability, enabled: boolean) => void;
  applyPreset: (preset: WorkspacePreset) => void;
  undo: () => void;
  runtimeState: (moduleId: ModuleId) => RuntimeState;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function snapshotFor(profile: WorkspaceProfileV2): RuntimeSnapshot {
  return {
    profile,
    moduleStates: (["main", "monitor", "enjoy"] as ModuleId[]).map((moduleId) => ({ moduleId, state: computeRuntimeState(profile, moduleId) })),
    canUndo: false,
    lastAction: null,
    historyCursor: 0,
    startedAt: Date.now(),
  };
}

function browserProfile(): WorkspaceProfileV2 {
  const stored = localStorage.getItem(BROWSER_STORE_KEY) ?? localStorage.getItem("keemash.workspace.v1");
  if (stored) {
    try { return normalizeProfile(JSON.parse(stored)); }
    catch { localStorage.removeItem(BROWSER_STORE_KEY); }
  }
  const profile = createDefaultProfile();
  const legacyEnjoy = localStorage.getItem("keemash.view.enjoy") === "true";
  const legacyMonitor = localStorage.getItem("keemash.view.monitor") === "true";
  profile.activeWorkspace = legacyEnjoy ? "enjoy" : legacyMonitor ? "monitor" : "main";
  return profile;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(() => snapshotFor(createDefaultProfile()));
  const [hydrated, setHydrated] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const canonicalRef = useRef(snapshot);
  const pendingRef = useRef<RuntimeAction[]>([]);
  const processingRef = useRef(false);
  const browserUndoRef = useRef<WorkspaceProfileV2[]>([]);
  const tauri = "__TAURI_INTERNALS__" in window;

  const rebasePending = useCallback((canonical: RuntimeSnapshot) => {
    let profile = canonical.profile;
    for (const action of pendingRef.current) profile = projectProfile(profile, action);
    profile = { ...profile, revision: canonical.profile.revision + pendingRef.current.length };
    setSnapshot({
      ...canonical,
      profile,
      canUndo: canonical.canUndo || pendingRef.current.some((action) =>
        action.type !== "setActiveWorkspace" &&
        action.type !== "setMotionLevel" &&
        action.type !== "setConsoleAutoScroll" &&
        action.type !== "setTelemetryInterval"
      ),
    });
  }, []);

  const drain = useCallback(async () => {
    if (!tauri || processingRef.current) return;
    processingRef.current = true;
    while (pendingRef.current.length) {
      const action = pendingRef.current[0];
      try {
        canonicalRef.current = await bridge.runtime.apply(action, canonicalRef.current.profile.revision);
        setRuntimeError(null);
      } catch (error) {
        setRuntimeError(error instanceof Error ? error.message : String(error));
        canonicalRef.current = await bridge.runtime.bootstrap();
      }
      pendingRef.current.shift();
      rebasePending(canonicalRef.current);
    }
    processingRef.current = false;
  }, [rebasePending, tauri]);

  const dispatch = useCallback((action: RuntimeAction) => {
    if (!tauri) {
      const current = canonicalRef.current.profile;
      let profile: WorkspaceProfileV2;
      if (action.type === "undo") {
        profile = browserUndoRef.current.pop() ?? current;
      } else {
        if (
          action.type !== "setActiveWorkspace" &&
          action.type !== "setMotionLevel" &&
          action.type !== "setConsoleAutoScroll" &&
          action.type !== "setTelemetryInterval"
        ) {
          browserUndoRef.current.push(current);
          browserUndoRef.current = browserUndoRef.current.slice(-12);
        }
        profile = projectProfile(current, action);
      }
      profile = { ...profile, revision: current.revision + 1 };
      const next = { ...snapshotFor(profile), canUndo: browserUndoRef.current.length > 0, lastAction: action.type };
      canonicalRef.current = next;
      setSnapshot(next);
      localStorage.setItem(BROWSER_STORE_KEY, JSON.stringify(profile));
      return;
    }
    pendingRef.current.push(action);
    rebasePending(canonicalRef.current);
    void drain();
  }, [drain, rebasePending, tauri]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const next = tauri ? await bridge.runtime.bootstrap() : snapshotFor(browserProfile());
      if (!active) return;
      canonicalRef.current = next;
      setSnapshot(next);
      setHydrated(true);
    };
    void load().catch(() => active && setHydrated(true));
    const stop = tauri ? bridge.runtime.onSnapshot((next) => {
      canonicalRef.current = next;
      rebasePending(next);
    }) : () => undefined;
    return () => { active = false; stop(); };
  }, [rebasePending, tauri]);

  const profile = snapshot.profile;
  const value = useMemo<WorkspaceContextValue>(() => ({
    profile,
    hydrated,
    canUndo: snapshot.canUndo,
    lastAction: snapshot.lastAction,
    runtimeError,
    setActiveWorkspace: (workspace) => dispatch({ type: "setActiveWorkspace", workspace }),
    setSidebarMode: (mode) => dispatch({ type: "setSidebarMode", mode }),
    setTopbarVisible: (visible) => dispatch({ type: "setTopbarVisible", visible }),
    setStatusbarVisible: (visible) => dispatch({ type: "setStatusbarVisible", visible }),
    setImmersiveChrome: (enabled) => dispatch({ type: "setImmersiveChrome", enabled }),
    setMotionLevel: (level) => dispatch({ type: "setMotionLevel", level }),
    setConsoleAutoScroll: (enabled) => dispatch({ type: "setConsoleAutoScroll", enabled }),
    setTelemetryInterval: (intervalMs) => dispatch({ type: "setTelemetryInterval", intervalMs }),
    setSignalBinding: (consumerEndpointId, providerEndpointId) => dispatch({ type: "setSignalBinding", consumerEndpointId, providerEndpointId }),
    setHubDock: ({ edge, offset }) => dispatch({ type: "setHubDock", edge, offset }),
    setLayout: (workspace, layouts) => dispatch({ type: "setLayout", workspace, layouts }),
    setWidgetVisible: (workspace, instanceId, visible) => dispatch({ type: "setWidgetVisible", workspace, instanceId, visible }),
    setWidgetKeepAlive: (workspace, instanceId, keepAlive) => dispatch({ type: "setWidgetKeepAlive", workspace, instanceId, keepAlive }),
    addWidget: (workspace, widgetId) => dispatch({ type: "addWidget", workspace, widgetId }),
    setModuleEnabled: (moduleId, enabled) => dispatch({ type: "setModuleEnabled", moduleId, enabled }),
    setCapability: (moduleId, capability, enabled) => {
      if (!SENSITIVE_CAPABILITIES.has(capability)) dispatch({ type: "setCapability", moduleId, capability, enabled });
    },
    applyPreset: (preset) => dispatch({ type: "applyPreset", preset }),
    undo: () => dispatch({ type: "undo" }),
    runtimeState: (moduleId) => computeRuntimeState(profile, moduleId),
  }), [dispatch, hydrated, profile, runtimeError, snapshot.canUndo, snapshot.lastAction]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return value;
}
