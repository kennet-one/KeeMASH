import {
  Activity, AirVent, BedDouble, CalendarClock, ChevronDown, ChevronUp, Clock3, CookingPot, Droplets, Fan,
  Flame, GitBranch, Heater, Lamp, Lightbulb, Plus, Power, RefreshCw, RotateCw, Router, Save,
  SlidersHorizontal, Sparkles, Thermometer, Trash2, Waves, Zap, type LucideIcon,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../core/workspace";
import type { TranslationKey } from "../i18n/catalog";
import { LocalizedText, useLocale } from "../i18n/locale";
import { feedbackClass, type CommandFeedback } from "../lib/commandFeedback";
import { graphEdgePath, meshEdgesForDomain, meshNodesForDomain, type MeshDomainId, type MeshNodeId, type MeshNodeSnapshot } from "../lib/operationalGraph";
import { useAppServices } from "../core/appServices";
import type { DeviceKey, LegacyState } from "../lib/protocol";
import {
  defaultSchedulePoints, encodeScheduleTransaction, HEATER_SCHEDULE_ALL_DAYS, HEATER_SCHEDULE_MAX_POINTS,
  minuteToTime, timeToMinute, validateSchedulePoints, type HeaterScheduleAction,
  type HeaterSchedulePoint,
} from "../lib/heaterSchedule";
import {
  defaultPowerLedSchedulePoints, encodePowerLedScheduleTransaction, POWER_LED_SCHEDULE_ALL_DAYS,
  POWER_LED_SCHEDULE_MAX_POINTS, validatePowerLedSchedulePoints, type PowerLedSchedulePoint,
} from "../lib/powerLedSchedule";
import { resolveSignalBinding, signalEndpointsFor } from "../lib/signalGraph";
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
  onSend: (command: string) => Promise<boolean>;
}

function DeviceAction({ label, icon: Icon, state, feedback, onClick }: { label: ReactNode; icon: LucideIcon; state: boolean | null; feedback?: CommandFeedback; onClick: () => void }) {
  const stateClass = state === true ? " is-on" : state === false ? " is-off" : " is-unknown";
  return <button className={`device-action${stateClass}${feedbackClass(feedback)}`} type="button" onClick={onClick} aria-busy={feedback?.phase === "sending" || feedback?.phase === "awaiting"}>
    <span className="device-icon"><Icon size={19} /></span><span>{label}</span>
    <span className="device-state">{state === null ? "?" : state ? "ON" : "OFF"}</span>
  </button>;
}

