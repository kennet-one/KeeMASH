import { Store } from "@tauri-apps/plugin-store";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Layout, LayoutItem, ResponsiveLayouts } from "react-grid-layout";
import type { ModuleCapability, ModuleId, RuntimeState, WorkspaceId } from "./moduleTypes";

export type AppBreakpoint = "lg" | "md" | "sm" | "xs";

export interface WidgetInstance {
  instanceId: string;
  widgetId: string;
  visible: boolean;
  keepAlive: boolean;
}

export interface WorkspaceProfile {
  schemaVersion: 1;
  activeWorkspace: WorkspaceId;
  sidebarCollapsed: boolean;
  enabledModules: Record<ModuleId, boolean>;
  grants: Record<ModuleId, ModuleCapability[]>;
  instances: Record<WorkspaceId, WidgetInstance[]>;
  layouts: Record<WorkspaceId, ResponsiveLayouts<AppBreakpoint>>;
  preset: "default" | "compact" | "monitoring";
}

const STORE_FILE = "workspace-v1.json";
const STORE_KEY = "profile";

const allGrants: Record<ModuleId, ModuleCapability[]> = {
  main: ["serial.read", "serial.command", "weather.read", "network.external", "background.run"],
  monitor: ["resources.read", "hardware.lowlevel", "background.run"],
  enjoy: [
    "serial.read", "serial.command", "resources.read", "weather.read", "knowledge.read",
    "network.external", "hardware.lowlevel", "firmware.manage", "updates.manage", "background.run",
  ],
};

const widgets: Record<WorkspaceId, Array<[string, boolean]>> = {
  home: [
    ["main.connection", false], ["monitor.summary", false], ["main.weather", false],
    ["monitor.pcie", false], ["main.console", true],
  ],
  main: [
    ["main.connection", false], ["main.weather", false], ["main.sensors", false],
    ["main.lighting", false], ["main.climate", false], ["main.console", true],
  ],
  monitor: [
    ["monitor.summary", false], ["monitor.thermals", false], ["monitor.pcie", true],
    ["monitor.compute", true], ["monitor.details", false],
  ],
  enjoy: [
    ["enjoy.search", false], ["enjoy.graph", false], ["enjoy.inspector", false],
  ],
};

const sizes: Record<string, Record<AppBreakpoint, [number, number]>> = {
  "main.connection": { lg: [12, 2], md: [8, 3], sm: [4, 4], xs: [1, 5] },
  "main.weather": { lg: [12, 3], md: [8, 3], sm: [4, 4], xs: [1, 5] },
  "main.sensors": { lg: [12, 2], md: [8, 3], sm: [4, 4], xs: [1, 6] },
  "main.lighting": { lg: [6, 5], md: [4, 6], sm: [4, 6], xs: [1, 8] },
  "main.climate": { lg: [6, 6], md: [4, 7], sm: [4, 7], xs: [1, 10] },
  "main.console": { lg: [6, 6], md: [8, 6], sm: [4, 6], xs: [1, 8] },
  "monitor.summary": { lg: [12, 3], md: [8, 4], sm: [4, 6], xs: [1, 9] },
  "monitor.thermals": { lg: [12, 5], md: [8, 6], sm: [4, 8], xs: [1, 12] },
  "monitor.pcie": { lg: [12, 5], md: [8, 6], sm: [4, 7], xs: [1, 9] },
  "monitor.compute": { lg: [7, 5], md: [8, 5], sm: [4, 6], xs: [1, 8] },
  "monitor.details": { lg: [5, 5], md: [8, 5], sm: [4, 6], xs: [1, 8] },
  "enjoy.search": { lg: [3, 9], md: [3, 9], sm: [4, 6], xs: [1, 8] },
  "enjoy.graph": { lg: [6, 9], md: [5, 9], sm: [4, 8], xs: [1, 10] },
  "enjoy.inspector": { lg: [3, 9], md: [8, 7], sm: [4, 7], xs: [1, 10] },
};

function makeInstances(workspace: WorkspaceId): WidgetInstance[] {
  return widgets[workspace].map(([widgetId, keepAlive], index) => ({
    instanceId: `${workspace}:${widgetId}:${index}`,
    widgetId,
    visible: true,
    keepAlive,
  }));
}

function makeLayout(workspace: WorkspaceId, breakpoint: AppBreakpoint): Layout {
  const cols = { lg: 12, md: 8, sm: 4, xs: 1 }[breakpoint];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  return widgets[workspace].map(([widgetId], index): LayoutItem => {
    const [rawW, h] = sizes[widgetId]?.[breakpoint] ?? [cols, 4];
    const w = Math.min(cols, rawW);
    if (x + w > cols) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    const item = { i: `${workspace}:${widgetId}:${index}`, x, y, w, h, minW: 1, minH: 2 };
    x += w;
    rowHeight = Math.max(rowHeight, h);
    return item;
  });
}

