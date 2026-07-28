import {
  Activity, AirVent, BedDouble, ChevronDown, ChevronUp, CookingPot, Droplets, Fan,
  GitBranch, Heater, Lamp, Lightbulb, RefreshCw, RotateCw, Router, Sparkles,
  Thermometer, Waves, Zap, type LucideIcon,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import type { TranslationKey } from "../i18n/catalog";
import { LocalizedText, useLocale } from "../i18n/locale";
import { meshNodesForDomain, type MeshDomainId, type MeshNodeSnapshot } from "../lib/operationalGraph";
import type { DeviceKey, LegacyState } from "../lib/protocol";
import type { WeatherSnapshot } from "../types";
import { WeatherPanel } from "./WeatherPanel";

export interface ConsoleEntry {
  id: number;
  timestamp: number;
  direction: "rx" | "tx" | "system";
  text: string;
}

interface SharedProps { state: LegacyState; onSend: (command: string) => void; }

function DeviceAction({ label, icon: Icon, state, onClick }: { label: ReactNode; icon: LucideIcon; state: boolean | null; onClick: () => void }) {
  const stateClass = state === true ? " is-on" : state === false ? " is-off" : " is-unknown";
  return <button className={`device-action${stateClass}`} type="button" onClick={onClick}>
    <span className="device-icon"><Icon size={19} /></span><span>{label}</span>
    <span className="device-state">{state === null ? "?" : state ? "ON" : "OFF"}</span>
  </button>;
}

function SensorMetric({ label, titleLabel, value, updatedAt, unit, icon: Icon, command, onSend }: { label: ReactNode; titleLabel: string; value: number | null; updatedAt?: number; unit: string; icon: LucideIcon; command: string; onSend: (command: string) => void }) {
  const { text } = useLocale();
  return <div className={`sensor-metric${value === null ? " is-waiting" : " has-reading"}`}><Icon size={17} /><span className="sensor-label">{label}</span>
    <strong className="sensor-value" key={`${value ?? "waiting"}-${updatedAt ?? 0}`}>{value === null ? "--" : Number(value.toFixed(2))}<small>{unit}</small></strong>
    <button className="metric-refresh" type="button" onClick={() => onSend(command)} title={text("controls.refreshMetric", { label: titleLabel })} aria-label={text("controls.refreshMetric", { label: titleLabel })}><RefreshCw size={13} /></button>
  </div>;
}

function nodeAge(lastSeenAt: number | null): string {
  if (lastSeenAt === null) return "--";
  const seconds = Math.max(0, Math.round((Date.now() - lastSeenAt) / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

function GraphNodeCard({ node, index }: { node: MeshNodeSnapshot; index: number }) {
  const { text } = useLocale();
  const role = text(node.definition.roleKey as TranslationKey);
  const runtimeState = text(`controls.nodeState.${node.state}` as TranslationKey);
  return <article className={`mesh-graph-node state-${node.state}`} style={{ "--node-index": index } as CSSProperties} aria-label={`${node.definition.tag}: ${runtimeState}`} title={`${node.definition.tag}: ${runtimeState}`}>
    <span className="mesh-node-route" aria-hidden="true" />
    <header><span className="mesh-node-state" /><strong>{node.definition.tag}</strong></header>
    <p title={role}>{role}</p>
    <footer>
      <span>{text("controls.nodeSignals", { known: node.knownSignals, total: node.totalSignals })}</span>
      <span>{node.error ?? nodeAge(node.lastSeenAt)}</span>
    </footer>
  </article>;
}

function OperationalDomainGraph({ domain, state }: { domain: MeshDomainId; state: LegacyState }) {
  const { text } = useLocale();
  const nodes = meshNodesForDomain(domain, state);
  const domainTitle = text(domain === "lighting" ? "controls.lighting" : "controls.climate");
  return <section className={`operational-graph graph-${domain}`} aria-label={text("controls.nodeGraph", { domain: domainTitle })}>
    <div className={`mesh-graph-root${state.online ? " is-online" : ""}`}>
      <Router size={17} /><span><strong>node0</strong><small>{text(state.online ? "controls.nodeState.observed" : "controls.nodeState.waiting")}</small></span>
    </div>
    <span className="mesh-graph-trunk" aria-hidden="true" />
    <div className="mesh-domain-core"><GitBranch size={17} /><span><strong>{domainTitle}</strong><small>{text("controls.graphAbstraction")}</small></span></div>
    <div className="mesh-graph-node-list">{nodes.map((node, index) => <GraphNodeCard node={node} index={index} key={node.definition.id} />)}</div>
  </section>;
}

function DomainGraphControl({ domain, state, open, onToggle }: { domain: MeshDomainId; state: LegacyState; open: boolean; onToggle: () => void }) {
  const { text } = useLocale();
  const count = meshNodesForDomain(domain, state).length;
  return <div className="domain-graph-control">
    <span><GitBranch size={14} />{text("controls.graphBacked")}</span>
    <button className={`domain-graph-toggle${open ? " is-active" : ""}`} type="button" onClick={onToggle} aria-expanded={open}>
      {text(open ? "controls.hideNodes" : "controls.showNodes", { count })}
      {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
    </button>
  </div>;
}

const redModes = ["Rainbow", "Rainbow G", "BPM", "Red", "Juggle", "Sinelon", "Confetti", "Green", "Rasta", "White"];
const percentOptions = Array.from({ length: 11 }, (_, index) => `${index * 10}%`);
const turboModes = ["OFF", "L", "M", "H"];

export function MeshSensorsWidget({ state, onSend }: SharedProps) {
  const { text } = useLocale();
  return <section className="sensor-strip widget-flat" aria-label={text("controls.sensors")}>
    <SensorMetric label="CO2" titleLabel="CO2" value={state.sensors.ppm} updatedAt={state.sensorUpdatedAt.ppm} unit=" ppm" icon={Activity} command="ppm_echo" onSend={onSend} />
    <SensorMetric label={<LocalizedText textKey="controls.temperature" />} titleLabel={text("controls.temperature")} value={state.sensors.temperatureC} updatedAt={state.sensorUpdatedAt.temperatureC} unit=" C" icon={Thermometer} command="temp_echo" onSend={onSend} />
    <SensorMetric label={<LocalizedText textKey="weather.humidity" />} titleLabel={text("weather.humidity")} value={state.sensors.humidityPercent} updatedAt={state.sensorUpdatedAt.humidityPercent} unit="%" icon={Droplets} command="humi_echo" onSend={onSend} />
    <SensorMetric label={<LocalizedText textKey="controls.illuminance" />} titleLabel={text("controls.illuminance")} value={state.sensors.lux} updatedAt={state.sensorUpdatedAt.lux} unit=" lx" icon={Lightbulb} command="lux_echo" onSend={onSend} />
    <SensorMetric label="PM1" titleLabel="PM1" value={state.sensors.pm1} updatedAt={state.sensorUpdatedAt.pm1} unit=" ug/m3" icon={AirVent} command="pm1" onSend={onSend} />
    <SensorMetric label="PM2.5" titleLabel="PM2.5" value={state.sensors.pm25} updatedAt={state.sensorUpdatedAt.pm25} unit=" ug/m3" icon={AirVent} command="pm1" onSend={onSend} />
    <SensorMetric label="PM10" titleLabel="PM10" value={state.sensors.pm10} updatedAt={state.sensorUpdatedAt.pm10} unit=" ug/m3" icon={AirVent} command="pm1" onSend={onSend} />
  </section>;
}

export function LightingWidget({ state, onSend }: SharedProps) {
  const [speed, setSpeed] = useState("");
  const [nodesOpen, setNodesOpen] = useState(false);
  const device = (key: DeviceKey) => state.devices[key];
  const submitSpeed = () => { const value = speed.trim(); if (value) { onSend(`05${value}`); setSpeed(""); } };
  return <div className="widget-section-body">
    <DomainGraphControl domain="lighting" state={state} open={nodesOpen} onToggle={() => setNodesOpen((value) => !value)} />
    {nodesOpen && <OperationalDomainGraph domain="lighting" state={state} />}
    <div className="device-grid">
      <DeviceAction label={<LocalizedText textKey="controls.garland" />} icon={Sparkles} state={device("garland")} onClick={() => onSend("garland")} />
      <DeviceAction label={<LocalizedText textKey="controls.redLed" />} icon={Zap} state={device("redLed")} onClick={() => onSend("power")} />
      <DeviceAction label={<LocalizedText textKey="controls.bedside" />} icon={BedDouble} state={device("bedside")} onClick={() => onSend("bedside")} />
      <DeviceAction label={<LocalizedText textKey="controls.lamp" />} icon={Lamp} state={device("lamp")} onClick={() => onSend("lam")} />
      <DeviceAction label={<LocalizedText textKey="controls.powerLed" />} icon={Lightbulb} state={device("powerLed")} onClick={() => onSend("powled")} />
    </div>
    <div className="control-row three-column-row">
      <label><LocalizedText textKey="controls.mode" /><select value={state.controls.redMode} onChange={(event) => onSend(`01_mode_${event.target.value}`)}>{redModes.map((mode, index) => <option key={mode} value={index}>{mode}</option>)}</select></label>
      <label><LocalizedText textKey="controls.brightness" /><select value={state.controls.redBrightness} onChange={(event) => onSend(`02_bri_${Number(event.target.value) <= 9 ? event.target.value : "M"}`)}>{percentOptions.map((option, index) => <option key={option} value={index}>{option}</option>)}</select></label>
      <label><LocalizedText textKey="controls.speed" /><span className="step-control"><button type="button" onClick={() => onSend("redl_sp-")}>-</button><input value={speed} onChange={(event) => setSpeed(event.target.value)} onKeyDown={(event) => event.key === "Enter" && submitSpeed()} placeholder={state.sensors.speed?.toString() ?? "--"} /><button type="button" onClick={() => onSend("redl_sp+")}>+</button></span></label>
    </div>
  </div>;
}

export function ClimateWidget({ state, onSend }: SharedProps) {
  const { text } = useLocale();
  const [heaterTarget, setHeaterTarget] = useState(state.controls.heaterTargetC);
  const [nodesOpen, setNodesOpen] = useState(false);
  useEffect(() => setHeaterTarget(state.controls.heaterTargetC), [state.controls.heaterTargetC]);
  const device = (key: DeviceKey) => state.devices[key];
  const colors = [text("controls.black"), text("controls.red"), text("controls.green"), text("controls.white")];
  const modes = ["OFF", text("controls.fan"), text("controls.low"), text("controls.high"), text("controls.max"), "AUTO"];
  return <div className="widget-section-body">
    <DomainGraphControl domain="climate" state={state} open={nodesOpen} onToggle={() => setNodesOpen((value) => !value)} />
    {nodesOpen && <OperationalDomainGraph domain="climate" state={state} />}
    <div className="device-grid climate-devices">
      <DeviceAction label={<LocalizedText textKey="controls.humidifier" />} icon={Droplets} state={device("humidifier")} onClick={() => onSend("huOn")} />
      <DeviceAction label={<LocalizedText textKey="controls.pump" />} icon={Waves} state={device("pump")} onClick={() => onSend("pomp")} />
      <DeviceAction label={<LocalizedText textKey="controls.flow" />} icon={Activity} state={device("flow")} onClick={() => onSend("flow")} />
      <DeviceAction label={<LocalizedText textKey="controls.ionizer" />} icon={Zap} state={device("ionizer")} onClick={() => onSend("ion")} />
      <DeviceAction label={<LocalizedText textKey="controls.rotation" />} icon={RotateCw} state={device("heaterRotation")} onClick={() => onSend("hero")} />
      <DeviceAction label={<LocalizedText textKey="controls.eggCooker" />} icon={CookingPot} state={device("eggCooker")} onClick={() => onSend("jajo")} />
    </div>
    <div className="control-row three-column-row">
      <label><LocalizedText textKey="controls.turbo" /><select value={state.controls.turboMode} onChange={(event) => onSend(`14${event.target.value}`)}>{turboModes.map((mode, index) => <option key={mode} value={index}>{mode}</option>)}</select></label>
      <label><LocalizedText textKey="controls.water" /><select value={state.controls.humidifierWaterLevel} onChange={(event) => onSend(`19${Number(event.target.value) <= 9 ? event.target.value : "M"}`)}>{percentOptions.map((option, index) => <option key={option} value={index}>{option}</option>)}</select></label>
      <label><LocalizedText textKey="controls.color" /><select value={state.controls.humidifierColor} onChange={(event) => onSend(`18${event.target.value}`)}>{colors.map((color, index) => <option key={color} value={index}>{color}</option>)}</select></label>
    </div>
    <div className="heater-row"><span className="heater-label"><Heater size={17} /><LocalizedText textKey="controls.heater" /></span><span className="mode-readout">{modes[state.controls.heaterMode] ?? text("common.unknown")}</span><label><LocalizedText textKey="controls.target" /><input type="number" min="0" max="45" step="0.1" value={heaterTarget} onChange={(event) => setHeaterTarget(Number(event.target.value))} onBlur={() => onSend(`W5${heaterTarget.toFixed(2)}`)} onKeyDown={(event) => event.key === "Enter" && onSend(`W5${heaterTarget.toFixed(2)}`)} /></label></div>
  </div>;
}

export function ConsoleWidget({ consoleEntries }: { consoleEntries: ConsoleEntry[] }) {
  return <div className="console-list widget-console" role="log" aria-live="polite">
    {consoleEntries.slice(-120).map((entry) => <div className={`console-line line-${entry.direction}`} key={entry.id}><time>{new Date(entry.timestamp).toLocaleTimeString([], { hour12: false })}</time><span>{entry.direction.toUpperCase()}</span><code>{entry.text}</code></div>)}
    {consoleEntries.length === 0 && <div className="console-empty"><Fan size={18} /><LocalizedText textKey="controls.noTraffic" /></div>}
  </div>;
}

interface ControlsViewProps extends SharedProps { weather: WeatherSnapshot | null; weatherLoading: boolean; consoleEntries: ConsoleEntry[]; onWeatherRefresh: () => void; }

export function ControlsView({ state, weather, weatherLoading, consoleEntries, onWeatherRefresh, onSend }: ControlsViewProps) {
  return <div className="view-stack view-enter"><WeatherPanel weather={weather} loading={weatherLoading} onRefresh={onWeatherRefresh} /><MeshSensorsWidget state={state} onSend={onSend} /><div className="control-grid"><section className="control-panel lighting-panel"><LightingWidget state={state} onSend={onSend} /></section><section className="control-panel climate-panel"><ClimateWidget state={state} onSend={onSend} /></section><section className="control-panel console-panel"><ConsoleWidget consoleEntries={consoleEntries} /></section></div></div>;
}
