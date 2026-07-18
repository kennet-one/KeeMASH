import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ConnectionBar } from "./components/ConnectionBar";
import { ControlsView, type ConsoleEntry } from "./components/ControlsView";
import { TopBar } from "./components/TopBar";
import { EnjoyTransition } from "./components/EnjoyTransition";
import { bridge } from "./lib/bridge";
import { initialLegacyState, parseLegacyLine, type LegacyState } from "./lib/protocol";
import type { LocalUpdateStatus, ResourceSample, SerialPortInfo, SerialStatus, WeatherSnapshot } from "./types";

const ResourceMonitor = lazy(() =>
  import("./components/ResourceMonitor").then((module) => ({ default: module.ResourceMonitor })),
);
const EnjoyView = lazy(() =>
  import("./components/EnjoyView").then((module) => ({ default: module.EnjoyView })),
);

const FEEDBACK_COMMANDS = [
  "garland_echo",
  "red_led_echo",
  "sens_echo",
  "choinka",
  "bedside_echo",
  "echo_turb",
  "lamech",
  "pm1",
  "jajoeh",
  "heho",
  "pwech",
];

const sleep = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function savedBoolean(key: string, fallback: boolean): boolean {
  const value = localStorage.getItem(key);
  return value === null ? fallback : value === "true";
}

