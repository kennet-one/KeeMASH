import { ResourceMonitor, type ResourceSection } from "../components/ResourceMonitor";
import { useAppServices } from "../core/appServices";
import { Cpu, Play, RefreshCw, RotateCcw, Square, TerminalSquare } from "lucide-react";
import { LocalizedText } from "../i18n/locale";
export { GpuResidencyWidget as GpuResidencyModuleWidget } from "../components/GpuResidencyWidget";

function bytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = Math.max(0, value);
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) { current /= 1024; unit++; }
  return `${current.toFixed(unit >= 3 ? 2 : 0)} ${units[unit]}`;
}

function Resource({ section }: { section: ResourceSection }) { const app = useAppServices(); return <ResourceMonitor latest={app.resources.at(-1) ?? null} history={app.resources} sections={[section]} memoryTest={app.memoryTest} onStartMemoryTest={app.startMemoryTest} onStopMemoryTest={app.stopMemoryTest} onOpenWindowsMemoryDiagnostic={app.openWindowsMemoryDiagnostic} onRebootToFirmware={app.rebootToFirmware} onScheduleSystemPower={app.scheduleSystemPower} onCancelSystemPower={app.cancelSystemPower} systemPowerPending={app.systemPowerPending} />; }
export const SummaryModuleWidget = () => <Resource section="summary" />;
export const ThermalsModuleWidget = () => <Resource section="thermals" />;
export const VramModuleWidget = () => <Resource section="vram" />;
export const PcieModuleWidget = () => <Resource section="pcie" />;
export const ComputeModuleWidget = () => <Resource section="compute" />;
export const DetailsModuleWidget = () => <Resource section="details" />;

export function CccDaemonModuleWidget() {
  const app = useAppServices();
  const status = app.cccStatus;
  const process = status?.process;
  const running = status?.state === "running" && status.identityValid;
  return <section className="ccc-daemon-panel">
    <header>
      <div><span className="eyebrow"><LocalizedText textKey="monitor.ccc.sharedRuntime" /></span><h2><Cpu size={18} /><LocalizedText textKey="monitor.ccc.title" /></h2></div>
      <div className={`ccc-state state-${status?.state ?? "loading"}`}><span />{status?.state ?? "loading"}</div>
    </header>
    <div className="ccc-metrics">
      <div><span>PID</span><strong>{process?.pid ?? "?"}</strong><small>{status?.pidSource ?? "none"}</small></div>
      <div><span><LocalizedText textKey="monitor.ccc.workingSet" /></span><strong>{bytes(process?.workingSetBytes)}</strong><small><LocalizedText textKey="monitor.ccc.physicalRam" /></small></div>
      <div><span><LocalizedText textKey="monitor.ccc.privateBytes" /></span><strong>{bytes(process?.privateBytes)}</strong><small><LocalizedText textKey="monitor.ccc.committedMemory" /></small></div>
      <div><span><LocalizedText textKey="monitor.ccc.dedicatedVram" /></span><strong>{bytes(process?.gpuMemory.dedicatedBytes)}</strong><small>{process?.gpuMemory.instanceCount ?? 0} GPU engines</small></div>
      <div><span><LocalizedText textKey="monitor.ccc.sharedGpu" /></span><strong>{bytes(process?.gpuMemory.sharedBytes)}</strong><small><LocalizedText textKey="monitor.ccc.systemRamMapped" /></small></div>
      <div><span><LocalizedText textKey="monitor.ccc.threads" /></span><strong>{process?.threadCount ?? "?"}</strong><small>{process?.name ?? "?"}</small></div>
    </div>
    <div className={`ccc-identity ${status?.identityValid ? "is-valid" : ""}`}><TerminalSquare size={15} /><div><strong>{status?.message ?? "CCC status is loading"}</strong><code>{process?.commandLine || status?.cliPath || "?"}</code></div></div>
    <div className="ccc-actions">
      <button className="command-button" type="button" disabled={app.cccBusy} onClick={app.refreshCcc}><RefreshCw size={15} /><LocalizedText textKey="common.refresh" /></button>
      {!running && <button className="command-button memory-start" type="button" disabled={app.cccBusy || status?.cliAvailable === false} onClick={() => app.manageCcc("start")}><Play size={15} /><LocalizedText textKey="monitor.ccc.start" /></button>}
      {running && <button className="command-button" type="button" disabled={app.cccBusy} onClick={() => app.manageCcc("restart")}><RotateCcw size={15} /><LocalizedText textKey="monitor.ccc.restart" /></button>}
      {running && <button className="command-button danger-button" type="button" disabled={app.cccBusy} onClick={() => app.manageCcc("stop")}><Square size={14} /><LocalizedText textKey="monitor.ccc.stop" /></button>}
    </div>
  </section>;
}