export function createDefaultProfile(preset: WorkspaceProfile["preset"] = "default"): WorkspaceProfile {
  const instances = Object.fromEntries((Object.keys(widgets) as WorkspaceId[]).map((id) => [id, makeInstances(id)])) as WorkspaceProfile["instances"];
  const layouts = Object.fromEntries((Object.keys(widgets) as WorkspaceId[]).map((id) => [id, {
    lg: makeLayout(id, "lg"), md: makeLayout(id, "md"), sm: makeLayout(id, "sm"), xs: makeLayout(id, "xs"),
  }])) as WorkspaceProfile["layouts"];

  if (preset === "compact") {
    instances.home = instances.home.map((instance) => ({ ...instance, visible: instance.widgetId !== "main.console" && instance.widgetId !== "monitor.pcie" }));
  } else if (preset === "monitoring") {
    instances.home = makeInstances("monitor").map((instance, index) => ({ ...instance, instanceId: `home:${instance.widgetId}:${index}`, keepAlive: true }));
    layouts.home = { lg: makeLayout("monitor", "lg").map((item) => ({ ...item, i: item.i.replace("monitor:", "home:") })), md: makeLayout("monitor", "md").map((item) => ({ ...item, i: item.i.replace("monitor:", "home:") })), sm: makeLayout("monitor", "sm").map((item) => ({ ...item, i: item.i.replace("monitor:", "home:") })), xs: makeLayout("monitor", "xs").map((item) => ({ ...item, i: item.i.replace("monitor:", "home:") })) };
  }

  return {
    schemaVersion: 1,
    activeWorkspace: "home",
    sidebarCollapsed: false,
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
  const valid = value.filter((item): item is WidgetInstance => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Partial<WidgetInstance>;
    return typeof candidate.instanceId === "string" && typeof candidate.widgetId === "string"
      && typeof candidate.visible === "boolean" && typeof candidate.keepAlive === "boolean";
  });
  return valid.length > 0 ? valid : fallback;
}

function safeLayouts(value: unknown, fallback: ResponsiveLayouts<AppBreakpoint>): ResponsiveLayouts<AppBreakpoint> {
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<ResponsiveLayouts<AppBreakpoint>>;
  return {
    lg: Array.isArray(candidate.lg) ? candidate.lg : fallback.lg,
    md: Array.isArray(candidate.md) ? candidate.md : fallback.md,
    sm: Array.isArray(candidate.sm) ? candidate.sm : fallback.sm,
    xs: Array.isArray(candidate.xs) ? candidate.xs : fallback.xs,
  };
}

export function normalizeProfile(value: unknown): WorkspaceProfile {
  const fallback = createDefaultProfile();
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<WorkspaceProfile>;
  if (candidate.schemaVersion !== 1) return fallback;
  const instances = Object.fromEntries((Object.keys(fallback.instances) as WorkspaceId[]).map((workspace) => [
    workspace,
    safeInstances(candidate.instances?.[workspace], fallback.instances[workspace]),
  ])) as WorkspaceProfile["instances"];
  const layouts = Object.fromEntries((Object.keys(fallback.layouts) as WorkspaceId[]).map((workspace) => [
    workspace,
    safeLayouts(candidate.layouts?.[workspace], fallback.layouts[workspace]),
  ])) as WorkspaceProfile["layouts"];
  return {
    ...fallback,
    activeWorkspace: isWorkspaceId(candidate.activeWorkspace) ? candidate.activeWorkspace : fallback.activeWorkspace,
    enabledModules: { ...fallback.enabledModules, ...candidate.enabledModules },
    grants: { ...fallback.grants, ...candidate.grants },
    instances,
    layouts,
    preset: candidate.preset === "compact" || candidate.preset === "monitoring" ? candidate.preset : "default",
  };
}