export function App() {
  const [showMain, setShowMain] = useState(() => savedBoolean("keemash.view.main", true));
  const [showMonitor, setShowMonitor] = useState(() => savedBoolean("keemash.view.monitor", false));
  const [showEnjoy, setShowEnjoy] = useState(() => savedBoolean("keemash.view.enjoy", false));
  const [enjoyEntering, setEnjoyEntering] = useState(false);
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [selectedPort, setSelectedPort] = useState(() => localStorage.getItem("keemash.serial.port") ?? "COM4");
  const [serialStatus, setSerialStatus] = useState<SerialStatus>({ connected: false, path: null, baudRate: 115200, error: null });
  const [legacyState, setLegacyState] = useState<LegacyState>(initialLegacyState);
  const legacyRef = useRef(legacyState);
  const [weather, setWeather] = useState<WeatherSnapshot | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [resources, setResources] = useState<ResourceSample[]>([]);
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const entryId = useRef(0);
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

  const checkLocalUpdate = useCallback(async (announce = false) => {
    setUpdateBusy(true);
    try {
      const next = await bridge.updates.check();
      setUpdateStatus(next);
      setUpdateError(null);
      if (announce) setToast(next.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUpdateError(message);
      if (announce) setToast(message);
    } finally {
      setUpdateBusy(false);
    }
  }, []);

  const addEntry = useCallback((direction: ConsoleEntry["direction"], text: string) => {
    const entry: ConsoleEntry = { id: ++entryId.current, timestamp: Date.now(), direction, text };
    setEntries((current) => [...current.slice(-299), entry]);
  }, []);

  const sendCommand = useCallback(async (command: string) => {
    try {
      await bridge.serial.send(command);
      addEntry("tx", command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addEntry("system", `Send failed: ${message}`);
      setToast(message);
    }
  }, [addEntry]);

  const cancelRefresh = useCallback(() => {
    refreshRunRef.current += 1;
    busyRef.current = false;
    setBusy(false);
  }, []);

  const refreshAll = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const run = ++refreshRunRef.current;
    setBusy(true);
    try {
      for (const command of FEEDBACK_COMMANDS) {
        if (run !== refreshRunRef.current) break;
        await sendCommand(command);
        await sleep(1_200);
      }
    } finally {
      if (run === refreshRunRef.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, [sendCommand]);

  const refreshPorts = useCallback(async () => {
    try {
      const available = await bridge.serial.list();
      setPorts(available);
      setSelectedPort((current) => {
        if (available.some((port) => port.path === current)) return current;
        const preferred = available.find((port) => port.path === "COM4")?.path ?? available[0]?.path ?? "";
        return preferred;
      });
    } catch (error) {
      addEntry("system", `Port scan failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [addEntry]);

  const refreshWeather = useCallback(async () => {
    setWeatherLoading(true);
    try {
      setWeather(await bridge.weather.refresh());
    } catch (error) {
      addEntry("system", `Weather failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setWeatherLoading(false);
    }
  }, [addEntry]);

  useEffect(() => {
    localStorage.setItem("keemash.view.main", String(showMain));
    localStorage.setItem("keemash.view.monitor", String(showMonitor));
    localStorage.setItem("keemash.view.enjoy", String(showEnjoy));
  }, [showMain, showMonitor, showEnjoy]);

  useEffect(() => {
    localStorage.setItem("keemash.serial.port", selectedPort);
  }, [selectedPort]);

  useEffect(() => {
    void refreshPorts();
    void bridge.serial.status().then(setSerialStatus);
    void refreshWeather();

    const removeLine = bridge.serial.onLine((line) => {
      addEntry("rx", line);
      const next = parseLegacyLine(legacyRef.current, line);
      legacyRef.current = next;
      setLegacyState(next);
      if (next.notification) setToast(next.notification);
      if (line.split(",")[0]?.trim() === "hello") window.setTimeout(() => void refreshAll(), 300);
    });
    const removeStatus = bridge.serial.onStatus((status) => {
      setSerialStatus(status);
      if (!status.connected) cancelRefresh();
    });
    return () => {
      refreshRunRef.current += 1;
      busyRef.current = false;
      removeLine();
      removeStatus();
    };
  }, [addEntry, cancelRefresh, refreshAll, refreshPorts, refreshWeather]);

  useEffect(() => {
    void bridge.resources.setEnabled(showMonitor);
    if (!showMonitor) return undefined;
    const removeSample = bridge.resources.onSample((sample) => {
      setResources((current) => [...current.slice(-89), sample]);
    });
    void bridge.resources.sample().then((sample) => setResources((current) => [...current.slice(-89), sample]));
    return () => removeSample();
  }, [showMonitor]);

  useEffect(() => {
    const weatherTimer = window.setInterval(() => void refreshWeather(), 10 * 60 * 1_000);
    return () => window.clearInterval(weatherTimer);
  }, [refreshWeather]);

  useEffect(() => {
    void checkLocalUpdate();
    const timer = window.setInterval(() => void checkLocalUpdate(), 60_000);
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") void checkLocalUpdate();
    };
    document.addEventListener("visibilitychange", checkWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, [checkLocalUpdate]);

  useEffect(() => {
    if (!serialStatus.connected) return undefined;
    const heartbeat = window.setInterval(() => void sendCommand("kyy"), 5 * 60 * 1_000);
    return () => window.clearInterval(heartbeat);
  }, [serialStatus.connected, sendCommand]);

  useEffect(() => {
    if (!autoRefresh || !serialStatus.connected) return undefined;
    const timer = window.setInterval(() => void refreshAll(), autoRefreshMinutes * 60 * 1_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, autoRefreshMinutes, refreshAll, serialStatus.connected]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 4_500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const openSerial = async () => {
    try {
      const status = await bridge.serial.open(selectedPort);
      setSerialStatus(status);
      addEntry("system", `Connected ${selectedPort} @ 115200`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setToast(message);
      addEntry("system", `Connect failed: ${message}`);
    }
  };

  const closeSerial = async () => {
    cancelRefresh();
    setSerialStatus(await bridge.serial.close());
    const offline = { ...legacyRef.current, online: false };
    legacyRef.current = offline;
    setLegacyState(offline);
    addEntry("system", "Serial disconnected");
  };

  const toggleDebug = (enabled: boolean) => {
    setDebugEnabled(enabled);
    if (serialStatus.connected) void sendCommand(enabled ? "dbg1" : "dbg0");
  };

  const toggleEnjoy = () => {
    if (showEnjoy) {
      setShowEnjoy(false);
      return;
    }
    setEnjoyEntering(true);
    setShowEnjoy(true);
  };

  const installLocalUpdate = async () => {
    setUpdateBusy(true);
    try {
      setToast("Verifying installer SHA256...");
      await bridge.updates.install();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUpdateError(message);
      setToast(message);
      setUpdateBusy(false);
    }
  };

  return (
    <div className="app-shell">
      <TopBar
        showMain={showMain}
        showMonitor={showMonitor}
        showEnjoy={showEnjoy}
        serialStatus={serialStatus}
        bridgeOnline={legacyState.online}
        updateStatus={updateStatus}
        updateBusy={updateBusy}
        updateError={updateError}
        onToggleMain={() => setShowMain((current) => !current)}
        onToggleMonitor={() => setShowMonitor((current) => !current)}
        onToggleEnjoy={toggleEnjoy}
        onCheckUpdate={() => void checkLocalUpdate(true)}
        onInstallUpdate={() => void installLocalUpdate()}
      />

      <main className="workspace">
        {showMain && !showEnjoy && (
          <>
            <ConnectionBar
              ports={ports}
              selectedPort={selectedPort}
              status={serialStatus}
              autoRefresh={autoRefresh}
              autoRefreshMinutes={autoRefreshMinutes}
              debugEnabled={debugEnabled}
              busy={busy}
              onPortChange={setSelectedPort}
              onRescan={() => void refreshPorts()}
              onConnect={() => void openSerial()}
              onDisconnect={() => void closeSerial()}
              onRefresh={() => void refreshAll()}
              onAutoRefreshChange={setAutoRefresh}
              onAutoRefreshMinutesChange={setAutoRefreshMinutes}
              onDebugChange={toggleDebug}
              onSend={(command) => void sendCommand(command)}
            />
            <ControlsView
              state={legacyState}
              weather={weather}
              weatherLoading={weatherLoading}
              consoleEntries={entries}
              onWeatherRefresh={() => void refreshWeather()}
              onSend={(command) => void sendCommand(command)}
            />
          </>
        )}
        {showMonitor && !showEnjoy && (
          <Suspense fallback={<div className="monitor-loading">Loading monitor</div>}>
            <ResourceMonitor latest={resources.at(-1) ?? null} history={resources} />
          </Suspense>
        )}
        {showEnjoy && (
          <Suspense fallback={<div className="monitor-loading">Loading Enjoy Mode</div>}>
            <EnjoyView />
          </Suspense>
        )}
      </main>

      <footer className="status-bar">
        <span>{showEnjoy ? "Enjoy Mode · local read-only BIOS Brain" : serialStatus.error ?? (serialStatus.connected ? "Serial active" : "Serial idle")}</span>
        <span>{legacyState.lastLine ? `Last: ${legacyState.lastLine}` : "No mesh reply"}</span>
      </footer>

      {toast && <div className="toast" role="status">{toast}</div>}
      {enjoyEntering && <EnjoyTransition onDone={() => setEnjoyEntering(false)} />}
    </div>
  );
}
