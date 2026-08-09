import { describe, expect, it } from "vitest";
import { moduleDefinitions, widgetDefinitions } from "../modules/registry";
import { createDefaultProfile, normalizeProfile, projectProfile } from "./workspace";

describe("modular workspace", () => {
  it("creates complete responsive layouts for every workspace", () => {
    const profile = createDefaultProfile();
    for (const workspace of ["home", "main", "monitor", "enjoy"] as const) {
      expect(profile.instances[workspace].length).toBeGreaterThan(0);
      for (const breakpoint of ["lg", "md", "sm", "xs"] as const) {
        expect(profile.layouts[workspace][breakpoint]?.length).toBe(profile.instances[workspace].length);
      }
    }
  });

  it("falls back safely when persisted data is corrupt", () => {
    expect(normalizeProfile(null).schemaVersion).toBe(2);
    expect(normalizeProfile({ schemaVersion: 99 }).activeWorkspace).toBe("home");
    expect(normalizeProfile({ schemaVersion: 1, activeWorkspace: "invalid" }).activeWorkspace).toBe("home");
    expect(normalizeProfile({ schemaVersion: 1, instances: { home: "broken" }, layouts: { home: null } }).instances.home.length).toBeGreaterThan(0);
  });

  it("migrates the v1 shell state and keeps widget instances", () => {
    const migrated = normalizeProfile({
      ...createDefaultProfile(),
      schemaVersion: 1,
      sidebarCollapsed: true,
      motionLevel: undefined,
      hubDock: undefined,
    });
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.sidebarMode).toBe("rail");
    expect(migrated.motionLevel).toBe("full");
    expect(migrated.instances.home.length).toBeGreaterThan(0);
  });

  it("adds new monitor widgets and residency grants once without resetting an existing layout", () => {
    const base = createDefaultProfile();
    const monitorLayouts = Object.fromEntries((["lg", "md", "sm", "xs"] as const).map((breakpoint) => [
      breakpoint,
      (base.layouts.monitor[breakpoint] ?? [])
        .filter((item) => !item.i.includes("monitor.vram") && !item.i.includes("monitor.ccc") && !item.i.includes("monitor.residency"))
        .map((item, index) => index === 0 ? { ...item, x: 1, y: 7 } : item),
    ]));
    const old = {
      ...base,
      instances: {
        ...base.instances,
        monitor: base.instances.monitor.filter((item) => !["monitor.vram", "monitor.ccc", "monitor.residency"].includes(item.widgetId)),
      },
      layouts: { ...base.layouts, monitor: monitorLayouts },
      grants: { ...base.grants, monitor: ["resources.read"] },
    };

    const migrated = normalizeProfile(old);
    const normalizedAgain = normalizeProfile(migrated);
    expect(migrated.instances.monitor.filter((item) => item.widgetId === "monitor.vram")).toHaveLength(1);
    expect(migrated.instances.monitor.filter((item) => item.widgetId === "monitor.ccc")).toHaveLength(1);
    expect(migrated.instances.monitor.filter((item) => item.widgetId === "monitor.residency")).toHaveLength(1);
    expect(migrated.grants.monitor).toEqual(expect.arrayContaining(["process.control", "process.inject"]));
    expect(normalizedAgain.instances.monitor).toHaveLength(migrated.instances.monitor.length);
    expect(migrated.layouts.monitor.lg?.[0]).toMatchObject({ x: 1, y: 7 });
  });

  it("projects focus-independent shell actions without moving widgets", () => {
    const profile = createDefaultProfile();
    const movedHub = projectProfile(profile, { type: "setHubDock", edge: "top", offset: 0.44 });
    const hiddenChrome = projectProfile(movedHub, { type: "setImmersiveChrome", enabled: true });
    expect(hiddenChrome.hubDock).toEqual({ edge: "top", offset: 0.44 });
    expect(hiddenChrome.immersiveChrome).toBe(true);
    expect(hiddenChrome.layouts).toEqual(profile.layouts);
  });

  it("normalizes and projects supported telemetry resolutions", () => {
    const profile = createDefaultProfile();
    expect(profile.telemetryIntervalMs).toBe(1_000);
    expect(normalizeProfile({ ...profile, telemetryIntervalMs: 7_000 }).telemetryIntervalMs).toBe(1_000);
    expect(projectProfile(profile, { type: "setTelemetryInterval", intervalMs: 30_000 }).telemetryIntervalMs).toBe(30_000);
  });

  it("keeps registry identifiers unique", () => {
    expect(new Set(moduleDefinitions.map((module) => module.id)).size).toBe(moduleDefinitions.length);
    expect(new Set(widgetDefinitions.map((widget) => widget.id)).size).toBe(widgetDefinitions.length);
  });

  it("grants Enjoy its trusted low-level participation profile", () => {
    const enjoy = moduleDefinitions.find((module) => module.id === "enjoy");
    expect(enjoy?.capabilities).toContain("hardware.lowlevel");
    expect(enjoy?.capabilities).toContain("firmware.manage");
    expect(enjoy?.capabilities).toContain("serial.command");
    expect(createDefaultProfile().grants.enjoy).toEqual(expect.arrayContaining(enjoy?.capabilities ?? []));
  });

  it("pins long-running logs and graphs in the default profile", () => {
    const profile = createDefaultProfile();
    const pinned = Object.values(profile.instances).flat().filter((instance) => instance.keepAlive).map((instance) => instance.widgetId);
    expect(pinned).toContain("main.console");
    expect(pinned).toContain("monitor.compute");
  });
});
