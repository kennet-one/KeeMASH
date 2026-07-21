import {
  Activity,
  CircuitBoard,
  Cpu,
  Gauge,
  HardDrive,
  MemoryStick,
  Microchip,
  Network,
  ShieldCheck,
  Thermometer,
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
import type { ReactNode } from "react";
import { LocalizedText, useLocale } from "../i18n/locale";
import type { ResourceSample } from "../types";
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

export type ResourceSection = "summary" | "thermals" | "pcie" | "compute" | "details";

interface ResourceMonitorProps {
  latest: ResourceSample | null;
  history: ResourceSample[];
  sections?: ResourceSection[];
}

export function ResourceMonitor({ latest, history, sections }: ResourceMonitorProps) {
  const { text } = useLocale();
  const visible = (section: ResourceSection) => !sections || sections.includes(section);
  const ramPercent = latest ? (latest.memory.usedBytes / latest.memory.totalBytes) * 100 : null;
  const gpuMemoryPercent = latest?.gpu.memoryUsedMiB !== null && latest?.gpu.memoryTotalMiB
    ? (latest.gpu.memoryUsedMiB / latest.gpu.memoryTotalMiB) * 100
    : null;
  const chartData = history.map((sample) => ({
    time: new Date(sample.timestamp).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" }),
    cpu: sample.cpu.loadPercent,
    ram: (sample.memory.usedBytes / sample.memory.totalBytes) * 100,
    gpu: sample.gpu.loadPercent ?? 0,
    rx: sample.pcie.rxMiBs ?? 0,
    tx: sample.pcie.txMiBs ?? 0,
    pcie: sample.pcie.loadPercent ?? 0,
  }));

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
                  </div>
                  <b>{temperature(module.temperatureC)}</b>
                </div>
              )) : (
                <div className="dimm-empty"><Microchip size={16} /><LocalizedText textKey="monitor.moduleInventory" /></div>
              )}
            </div>
          </div>
        </div>
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
          <div className="chart-title"><Gauge size={17} /><LocalizedText textKey="monitor.computeLoad" /></div>
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
        </article>}
      </section>}
    </div>
  );
}