function SensorMetric({ label, titleLabel, value, updatedAt, unit, icon: Icon, command, feedback, motion, onSend }: { label: ReactNode; titleLabel: string; value: number | null; updatedAt?: number; unit: string; icon: LucideIcon; command: string; feedback?: CommandFeedback; motion: string; onSend: (command: string) => Promise<boolean> }) {
  const { text } = useLocale();
  return <div className={`sensor-metric sensor-motion-${motion}${value === null ? " is-waiting" : " has-reading"}${feedbackClass(feedback)}`}>
    <span className="sensor-motion-visual" aria-hidden="true"><Icon size={17} /><i /><i /><i /></span><span className="sensor-label">{label}</span>
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
  const { meshInventory } = useAppServices();
  const nodes = useMemo(() => meshNodesForDomain(domain, state, meshInventory), [domain, meshInventory, state]);
  const edges = useMemo(() => meshEdgesForDomain(domain, meshInventory), [domain, meshInventory]);
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
    const next: RenderedGraphEdge[] = edges.filter((edge) => edge.kind === "routes").flatMap((edge): RenderedGraphEdge[] => {
      const from = elementRefs.current.get(edge.from);
      const to = elementRefs.current.get(edge.to);
      if (!from || !to) return [];
      const fromRect = from.getBoundingClientRect();
      const toRect = to.getBoundingClientRect();
      const start = { x: fromRect.right - containerRect.left, y: fromRect.top + fromRect.height / 2 - containerRect.top };
      const end = { x: toRect.left - containerRect.left, y: toRect.top + toRect.height / 2 - containerRect.top };
      const edgeFeedback = Object.values(feedback).filter((item) => nodes.some((candidate) => candidate.definition.id === item.owner)).sort((left, right) => right.startedAt - left.startedAt)[0];
      return [{
        key: `${edge.from}-${edge.to}`,
        path: graphEdgePath(start, end),
        className: `mesh-graph-edge edge-${edge.kind}${feedbackClass(edgeFeedback)}`,
      }];
    });
    const domainElement = elementRefs.current.get(domain);
    const branches = edges.filter((edge) => edge.kind === "contains").flatMap((edge) => {
      const nodeElement = elementRefs.current.get(edge.to);
      if (!nodeElement) return [];
      const rect = nodeElement.getBoundingClientRect();
      return [{ edge, x: rect.left + rect.width / 2 - containerRect.left, top: rect.top - containerRect.top }];
    });
    if (domainElement && branches.length > 0) {
      const domainRect = domainElement.getBoundingClientRect();
      const domainX = domainRect.left + domainRect.width / 2 - containerRect.left;
      const domainBottom = domainRect.bottom - containerRect.top;
      const busY = Math.min(...branches.map((branch) => branch.top)) - 12;
      const busLeft = Math.min(domainX, ...branches.map((branch) => branch.x));
      const busRight = Math.max(domainX, ...branches.map((branch) => branch.x));
      next.push({
        key: `${domain}-bus`,
        path: `M ${domainX} ${domainBottom} L ${domainX} ${busY} M ${busLeft} ${busY} L ${busRight} ${busY}`,
        className: "mesh-graph-edge edge-contains edge-bus",
      });
      for (const branch of branches) {
        const node = nodes.find((item) => item.definition.id === branch.edge.to);
        const edgeFeedback = newestFeedbackForNode(feedback, branch.edge.to as MeshNodeId);
        next.push({
          key: `${branch.edge.from}-${branch.edge.to}`,
          path: `M ${branch.x} ${busY} L ${branch.x} ${branch.top}`,
          className: `mesh-graph-edge edge-contains${node ? ` state-${node.state}` : ""}${feedbackClass(edgeFeedback)}`,
        });
      }
    }
    setRenderedEdges(next);
  }, [domain, edges, feedback, nodes]);
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
  const { meshInventory } = useAppServices();
  const count = meshNodesForDomain(domain, state, meshInventory).length;
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
const scheduleDayKeys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

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
  const { text } = useLocale();
  const [nodesOpen, setNodesOpen] = useState(false);
  const [schedulePoints, setSchedulePoints] = useState<PowerLedSchedulePoint[]>(() => defaultPowerLedSchedulePoints());
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [schedulePersistent, setSchedulePersistent] = useState(false);
  const [scheduleAdvanced, setScheduleAdvanced] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const loadedGeneration = useRef<number | null>(null);
  const requestedSchedulePoints = useRef(new Set<string>());
  useEffect(() => { void onSend("PSQ"); }, [onSend]);
  useEffect(() => {
    const remote = state.controls.powerLedSchedule;
    if (remote.generation === 0 || loadedGeneration.current === remote.generation) return;
    const missing = remote.points.map((point, index) => point ? null : index).filter((index): index is number => index !== null);
    if (missing.length) {
      for (const index of missing) {
        const key = `${remote.generation}:${index}`;
        if (requestedSchedulePoints.current.has(key)) continue;
        requestedSchedulePoints.current.add(key);
        void onSend(`PSQ${index.toString(16).toUpperCase()}`);
      }
      return;
    }
    loadedGeneration.current = remote.generation;
    setScheduleEnabled(remote.enabled);
    setSchedulePersistent(remote.persistenceEnabled);
    const loadedPoints = remote.points
      .filter((point): point is PowerLedSchedulePoint => point !== null)
      .sort((left, right) => left.minuteOfDay - right.minuteOfDay);
    setSchedulePoints(loadedPoints.length > 0 ? loadedPoints : defaultPowerLedSchedulePoints());
    setScheduleAdvanced(remote.points.some((point) => point !== null && point.daysMask !== POWER_LED_SCHEDULE_ALL_DAYS));
  }, [onSend, state.controls.powerLedSchedule]);
  const device = (key: DeviceKey) => state.devices[key];
  const updateSchedulePoint = (index: number, patch: Partial<PowerLedSchedulePoint>) => {
    setSchedulePoints((points) => points.map((point, current) => current === index ? { ...point, ...patch } : point));
  };
  const applySchedule = async () => {
    const points = schedulePoints.map((point) => scheduleAdvanced ? point : {
      ...point,
      daysMask: POWER_LED_SCHEDULE_ALL_DAYS,
    }).sort((left, right) => left.minuteOfDay - right.minuteOfDay);
    const validation = validatePowerLedSchedulePoints(points);
    if (validation) {
      setScheduleError(text(validation === "overlap" ? "controls.scheduleOverlap" : "controls.scheduleLimit"));
      return;
    }
    setScheduleBusy(true);
    setScheduleError(null);
    try {
      const generation = Math.max(1, Date.now() >>> 0);
      setSchedulePoints(points);
      for (const command of encodePowerLedScheduleTransaction(generation, scheduleEnabled, schedulePersistent, points)) {
        if (!await onSend(command)) throw new Error(text("controls.scheduleTransferFailed"));
      }
      loadedGeneration.current = null;
      requestedSchedulePoints.current.clear();
      await onSend("PSQ");
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : String(error));
    } finally {
      setScheduleBusy(false);
    }
  };
  const remoteSchedule = state.controls.powerLedSchedule;
  const nextPoint = remoteSchedule.nextIndex === null ? null : remoteSchedule.points[remoteSchedule.nextIndex] ?? null;
  const powerLedState = device("powerLed");
  const powerLedStateLabel = powerLedState === null ? "?" : powerLedState ? "ON" : "OFF";
  const powerLedFeedback = feedback["device.powerLed"];
  return <div className="widget-section-body">
    <DomainGraphControl domain="lighting" state={state} open={nodesOpen} onToggle={() => setNodesOpen((value) => !value)} />
    {nodesOpen && <OperationalDomainGraph domain="lighting" state={state} feedback={feedback} />}
    <div className="device-grid">
      <DeviceAction label={<LocalizedText textKey="controls.garland" />} icon={Sparkles} state={device("garland")} feedback={feedback["device.garland"]} onClick={() => onSend("garland")} />
      <DeviceAction label={<LocalizedText textKey="controls.redLed" />} icon={Zap} state={device("redLed")} feedback={feedback["device.redLed"]} onClick={() => onSend("power")} />
      <DeviceAction label={<LocalizedText textKey="controls.bedside" />} icon={BedDouble} state={device("bedside")} feedback={feedback["device.bedside"]} onClick={() => onSend("bedside")} />
      <DeviceAction label={<LocalizedText textKey="controls.lamp" />} icon={Lamp} state={device("lamp")} feedback={feedback["device.lamp"]} onClick={() => onSend("lam")} />
    </div>
    <div className="control-row three-column-row">
      <label className={`control-feedback${feedbackClass(feedback["control.redMode"])}`}><LocalizedText textKey="controls.mode" /><select value={state.controls.redMode} onChange={(event) => onSend(`01_mode_${event.target.value}`)}>{redModes.map((mode, index) => <option key={mode} value={index}>{mode}</option>)}</select></label>
      <label className={`control-feedback${feedbackClass(feedback["control.redBrightness"])}`}><LocalizedText textKey="controls.brightness" /><select value={state.controls.redBrightness} onChange={(event) => onSend(`02_bri_${Number(event.target.value) <= 9 ? event.target.value : "M"}`)}>{percentOptions.map((option, index) => <option key={option} value={index}>{option}</option>)}</select></label>
      <label className={`control-feedback${feedbackClass(feedback["control.redSpeed"])}`}><LocalizedText textKey="controls.speed" /><span className="step-control"><button type="button" onClick={() => onSend("redl_sp-")}>-</button><input readOnly value={state.sensors.speed?.toString() ?? ""} placeholder="--" /><button type="button" onClick={() => onSend("redl_sp+")}>+</button></span></label>
    </div>
    <section className={`heater-console operational-device-console power-led-console${powerLedState === true ? " is-on" : powerLedState === false ? " is-off" : " is-unknown"}${feedbackClass(powerLedFeedback)}`}>
      <div className="heater-row power-led-row">
        <span className="heater-label"><span className="heater-icon power-led-icon"><Lightbulb size={18} /></span><span><LocalizedText textKey="controls.powerLed" /><small>{powerLedStateLabel}</small></span></span>
        <button className="power-led-toggle" type="button" onClick={() => onSend("powled")} aria-busy={powerLedFeedback?.phase === "sending" || powerLedFeedback?.phase === "awaiting"} title={text("controls.powerLedToggle")}><Power size={17} /><LocalizedText textKey="controls.powerLedToggle" /></button>
      </div>
      <div className="power-led-live-status">
        <div className={`power-led-status-card output-state${powerLedState === true ? " is-active" : ""}`}><Power size={18} /><span><small><LocalizedText textKey="controls.confirmedState" /></small><strong>{powerLedStateLabel}</strong></span></div>
        <div className={`power-led-status-card${remoteSchedule.clockValid ? " is-active" : " is-waiting"}`}><Clock3 size={18} /><span><small><LocalizedText textKey="controls.clock" /></small><strong>{remoteSchedule.clockValid ? text("controls.ready") : text("controls.waiting")}</strong></span></div>
        <div className={`power-led-status-card${remoteSchedule.enabled ? " is-active" : ""}`}><CalendarClock size={18} /><span><small><LocalizedText textKey="controls.powerSchedule" /></small><strong>{nextPoint ? `${minuteToTime(nextPoint.minuteOfDay)} -> ${nextPoint.stateOn ? "ON" : "OFF"}` : text("controls.powerScheduleNone")}</strong></span></div>
      </div>
      <div className="heater-source-line power-led-source-line"><span><LocalizedText textKey="controls.statusSource" /></span><strong>kPowerLed</strong><span><LocalizedText textKey="controls.schedule" /></span><strong>{remoteSchedule.enabled ? "ON" : "OFF"}</strong><span><LocalizedText textKey="controls.persistence" /></span><strong>{remoteSchedule.persistenceEnabled ? "ON" : "OFF"}</strong></div>
      <section className={`heater-schedule power-led-schedule${scheduleEnabled ? " is-enabled" : ""}${scheduleAdvanced ? " is-advanced" : ""}${scheduleBusy ? " is-busy" : ""}`}>
        <header>
          <label className={`heater-persist-toggle${scheduleEnabled ? " is-active" : ""}`}><input type="checkbox" checked={scheduleEnabled} onChange={(event) => setScheduleEnabled(event.target.checked)} /><i aria-hidden="true" /><span><LocalizedText textKey="controls.powerSchedule" /></span></label>
          <label className={`heater-persist-toggle${schedulePersistent ? " is-active" : ""}`}><input type="checkbox" checked={schedulePersistent} onChange={(event) => setSchedulePersistent(event.target.checked)} /><i aria-hidden="true" /><span><LocalizedText textKey="controls.scheduleKeep" /></span></label>
          <button type="button" className={scheduleAdvanced ? "is-active" : ""} onClick={() => setScheduleAdvanced((value) => !value)} title={text("controls.scheduleAdvanced")}><SlidersHorizontal size={15} /></button>
          <button type="button" disabled={schedulePoints.length >= POWER_LED_SCHEDULE_MAX_POINTS} onClick={() => setSchedulePoints((points) => [...points, { enabled: true, minuteOfDay: 720, stateOn: true, daysMask: POWER_LED_SCHEDULE_ALL_DAYS }])} title={text("controls.powerScheduleAdd")}><Plus size={15} /></button>
          <button type="button" disabled={scheduleBusy} onClick={() => void applySchedule()} title={text("controls.scheduleApply")}><Save size={15} /></button>
        </header>
        <div className="heater-schedule-points power-schedule-points">
          {schedulePoints.map((point, index) => <article key={index} className={point.enabled ? "is-enabled" : ""}>
            <label className="schedule-enabled"><input type="checkbox" checked={point.enabled} onChange={(event) => updateSchedulePoint(index, { enabled: event.target.checked })} /><span>{index + 1}</span></label>
            <input type="time" value={minuteToTime(point.minuteOfDay)} onChange={(event) => { const minute = timeToMinute(event.target.value); if (minute !== null) updateSchedulePoint(index, { minuteOfDay: minute }); }} />
            <select className="schedule-state" value={point.stateOn ? "1" : "0"} onChange={(event) => updateSchedulePoint(index, { stateOn: event.target.value === "1" })} aria-label={text("controls.powerScheduleState")}><option value="1">ON</option><option value="0">OFF</option></select>
            {scheduleAdvanced && <div className="schedule-days">{scheduleDayKeys.map((day, dayIndex) => <button type="button" key={day} className={(point.daysMask & (1 << dayIndex)) !== 0 ? "is-active" : ""} onClick={() => { const nextMask = point.daysMask ^ (1 << dayIndex); if (nextMask !== 0) updateSchedulePoint(index, { daysMask: nextMask }); }}>{text(`controls.day.${day}` as TranslationKey)}</button>)}</div>}
            <button type="button" className="schedule-remove" onClick={() => setSchedulePoints((points) => points.filter((_, current) => current !== index))} title={text("controls.scheduleRemove")}><Trash2 size={14} /></button>
          </article>)}
        </div>
        <footer>
          <span>{remoteSchedule.clockValid ? text("controls.scheduleClockReady") : text("controls.scheduleClockWaiting")}</span>
          <span>{text("controls.powerScheduleCurrent", { state: remoteSchedule.outputOn ? "ON" : "OFF" })}</span>
          {nextPoint && <span>{text("controls.powerScheduleNext", { time: minuteToTime(nextPoint.minuteOfDay), state: nextPoint.stateOn ? "ON" : "OFF" })}</span>}
          <span>{schedulePoints.length}/{POWER_LED_SCHEDULE_MAX_POINTS}</span>
          {scheduleError && <strong>{scheduleError}</strong>}
        </footer>
      </section>
    </section>
  </div>;
}

