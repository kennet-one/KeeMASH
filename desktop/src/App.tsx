import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SuperAppShell } from "./components/SuperAppShell";
import { type ConsoleEntry } from "./components/ControlsView";
import { AppServicesProvider, type AppServices } from "./core/appServices";
import { EnjoyModuleProvider } from "./core/enjoyState";
import { WorkspaceProvider, useWorkspace } from "./core/workspace";
import { bridge } from "./lib/bridge";
import { useLocale } from "./i18n/locale";
import { meshFeedbackCommands } from "./lib/operationalGraph";
import { meshNodeIdForTag } from "./lib/operationalGraph";
import { preferredStartupPort } from "./lib/serialStartup";
import {
  commandDeadlineAction,
  commandExpectation,
  matchingFeedback,
  transitionFeedback,
  type CommandFeedback,
} from "./lib/commandFeedback";
import {
  initialLegacyState,
  normalizeLegacyToken,
  parseLegacyLine,
  type LegacyState,
} from "./lib/protocol";
import type { CccDaemonStatus, GpuPolicyPreset, GpuResidencySnapshot, GraphicsRuntimeStatus, LocalUpdateStatus, MemoryTestStatus, MeshEvent, ProcessIdentity, ResourceSample, RootStatus, SerialPortInfo, SerialStatus, WeatherSnapshot } from "./types";

const sleep = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function applyTypedSensorEvent(current: LegacyState, event: MeshEvent): LegacyState {
  if (event.channel !== 5 || !event.data) return current;
  const metricId = Number(event.data.id);
  const status = Number(event.data.status);
  const rawValue = Number(event.data.value);
  const scale10 = Number(event.data.scale10);
  if (!Number.isInteger(metricId) || !Number.isFinite(rawValue) ||
      !Number.isInteger(scale10) || (status & 1) === 0) return current;
  const key = ({ 1: "ppm", 2: "temperatureC", 3: "humidityPercent", 4: "lux" } as const)[metricId as 1 | 2 | 3 | 4];
  if (!key) return current;
  const value = rawValue * (10 ** scale10);
  const now = Date.now();
  return {
    ...current,
    online: true,
    lastSeenAt: now,
    sensors: { ...current.sensors, [key]: value },
    sensorUpdatedAt: { ...current.sensorUpdatedAt, [key]: now },
    nodeActivity: {
      ...current.nodeActivity,
      esp_mixer: { lastSeenAt: now, lastError: null },
    },
  };
}

