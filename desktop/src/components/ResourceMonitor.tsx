import { Activity, Cpu, Gauge, HardDrive, MemoryStick, Network, Thermometer, Zap } from "lucide-react";
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
import type { ResourceSample } from "../types";

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

interface MeterProps {
  label: string;
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

interface ResourceMonitorProps {
  latest: ResourceSample | null;
  history: ResourceSample[];
}

export function ResourceMonitor({ latest, history }: ResourceMonitorProps) {
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
      <section className="resource-summary">
        <Meter
          label="CPU"
          value={percent(latest?.cpu.loadPercent)}
          detail={latest?.cpu.temperatureC == null ? "temperature ?" : `${latest.cpu.temperatureC.toFixed(0)} C / ${latest.cpu.cores.length} threads`}
          progress={latest?.cpu.loadPercent ?? null}
          tone="green"
          icon={Cpu}
        />
        <Meter
          label="RAM"
          value={ramPercent === null ? "?" : percent(ramPercent)}
          detail={latest ? `${bytes(latest.memory.usedBytes)} / ${bytes(latest.memory.totalBytes)}` : "waiting"}
          progress={ramPercent}
          tone="cyan"
          icon={MemoryStick}
        />
        <Meter
          label="GPU"
          value={percent(latest?.gpu.loadPercent)}
          detail={latest?.gpu.available ? `${latest.gpu.temperatureC ?? "?"} C / ${latest.gpu.powerW?.toFixed(0) ?? "?"} W` : "unavailable"}
          progress={latest?.gpu.loadPercent ?? null}
          tone="yellow"
          icon={Zap}
        />
        <Meter
          label="VRAM"
          value={gpuMemoryPercent === null ? "?" : percent(gpuMemoryPercent)}
          detail={latest?.gpu.memoryUsedMiB == null ? "unavailable" : `${latest.gpu.memoryUsedMiB.toFixed(0)} / ${latest.gpu.memoryTotalMiB?.toFixed(0)} MiB`}
          progress={gpuMemoryPercent}
          tone="red"
          icon={HardDrive}
        />
      </section>

      <section className="pcie-panel">
        <div className="section-heading">
          <div><span className="eyebrow">NVIDIA transport</span><h2>PCIe bus</h2></div>
          <Activity size={20} />
        </div>
        <div className="pcie-content">
          <div className="pcie-readouts">
            <div><span>RX</span><strong>{throughput(latest?.pcie.rxMiBs)}</strong></div>
            <div><span>TX</span><strong>{throughput(latest?.pcie.txMiBs)}</strong></div>
            <div><span>Link load</span><strong>{percent(latest?.pcie.loadPercent)}</strong></div>
            <div><span>Active link</span><strong>{latest?.pcie.currentGen ? `Gen ${latest.pcie.currentGen} x${latest.pcie.currentWidth}` : "?"}</strong></div>
            <div><span>Maximum</span><strong>{latest?.pcie.maxGen ? `Gen ${latest.pcie.maxGen} x${latest.pcie.maxWidth}` : "?"}</strong></div>
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
      </section>

      <section className="resource-charts">
        <article className="chart-panel">
          <div className="chart-title"><Gauge size={17} /><span>Compute load</span></div>
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
        </article>
        <article className="chart-panel resource-detail-panel">
          <div className="chart-title"><Network size={17} /><span>System detail</span></div>
          <dl className="resource-detail-list">
            <div><dt>GPU</dt><dd>{latest?.gpu.name ?? "Waiting"}</dd></div>
            <div><dt>Network RX</dt><dd>{latest ? `${bytes(latest.network.rxBytesPerSecond)}/s` : "?"}</dd></div>
            <div><dt>Network TX</dt><dd>{latest ? `${bytes(latest.network.txBytesPerSecond)}/s` : "?"}</dd></div>
            <div><dt>Active RAM</dt><dd>{latest ? bytes(latest.memory.activeBytes) : "?"}</dd></div>
            <div><dt>CPU temperature</dt><dd>{latest?.cpu.temperatureC == null ? "?" : `${latest.cpu.temperatureC.toFixed(1)} C`}</dd></div>
            <div><dt>PCIe source</dt><dd>{latest?.pcie.available ? "NVIDIA dmon" : "Unavailable"}</dd></div>
          </dl>
          <div className="resource-status">
            <Thermometer size={15} />
            <span>{latest ? `Updated ${new Date(latest.timestamp).toLocaleTimeString([], { hour12: false })}` : "Waiting for sample"}</span>
          </div>
        </article>
      </section>
    </div>
  );
}