export function ClimateWidget({ state, feedback, onSend }: SharedProps) {
  const { text } = useLocale();
  const { profile, setSignalBinding } = useWorkspace();
  const [heaterTarget, setHeaterTarget] = useState(state.controls.heaterTargetC);
  const [nodesOpen, setNodesOpen] = useState(false);
  const initialPoints = useMemo<HeaterSchedulePoint[]>(() =>
    defaultSchedulePoints(state.controls.heaterTargetC), []);
  const [schedulePoints, setSchedulePoints] = useState<HeaterSchedulePoint[]>(initialPoints);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [schedulePersistent, setSchedulePersistent] = useState(false);
  const [scheduleAdvanced, setScheduleAdvanced] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const loadedGeneration = useRef<number | null>(null);
  const requestedSchedulePoints = useRef(new Set<string>());
  useEffect(() => setHeaterTarget(state.controls.heaterTargetC), [state.controls.heaterTargetC]);
  useEffect(() => { void onSend("S5Q"); }, [onSend]);
  useEffect(() => {
    const remote = state.controls.heaterSchedule;
    if (remote.generation === 0 || loadedGeneration.current === remote.generation) return;
    const missing = remote.points.map((point, index) => point ? null : index).filter((index): index is number => index !== null);
    if (missing.length) {
      for (const index of missing) {
        const key = `${remote.generation}:${index}`;
        if (requestedSchedulePoints.current.has(key)) continue;
        requestedSchedulePoints.current.add(key);
        void onSend(`S5Q${index.toString(16).toUpperCase()}`);
      }
      return;
    }
    loadedGeneration.current = remote.generation;
    setScheduleEnabled(remote.enabled);
    setSchedulePersistent(remote.persistenceEnabled);
    const loadedPoints = remote.points
      .filter((point): point is HeaterSchedulePoint => point !== null)
      .sort((left, right) => left.minuteOfDay - right.minuteOfDay);
    setSchedulePoints(loadedPoints.length > 0
      ? loadedPoints
      : defaultSchedulePoints(state.controls.heaterTargetC));
    setScheduleAdvanced(remote.points.some((point) => point !== null && (point.action !== "unchanged" || point.daysMask !== HEATER_SCHEDULE_ALL_DAYS)));
  }, [onSend, state.controls.heaterSchedule]);
  const device = (key: DeviceKey) => state.devices[key];
  const colors = [text("controls.black"), text("controls.red"), text("controls.green"), text("controls.white")];
  const modes = ["OFF", text("controls.fan"), text("controls.low"), text("controls.high"), text("controls.max"), "AUTO"];
  const modeCommands = ["he4", "he0", "he1", "he2", "he3", "he5"];
  const heaterStatus = state.controls.heaterStatus;
  const sourceBinding = profile.signalBindings["Kheater.inputTemperature"]?.providerEndpointId ?? "esp_mixer.temperatureC";
  const sourceState = resolveSignalBinding(sourceBinding, state);
  const temperatureProviders = signalEndpointsFor("temperatureC");
  const scheduleActions: HeaterScheduleAction[] = ["unchanged", "auto", "off", "fan", "low", "high", "max"];
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
  const updateSchedulePoint = (index: number, patch: Partial<HeaterSchedulePoint>) => {
    setSchedulePoints((points) => points.map((point, current) => current === index ? { ...point, ...patch } : point));
  };
  const applySchedule = async () => {
    const points = schedulePoints.map((point) => scheduleAdvanced ? point : {
      ...point,
      action: "unchanged" as const,
      daysMask: HEATER_SCHEDULE_ALL_DAYS,
    }).sort((left, right) => left.minuteOfDay - right.minuteOfDay);
    const validation = validateSchedulePoints(points);
    if (validation) {
      setScheduleError(text(validation === "overlap" ? "controls.scheduleOverlap" : "controls.scheduleLimit"));
      return;
    }
    setScheduleBusy(true);
    setScheduleError(null);
    try {
      const generation = Math.max(1, (Date.now() >>> 0));
      setSchedulePoints(points);
      for (const command of encodeScheduleTransaction(generation, scheduleEnabled, schedulePersistent, points)) {
        if (!await onSend(command)) throw new Error(text("controls.scheduleTransferFailed"));
      }
      loadedGeneration.current = null;
      requestedSchedulePoints.current.clear();
      await onSend("S5Q");
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : String(error));
    } finally {
      setScheduleBusy(false);
    }
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
    <section className={`heater-console${heaterStatus.cooldownActive ? " is-cooldown" : ""}`}>
      <div className="heater-row">
        <span className="heater-label"><span className="heater-icon"><Heater size={18} /></span><span><LocalizedText textKey="controls.heater" /><small>{modes[state.controls.heaterMode] ?? "OFF"}</small></span></span>
        <label className={`control-feedback${feedbackClass(feedback["control.heaterMode"])}`}><LocalizedText textKey="controls.mode" /><select value={state.controls.heaterMode} onChange={(event) => { const command = modeCommands[Number(event.target.value)]; if (command) onSend(command); }}>{modes.map((mode, index) => <option key={mode} value={index}>{mode}</option>)}</select></label>
        <label className={`control-feedback${feedbackClass(feedback["control.heaterTarget"])}`}><LocalizedText textKey="controls.target" /><input type="number" min="5" max="35" step="0.1" value={heaterTarget} onChange={(event) => setHeaterTarget(Number(event.target.value))} onBlur={commitHeaterTarget} onKeyDown={(event) => event.key === "Enter" && commitHeaterTarget()} /></label>
      </div>
      <div className="heater-live-status">
        <div className={`heater-thermal${heaterStatus.temperatureValid === false ? " is-stale" : ""}`}>
          <Thermometer size={18} /><span><small><LocalizedText textKey="controls.heaterInput" /></small><strong>{heaterStatus.acceptedTemperatureC === null ? "--" : `${heaterStatus.acceptedTemperatureC.toFixed(1)} C`}</strong><em>{sourceState.available ? sourceState.endpoint?.nodeId : text("controls.sourceUnavailable")}</em></span>
          <select value={sourceBinding} onChange={(event) => setSignalBinding("Kheater.inputTemperature", event.target.value)} aria-label={text("controls.inputSource")}>
            {temperatureProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.nodeId}.{provider.signal}{provider.routingDeployed ? "" : ` - ${text("controls.routingNotDeployed")}`}</option>)}
          </select>
        </div>
        <div className={`heater-target-card${feedbackClass(feedback["control.heaterPersistence"])}`}>
          <Save size={18} />
          <span><small><LocalizedText textKey="controls.heaterConfiguredTarget" /></small><strong>{state.controls.heaterTargetC.toFixed(1)} C</strong></span>
          <label className={`heater-persist-toggle${heaterStatus.setpointPersistent ? " is-active" : ""}`}>
            <input
              type="checkbox"
              checked={heaterStatus.setpointPersistent === true}
              disabled={heaterStatus.setpointPersistent === null}
              onChange={(event) => onSend(event.target.checked ? "P51" : "P50")}
            />
            <i aria-hidden="true" />
            <span><LocalizedText textKey="controls.heaterRememberTarget" /></span>
          </label>
        </div>
        <div className="heater-output-bank">
          <span className={`heater-state-chip${heaterStatus.autoEnabled ? " is-active" : ""}`}>AUTO</span>
          <span className={`heater-state-chip${heaterStatus.fanOn ? " is-active" : ""}`}><Fan size={11} />FAN</span>
          <span className={`heater-state-chip${heaterStatus.lowHeatOn ? " is-active is-heat" : ""}`}><Flame size={11} />LOW</span>
          <span className={`heater-state-chip${heaterStatus.highHeatOn ? " is-active is-heat" : ""}`}><Flame size={11} />HIGH</span>
          <span className={`heater-state-chip${heaterStatus.rotationOn ? " is-active" : ""}`}><RotateCw size={11} />ROT</span>
        </div>
        <div className="heater-stop-reason"><small>{heaterStatus.cooldownActive ? <LocalizedText textKey="controls.cooldown" /> : <LocalizedText textKey="controls.mode" />}</small><strong>{stopReason}</strong></div>
      </div>
      <div className="heater-source-line"><span><LocalizedText textKey="controls.statusSource" /></span><strong>Kheater</strong><span><LocalizedText textKey="controls.inputSource" /></span><strong>{sourceBinding}</strong>{!sourceState.routingDeployed && <em><LocalizedText textKey="controls.routingNotDeployed" /></em>}</div>
      <section className={`heater-schedule${scheduleEnabled ? " is-enabled" : ""}${scheduleBusy ? " is-busy" : ""}`}>
        <header>
          <label className={`heater-persist-toggle${scheduleEnabled ? " is-active" : ""}`}><input type="checkbox" checked={scheduleEnabled} onChange={(event) => setScheduleEnabled(event.target.checked)} /><i aria-hidden="true" /><span><LocalizedText textKey="controls.schedule" /></span></label>
          <label className={`heater-persist-toggle${schedulePersistent ? " is-active" : ""}`}><input type="checkbox" checked={schedulePersistent} onChange={(event) => setSchedulePersistent(event.target.checked)} /><i aria-hidden="true" /><span><LocalizedText textKey="controls.scheduleKeep" /></span></label>
          <button type="button" className={scheduleAdvanced ? "is-active" : ""} onClick={() => setScheduleAdvanced((value) => !value)} title={text("controls.scheduleAdvanced")}><SlidersHorizontal size={15} /></button>
          <button type="button" disabled={schedulePoints.length >= HEATER_SCHEDULE_MAX_POINTS} onClick={() => setSchedulePoints((points) => [...points, { enabled: true, minuteOfDay: 720, targetC: state.controls.heaterTargetC, action: "unchanged", daysMask: HEATER_SCHEDULE_ALL_DAYS }])} title={text("controls.scheduleAdd")}><Plus size={15} /></button>
          <button type="button" disabled={scheduleBusy} onClick={() => void applySchedule()} title={text("controls.scheduleApply")}><Save size={15} /></button>
        </header>
        <div className="heater-schedule-points">
          {schedulePoints.map((point, index) => <article key={index} className={point.enabled ? "is-enabled" : ""}>
            <label className="schedule-enabled"><input type="checkbox" checked={point.enabled} onChange={(event) => updateSchedulePoint(index, { enabled: event.target.checked })} /><span>{index + 1}</span></label>
            <input type="time" value={minuteToTime(point.minuteOfDay)} onChange={(event) => { const minute = timeToMinute(event.target.value); if (minute !== null) updateSchedulePoint(index, { minuteOfDay: minute }); }} />
            <label className="schedule-temperature"><Thermometer size={14} /><input type="number" min="5" max="35" step="0.1" value={point.targetC} onChange={(event) => updateSchedulePoint(index, { targetC: Number(event.target.value) })} /><span>C</span></label>
            {scheduleAdvanced && <select value={point.action} onChange={(event) => updateSchedulePoint(index, { action: event.target.value as HeaterScheduleAction })}>{scheduleActions.map((action) => <option key={action} value={action}>{text(`controls.scheduleAction.${action}` as TranslationKey)}</option>)}</select>}
            {scheduleAdvanced && <div className="schedule-days">{scheduleDayKeys.map((day, dayIndex) => <button type="button" key={day} className={(point.daysMask & (1 << dayIndex)) !== 0 ? "is-active" : ""} onClick={() => { const nextMask = point.daysMask ^ (1 << dayIndex); if (nextMask !== 0) updateSchedulePoint(index, { daysMask: nextMask }); }}>{text(`controls.day.${day}` as TranslationKey)}</button>)}</div>}
            <button type="button" className="schedule-remove" onClick={() => setSchedulePoints((points) => points.filter((_, current) => current !== index))} title={text("controls.scheduleRemove")}><Trash2 size={14} /></button>
          </article>)}
        </div>
        <footer><span>{state.controls.heaterSchedule.clockValid ? text("controls.scheduleClockReady") : text("controls.scheduleClockWaiting")}</span>{state.controls.heaterSchedule.nextIndex !== null && state.controls.heaterSchedule.points[state.controls.heaterSchedule.nextIndex] && <span>{text("controls.scheduleNext", { time: minuteToTime(state.controls.heaterSchedule.points[state.controls.heaterSchedule.nextIndex]!.minuteOfDay), temperature: state.controls.heaterSchedule.points[state.controls.heaterSchedule.nextIndex]!.targetC.toFixed(1) })}</span>}<span>{schedulePoints.length}/{HEATER_SCHEDULE_MAX_POINTS}</span>{scheduleError && <strong>{scheduleError}</strong>}</footer>
      </section>
    </section>
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
