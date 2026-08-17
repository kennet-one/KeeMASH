import {
  Activity,
  CircuitBoard,
  Cpu,
  Gauge,
  HardDrive,
  FlaskConical,
  Grid3X3,
  MemoryStick,
  Microchip,
  Network,
  Play,
  Power,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Square,
  Thermometer,
  Timer,
  XCircle,
  Zap,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { LocalizedText, useLocale } from "../i18n/locale";
import type { GraphicsRuntimeStatus, MemoryTestStatus, ResourceSample } from "../types";
import { useWorkspace } from "../core/workspace";
import { TechnicalTerm } from "./TechnicalTerm";

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "?" : `${value.toFixed(1)}%`;
}

function bytes(value: number): string {
  if (!Number.isFinite(value)) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = Math.max(0, value);
  let index = 0;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index++;
  }
  return `${current.toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}

function throughput(value: number | null | undefined): string {
  return value === null || value === undefined ? "?" : `${value.toFixed(value < 10 ? 1 : 0)} MB/s`;
}

function temperature(value: number | null | undefined): string {
  return value === null || value === undefined ? "? C" : `${value.toFixed(1)} C`;
}

function clock(value: number | null | undefined): string {
  return value === null || value === undefined ? "? MHz" : `${value.toFixed(0)} MHz`;
}

interface MeterProps {
  label: ReactNode;
  value: string;
  detail: string;
  progress: number | null;
  tone: "green" | "cyan" | "yellow" | "red";
  icon: typeof Cpu;
}

function Meter({ label, value, detail, progress, tone, icon: Icon }: MeterProps) {
  const width = progress === null ? 0 : Math.max(0, Math.min(100, progress));
  return (
    <article className={`resource-meter tone-${tone}`}>
      <div className="meter-top"><Icon size={18} /><span>{label}</span></div>
      <strong>{value}</strong>
      <div className="meter-detail">{detail}</div>
      <div className="meter-track" aria-hidden="true"><span style={{ width: `${width}%` }} /></div>
    </article>
  );
}

interface ThermalReadingProps {
  label: string;
  value: string;
  detail: string;
}

function ThermalReading({ label, value, detail }: ThermalReadingProps) {
  return (
    <div className="thermal-reading">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

export type ResourceSection = "summary" | "thermals" | "vram" | "pcie" | "compute" | "details";

interface ResourceMonitorProps {
  latest: ResourceSample | null;
  history: ResourceSample[];
  sections?: ResourceSection[];
  memoryTest?: MemoryTestStatus | null;
  onStartMemoryTest?: (memoryMiB: number, durationSeconds: number, threads?: number) => void;
  onStopMemoryTest?: () => void;
  onOpenWindowsMemoryDiagnostic?: () => void;
  onRebootToFirmware?: () => void;
  onScheduleSystemPower?: (action: "restart" | "shutdown") => void;
  onCancelSystemPower?: () => void;
  systemPowerPending?: "restart" | "shutdown" | null;
  graphicsRuntime?: GraphicsRuntimeStatus | null;
}

const timingCatalog = {
  primary: ["tCL", "tRCD", "tRP", "tRAS", "CR"],
  secondary: ["tRC", "tRFC1", "tRFC2", "tRFC4", "tREFI", "tFAW", "tRRD_S", "tRRD_L", "tCCD_S", "tCCD_L", "tWR", "tWTR_S", "tWTR_L", "tRTP", "tCWL", "tCKE", "tXP"],
  tertiary: ["tRDRD_SG", "tRDRD_DG", "tRDRD_DR", "tRDRD_DD", "tRDWR_SG", "tRDWR_DG", "tRDWR_DR", "tRDWR_DD", "tWRRD_SG", "tWRRD_DG", "tWRRD_DR", "tWRRD_DD", "tWRWR_SG", "tWRWR_DG", "tWRWR_DR", "tWRWR_DD"],
} as const;

type TimingGroup = "all" | keyof typeof timingCatalog;

const historyIntervals = [1_000, 5_000, 10_000, 30_000, 60_000] as const;

function intervalLabel(value: number): string {
  return value === 60_000 ? "1 min" : `${value / 1_000} s`;
}

export function ResourceMonitor({ latest, history, sections, memoryTest, onStartMemoryTest, onStopMemoryTest, onOpenWindowsMemoryDiagnostic, onRebootToFirmware, onScheduleSystemPower, onCancelSystemPower, systemPowerPending, graphicsRuntime }: ResourceMonitorProps) {
  const { text } = useLocale();
  const { profile, setTelemetryInterval } = useWorkspace();
  const [timingGroup, setTimingGroup] = useState<TimingGroup>("all");
  const [spdIndex, setSpdIndex] = useState(0);
  const [testMemoryMiB, setTestMemoryMiB] = useState(4096);
  const [testDuration, setTestDuration] = useState(900);
  const [testThreads, setTestThreads] = useState(0);
  const visible = (section: ResourceSection) => !sections || sections.includes(section);
  const ramPercent = latest ? (latest.memory.usedBytes / latest.memory.totalBytes) * 100 : null;
  const gpuMemoryPercent = latest?.gpu.memoryUsedMiB !== null && latest?.gpu.memoryTotalMiB
    ? (latest.gpu.memoryUsedMiB / latest.gpu.memoryTotalMiB) * 100
    : null;
  const ramBusHasLoad = latest?.memory.busLoadPercent != null || history.some((sample) => sample.memory.busLoadPercent != null);
  const ramBusHasThroughput = latest?.memory.readMiBs != null || latest?.memory.writeMiBs != null
    || history.some((sample) => sample.memory.readMiBs != null || sample.memory.writeMiBs != null);
  const spdProfiles = latest?.memory.spdProfiles ?? [];
  const selectedSpd = spdProfiles[Math.min(spdIndex, Math.max(0, spdProfiles.length - 1))];
  const timingMap = useMemo(() => {
    const values = new Map(selectedSpd?.timings.map((timing) => [timing.name, timing]) ?? []);
    for (const timing of latest?.memory.activeTimings ?? []) values.set(timing.name, timing);
    return values;
  }, [latest?.memory.activeTimings, selectedSpd]);
  const visibleTimingGroups = timingGroup === "all" ? Object.keys(timingCatalog) as Array<keyof typeof timingCatalog> : [timingGroup];
  const configuredSpeed = latest?.memory.modules.find((module) => module.configuredSpeedMts > 0)?.configuredSpeedMts ?? 0;
  const configuredVoltage = latest?.memory.modules.find((module) => module.configuredVoltageMv > 0)?.configuredVoltageMv ?? 0;
  const testRunning = memoryTest?.state === "running" || memoryTest?.state === "allocating";
  const chartData = history.map((sample) => ({
    time: new Date(sample.timestamp).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" }),
    cpu: sample.cpu.loadPercent,
    ram: (sample.memory.usedBytes / sample.memory.totalBytes) * 100,
    gpu: sample.gpu.loadPercent ?? 0,
    rx: sample.pcie.rxMiBs ?? 0,
    tx: sample.pcie.txMiBs ?? 0,
    pcie: sample.pcie.loadPercent ?? 0,
    ramBus: sample.memory.busLoadPercent ?? null,
    ramRead: sample.memory.readMiBs ?? null,
    ramWrite: sample.memory.writeMiBs ?? null,
    cpuPower: sample.cpu.powerW ?? null,
    gpuPower: sample.gpu.powerW ?? null,
  }));
  const vramChannels = useMemo(() => Array.from(new Set(history.flatMap((sample) => sample.gpu.memoryChips.map((chip) => chip.channel)))).sort((left, right) => left - right), [history]);
  const vramChartData = useMemo(() => history.map((sample) => {
    const point: Record<string, string | number | null> = {
      time: new Date(sample.timestamp).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" }),
    };
    for (const chip of sample.gpu.memoryChips) point[`chip-${chip.channel}`] = chip.temperatureC;
    return point;
  }), [history]);
  const chipTemperatures = latest?.gpu.memoryChips.map((chip) => chip.temperatureC) ?? [];
  const chipMinimum = chipTemperatures.length ? Math.min(...chipTemperatures) : null;
  const chipMaximum = chipTemperatures.length ? Math.max(...chipTemperatures) : null;
  const chipSpread = chipMinimum === null || chipMaximum === null ? null : chipMaximum - chipMinimum;
  const chipColors = ["#45d483", "#55b8ef", "#f4bd52", "#f07178", "#b893f7", "#64d6c4", "#f49268", "#7aa6ff"];

  return (
    <div className="resource-view view-enter">
      {visible("summary") && <section className="resource-summary">
        <Meter
          label={<TechnicalTerm term="CPU" />}
          value={percent(latest?.cpu.loadPercent)}
          detail={latest ? text("monitor.cpuDetail", { temperature: temperature(latest.cpu.temperatureC), hotspot: temperature(latest.cpu.hotspotC), threads: latest.cpu.cores.length }) : text("common.waiting")}
          progress={latest?.cpu.loadPercent ?? null}
          tone="green"
          icon={Cpu}
        />
        <Meter
          label={<TechnicalTerm term="RAM" fallback />}
          value={ramPercent === null ? "?" : percent(ramPercent)}
          detail={latest ? text("monitor.ramDetail", { used: bytes(latest.memory.usedBytes), total: bytes(latest.memory.totalBytes), dimms: latest.memory.modules.length }) : text("common.waiting")}
          progress={ramPercent}
          tone="cyan"
          icon={MemoryStick}
        />
        <Meter
          label={<TechnicalTerm term="GPU" />}
          value={percent(latest?.gpu.loadPercent)}
          detail={latest?.gpu.available ? text("monitor.gpuDetail", { temperature: temperature(latest.gpu.temperatureC), hotspot: temperature(latest.gpu.hotspotC), power: latest.gpu.powerW?.toFixed(0) ?? "?" }) : text("common.unavailable")}
          progress={latest?.gpu.loadPercent ?? null}
          tone="yellow"
          icon={Zap}
        />
        <Meter
          label={<TechnicalTerm term="VRAM" />}
          value={gpuMemoryPercent === null ? "?" : percent(gpuMemoryPercent)}
          detail={latest?.gpu.memoryUsedMiB == null ? text("common.unavailable") : `${temperature(latest.gpu.memoryTemperatureC)} / ${clock(latest.gpu.memoryClockMhz)}`}
          progress={gpuMemoryPercent}
          tone="red"
          icon={HardDrive}
        />
        <article className={`graphics-runtime-card${graphicsRuntime?.fallbackReason ? " has-warning" : ""}`}>
          <header><CircuitBoard size={17} /><div><span>{text("graphics.diagnostics")}</span><strong>{graphicsRuntime?.restartRequired ? text("graphics.pendingRestart") : text("graphics.active")}</strong></div></header>
          <dl>
            <div><dt>{text("graphics.requested")}</dt><dd>{graphicsRuntime?.selected.name ?? "?"}</dd></div>
            <div><dt>{text("graphics.native")}</dt><dd>{graphicsRuntime?.activeNativeLuid ? graphicsRuntime.adapters.find((adapter) => adapter.luid === graphicsRuntime.activeNativeLuid)?.name ?? graphicsRuntime.activeNativeLuid : "Windows default"}</dd></div>
            <div><dt>{text("graphics.observed")}</dt><dd>{graphicsRuntime?.observedNames.length ? graphicsRuntime.observedNames.join(", ") : text("graphics.notObserved")}</dd></div>
          </dl>
          {graphicsRuntime?.fallbackReason && <p><ShieldAlert size={14} />{graphicsRuntime.fallbackReason}</p>}
        </article>
      </section>}

      {visible("thermals") && <section className="thermal-panel widget-flat">
        <div className="section-heading">
          <div><span className="eyebrow"><LocalizedText textKey="monitor.readOnlySensors" /></span><h2><LocalizedText textKey="monitor.thermalsClocks" /></h2></div>
          <div className={`sensor-source ${latest?.advancedSensorsAvailable ? "is-live" : ""}`}>
            <ShieldCheck size={15} />
            <span>{latest?.sensorBackend ?? text("common.waiting")}</span>
          </div>
        </div>
        <div className="thermal-content">
          <div className="thermal-readings">
            <ThermalReading label={text("monitor.cpuPackage")} value={temperature(latest?.cpu.temperatureC)} detail={text("monitor.processorPackage")} />
            <ThermalReading label={text("monitor.cpuHotspot")} value={temperature(latest?.cpu.hotspotC)} detail={text("monitor.hottestCore")} />
            <ThermalReading label={text("monitor.cpuPower")} value={latest?.cpu.powerW == null ? "? W" : `${latest.cpu.powerW.toFixed(1)} W`} detail={text("monitor.packagePower")} />
            <ThermalReading label={text("monitor.gpuCore")} value={temperature(latest?.gpu.temperatureC)} detail={clock(latest?.gpu.graphicsClockMhz)} />
            <ThermalReading label={text("monitor.gpuHotspot")} value={temperature(latest?.gpu.hotspotC)} detail={text("monitor.sensorVaries")} />
            <ThermalReading label="VRAM" value={temperature(latest?.gpu.memoryTemperatureC)} detail={clock(latest?.gpu.memoryClockMhz)} />
            <ThermalReading label={text("monitor.gpuPower")} value={latest?.gpu.powerW == null ? "? W" : `${latest.gpu.powerW.toFixed(1)} W`} detail={latest?.gpu.name ?? text("common.waiting")} />
          </div>
          <div className="dimm-panel">
            <div className="dimm-heading"><MemoryStick size={16} /><LocalizedText textKey="monitor.memoryModules" /><TechnicalTerm term="DIMM" showLabel={false} /></div>
            <div className="dimm-list">
              {latest?.memory.modules.length ? latest.memory.modules.map((module) => (
                <div className="dimm-row" key={`${module.slot}-${module.name}`}>
                  <div>
                    <strong>{module.slot}</strong>
                    <span>{module.name} · {module.capacityBytes ? bytes(module.capacityBytes) : text("monitor.capacityUnknown")}</span>
                    <small>{module.memoryType || "?"} · {module.configuredSpeedMts || module.speedMts || "?"} MT/s · {module.configuredVoltageMv ? `${(module.configuredVoltageMv / 1000).toFixed(2)} V` : "? V"} · {module.dataWidthBits || "?"}-bit</small>
                  </div>
                  <b>{temperature(module.temperatureC)}</b>
                </div>
              )) : (
                <div className="dimm-empty"><Microchip size={16} /><LocalizedText textKey="monitor.moduleInventory" /></div>
              )}
            </div>
          </div>
        </div>
        <div className="memory-lab">
          <div className="memory-operating-strip">
            <div><span><LocalizedText textKey="monitor.operatingPoint" /></span><strong>{configuredSpeed ? `${configuredSpeed} MT/s` : "? MT/s"}</strong></div>
            <div><span><LocalizedText textKey="monitor.dramVoltage" /></span><strong>{configuredVoltage ? `${(configuredVoltage / 1000).toFixed(2)} V` : "? V"}</strong></div>
            <div><span><LocalizedText textKey="monitor.population" /></span><strong>{latest?.memory.modules.length ?? 0} / {bytes(latest?.memory.totalBytes ?? 0)}</strong></div>
            <div><span><LocalizedText textKey="monitor.spdProfiles" /></span><strong>{spdProfiles.length || "?"}</strong></div>
          </div>

          <section className="timing-workbench" aria-label={text("monitor.memoryTimings")}>
            <div className="memory-lab-heading">
              <div><span className="eyebrow"><LocalizedText textKey="monitor.readOnlyProfile" /></span><h3><LocalizedText textKey="monitor.memoryTimings" /></h3></div>
              <div className="timing-toolbar">
                {spdProfiles.length > 1 && <select value={spdIndex} onChange={(event) => setSpdIndex(Number(event.target.value))} aria-label={text("monitor.spdProfile")}>
                  {spdProfiles.map((spd, index) => <option value={index} key={`${spd.address}-${spd.serialNumber}`}>{spd.partNumber || spd.address}</option>)}
                </select>}
                <div className="segment-control timing-filter">
                  {(["all", "primary", "secondary", "tertiary"] as TimingGroup[]).map((group) => <button type="button" className={timingGroup === group ? "is-active" : ""} key={group} onClick={() => setTimingGroup(group)}>{text(`monitor.timing.${group}`)}</button>)}
                </div>
              </div>
            </div>
            <div className="timing-source-line">
              <CircuitBoard size={15} />
              <span>{selectedSpd ? `${selectedSpd.manufacturer || "SPD"} ${selectedSpd.partNumber} · ${selectedSpd.dataRateMts || "?"} MT/s · ${selectedSpd.address}` : latest?.memory.spdError || text("monitor.spdUnavailable")}</span>
              <b>{selectedSpd ? text("monitor.spdMinimum") : text("monitor.controllerUnavailable")}</b>
            </div>
            <div className={`timing-source-line active-timing-source ${latest?.memory.activeTimings.length ? "is-live" : ""}`}>
              <Activity size={15} />
              <span>{latest?.memory.activeTimingSource || latest?.memory.activeTimingError || text("monitor.controllerUnavailable")}</span>
              <b>{latest?.memory.activeTimings.length ? text("monitor.activeController") : text("common.waiting")}</b>
            </div>
            <div className="timing-groups">
              {visibleTimingGroups.map((group) => <div className="timing-group" key={group}>
                <h4>{text(`monitor.timing.${group}`)}</h4>
                <div className="timing-table">
                  {timingCatalog[group].map((name) => {
                    const timing = timingMap.get(name);
                    return <div className={`timing-row ${timing ? "has-value" : ""}`} key={name}>
                      <strong>{name}</strong>
                      <span>{timing ? `${timing.cycles}T` : "?"}</span>
                      <span>{timing ? `${timing.nanoseconds.toFixed(2)} ns` : "? ns"}</span>
                      <small>{timing?.source ?? text("monitor.controllerOnly")}</small>
                    </div>;
                  })}
                </div>
              </div>)}
            </div>
          </section>

          <section className="memory-stability" aria-label={text("monitor.memoryStability")}>
            <div className="memory-lab-heading">
              <div><span className="eyebrow"><LocalizedText textKey="monitor.openSourceEngine" /></span><h3><LocalizedText textKey="monitor.memoryStability" /></h3></div>
              <div className={`memory-test-state state-${memoryTest?.state ?? "idle"}`}><span />{memoryTest?.stage ?? text("common.waiting")}</div>
            </div>
            <div className="memory-test-layout">
              <div className="memory-test-controls">
                <label><LocalizedText textKey="monitor.testMemory" /><select value={testMemoryMiB} disabled={testRunning} onChange={(event) => setTestMemoryMiB(Number(event.target.value))}><option value={0}>Auto</option><option value={1024}>1 GB</option><option value={2048}>2 GB</option><option value={4096}>4 GB</option><option value={8192}>8 GB</option><option value={16384}>16 GB</option></select></label>
                <label><LocalizedText textKey="monitor.testDuration" /><select value={testDuration} disabled={testRunning} onChange={(event) => setTestDuration(Number(event.target.value))}><option value={60}>1 min</option><option value={300}>5 min</option><option value={900}>15 min</option><option value={1800}>30 min</option><option value={3600}>1 h</option></select></label>
                <label><LocalizedText textKey="monitor.testThreads" /><select value={testThreads} disabled={testRunning} onChange={(event) => setTestThreads(Number(event.target.value))}><option value={0}>Auto</option><option value={4}>4</option><option value={8}>8</option><option value={12}>12</option><option value={16}>16</option></select></label>
                {!testRunning
                  ? <button className="command-button memory-start" type="button" onClick={() => onStartMemoryTest?.(testMemoryMiB, testDuration, testThreads)}><Play size={15} /><LocalizedText textKey="monitor.startMemoryTest" /></button>
                  : <button className="command-button danger-button" type="button" onClick={onStopMemoryTest}><Square size={14} /><LocalizedText textKey="monitor.stopMemoryTest" /></button>}
              </div>
              <div className="memory-test-metrics">
                <div><span><LocalizedText textKey="monitor.allocated" /></span><strong>{memoryTest?.allocatedMiB ? `${memoryTest.allocatedMiB} MB` : "?"}</strong></div>
                <div><span><LocalizedText textKey="monitor.elapsed" /></span><strong>{memoryTest ? `${memoryTest.elapsedSeconds}s / ${memoryTest.durationSeconds || "?"}s` : "?"}</strong></div>
                <div><span><LocalizedText textKey="monitor.passes" /></span><strong>{memoryTest?.passes ?? 0}</strong></div>
                <div><span><LocalizedText textKey="monitor.errors" /></span><strong className={memoryTest?.errors ? "is-error" : "is-good"}>{memoryTest?.errors ?? 0}</strong></div>
                <div><span><LocalizedText textKey="monitor.verified" /></span><strong>{bytes(memoryTest?.testedBytes ?? 0)}</strong></div>
                <div><span><LocalizedText textKey="monitor.bandwidth" /></span><strong>{memoryTest?.throughputMiBs ? `${memoryTest.throughputMiBs.toFixed(0)} MB/s` : "?"}</strong></div>
              </div>
              <div className="memory-health-actions">
                <div className={`whea-status ${memoryTest?.wheaCount24h ? "has-warning" : "is-clear"}`}>
                  {memoryTest?.wheaCount24h ? <ShieldAlert size={22} /> : <ShieldCheck size={22} />}
                  <div><span>WHEA · 24h</span><strong>{memoryTest?.wheaCount24h == null ? "?" : `${memoryTest.wheaCount24h}${memoryTest.wheaCapped ? "+" : ""}`}</strong><small>{memoryTest?.wheaError || (memoryTest?.wheaLastEventId ? `Event ${memoryTest.wheaLastEventId}` : text("monitor.noHardwareErrors"))}</small></div>
                </div>
                <button className="command-button diagnostic-button" type="button" onClick={onOpenWindowsMemoryDiagnostic}><Timer size={15} /><LocalizedText textKey="monitor.windowsDiagnostic" /></button>
              </div>
            </div>
            {memoryTest?.lastError && <div className="memory-test-error"><ShieldAlert size={15} /><span>{memoryTest.lastError}</span></div>}
          </section>
        </div>
      </section>}

      {visible("vram") && <section className="vram-chip-panel widget-flat">
        <div className="section-heading">
          <div><span className="eyebrow"><LocalizedText textKey="monitor.exactPhysicalSensors" /></span><h2><Grid3X3 size={19} /><LocalizedText textKey="monitor.vramChipThermals" /></h2></div>
          <div className={`sensor-source ${latest?.gpu.memoryChipsAvailable ? "is-live" : ""}`}>
            {latest?.gpu.memoryChipsAvailable ? <ShieldCheck size={15} /> : <ShieldAlert size={15} />}
            <span>{latest?.gpu.memoryChipSource ?? "Experimental per-chip providers"}</span>
            {latest?.gpu.memoryChipExperimentalSupported && !latest.gpu.memoryChipsAvailable && <em><FlaskConical size={12} /><LocalizedText textKey="monitor.experimental" /></em>}
          </div>
        </div>
        {latest?.gpu.memoryChipsAvailable ? <>
          <div className="vram-chip-summary">
            <div><span><LocalizedText textKey="monitor.detectedChips" /></span><strong>{latest.gpu.memoryChips.length}</strong></div>
            <div><span><LocalizedText textKey="monitor.coolestChip" /></span><strong>{temperature(chipMinimum)}</strong></div>
            <div><span><LocalizedText textKey="monitor.hottestChip" /></span><strong>{temperature(chipMaximum)}</strong></div>
            <div><span><LocalizedText textKey="monitor.thermalSpread" /></span><strong>{chipSpread === null ? "? C" : `${chipSpread.toFixed(1)} C`}</strong></div>
          </div>
          <div className="vram-chip-map">
            {latest.gpu.memoryChips.map((chip, index) => {
              const intensity = chipMinimum === null || chipMaximum === null || chipMaximum === chipMinimum ? 0.45 : (chip.temperatureC - chipMinimum) / (chipMaximum - chipMinimum);
              return <article className="vram-chip" key={`${chip.channel}-${chip.label}`} style={{ "--chip-heat": intensity, "--chip-color": chipColors[index % chipColors.length] } as CSSProperties}>
                <div><span><LocalizedText textKey="monitor.memoryChip" /> {chip.channel}</span><Grid3X3 size={16} /></div>
                <strong>{temperature(chip.temperatureC)}</strong>
                <small>{chip.label}</small>
                <dl>
                  <div><dt>min</dt><dd>{temperature(chip.minimumC)}</dd></div>
                  <div><dt>avg</dt><dd>{temperature(chip.averageC)}</dd></div>
                  <div><dt>max</dt><dd>{temperature(chip.maximumC)}</dd></div>
                </dl>
              </article>;
            })}
          </div>
          <div className="vram-history chart-frame">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={vramChartData} margin={{ top: 8, right: 10, left: -14, bottom: 0 }}>
                <CartesianGrid stroke="#24303b" vertical={false} />
                <XAxis dataKey="time" stroke="#73808d" tick={{ fontSize: 9 }} minTickGap={34} />
                <YAxis stroke="#73808d" tick={{ fontSize: 9 }} domain={["dataMin - 4", "dataMax + 4"]} unit=" C" width={50} />
                <Tooltip contentStyle={{ background: "#111820", border: "1px solid #34414e", borderRadius: 5, fontSize: 10 }} />
                {vramChannels.map((channel, index) => <Line key={channel} type="monotone" dataKey={`chip-${channel}`} name={`${text("monitor.memoryChip")} ${channel}`} stroke={chipColors[index % chipColors.length]} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={profile.motionLevel === "full"} animationDuration={180} />)}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </> : <div className="vram-provider-diagnostics">
          <div className="vram-fallback-metrics">
            <div><span><LocalizedText textKey="monitor.aggregateTemperature" /></span><strong>{temperature(latest?.gpu.memoryTemperatureC)}</strong></div>
            <div><span><LocalizedText textKey="monitor.memoryClock" /></span><strong>{clock(latest?.gpu.memoryClockMhz)}</strong></div>
            <div><span><LocalizedText textKey="monitor.vramUsage" /></span><strong>{latest?.gpu.memoryUsedMiB == null ? "?" : `${latest.gpu.memoryUsedMiB.toFixed(0)} / ${latest.gpu.memoryTotalMiB?.toFixed(0) ?? "?"} MB`}</strong></div>
            <div><span><LocalizedText textKey="monitor.exactChannels" /></span><strong>0</strong></div>
          </div>
          <div className="vram-provider-empty">
            <Grid3X3 size={28} />
            <div><strong><LocalizedText textKey="monitor.perChipUnavailable" /></strong><span><LocalizedText textKey={latest?.gpu.memoryChipExperimentalSupported ? "monitor.mobileGddr6Experiment" : "monitor.hwinfoUnavailable"} /></span><span><LocalizedText textKey="monitor.hwinfoSetup" /></span>{latest?.gpu.memoryChipError && <code>{latest.gpu.memoryChipError}</code>}<small><LocalizedText textKey="monitor.noSyntheticChipData" /></small></div>
          </div>
          <div className="vram-provider-grid">
            {(latest?.gpu.memoryChipProviders ?? []).map((provider) => <article className={`vram-provider-card state-${provider.state}`} key={provider.id}>
              <div><span className="vram-provider-state" /> <strong>{provider.label}</strong><small><LocalizedText textKey={`monitor.provider.${provider.state}`} /></small></div>
              <dl>
                <div><dt><LocalizedText textKey="monitor.exactChannels" /></dt><dd>{provider.exactChannelCount}</dd></div>
                <div><dt><LocalizedText textKey="monitor.temperatureCandidates" /></dt><dd>{provider.candidateCount}</dd></div>
              </dl>
              <p>{provider.detail}</p>
            </article>)}
          </div>
        </div>}
        {(latest?.gpu.thermalChannels.length ?? 0) > 0 && <div className="gpu-thermal-channels">
          <div className="gpu-thermal-heading">
            <div><strong><LocalizedText textKey="monitor.nativeThermalChannels" /></strong><span>{latest?.gpu.thermalChannelSource}</span></div>
            <small><LocalizedText textKey="monitor.nativeThermalHint" /></small>
          </div>
          <div className="gpu-thermal-grid">
            {latest?.gpu.thermalChannels.map((channel) => <article className={channel.channelType === 3 || channel.primaryMemory ? "is-memory" : ""} key={`${channel.gpuIndex}-${channel.channelIndex}`}>
              <div><span><LocalizedText textKey="monitor.driverChannel" /> {channel.channelIndex}</span><Activity size={14} /></div>
              <strong>{temperature(channel.temperatureC)}</strong>
              <small><LocalizedText textKey="monitor.driverType" /> {channel.channelType === 255 ? text("monitor.privateChannel") : channel.channelType}{channel.primaryMemory ? ` · ${text("monitor.primaryMemory")}` : ""}</small>
            </article>)}
          </div>
          {latest?.gpu.thermalChannelError && <code>{latest.gpu.thermalChannelError}</code>}
        </div>}
      </section>}

      {visible("pcie") && <section className="pcie-panel widget-flat">
        <div className="section-heading">
          <div><span className="eyebrow"><LocalizedText textKey="monitor.nvidiaTransport" /></span><h2><TechnicalTerm term="PCIe bus" /></h2></div>
          <Activity size={20} />
        </div>
        <div className="pcie-content">
          <div className="pcie-readouts">
            <div><TechnicalTerm term="RX" /><strong>{throughput(latest?.pcie.rxMiBs)}</strong></div>
            <div><TechnicalTerm term="TX" /><strong>{throughput(latest?.pcie.txMiBs)}</strong></div>
            <div><LocalizedText textKey="monitor.linkLoad" /><strong>{percent(latest?.pcie.loadPercent)}</strong></div>
            <div><LocalizedText textKey="monitor.activeLink" /><strong>{latest?.pcie.currentGen ? `Gen ${latest.pcie.currentGen} x${latest.pcie.currentWidth}` : "?"}</strong></div>
            <div><LocalizedText textKey="monitor.maximum" /><strong>{latest?.pcie.maxGen ? `Gen ${latest.pcie.maxGen} x${latest.pcie.maxWidth}` : "?"}</strong></div>
          </div>
          <div className="chart-frame pcie-chart">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 8, right: 10, bottom: 0, left: -12 }}>
                <CartesianGrid stroke="#28313b" vertical={false} />
                <XAxis dataKey="time" tick={{ fill: "#7f8b99", fontSize: 10 }} minTickGap={36} />
                <YAxis tick={{ fill: "#7f8b99", fontSize: 10 }} width={48} />
                <Tooltip contentStyle={{ background: "#11161d", border: "1px solid #394452", borderRadius: 6 }} />
                <Area type="monotone" dataKey="rx" stroke="#45d483" fill="#45d483" fillOpacity={0.12} strokeWidth={2} isAnimationActive={false} />
                <Area type="monotone" dataKey="tx" stroke="#55b8ef" fill="#55b8ef" fillOpacity={0.08} strokeWidth={2} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>}

      {(visible("compute") || visible("details")) && <section className="resource-charts">
        {visible("compute") && <article className="chart-panel widget-flat">
          <div className="chart-title chart-title-with-control"><span><Gauge size={17} /><LocalizedText textKey="monitor.computeLoad" /></span><label className="history-resolution"><LocalizedText textKey="monitor.historyResolution" /><select value={profile.telemetryIntervalMs} onChange={(event) => setTelemetryInterval(Number(event.target.value))}>{historyIntervals.map((value) => <option key={value} value={value}>{intervalLabel(value)}</option>)}</select></label></div>
          <div className="chart-frame">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 10, right: 12, bottom: 0, left: -18 }}>
                <CartesianGrid stroke="#28313b" vertical={false} />
                <XAxis dataKey="time" tick={{ fill: "#7f8b99", fontSize: 10 }} minTickGap={36} />
                <YAxis domain={[0, 100]} tick={{ fill: "#7f8b99", fontSize: 10 }} />
                <Tooltip contentStyle={{ background: "#11161d", border: "1px solid #394452", borderRadius: 6 }} />
                <Line type="monotone" dataKey="cpu" stroke="#45d483" dot={false} strokeWidth={2} isAnimationActive={false} />
                <Line type="monotone" dataKey="gpu" stroke="#f4bd52" dot={false} strokeWidth={2} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="chart-title power-history-title"><span><Zap size={17} /><LocalizedText textKey="monitor.powerHistory" /></span><small>{text("monitor.powerNow", { cpu: latest?.cpu.powerW?.toFixed(1) ?? "?", gpu: latest?.gpu.powerW?.toFixed(1) ?? "?" })}</small></div>
          <div className="chart-frame power-history-chart">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 12, bottom: 0, left: -12 }}>
                <defs>
                  <linearGradient id="cpu-power-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#45d483" stopOpacity={0.24} /><stop offset="100%" stopColor="#45d483" stopOpacity={0.01} /></linearGradient>
                  <linearGradient id="gpu-power-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#f4bd52" stopOpacity={0.2} /><stop offset="100%" stopColor="#f4bd52" stopOpacity={0.01} /></linearGradient>
                </defs>
                <CartesianGrid stroke="#28313b" vertical={false} />
                <XAxis dataKey="time" tick={{ fill: "#7f8b99", fontSize: 10 }} minTickGap={36} />
                <YAxis domain={[0, "auto"]} tick={{ fill: "#7f8b99", fontSize: 10 }} unit=" W" width={54} />
                <Tooltip contentStyle={{ background: "#11161d", border: "1px solid #394452", borderRadius: 6 }} formatter={(value) => [`${Number(value).toFixed(1)} W`]} />
                <Area type="monotone" dataKey="cpuPower" name={text("monitor.cpuPower")} stroke="#45d483" fill="url(#cpu-power-fill)" strokeWidth={2} connectNulls={false} isAnimationActive={false} />
                <Area type="monotone" dataKey="gpuPower" name={text("monitor.gpuPower")} stroke="#f4bd52" fill="url(#gpu-power-fill)" strokeWidth={2} connectNulls={false} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="chart-title ram-bus-title"><span><MemoryStick size={17} /><LocalizedText textKey="monitor.ramBusLoad" /></span><small>{latest?.memory.busAvailable ? `${throughput(latest.memory.readMiBs)} R / ${throughput(latest.memory.writeMiBs)} W` : text("common.unavailable")}</small></div>
          <div className="chart-frame ram-bus-chart">
            {latest?.memory.busAvailable && (ramBusHasLoad || ramBusHasThroughput) ? <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 12, bottom: 0, left: -18 }}>
                <CartesianGrid stroke="#28313b" vertical={false} />
                <XAxis dataKey="time" tick={{ fill: "#7f8b99", fontSize: 10 }} minTickGap={36} />
                <YAxis domain={ramBusHasLoad ? [0, 100] : [0, "auto"]} tick={{ fill: "#7f8b99", fontSize: 10 }} />
                <Tooltip contentStyle={{ background: "#11161d", border: "1px solid #394452", borderRadius: 6 }} />
                {ramBusHasLoad
                  ? <Area type="monotone" dataKey="ramBus" stroke="#55b8ef" fill="#55b8ef" fillOpacity={0.12} strokeWidth={2} isAnimationActive={false} connectNulls={false} />
                  : <>
                    <Area type="monotone" dataKey="ramRead" stroke="#55b8ef" fill="#55b8ef" fillOpacity={0.12} strokeWidth={2} isAnimationActive={false} connectNulls={false} />
                    <Area type="monotone" dataKey="ramWrite" stroke="#45d483" fill="#45d483" fillOpacity={0.08} strokeWidth={2} isAnimationActive={false} connectNulls={false} />
                  </>}
              </AreaChart>
            </ResponsiveContainer> : <div className="chart-unavailable"><MemoryStick size={20} /><span>{text("monitor.ramBusUnavailable")}</span><small>{latest?.memory.busSource ?? text("common.waiting")}</small></div>}
          </div>
        </article>}
        {visible("details") && <article className="chart-panel resource-detail-panel widget-flat">
          <div className="chart-title"><Network size={17} /><LocalizedText textKey="monitor.systemDetail" /></div>
          <dl className="resource-detail-list">
            <div><dt>GPU</dt><dd>{latest?.gpu.name ?? text("common.waiting")}</dd></div>
            <div><dt>{text("monitor.networkRx")}</dt><dd>{latest ? `${bytes(latest.network.rxBytesPerSecond)}/s` : "?"}</dd></div>
            <div><dt>{text("monitor.networkTx")}</dt><dd>{latest ? `${bytes(latest.network.txBytesPerSecond)}/s` : "?"}</dd></div>
            <div><dt>{text("monitor.activeRam")}</dt><dd>{latest ? bytes(latest.memory.activeBytes) : "?"}</dd></div>
            <div><dt>{text("monitor.gpuClock")}</dt><dd>{clock(latest?.gpu.graphicsClockMhz)}</dd></div>
            <div><dt>{text("monitor.pcieSource")}</dt><dd>{latest?.pcie.available ? "NVIDIA dmon" : text("common.unavailable")}</dd></div>
          </dl>
          <div className="resource-status">
            <Thermometer size={15} />
            <span>{latest ? text("monitor.updated", { time: new Date(latest.timestamp).toLocaleTimeString([], { hour12: false }) }) : text("monitor.waitingSample")}</span>
          </div>
          <div className="system-power-controls">
            <button className="command-button firmware-reboot" type="button" disabled={systemPowerPending !== null} onClick={() => onScheduleSystemPower?.("restart")}><RotateCcw size={15} /><LocalizedText textKey="monitor.restart" /></button>
            <button className="command-button danger-button firmware-reboot" type="button" disabled={systemPowerPending !== null} onClick={() => onScheduleSystemPower?.("shutdown")}><Power size={15} /><LocalizedText textKey="monitor.shutdown" /></button>
            <button className="command-button firmware-reboot" type="button" disabled={systemPowerPending !== null} onClick={onRebootToFirmware}><CircuitBoard size={15} /><LocalizedText textKey="monitor.rebootFirmware" /></button>
            {systemPowerPending && <button className="command-button power-cancel" type="button" onClick={onCancelSystemPower}><XCircle size={15} /><LocalizedText textKey="monitor.cancelPower" /></button>}
          </div>
        </article>}
      </section>}
    </div>
  );
}