function AppController() {
  const { text } = useLocale();
  const { profile, runtimeState } = useWorkspace();
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [selectedPort, setSelectedPort] = useState(() => localStorage.getItem("keemash.serial.port") ?? "COM4");
  const [serialStatus, setSerialStatus] = useState<SerialStatus>({ connected: false, path: null, baudRate: 115200, error: null });
  const [meshStatus, setMeshStatus] = useState<RootStatus>({ connected: false, paired: false, transport: "none", rootIdentity: null, address: null, security: "unpaired", latencyMs: null, reconnectPhase: "discovering", lastError: null });
  const meshConnectedRef = useRef(false);
  const serialConnectedRef = useRef(false);
  const [legacyState, setLegacyState] = useState<LegacyState>(initialLegacyState);
  const legacyRef = useRef(legacyState);
  const [weather, setWeather] = useState<WeatherSnapshot | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [resources, setResources] = useState<ResourceSample[]>([]);
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const entryId = useRef(0);
  const feedbackId = useRef(0);
  const [commandFeedback, setCommandFeedback] = useState<Record<string, CommandFeedback>>({});
  const commandFeedbackRef = useRef<Record<string, CommandFeedback>>({});
  const feedbackTimersRef = useRef(new Map<string, number[]>());
  const [meshInventory, setMeshInventory] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const refreshRunRef = useRef(0);
  const [toast, setToast] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [autoRefreshMinutes, setAutoRefreshMinutes] = useState(60);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<LocalUpdateStatus | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [memoryTest, setMemoryTest] = useState<MemoryTestStatus | null>(null);
  const [systemPowerPending, setSystemPowerPending] = useState<"restart" | "shutdown" | null>(null);
  const [cccStatus, setCccStatus] = useState<CccDaemonStatus | null>(null);
  const [cccBusy, setCccBusy] = useState(false);
  const [gpuResidency, setGpuResidency] = useState<GpuResidencySnapshot | null>(null);
  const [gpuResidencyBusy, setGpuResidencyBusy] = useState(false);
  const [gpuResidencyError, setGpuResidencyError] = useState<string | null>(null);
  const [graphicsRuntime, setGraphicsRuntime] = useState<GraphicsRuntimeStatus | null>(null);
  const [graphicsRuntimeBusy, setGraphicsRuntimeBusy] = useState(false);
  const [graphicsRuntimeError, setGraphicsRuntimeError] = useState<string | null>(null);
  const weatherFlightRef = useRef<Promise<void> | null>(null);
  const weatherGenerationRef = useRef(0);
  const cccFlightRef = useRef<Promise<void> | null>(null);
  const cccGenerationRef = useRef(0);
  const gpuFlightRef = useRef<Promise<void> | null>(null);
  const gpuGenerationRef = useRef(0);
  const graphicsFlightRef = useRef<Promise<void> | null>(null);
  const updateFlightRef = useRef<Promise<void> | null>(null);
  const updateGenerationRef = useRef(0);

  const addEntry = useCallback((direction: ConsoleEntry["direction"], value: string) => {
    setEntries((current) => [...current.slice(-299), { id: ++entryId.current, timestamp: Date.now(), direction, text: value }]);
  }, []);

  const replaceCommandFeedback = useCallback((next: Record<string, CommandFeedback>) => {
    commandFeedbackRef.current = next;
    setCommandFeedback(next);
  }, []);

  const clearFeedbackTimers = useCallback((target: string) => {
    for (const timer of feedbackTimersRef.current.get(target) ?? []) window.clearTimeout(timer);
    feedbackTimersRef.current.delete(target);
  }, []);

  const finishFeedback = useCallback((
    targets: string[],
    phase: CommandFeedback["phase"],
    detail: string | null = null,
  ) => {
    if (!targets.length) return;
    const next = { ...commandFeedbackRef.current };
    for (const target of targets) {
      const current = next[target];
      if (!current) continue;
      clearFeedbackTimers(target);
      next[target] = transitionFeedback(current, phase, detail);
      const id = current.id;
      const timer = window.setTimeout(() => {
        if (commandFeedbackRef.current[target]?.id !== id) return;
        const cleared = { ...commandFeedbackRef.current };
        delete cleared[target];
        replaceCommandFeedback(cleared);
      }, phase === "confirmed" ? 900 : 4_500);
      feedbackTimersRef.current.set(target, [timer]);
    }
    replaceCommandFeedback(next);
  }, [clearFeedbackTimers, replaceCommandFeedback]);

  const sendCommand = useCallback(async (command: string) => {
    const expectation = commandExpectation(command);
    let pending: CommandFeedback | null = null;
    if (expectation) {
      clearFeedbackTimers(expectation.target);
      pending = {
        id: ++feedbackId.current,
        command,
        owner: expectation.owner,
        target: expectation.target,
        phase: "sending",
        startedAt: Date.now(),
        detail: null,
      };
      replaceCommandFeedback({ ...commandFeedbackRef.current, [expectation.target]: pending });
    }
    try {
      if (meshConnectedRef.current) {
        if (!expectation?.owner) throw new Error("KeeLink requires a known command owner");
        await bridge.mesh.send(expectation.owner, command);
        if (serialConnectedRef.current && localStorage.getItem("keemash.transport.dualRun") === "true") {
          await bridge.serial.send(command);
        }
      } else {
        await bridge.serial.send(command);
      }
      addEntry("tx", command);
      if (pending && commandFeedbackRef.current[pending.target]?.id === pending.id) {
        const awaiting = transitionFeedback(pending, "awaiting");
        replaceCommandFeedback({
          ...commandFeedbackRef.current,
          [pending.target]: awaiting,
        });
        const timers: number[] = [];
        if (expectation?.feedbackCommand) {
          timers.push(window.setTimeout(() => {
            const current = commandFeedbackRef.current[pending!.target];
            if (current?.id !== pending!.id ||
                commandDeadlineAction(current, Date.now()) !== "resync") return;
            const resend = meshConnectedRef.current
              ? bridge.mesh.send(expectation.owner, expectation.feedbackCommand!)
              : bridge.serial.send(expectation.feedbackCommand!);
            void resend.then(() => {
              addEntry("tx", expectation.feedbackCommand!);
            }).catch(() => undefined);
          }, 4_050));
        }
        timers.push(window.setTimeout(() => {
          const current = commandFeedbackRef.current[pending!.target];
          if (current?.id !== pending!.id ||
              commandDeadlineAction(current, Date.now()) !== "unconfirmed") return;
          finishFeedback([pending!.target], "unconfirmed", "status not confirmed");
        }, 12_050));
        feedbackTimersRef.current.set(pending.target, timers);
      }
      return true;
    } catch (error) {
      const message = text("app.sendFailed", { detail: error instanceof Error ? error.message : String(error) });
      addEntry("system", message);
      setToast(message);
      if (pending) finishFeedback([pending.target], "error", message);
      return false;
    }
  }, [addEntry, clearFeedbackTimers, finishFeedback, replaceCommandFeedback, text]);

  const cancelRefresh = useCallback(() => { refreshRunRef.current += 1; busyRef.current = false; setBusy(false); }, []);
  const refreshAll = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const run = ++refreshRunRef.current;
    setBusy(true);
    try { for (const command of meshFeedbackCommands) { if (run !== refreshRunRef.current) break; await sendCommand(command); await sleep(1_200); } }
    finally { if (run === refreshRunRef.current) { busyRef.current = false; setBusy(false); } }
  }, [sendCommand]);

  const refreshPorts = useCallback(async () => {
    try {
      const available = await bridge.serial.list();
      setPorts(available);
      setSelectedPort((current) => available.some((port) => port.path === current) ? current : available.find((port) => port.path === "COM4")?.path ?? available[0]?.path ?? "");
    } catch (error) { addEntry("system", text("app.portScanFailed", { detail: error instanceof Error ? error.message : String(error) })); }
  }, [addEntry, text]);

  const refreshWeather = useCallback(async () => {
    if (weatherFlightRef.current) return weatherFlightRef.current;
    const generation = ++weatherGenerationRef.current;
    const flight = (async () => {
      setWeatherLoading(true);
      try {
        const next = await bridge.weather.refresh();
        if (generation === weatherGenerationRef.current) setWeather(next);
      } catch (error) {
        addEntry("system", text("app.weatherFailed", { detail: error instanceof Error ? error.message : String(error) }));
      } finally {
        if (generation === weatherGenerationRef.current) setWeatherLoading(false);
      }
    })();
    weatherFlightRef.current = flight;
    try { await flight; } finally { if (weatherFlightRef.current === flight) weatherFlightRef.current = null; }
  }, [addEntry, text]);

  const checkLocalUpdate = useCallback(async (announce = false) => {
    if (updateFlightRef.current) return updateFlightRef.current;
    const generation = ++updateGenerationRef.current;
    const flight = (async () => {
      setUpdateBusy(true);
      try {
        const next = await bridge.updates.check();
        if (generation !== updateGenerationRef.current) return;
        setUpdateStatus(next);
        setUpdateError(null);
        if (announce) setToast(text(next.available ? "update.readyTitle" : "update.current", { version: next.version ?? next.currentVersion }));
      } catch (error) {
        if (generation !== updateGenerationRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        setUpdateError(message);
        if (announce) setToast(message);
      } finally {
        if (generation === updateGenerationRef.current) setUpdateBusy(false);
      }
    })();
    updateFlightRef.current = flight;
    try { await flight; } finally { if (updateFlightRef.current === flight) updateFlightRef.current = null; }
  }, [text]);

  useEffect(() => { localStorage.setItem("keemash.serial.port", selectedPort); }, [selectedPort]);
  useEffect(() => {
    void Promise.all([bridge.mesh.status(), bridge.serial.list(), bridge.serial.status()])
      .then(async ([root, available, serial]) => {
        let rootState = root;
        let serialState = serial;
        setPorts(available);
        if (!root.paired) {
          const bootstrapPort = serial.connected
            ? serial.path
            : preferredStartupPort(available, localStorage.getItem("keemash.serial.port"));
          if (!serialState.connected && bootstrapPort) {
            try {
              serialState = await bridge.serial.open(bootstrapPort);
              setSelectedPort(bootstrapPort);
              addEntry("system", `Trusted commissioning link opened on ${bootstrapPort}`);
            } catch (error) {
              addEntry("system", `Trusted commissioning link unavailable: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          if (serialState.connected) {
            try {
              rootState = await bridge.mesh.pair();
              addEntry("system", "KeeLink trusted commissioning accepted");
            } catch (error) {
              addEntry("system", `KeeLink commissioning failed: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
        setMeshStatus(rootState);
        meshConnectedRef.current = rootState.connected;
        setSerialStatus(serialState);
        serialConnectedRef.current = serialState.connected;
      })
      .catch((error) => addEntry("system", `Transport startup failed: ${error instanceof Error ? error.message : String(error)}`));
    void refreshWeather();
    const processLine = (line: string) => {
      addEntry("rx", line);
      const token = normalizeLegacyToken(line);
      const matched = matchingFeedback(commandFeedbackRef.current, token);
      const next = parseLegacyLine(legacyRef.current, line, matched[0]?.owner ?? null);
      legacyRef.current = next;
      setLegacyState(next);
      if (next.notificationKey) setToast(text(next.notificationKey));
      if (next.commandError) {
        const key = next.commandError.code === "OFFLINE" ? "mesh.commandOffline" : next.commandError.code === "POWER_OFF" ? "mesh.commandPowerOff" : next.commandError.code === "TIMEOUT" ? "mesh.commandTimeout" : "mesh.commandRejected";
        setToast(text(key, { node: next.commandError.owner }));
        const owner = meshNodeIdForTag(next.commandError.owner);
        if (owner) {
          finishFeedback(
            Object.values(commandFeedbackRef.current).filter((feedback) => feedback.owner === owner).map((feedback) => feedback.target),
            "error",
            next.commandError.code,
          );
        }
      } else if (matched.length) {
        finishFeedback(matched.map((feedback) => feedback.target), "confirmed");
      }
      if (token === "hello") window.setTimeout(() => void refreshAll(), 300);
    };
    const removeSerialLine = bridge.serial.onLine((line) => {
      if (!meshConnectedRef.current) processLine(line);
      else if (localStorage.getItem("keemash.transport.dualRun") === "true") addEntry("rx", `[COM compare] ${line}`);
    });
    const removeMeshLine = bridge.mesh.onLine(processLine);
    const removeSerialStatus = bridge.serial.onStatus((status) => {
      serialConnectedRef.current = status.connected;
      setSerialStatus(status);
    });
    const removeMeshStatus = bridge.mesh.onStatus((status) => {
      meshConnectedRef.current = status.connected;
      setMeshStatus(status);
      if (!status.connected && !serialConnectedRef.current) cancelRefresh();
    });
    const removeInventory = bridge.mesh.onInventory(setMeshInventory);
    const removeMeshEvent = bridge.mesh.onEvent((event) => {
      const next = applyTypedSensorEvent(legacyRef.current, event);
      if (next !== legacyRef.current) {
        legacyRef.current = next;
        setLegacyState(next);
      }
    });
    const removeWeather = bridge.weather.onSnapshot(setWeather);
    const removeUpdate = bridge.updates.onStatus((status) => { setUpdateStatus(status); setUpdateError(null); });
    return () => {
      cancelRefresh();
      for (const target of feedbackTimersRef.current.keys()) clearFeedbackTimers(target);
      removeSerialLine();
      removeMeshLine();
      removeSerialStatus();
      removeMeshStatus();
      removeInventory();
      removeMeshEvent();
      removeWeather();
      removeUpdate();
    };
  }, [addEntry, cancelRefresh, clearFeedbackTimers, finishFeedback, refreshAll, refreshWeather, text]);

  const monitorActive = runtimeState("monitor") === "active" || runtimeState("monitor") === "background";
  useEffect(() => {
    const removeSample = bridge.resources.onSample((sample) => setResources((current) => [...current.slice(-89), sample]));
    if (monitorActive) void bridge.resources.sample().then((sample) => setResources((current) => [...current.slice(-89), sample]));
    return () => removeSample();
  }, [monitorActive]);

  useEffect(() => {
    if (!monitorActive) return;
    let active = true;
    let inFlight = false;
    let generation = 0;
    const refresh = () => {
      if (inFlight) return;
      inFlight = true;
      const request = ++generation;
      void bridge.memory.status()
        .then((status) => { if (active && request === generation) setMemoryTest(status); })
        .catch(() => undefined)
        .finally(() => { if (request === generation) inFlight = false; });
    };
    refresh();
    const timer = window.setInterval(refresh, memoryTest?.state === "running" || memoryTest?.state === "allocating" ? 1_000 : 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [memoryTest?.state, monitorActive]);

  const refreshCcc = useCallback(async () => {
    if (cccFlightRef.current) return cccFlightRef.current;
    const generation = ++cccGenerationRef.current;
    const flight = (async () => {
      try {
        const next = await bridge.ccc.status();
        if (generation === cccGenerationRef.current) setCccStatus(next);
      } catch (error) {
        if (generation === cccGenerationRef.current) setToast(text("monitor.cccFailed", { detail: error instanceof Error ? error.message : String(error) }));
      }
    })();
    cccFlightRef.current = flight;
    try { await flight; } finally { if (cccFlightRef.current === flight) cccFlightRef.current = null; }
  }, [text]);
  useEffect(() => {
    if (!monitorActive) return;
    void refreshCcc();
    const timer = window.setInterval(() => void refreshCcc(), 5_000);
    return () => window.clearInterval(timer);
  }, [monitorActive, refreshCcc]);

  const refreshGpuResidency = useCallback(async () => {
    if (gpuFlightRef.current) return gpuFlightRef.current;
    const generation = ++gpuGenerationRef.current;
    const flight = (async () => {
      try {
        const next = await bridge.gpuResidency.snapshot();
        if (generation !== gpuGenerationRef.current) return;
        setGpuResidency(next);
        setGpuResidencyError(null);
      } catch (error) {
        if (generation === gpuGenerationRef.current) setGpuResidencyError(error instanceof Error ? error.message : String(error));
      }
    })();
    gpuFlightRef.current = flight;
    try { await flight; } finally { if (gpuFlightRef.current === flight) gpuFlightRef.current = null; }
  }, []);
  useEffect(() => {
    if (!monitorActive) return;
    void refreshGpuResidency();
    const timer = window.setInterval(() => void refreshGpuResidency(), Math.max(1_000, profile.telemetryIntervalMs));
    return () => window.clearInterval(timer);
  }, [monitorActive, profile.telemetryIntervalMs, refreshGpuResidency]);

  const refreshGraphicsRuntime = useCallback(async () => {
    if (graphicsFlightRef.current) return graphicsFlightRef.current;
    const flight = (async () => {
      try {
        setGraphicsRuntime(await bridge.graphics.status());
        setGraphicsRuntimeError(null);
      } catch (error) {
        setGraphicsRuntimeError(error instanceof Error ? error.message : String(error));
      }
    })();
    graphicsFlightRef.current = flight;
    try { await flight; } finally { if (graphicsFlightRef.current === flight) graphicsFlightRef.current = null; }
  }, []);
  useEffect(() => {
    void refreshGraphicsRuntime();
    const stop = bridge.graphics.onStatus((status) => { setGraphicsRuntime(status); setGraphicsRuntimeError(null); });
    const timer = window.setInterval(() => void refreshGraphicsRuntime(), 5_000);
    return () => { stop(); window.clearInterval(timer); };
  }, [refreshGraphicsRuntime]);

  useEffect(() => { void checkLocalUpdate(); }, [checkLocalUpdate]);
  const transportConnected = meshStatus.connected || serialStatus.connected;
  useEffect(() => { if (!serialStatus.connected || meshStatus.connected) return; const timer = window.setInterval(() => void bridge.serial.send("kyy"), 5 * 60 * 1_000); return () => window.clearInterval(timer); }, [meshStatus.connected, serialStatus.connected]);
  useEffect(() => { if (!autoRefresh || !transportConnected) return; const timer = window.setInterval(() => void refreshAll(), autoRefreshMinutes * 60 * 1_000); return () => window.clearInterval(timer); }, [autoRefresh, autoRefreshMinutes, refreshAll, transportConnected]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 4_500); return () => window.clearTimeout(timer); }, [toast]);

  const openSerial = useCallback(async () => { try { const status = await bridge.serial.open(selectedPort); serialConnectedRef.current = status.connected; setSerialStatus(status); addEntry("system", text("app.connected", { port: selectedPort })); } catch (error) { const message = text("app.connectFailed", { detail: error instanceof Error ? error.message : String(error) }); setToast(message); addEntry("system", message); } }, [addEntry, selectedPort, text]);
  const closeSerial = useCallback(async () => {
    cancelRefresh();
    for (const target of feedbackTimersRef.current.keys()) clearFeedbackTimers(target);
    replaceCommandFeedback({});
    const status = await bridge.serial.close();
    serialConnectedRef.current = false;
    setSerialStatus(status);
    const offline = { ...legacyRef.current, online: false };
    legacyRef.current = offline;
    setLegacyState(offline);
    addEntry("system", text("app.disconnected"));
  }, [addEntry, cancelRefresh, clearFeedbackTimers, replaceCommandFeedback, text]);
  const pairRoot = useCallback(async () => {
    try {
      const status = await bridge.mesh.pair();
      setMeshStatus(status);
      setToast("KeeLink trusted commissioning accepted");
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    }
  }, []);
  const revokeRoot = useCallback(async () => {
    try {
      await bridge.mesh.revoke();
      meshConnectedRef.current = false;
      setMeshStatus({ connected: false, paired: false, transport: "none", rootIdentity: null, address: null, security: "unpaired", latencyMs: null, reconnectPhase: "commissioning-required", lastError: null });
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    }
  }, []);
  const installLocalUpdate = useCallback(async () => {
    setUpdateBusy(true);
    setUpdateError(null);
    try {
      setToast(text("app.verifyingInstaller"));
      await bridge.updates.install();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUpdateError(message);
      setToast(message);
      setUpdateBusy(false);
    }
  }, [text]);
  const rebootToFirmware = useCallback(async () => {
    try {
      await bridge.system.rebootToFirmware();
      setToast(text("monitor.rebootFirmwareScheduled"));
    } catch (error) {
      setToast(text("monitor.rebootFirmwareFailed", { detail: error instanceof Error ? error.message : String(error) }));
    }
  }, [text]);
  const scheduleSystemPower = useCallback(async (action: "restart" | "shutdown") => {
    try {
      const result = action === "restart" ? await bridge.system.restart() : await bridge.system.shutdown();
      setSystemPowerPending(action);
      setToast(text("monitor.powerScheduled", { action: text(`monitor.${action}`), seconds: result.delaySeconds }));
    } catch (error) {
      setToast(text("monitor.powerFailed", { detail: error instanceof Error ? error.message : String(error) }));
    }
  }, [text]);
  const cancelSystemPower = useCallback(async () => {
    try {
      await bridge.system.cancelPower();
      setSystemPowerPending(null);
      setToast(text("monitor.powerCancelled"));
    } catch (error) {
      setToast(text("monitor.powerFailed", { detail: error instanceof Error ? error.message : String(error) }));
    }
  }, [text]);
  const manageCcc = useCallback(async (action: "start" | "stop" | "restart") => {
    setCccBusy(true);
    try {
      const result = await bridge.ccc[action]();
      setCccStatus(result.status);
      setToast(result.forced ? text("monitor.cccForced", { action }) : result.message);
    } catch (error) {
      setToast(text("monitor.cccFailed", { detail: error instanceof Error ? error.message : String(error) }));
    } finally {
      setCccBusy(false);
    }
  }, [text]);
  const applyGpuPolicy = useCallback(async (settings: { identity: ProcessIdentity; preset: GpuPolicyPreset; gpuPriority: number; ramPriority: number; persist: boolean; autoAttach: boolean; agentAllowed: boolean }) => {
    setGpuResidencyBusy(true);
    try {
      const result = await bridge.gpuResidency.setProcessPolicy(settings);
      await refreshGpuResidency();
      setToast(result.message);
      return result;
    } finally {
      setGpuResidencyBusy(false);
    }
  }, [refreshGpuResidency]);
  const removeGpuRule = useCallback(async (executablePath: string) => {
    setGpuResidencyBusy(true);
    try {
      const removed = await bridge.gpuResidency.removeRule(executablePath);
      await refreshGpuResidency();
      return removed;
    } finally {
      setGpuResidencyBusy(false);
    }
  }, [refreshGpuResidency]);
  const undoGpuPolicy = useCallback(async (identity: ProcessIdentity) => {
    setGpuResidencyBusy(true);
    try {
      const result = await bridge.gpuResidency.undoProcessPolicy(identity);
      await refreshGpuResidency();
      setToast(result.message);
      return result;
    } finally {
      setGpuResidencyBusy(false);
    }
  }, [refreshGpuResidency]);
  const closeGpuProcess = useCallback(async (identity: ProcessIdentity) => {
    setGpuResidencyBusy(true);
    try {
      const result = await bridge.process.close(identity);
      await refreshGpuResidency();
      return result;
    } finally {
      setGpuResidencyBusy(false);
    }
  }, [refreshGpuResidency]);
  const terminateGpuProcess = useCallback(async (identity: ProcessIdentity) => {
    setGpuResidencyBusy(true);
    try {
      const result = await bridge.process.terminate(identity);
      await refreshGpuResidency();
      return result;
    } finally {
      setGpuResidencyBusy(false);
    }
  }, [refreshGpuResidency]);
  const terminateGpuProcessTree = useCallback(async (identity: ProcessIdentity) => {
    setGpuResidencyBusy(true);
    try {
      const result = await bridge.process.terminateTree(identity);
      await refreshGpuResidency();
      return result;
    } finally {
      setGpuResidencyBusy(false);
    }
  }, [refreshGpuResidency]);
  const setMasterGpu = useCallback(async (luid: string | null) => {
    setGraphicsRuntimeBusy(true);
    try {
      setGraphicsRuntime(await bridge.graphics.setMaster(luid));
      setGraphicsRuntimeError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== "Operation cancelled by user") setGraphicsRuntimeError(message);
    } finally {
      setGraphicsRuntimeBusy(false);
    }
  }, []);
  const restartForGraphics = useCallback(async () => {
    setGraphicsRuntimeBusy(true);
    try {
      await bridge.graphics.restart();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== "Operation cancelled by user") setGraphicsRuntimeError(message);
      setGraphicsRuntimeBusy(false);
    }
  }, []);
  const startMemoryTest = useCallback(async (memoryMiB: number, durationSeconds: number, threads = 0) => {
    try { setMemoryTest(await bridge.memory.start(memoryMiB, durationSeconds, threads)); setToast(text("monitor.memoryTestStarted")); }
    catch (error) { setToast(text("monitor.memoryTestFailed", { detail: error instanceof Error ? error.message : String(error) })); }
  }, [text]);
  const stopMemoryTest = useCallback(async () => {
    try { setMemoryTest(await bridge.memory.stop()); }
    catch (error) { setToast(text("monitor.memoryTestFailed", { detail: error instanceof Error ? error.message : String(error) })); }
  }, [text]);
  const openWindowsMemoryDiagnostic = useCallback(async () => {
    if (!window.confirm(text("monitor.windowsDiagnosticConfirm"))) return;
    try { await bridge.memory.openWindowsDiagnostic(); }
    catch (error) { setToast(text("monitor.memoryTestFailed", { detail: error instanceof Error ? error.message : String(error) })); }
  }, [text]);

  const services = useMemo<AppServices>(() => ({
    ports, selectedPort, serialStatus: { connected: transportConnected, path: meshStatus.connected ? `KeeLink ${meshStatus.transport.toUpperCase()}` : serialStatus.path, baudRate: serialStatus.baudRate, error: meshStatus.lastError ?? serialStatus.error }, meshStatus, meshInventory, legacyState, weather, weatherLoading, resources, entries, commandFeedback, busy, autoRefresh, autoRefreshMinutes, debugEnabled, updateStatus, updateBusy, updateError, memoryTest, systemPowerPending, cccStatus, cccBusy, gpuResidency, gpuResidencyBusy, gpuResidencyError, graphicsRuntime, graphicsRuntimeBusy, graphicsRuntimeError,
    setSelectedPort, refreshPorts: () => void refreshPorts(), openSerial: () => void openSerial(), closeSerial: () => void closeSerial(), pairRoot: () => void pairRoot(), revokeRoot: () => void revokeRoot(), refreshAll: () => void refreshAll(), setAutoRefresh, setAutoRefreshMinutes,
    setDebugEnabled: (enabled) => { setDebugEnabled(enabled); if (serialStatus.connected) void bridge.serial.send(enabled ? "dbg1" : "dbg0"); }, refreshWeather: () => void refreshWeather(), sendCommand, checkUpdate: () => void checkLocalUpdate(true), installUpdate: () => void installLocalUpdate(), rebootToFirmware: () => void rebootToFirmware(), scheduleSystemPower: (action) => void scheduleSystemPower(action), cancelSystemPower: () => void cancelSystemPower(), startMemoryTest: (memoryMiB, durationSeconds, threads) => void startMemoryTest(memoryMiB, durationSeconds, threads), stopMemoryTest: () => void stopMemoryTest(), openWindowsMemoryDiagnostic: () => void openWindowsMemoryDiagnostic(), refreshCcc: () => void refreshCcc(), manageCcc: (action) => void manageCcc(action), refreshGpuResidency: () => void refreshGpuResidency(), applyGpuPolicy, undoGpuPolicy, removeGpuRule, closeProcess: closeGpuProcess, terminateProcess: terminateGpuProcess, terminateProcessTree: terminateGpuProcessTree, refreshGraphicsRuntime: () => void refreshGraphicsRuntime(), setMasterGpu, restartForGraphics,
  }), [applyGpuPolicy, autoRefresh, autoRefreshMinutes, busy, cancelSystemPower, cccBusy, cccStatus, checkLocalUpdate, closeGpuProcess, closeSerial, commandFeedback, debugEnabled, entries, gpuResidency, gpuResidencyBusy, gpuResidencyError, graphicsRuntime, graphicsRuntimeBusy, graphicsRuntimeError, installLocalUpdate, legacyState, manageCcc, memoryTest, meshInventory, meshStatus, openSerial, openWindowsMemoryDiagnostic, pairRoot, ports, rebootToFirmware, refreshAll, refreshCcc, refreshGpuResidency, refreshGraphicsRuntime, refreshPorts, refreshWeather, removeGpuRule, resources, restartForGraphics, revokeRoot, scheduleSystemPower, selectedPort, sendCommand, serialStatus, setMasterGpu, startMemoryTest, stopMemoryTest, systemPowerPending, terminateGpuProcess, terminateGpuProcessTree, transportConnected, undoGpuPolicy, updateBusy, updateError, updateStatus, weather, weatherLoading]);

  return <AppServicesProvider value={services}><EnjoyModuleProvider><SuperAppShell /></EnjoyModuleProvider>{toast && <div className="toast" role="status">{toast}</div>}</AppServicesProvider>;
}

export function App() { return <WorkspaceProvider><AppController /></WorkspaceProvider>; }
