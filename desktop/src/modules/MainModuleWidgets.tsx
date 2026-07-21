import { ConnectionBar } from "../components/ConnectionBar";
import { ClimateWidget, ConsoleWidget, LightingWidget, MeshSensorsWidget } from "../components/ControlsView";
import { WeatherPanel } from "../components/WeatherPanel";
import { useAppServices } from "../core/appServices";

export function ConnectionModuleWidget() { const app = useAppServices(); return <ConnectionBar ports={app.ports} selectedPort={app.selectedPort} status={app.serialStatus} autoRefresh={app.autoRefresh} autoRefreshMinutes={app.autoRefreshMinutes} debugEnabled={app.debugEnabled} busy={app.busy} onPortChange={app.setSelectedPort} onRescan={app.refreshPorts} onConnect={app.openSerial} onDisconnect={app.closeSerial} onRefresh={app.refreshAll} onAutoRefreshChange={app.setAutoRefresh} onAutoRefreshMinutesChange={app.setAutoRefreshMinutes} onDebugChange={app.setDebugEnabled} onSend={app.sendCommand} />; }
export function WeatherModuleWidget() { const app = useAppServices(); return <WeatherPanel weather={app.weather} loading={app.weatherLoading} onRefresh={app.refreshWeather} />; }
export function SensorsModuleWidget() { const app = useAppServices(); return <MeshSensorsWidget state={app.legacyState} onSend={app.sendCommand} />; }
export function LightingModuleWidget() { const app = useAppServices(); return <LightingWidget state={app.legacyState} onSend={app.sendCommand} />; }
export function ClimateModuleWidget() { const app = useAppServices(); return <ClimateWidget state={app.legacyState} onSend={app.sendCommand} />; }
export function ConsoleModuleWidget() { const app = useAppServices(); return <ConsoleWidget consoleEntries={app.entries} />; }
