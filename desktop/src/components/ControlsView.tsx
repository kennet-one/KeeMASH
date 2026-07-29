import {
  Activity, AirVent, BedDouble, ChevronDown, ChevronUp, CookingPot, Droplets, Fan,
  GitBranch, Heater, Lamp, Lightbulb, RefreshCw, RotateCw, Router, Sparkles,
  Thermometer, Waves, Zap, type LucideIcon,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../core/workspace";
import type { TranslationKey } from "../i18n/catalog";
import { LocalizedText, useLocale } from "../i18n/locale";
import { feedbackClass, type CommandFeedback } from "../lib/commandFeedback";
import { graphEdgePath, meshEdgesForDomain, meshNodesForDomain, type MeshDomainId, type MeshNodeId, type MeshNodeSnapshot } from "../lib/operationalGraph";
import type { DeviceKey, LegacyState } from "../lib/protocol";
import type { WeatherSnapshot } from "../types";
import { WeatherPanel } from "./WeatherPanel";

export interface ConsoleEntry {
  id: number;
  timestamp: number;
  direction: "rx" | "tx" | "system";
  text: string;
}

interface SharedProps {
  state: LegacyState;
  feedback: Record<string, CommandFeedback>;
  onSend: (command: string) => void;
}

function DeviceAction({ label, icon: Icon, state, feedback, onClick }: { label: ReactNode; icon: LucideIcon; state: boolean | null; feedback?: CommandFeedback; onClick: () => void }) {
  const stateClass = state === true ? " is-on" : state === false ? " is-off" : " is-unknown";
  return <button className={`device-action${stateClass}${feedbackClass(feedback)}`} type="button" onClick={onClick} aria-busy={feedback?.phase === "sending" || feedback?.phase === "awaiting"}>
    <span className="device-icon"><Icon size={19} /></span><span>{label}</span>
    <span className="device-state">{state === null ? "?" : state ? "ON" : "OFF"}</span>
  </button>;
}

function SensorMetric({ label, titleLabel, value, updatedAt, unit, icon: Icon, command, feedback, motion, onSend }: { label: ReactNode; titleLabel: string; value: number | null; updatedAt?: number; unit: string; icon: LucideIcon; command: string; feedback?: CommandFeedback; motion: string; onSend: (command: string) => void }) {
  const { text } = useLocale();
  return <div className={`sensor-metric sensor-motion-${motion}${value === null ? " is-waiting" : " has-reading"}${feedbackClass(feedback)}`}><Icon size={17} /><span className="sensor-label">{label}</span>
    <strong className="sensor-value" key={`${value ?? "waiting"}-${updatedAt ?? 0}`}>{value === null ? "--" : Number(value.toFixed(2))}<small>{unit}</small></strong>
    <button className="metric-refresh" type="button" onClick={() => onSend(command)} title={text("controls.refreshMetric", { label: titleLabel })} aria-label={text("controls.refreshMetric", { label: titleLabel })}><RefreshCw size={13} /></button>
  </div>;
}

function nodeAge(lastSeenAt: number | null): string {
  if (lastSeenAt === null) return "--";
  const seconds = Math.max(0, Math.round((Date.now() - lastSeenAt) / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

function GraphNodeCard({ node, index, feedback, nodeRef }: { node: MeshNodeSnapshot; index: number; feedback?: CommandFeedback; nodeRef: (element: HTMLElement | null) => void }) {
  const { text } = useLocale();
  const role = text(node.definition.roleKey as TranslationKey);
  const runtimeState = text(`controls.nodeState.${node.state}` as TranslationKey);
  return <article className={`mesh-graph-node state-${node.state}${feedbackClass(feedback)}`} ref={nodeRef} style={{ "--node-index": index } as CSSProperties} aria-label={`${node.definition.tag}: ${runtimeState}`} title={`${node.definition.tag}: ${runtimeState}`}>
    <header><span className="mesh-node-state" /><strong>{node.definition.tag}</strong></header>
    <p title={role}>{role}</p>
    <footer>
      <span>{text("controls.nodeSignals", { known: node.knownSignals, total: node.totalSignals })}</span>
      <span>{node.error ?? nodeAge(node.lastSeenAt)}</span>
    </footer>
  </article>;
}

interface RenderedGraphEdge {
  key: string;
  path: string;
  className: string;
}

function newestFeedbackForNode(feedback: Record<string, CommandFeedback>, node: MeshNodeId): CommandFeedback | undefined {
  return Object.values(feedback)
    .filter((item) => item.owner === node)
    .sort((left, right) => right.startedAt - left.startedAt)[0];
}

function OperationalDomainGraph({ domain, state, feedback }: { domain: MeshDomainId; state: LegacyState; feedback: Record<string, CommandFeedback> }) {
  const { text } = useLocale();
  const nodes = useMemo(() => meshNodesForDomain(domain, state), [domain, state]);
  const edges = useMemo(() => meshEdgesForDomain(domain), [domain]);
  const containerRef = useRef<HTMLElement>(null);
  const elementRefs = useRef(new Map<string, HTMLElement>());
  const [renderedEdges, setRenderedEdges] = useState<RenderedGraphEdge[]>([]);
  const domainTitle = text(domain === "lighting" ? "controls.lighting" : "controls.climate");
  const registerElement = useCallback((id: string) => (element: HTMLElement | null) => {
    if (element) elementRefs.current.set(id, element);
    else elementRefs.current.delete(id);
  }, []);
  const measureEdges = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const next = edges.flatMap((edge): RenderedGraphEdge[] => {
      const from = elementRefs.current.get(edge.from);
      const to = elementRefs.current.get(edge.to);
      if (!from || !to) return [];
      const fromRect = from.getBoundingClientRect();
      const toRect = to.getBoundingClientRect();
      const horizontal = edge.kind === "routes";
      const start = horizontal
        ? { x: fromRect.right - containerRect.left, y: fromRect.top + fromRect.height / 2 - containerRect.top }
        : { x: fromRect.left + fromRect.width / 2 - containerRect.left, y: fromRect.bottom - containerRect.top };
      const end = horizontal
        ? { x: toRect.left - containerRect.left, y: toRect.top + toRect.height / 2 - containerRect.top }
        : { x: toRect.left + toRect.width / 2 - containerRect.left, y: toRect.top - containerRect.top };
      const node = nodes.find((item) => item.definition.id === edge.to);
      const edgeFeedback = edge.kind === "routes"
        ? Object.values(feedback).filter((item) => nodes.some((candidate) => candidate.definition.id === item.owner)).sort((left, right) => right.startedAt - left.startedAt)[0]
        : newestFeedbackForNode(feedback, edge.to as MeshNodeId);
      return [{
        key: `${edge.from}-${edge.to}`,
        path: graphEdgePath(start, end),
        className: `mesh-graph-edge edge-${edge.kind}${node ? ` state-${node.state}` : ""}${feedbackClass(edgeFeedback)}`,
      }];
    });
    setRenderedEdges(next);
  }, [edges, feedback, nodes]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(measureEdges);
    if (containerRef.current) observer.observe(containerRef.current);
    for (const element of elementRefs.current.values()) observer.observe(element);
    const frame = window.requestAnimationFrame(measureEdges);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [measureEdges, nodes.length]);
  return <section className={`operational-graph graph-${domain}`} ref={containerRef} aria-label={text("controls.nodeGraph", { domain: domainTitle })}>
    <svg className="mesh-graph-edges" aria-hidden="true">
      {renderedEdges.map((edge) => <path className={edge.className} d={edge.path} key={edge.key} />)}
    </svg>
    <div className={`mesh-graph-root${state.online ? " is-online" : ""}`} ref={registerElement("node0")}>
      <Router size={17} /><span><strong>node0</strong><small>{text(state.online ? "controls.nodeState.observed" : "controls.nodeState.waiting")}</small></span>
    </div>
    <div className="mesh-domain-core" ref={registerElement(domain)}><GitBranch size={17} /><span><strong>{domainTitle}</strong><small>{text("controls.graphAbstraction")}</small></span></div>
    <div className="mesh-graph-node-list">{nodes.map((node, index) => <GraphNodeCard node={node} index={index} feedback={newestFeedbackForNode(feedback, node.definition.id)} nodeRef={registerElement(node.definition.id)} key={node.definition.id} />)}</div>
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

export function MeshSensorsWidget({ state, feedback, onSend }: SharedProps) {
  const { text } = useLocale();
  return <section className="sensor-strip widget-flat" aria-label={text("controls.sensors")}>
    <SensorMetric label="CO2" titleLabel="CO2" value={state.sensors.ppm} updatedAt={state.sensorUpdatedAt.ppm} unit=" ppm" icon={Activity} command="ppm_echo" feedback={feedback["sensor.ppm"]} motion="co2" onSend={onSend} />
    <SensorMetric label={<LocalizedText textKey="controls.temperature" />} titleLabel={text("controls.temperature")} value={state.sensors.temperatureC} updatedAt={state.sensorUpdatedAt.temperatureC} unit=" C" icon={Thermometer} command="temp_echo" feedback={feedback["sensor.temperatureC"]} motion="temperature" onSend={onSend} />
    <SensorMetric label={<LocalizedText textKey="weather.humidity" />} titleLabel={text("weather.humidity")} value={state.sensors.humidityPercent} updatedAt={state.sensorUpdatedAt.humidityPercent} unit="%" icon={Droplets} command="humi_echo" feedback={feedback["sensor.humidityPercent"]} motion="humidity" onSend={onSend} />
    <SensorMetric label={<LocalizedText textKey="controls.illuminance" />} titleLabel={text("controls.illuminance")} value={state.sensors.lux} updatedAt={state.sensorUpdatedAt.lux} unit=" lx" icon={Lightbulb} command="lux_echo" feedback={feedback["sensor.lux"]} motion="light" onSend={onSend} />
    <SensorMetric label="PM1" titleLabel="PM1" value={state.sensors.pm1} updatedAt={state.sensorUpdatedAt.pm1} unit=" ug/m3" icon={AirVent} command="pm1" feedback={feedback["sensor.particulate"]} motion="particles" onSend={onSend} />
    <SensorMetric label="PM2.5" titleLabel="PM2.5" value={state.sensors.pm25} updatedAt={state.sensorUpdatedAt.pm25} unit=" ug/m3" icon={AirVent} command="pm1" feedback={feedback["sensor.particulate"]} motion="particles" onSend={onSend} />
    <SensorMetric label="PM10" titleLabel="PM10" value={state.sensors.pm10} updatedAt={state.sensorUpdatedAt.pm10} unit=" ug/m3" icon={AirVent} command="pm1" feedback={feedback["sensor.particulate"]} motion="particles" onSend={onSend} />
  </section>;
}

export function LightingWidget({ state, feedback, onSend }: SharedProps) {
  const [nodesOpen, setNodesOpen] = useState(false);
  const device = (key: DeviceKey) => state.devices[key];
  return <div className="widget-section-body">
    <DomainGraphControl domain="lighting" state={state} open={nodesOpen} onToggle={() => setNodesOpen((value) => !value)} />
    {nodesOpen && <OperationalDomainGraph domain="lighting" state={state} feedback={feedback} />}
    <div className="device-grid">
      <DeviceAction label={<LocalizedText textKey="controls.garland" />} icon={Sparkles} state={device("garland")} feedback={feedback["device.garland"]} onClick={() => onSend("garland")} />
      <DeviceAction label={<LocalizedText textKey="controls.redLed" />} icon={Zap} state={device("redLed")} feedback={feedback["device.redLed"]} onClick={() => onSend("power")} />
      <DeviceAction label={<LocalizedText textKey="controls.bedside" />} icon={BedDouble} state={device("bedside")} feedback={feedback["device.bedside"]} onClick={() => onSend("bedside")} />
      <DeviceAction label={<LocalizedText textKey="controls.lamp" />} icon={Lamp} state={device("lamp")} feedback={feedback["device.lamp"]} onClick={() => onSend("lam")} />
      <DeviceAction label={<LocalizedText textKey="controls.powerLed" />} icon={Lightbulb} state={device("powerLed")} feedback={feedback["device.powerLed"]} onClick={() => onSend("powled")} />
    </div>
    <div className="control-row three-column-row">
      <label className={`control-feedback${feedbackClass(feedback["control.redMode"])}`}><LocalizedText textKey="controls.mode" /><select value={state.controls.redMode} onChange={(event) => onSend(`01_mode_${event.target.value}`)}>{redModes.map((mode, index) => <option key={mode} value={index}>{mode}</option>)}</select></label>
      <label className={`control-feedback${feedbackClass(feedback["control.redBrightness"])}`}><LocalizedText textKey="controls.brightness" /><select value={state.controls.redBrightness} onChange={(event) => onSend(`02_bri_${Number(event.target.value) <= 9 ? event.target.value : "M"}`)}>{percentOptions.map((option, index) => <option key={option} value={index}>{option}</option>)}</select></label>
      <label className={`control-feedback${feedbackClass(feedback["control.redSpeed"])}`}><LocalizedText textKey="controls.speed" /><span className="step-control"><button type="button" onClick={() => onSend("redl_sp-")}>-</button><input readOnly value={state.sensors.speed?.toString() ?? ""} placeholder="--" /><button type="button" onClick={() => onSend("redl_sp+")}>+</button></span></label>
    </div>
  </div>;
}

export function ClimateWidget({ state, feedback, onSend }: SharedProps) {
  const { text } = useLocale();
  const [heaterTarget, setHeaterTarget] = useState(state.controls.heaterTargetC);
  const [nodesOpen, setNodesOpen] = useState(false);
  useEffect(() => setHeaterTarget(state.controls.heaterTargetC), [state.controls.heaterTargetC]);
  const device = (key: DeviceKey) => state.devices[key];
  const colors = [text("controls.black"), text("controls.red"), text("controls.green"), text("controls.white")];
  const modes = ["OFF", text("controls.fan"), text("controls.low"), text("controls.high"), text("controls.max"), "AUTO"];
  const modeCommands = ["he4", "he0", "he1", "he2", "he3", "he5"];
  const heaterStatus = state.controls.heaterStatus;
  const stopReason = heaterStatus.stopReason
    ? text(`controls.heaterStop.${heaterStatus.stopReason}` as TranslationKey)
    : text("common.waiting");
  const commitHeaterTarget = () => {
    if (!Number.isFinite(heaterTarget)) {
      setHeaterTarget(state.controls.heaterTargetC);
      return;
    }
    const target = Math.min(35, Math.max(5, heaterTarget));
    setHeaterTarget(target);
    onSend(`W5${target.toFixed(1)}`);
  };
  return <div className="widget-section-body">
    <DomainGraphControl domain="climate" state={state} open={nodesOpen} onToggle={() => setNodesOpen((value) => !value)} />
    {nodesOpen && <OperationalDomainGraph domain="climate" state={state} feedback={feedback} />}
    <div className="device-grid climate-devices">
      <DeviceAction label={<LocalizedText textKey="controls.humidifier" />} icon={Droplets} state={device("humidifier")} feedback={feedback["device.humidifier"]} onClick={() => onSend("huOn")} />
      <DeviceAction label={<LocalizedText textKey="controls.pump" />} icon={Waves} state={device("pump")} feedback={feedback["device.pump"]} onClick={() => onSend("pomp")} />
      <DeviceAction label={<LocalizedText textKey="controls.flow" />} icon={Activity} state={device("flow")} feedback={feedback["device.flow"]} onClick={() => onSend("flow")} />
      <DeviceAction label={<LocalizedText textKey="controls.ionizer" />} icon={Zap} state={device("ionizer")} feedback={feedback["device.ionizer"]} onClick={() => onSend("ion")} />
      <DeviceAction label={<LocalizedText textKey="controls.rotation" />} icon={RotateCw} state={device("heaterRotation")} feedback={feedback["device.heaterRotation"]} onClick={() => onSend("hero")} />
      <DeviceAction label={<LocalizedText textKey="controls.eggCooker" />} icon={CookingPot} state={device("eggCooker")} feedback={feedback["device.eggCooker"]} onClick={() => onSend("jajo")} />
    </div>
    <div className="control-row three-column-row">
      <label className={`control-feedback${feedbackClass(feedback["control.turboMode"])}`}><LocalizedText textKey="controls.turbo" /><select value={state.controls.turboMode} onChange={(event) => onSend(`14${event.target.value}`)}>{turboModes.map((mode, index) => <option key={mode} value={index}>{mode}</option>)}</select></label>
      <label className={`control-feedback${feedbackClass(feedback["control.humidifierWaterLevel"])}`}><LocalizedText textKey="controls.water" /><select value={state.controls.humidifierWaterLevel} onChange={(event) => onSend(`19${Number(event.target.value) <= 9 ? event.target.value : "M"}`)}>{percentOptions.map((option, index) => <option key={option} value={index}>{option}</option>)}</select></label>
      <label className={`control-feedback${feedbackClass(feedback["control.humidifierColor"])}`}><LocalizedText textKey="controls.color" /><select value={state.controls.humidifierColor} onChange={(event) => onSend(`18${event.target.value}`)}>{colors.map((color, index) => <option key={color} value={index}>{color}</option>)}</select></label>
    </div>
    <div className="heater-row"><span className="heater-label"><Heater size={17} /><LocalizedText textKey="controls.heater" /></span><label className={`control-feedback${feedbackClass(feedback["control.heaterMode"])}`}><LocalizedText textKey="controls.mode" /><select value={state.controls.heaterMode} onChange={(event) => { const command = modeCommands[Number(event.target.value)]; if (command) onSend(command); }}>{modes.map((mode, index) => <option key={mode} value={index}>{mode}</option>)}</select></label><label className={`control-feedback${feedbackClass(feedback["control.heaterTarget"])}`}><LocalizedText textKey="controls.target" /><input type="number" min="5" max="35" step="0.1" value={heaterTarget} onChange={(event) => setHeaterTarget(Number(event.target.value))} onBlur={commitHeaterTarget} onKeyDown={(event) => event.key === "Enter" && commitHeaterTarget()} /></label></div>
    <div className={`heater-status-strip${heaterStatus.cooldownActive ? " is-cooldown" : ""}`}>
      <span className={`heater-state-chip${heaterStatus.autoEnabled ? " is-active" : ""}`}>AUTO</span>
      <span className={`heater-state-chip${heaterStatus.fanOn ? " is-active" : ""}`}>FAN</span>
      <span className={`heater-state-chip${heaterStatus.lowHeatOn ? " is-active is-heat" : ""}`}>LOW</span>
      <span className={`heater-state-chip${heaterStatus.highHeatOn ? " is-active is-heat" : ""}`}>HIGH</span>
      <span className={`heater-state-chip${heaterStatus.rotationOn ? " is-active" : ""}`}>ROT</span>
      <span className={`heater-temperature${heaterStatus.temperatureValid === false ? " is-stale" : ""}`}><LocalizedText textKey="controls.heaterInput" /> <strong>{heaterStatus.acceptedTemperatureC === null ? "--" : `${heaterStatus.acceptedTemperatureC.toFixed(1)} C`}</strong></span>
      <span className="heater-stop-reason">{heaterStatus.cooldownActive && <LocalizedText textKey="controls.cooldown" />}<strong>{stopReason}</strong></span>
    </div>
  </div>;
}

export function ConsoleWidget({ consoleEntries }: { consoleEntries: ConsoleEntry[] }) {
  const { profile } = useWorkspace();
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!profile.consoleAutoScroll || !listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [consoleEntries.length, profile.consoleAutoScroll]);
  return <div className="console-list widget-console" ref={listRef} role="log" aria-live="polite" tabIndex={0}>
    {consoleEntries.slice(-120).map((entry) => <div className={`console-line line-${entry.direction}`} key={entry.id}><time>{new Date(entry.timestamp).toLocaleTimeString([], { hour12: false })}</time><span>{entry.direction.toUpperCase()}</span><code>{entry.text}</code></div>)}
    {consoleEntries.length === 0 && <div className="console-empty"><Fan size={18} /><LocalizedText textKey="controls.noTraffic" /></div>}
  </div>;
}

interface ControlsViewProps extends SharedProps { weather: WeatherSnapshot | null; weatherLoading: boolean; consoleEntries: ConsoleEntry[]; onWeatherRefresh: () => void; }

export function ControlsView({ state, feedback, weather, weatherLoading, consoleEntries, onWeatherRefresh, onSend }: ControlsViewProps) {
  return <div className="view-stack view-enter"><WeatherPanel weather={weather} loading={weatherLoading} onRefresh={onWeatherRefresh} /><MeshSensorsWidget state={state} feedback={feedback} onSend={onSend} /><div className="control-grid"><section className="control-panel lighting-panel"><LightingWidget state={state} feedback={feedback} onSend={onSend} /></section><section className="control-panel climate-panel"><ClimateWidget state={state} feedback={feedback} onSend={onSend} /></section><section className="control-panel console-panel"><ConsoleWidget consoleEntries={consoleEntries} /></section></div></div>;
}