interface WorkspaceContextValue {
  profile: WorkspaceProfile;
  hydrated: boolean;
  setActiveWorkspace: (workspace: WorkspaceId) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setLayout: (workspace: WorkspaceId, layouts: ResponsiveLayouts<AppBreakpoint>) => void;
  setWidgetVisible: (workspace: WorkspaceId, instanceId: string, visible: boolean) => void;
  setWidgetKeepAlive: (workspace: WorkspaceId, instanceId: string, keepAlive: boolean) => void;
  addWidget: (workspace: WorkspaceId, widgetId: string) => void;
  setModuleEnabled: (moduleId: ModuleId, enabled: boolean) => void;
  setCapability: (moduleId: ModuleId, capability: ModuleCapability, enabled: boolean) => void;
  applyPreset: (preset: WorkspaceProfile["preset"]) => void;
  runtimeState: (moduleId: ModuleId) => RuntimeState;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<WorkspaceProfile>(() => {
    const legacyEnjoy = localStorage.getItem("keemash.view.enjoy") === "true";
    const legacyMonitor = localStorage.getItem("keemash.view.monitor") === "true";
    const initial = createDefaultProfile();
    initial.activeWorkspace = legacyEnjoy ? "enjoy" : legacyMonitor ? "monitor" : "main";
    return initial;
  });
  const [hydrated, setHydrated] = useState(false);
  const storeRef = useRef<Store | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      if ("__TAURI_INTERNALS__" in window) {
        const store = await Store.load(STORE_FILE);
        const stored = await store.get<WorkspaceProfile>(STORE_KEY);
        if (!active) return;
        storeRef.current = store;
        if (stored) setProfile(normalizeProfile(stored));
      } else {
        const stored = localStorage.getItem("keemash.workspace.v1");
        if (stored) {
          try { setProfile(normalizeProfile(JSON.parse(stored))); }
          catch { localStorage.removeItem("keemash.workspace.v1"); }
        }
      }
      if (active) setHydrated(true);
    };
    void load().catch(() => active && setHydrated(true));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
      if (storeRef.current) void storeRef.current.set(STORE_KEY, profile);
      else localStorage.setItem("keemash.workspace.v1", JSON.stringify(profile));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [hydrated, profile]);

  const mutateInstances = useCallback((workspace: WorkspaceId, mapper: (items: WidgetInstance[]) => WidgetInstance[]) => {
    setProfile((current) => ({ ...current, instances: { ...current.instances, [workspace]: mapper(current.instances[workspace]) } }));
  }, []);

  const value = useMemo<WorkspaceContextValue>(() => ({
    profile,
    hydrated,
    setActiveWorkspace: (activeWorkspace) => setProfile((current) => ({ ...current, activeWorkspace })),
    setSidebarCollapsed: (sidebarCollapsed) => setProfile((current) => ({ ...current, sidebarCollapsed })),
    setLayout: (workspace, layouts) => setProfile((current) => ({ ...current, layouts: { ...current.layouts, [workspace]: layouts } })),
    setWidgetVisible: (workspace, instanceId, visible) => mutateInstances(workspace, (items) => items.map((item) => item.instanceId === instanceId ? { ...item, visible } : item)),
    setWidgetKeepAlive: (workspace, instanceId, keepAlive) => mutateInstances(workspace, (items) => items.map((item) => item.instanceId === instanceId ? { ...item, keepAlive } : item)),
    addWidget: (workspace, widgetId) => mutateInstances(workspace, (items) => {
      const existing = items.find((item) => item.widgetId === widgetId);
      if (existing) return items.map((item) => item.instanceId === existing.instanceId ? { ...item, visible: true } : item);
      return [...items, { instanceId: `${workspace}:${widgetId}:${Date.now()}`, widgetId, visible: true, keepAlive: false }];
    }),
    setModuleEnabled: (moduleId, enabled) => setProfile((current) => ({ ...current, enabledModules: { ...current.enabledModules, [moduleId]: enabled }, activeWorkspace: !enabled && current.activeWorkspace === moduleId ? "home" : current.activeWorkspace })),
    setCapability: (moduleId, capability, enabled) => setProfile((current) => ({ ...current, grants: { ...current.grants, [moduleId]: enabled ? Array.from(new Set([...current.grants[moduleId], capability])) : current.grants[moduleId].filter((item) => item !== capability) } })),
    applyPreset: (preset) => setProfile(createDefaultProfile(preset)),
    runtimeState: (moduleId) => {
      if (!profile.enabledModules[moduleId]) return "disabled";
      if (profile.activeWorkspace === moduleId) return "active";
      const activeWorkspaceInstances = profile.instances[profile.activeWorkspace].filter((item) => item.visible && item.widgetId.startsWith(`${moduleId}.`));
      if (activeWorkspaceInstances.length > 0) return "active";
      const pinned = Object.values(profile.instances).flat().some((item) => item.keepAlive && item.widgetId.startsWith(`${moduleId}.`));
      return pinned ? "background" : "idle";
    },
  }), [hydrated, mutateInstances, profile]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return value;
}
