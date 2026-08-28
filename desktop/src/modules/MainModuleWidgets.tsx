import { ConnectionBar } from "../components/ConnectionBar";
import {
  BedsideNodeWidget, ChoinkaNodeWidget, ClimateWidget, ConsoleWidget, EggCookerNodeWidget,
  EspMixerNodeWidget, GarlandNodeWidget, HeaterNodeWidget, HumidifierNodeWidget, LampNodeWidget,
  LightingWidget, MeshSensorsWidget, PowerLedNodeWidget,
} from "../components/ControlsView";
import { WeatherPanel } from "../components/WeatherPanel";
import { useAppServices } from "../core/appServices";

export function ConnectionModuleWidget() { const app = useAppServices(); return <ConnectionBar status={app.meshStatus} busy={app.busy} autoRefresh={app.autoRefresh} autoRefreshMinutes={app.autoRefreshMinutes} debugEnabled={app.debugEnabled} onPair={app.pairRoot} onRevoke={app.revokeRoot} onRefresh={app.refreshAll} onAutoRefreshChange={app.setAutoRefresh} onAutoRefreshMinutesChange={app.setAutoRefreshMinutes} onDebugChange={app.setDebugEnabled} onSend={app.sendCommand} />; }
export function WeatherModuleWidget() { const app = useAppServices(); return <WeatherPanel weather={app.weather} loading={app.weatherLoading} onRefresh={app.refreshWeather} />; }
export function SensorsModuleWidget() { const app = useAppServices(); return <MeshSensorsWidget state={app.legacyState} feedback={app.commandFeedback} onSend={app.sendCommand} />; }
export function LightingModuleWidget() { const app = useAppServices(); return <LightingWidget state={app.legacyState} feedback={app.commandFeedback} onSend={app.sendCommand} />; }
export function ClimateModuleWidget() { const app = useAppServices(); return <ClimateWidget state={app.legacyState} feedback={app.commandFeedback} onSend={app.sendCommand} />; }
export function EspMixerModuleWidget() { const app = useAppServices(); return <EspMixerNodeWidget state={app.legacyState} feedback={app.commandFeedback} onSend={app.sendCommand} />; }
export function HumidifierModuleWidget() { const app = useAppServices(); return <HumidifierNodeWidget state={app.legacyState} feedback={app.commandFeedback} onSend={app.sendCommand} />; }
export function PowerLedModuleWidget() { const app = useAppServices(); return <PowerLedNodeWidget state={app.legacyState} feedback={app.commandFeedback} onSend={app.sendCommand} />; }
export function HeaterModuleWidget() { const app = useAppServices(); return <HeaterNodeWidget state={app.legacyState} feedback={app.commandFeedback} onSend={app.sendCommand} />; }
export function GarlandModuleWidget() { const app = useAppServices(); return <GarlandNodeWidget state={app.legacyState} feedback={app.commandFeedback} onSend={app.sendCommand} />; }
export function BedsideModuleWidget() { const app = useAppServices(); return <BedsideNodeWidget state={app.legacyState} feedback={app.commandFeedback} onSend={app.sendCommand} />; }
export function LampModuleWidget() { const app = useAppServices(); return <LampNodeWidget state={app.legacyState} feedback={app.commandFeedback} onSend={app.sendCommand} />; }
export function EggCookerModuleWidget() { const app = useAppServices(); return <EggCookerNodeWidget state={app.legacyState} feedback={app.commandFeedback} onSend={app.sendCommand} />; }
export function ChoinkaModuleWidget() { const app = useAppServices(); return <ChoinkaNodeWidget state={app.legacyState} feedback={app.commandFeedback} onSend={app.sendCommand} />; }
export function ConsoleModuleWidget() { const app = useAppServices(); return <ConsoleWidget consoleEntries={app.entries} />; }
