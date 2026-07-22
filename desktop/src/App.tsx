import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SuperAppShell } from "./components/SuperAppShell";
import { type ConsoleEntry } from "./components/ControlsView";
import { AppServicesProvider, type AppServices } from "./core/appServices";
import { EnjoyModuleProvider } from "./core/enjoyState";
import { WorkspaceProvider, useWorkspace } from "./core/workspace";
import { bridge } from "./lib/bridge";
import { useLocale } from "./i18n/locale";
import { initialLegacyState, parseLegacyLine, type LegacyState } from "./lib/protocol";
import type { LocalUpdateStatus, ResourceSample, SerialPortInfo, SerialStatus, WeatherSnapshot } from "./types";

const FEEDBACK_COMMANDS = ["garland_echo", "red_led_echo", "sens_echo", "choinka", "bedside_echo", "echo_turb", "lamech", "pm1", "jajoeh", "heho", "pwech"];
const sleep = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function AppController() {
  const { text } = useLocale();
  const { runtimeState } = useWorkspace();
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

  const addEntry = useCallback((direction: ConsoleEntry["direction"], value: string) => {
    setEntries((current) => [...current.slice(-299), { id: ++entryId.current, timestamp: Date.now(), direction, text: value }]);
  }, []);

  const sendCommand = useCallback(async (command: string) => {
    try { await bridge.serial.send(command); addEntry("tx", command); }
    catch (error) { const message = text("app.sendFailed", { detail: error instanceof Error ? error.message : String(error) }); addEntry("system", message); setToast(message); }
  }, [addEntry, text]);

  const cancelRefresh = useCallback(() => { refreshRunRef.current += 1; busyRef.current = false; setBusy(false); }, []);
  const refreshAll = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const run = ++refreshRunRef.current;
    setBusy(true);
    try { for (const command of FEEDBACK_COMMANDS) { if (run !== refreshRunRef.current) break; await sendCommand(command); await sleep(1_200); } }
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
    setWeatherLoading(true);
    try { setWeather(await bridge.weather.refresh()); }
    catch (error) { addEntry("system", text("app.weatherFailed", { detail: error instanceof Error ? error.message : String(error) })); }
    finally { setWeatherLoading(false); }
  }, [addEntry, text]);

  const checkLocalUpdate = useCallback(async (announce = false) => {
    setUpdateBusy(true);
    try { const next = await bridge.updates.check(); setUpdateStatus(next); setUpdateError(null); if (announce) setToast(text(next.available ? "update.readyTitle" : "update.current", { version: next.version ?? next.currentVersion })); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); setUpdateError(message); if (announce) setToast(message); }
    finally { setUpdateBusy(false); }
  }, [text]);

  useEffect(() => { localStorage.setItem("keemash.serial.port", selectedPort); }, [selectedPort]);
  useEffect(() => {
    void refreshPorts(); void bridge.serial.status().then(setSerialStatus); void refreshWeather();
    const removeLine = bridge.serial.onLine((line) => { addEntry("rx", line); const next = parseLegacyLine(legacyRef.current, line); legacyRef.current = next; setLegacyState(next); if (next.notificationKey) setToast(text(next.notificationKey)); if (line.split(",")[0]?.trim() === "hello") window.setTimeout(() => void refreshAll(), 300); });
    const removeStatus = bridge.serial.onStatus((status) => { setSerialStatus(status); if (!status.connected) cancelRefresh(); });
    const removeWeather = bridge.weather.onSnapshot(setWeather);
    const removeUpdate = bridge.updates.onStatus((status) => { setUpdateStatus(status); setUpdateError(null); });
    return () => { cancelRefresh(); removeLine(); removeStatus(); removeWeather(); removeUpdate(); };
  }, [addEntry, cancelRefresh, refreshAll, refreshPorts, refreshWeather, text]);

  const monitorActive = runtimeState("monitor") === "active" || runtimeState("monitor") === "background";
  useEffect(() => {
    const removeSample = bridge.resources.onSample((sample) => setResources((current) => [...current.slice(-89), sample]));
    if (monitorActive) void bridge.resources.sample().then((sample) => setResources((current) => [...current.slice(-89), sample]));
    return () => removeSample();
  }, [monitorActive]);

  useEffect(() => { void checkLocalUpdate(); }, [checkLocalUpdate]);
  useEffect(() => { if (!serialStatus.connected) return; const timer = window.setInterval(() => void sendCommand("kyy"), 5 * 60 * 1_000); return () => window.clearInterval(timer); }, [sendCommand, serialStatus.connected]);
  useEffect(() => { if (!autoRefresh || !serialStatus.connected) return; const timer = window.setInterval(() => void refreshAll(), autoRefreshMinutes * 60 * 1_000); return () => window.clearInterval(timer); }, [autoRefresh, autoRefreshMinutes, refreshAll, serialStatus.connected]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 4_500); return () => window.clearTimeout(timer); }, [toast]);

  const openSerial = useCallback(async () => { try { const status = await bridge.serial.open(selectedPort); setSerialStatus(status); addEntry("system", text("app.connected", { port: selectedPort })); } catch (error) { const message = text("app.connectFailed", { detail: error instanceof Error ? error.message : String(error) }); setToast(message); addEntry("system", message); } }, [addEntry, selectedPort, text]);
  const closeSerial = useCallback(async () => { cancelRefresh(); setSerialStatus(await bridge.serial.close()); const offline = { ...legacyRef.current, online: false }; legacyRef.current = offline; setLegacyState(offline); addEntry("system", text("app.disconnected")); }, [addEntry, cancelRefresh, text]);
  const installLocalUpdate = useCallback(async () => { setUpdateBusy(true); try { setToast(text("app.verifyingInstaller")); await bridge.updates.install(); } catch (error) { const message = error instanceof Error ? error.message : String(error); setUpdateError(message); setToast(message); setUpdateBusy(false); } }, [text]);
  const rebootToFirmware = useCallback(async () => {
    if (!window.confirm(text("monitor.rebootFirmwareConfirm"))) return;
    try {
      await bridge.system.rebootToFirmware();
      setToast(text("monitor.rebootFirmwareScheduled"));
    } catch (error) {
      setToast(text("monitor.rebootFirmwareFailed", { detail: error instanceof Error ? error.message : String(error) }));
    }
  }, [text]);

  const services = useMemo<AppServices>(() => ({
    ports, selectedPort, serialStatus, legacyState, weather, weatherLoading, resources, entries, busy, autoRefresh, autoRefreshMinutes, debugEnabled, updateStatus, updateBusy, updateError,
    setSelectedPort, refreshPorts: () => void refreshPorts(), openSerial: () => void openSerial(), closeSerial: () => void closeSerial(), refreshAll: () => void refreshAll(), setAutoRefresh, setAutoRefreshMinutes,
    setDebugEnabled: (enabled) => { setDebugEnabled(enabled); if (serialStatus.connected) void sendCommand(enabled ? "dbg1" : "dbg0"); }, refreshWeather: () => void refreshWeather(), sendCommand: (command) => void sendCommand(command), checkUpdate: () => void checkLocalUpdate(true), installUpdate: () => void installLocalUpdate(), rebootToFirmware: () => void rebootToFirmware(),
  }), [autoRefresh, autoRefreshMinutes, busy, checkLocalUpdate, closeSerial, debugEnabled, entries, installLocalUpdate, legacyState, openSerial, ports, rebootToFirmware, refreshAll, refreshPorts, refreshWeather, resources, selectedPort, sendCommand, serialStatus, updateBusy, updateError, updateStatus, weather, weatherLoading]);

  return <AppServicesProvider value={services}><EnjoyModuleProvider><SuperAppShell /></EnjoyModuleProvider>{toast && <div className="toast" role="status">{toast}</div>}</AppServicesProvider>;
}

export function App() { return <WorkspaceProvider><AppController /></WorkspaceProvider>; }
