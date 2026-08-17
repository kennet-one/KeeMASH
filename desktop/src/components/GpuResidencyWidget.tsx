import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, CircleGauge, Cpu, MemoryStick, OctagonX, RefreshCw, RotateCcw, Save, Shield, Trash2, TriangleAlert, Unplug, X } from "lucide-react";
import { useAppServices } from "../core/appServices";
import { useLocale } from "../i18n/locale";
import type { GpuPolicyPreset, GpuProcessResidency, ProcessActionResult } from "../types";

const GPU_PRIORITIES = [
  [0, "Idle"], [1, "Below normal"], [2, "Normal"], [3, "Above normal"], [4, "High"],
] as const;
const RAM_PRIORITIES = [
  [1, "Very low"], [2, "Low"], [3, "Medium"], [4, "Below normal"], [5, "Normal"],
] as const;
const PRESETS: Record<Exclude<GpuPolicyPreset, "custom">, { gpu: number; ram: number }> = {
  protect: { gpu: 3, ram: 5 }, balanced: { gpu: 2, ram: 5 }, yield: { gpu: 1, ram: 2 },
};

function bytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) { current /= 1024; unit++; }
  return `${current.toFixed(unit >= 3 ? 2 : unit === 2 ? 0 : 1)} ${units[unit]}`;
}

function resultText(result: ProcessActionResult): string {
  if (result.success) return result.message;
  return result.errors.length ? `${result.message}: ${result.errors.join("; ")}` : result.message;
}

function ProcessPolicyEditor({ process }: { process: GpuProcessResidency }) {
  const app = useAppServices();
  const { text } = useLocale();
  const initialPreset = process.appliedRule?.preset ?? "balanced";
  const [preset, setPreset] = useState<GpuPolicyPreset>(initialPreset);
  const [gpuPriority, setGpuPriority] = useState(process.gpuPriority ?? PRESETS.balanced.gpu);
  const [ramPriority, setRamPriority] = useState(process.ramPriority ?? PRESETS.balanced.ram);
  const [persist, setPersist] = useState(Boolean(process.appliedRule));
  const [message, setMessage] = useState<string | null>(null);
  const [forceVisible, setForceVisible] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const appliedRuleKey = process.appliedRule
    ? `${process.appliedRule.preset}:${process.appliedRule.gpuPriority}:${process.appliedRule.ramPriority}:${process.appliedRule.autoAttach}`
    : "";

  useEffect(() => {
    if (!process.appliedRule) return;
    setPreset(process.appliedRule.preset);
    setGpuPriority(process.appliedRule.gpuPriority);
    setRamPriority(process.appliedRule.ramPriority);
    setPersist(true);
  }, [appliedRuleKey]);

  const selectPreset = (next: GpuPolicyPreset) => {
    setPreset(next);
    if (next !== "custom") {
      setGpuPriority(PRESETS[next].gpu);
      setRamPriority(PRESETS[next].ram);
    }
  };

  const apply = async () => {
    setMessage(null);
    try {
      const result = await app.applyGpuPolicy({
        identity: process.identity, preset, gpuPriority, ramPriority, persist,
        autoAttach: false, agentAllowed: false,
      });
      setMessage(result.message);
      setCanUndo(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const undo = async () => {
    try {
      const result = await app.undoGpuPolicy(process.identity);
      setMessage(result.message);
      setCanUndo(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const close = async () => {
    try {
      const result = await app.closeProcess(process.identity);
      setMessage(resultText(result));
      setForceVisible(result.stillRunning);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const force = async (tree: boolean) => {
    try {
      const result = tree
        ? await app.terminateProcessTree(process.identity)
        : await app.terminateProcess(process.identity);
      setMessage(resultText(result));
      setForceVisible(result.stillRunning);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return <div className="residency-process-detail">
    <div className="residency-identity">
      <code>{process.identity.executablePath || "path unavailable"}</code>
      <span>{process.adapters.join(", ") || "adapter ?"}</span>
      <span>{process.engines.join(", ") || "engine idle"}</span>
    </div>
    <div className="residency-policy-grid">
      <label><span>{text("monitor.residency.preset")}</span><select value={preset} disabled={!process.manageable || app.gpuResidencyBusy} onChange={(event) => selectPreset(event.target.value as GpuPolicyPreset)}><option value="protect">Protect</option><option value="balanced">Balanced</option><option value="yield">Yield</option><option value="custom">Custom</option></select></label>
      <label><span>{text("monitor.residency.gpuPriority")}</span><select value={gpuPriority} disabled={!process.manageable || app.gpuResidencyBusy} onChange={(event) => { setGpuPriority(Number(event.target.value)); setPreset("custom"); }}>{GPU_PRIORITIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><span>{text("monitor.residency.ramPriority")}</span><select value={ramPriority} disabled={!process.manageable || app.gpuResidencyBusy} onChange={(event) => { setRamPriority(Number(event.target.value)); setPreset("custom"); }}>{RAM_PRIORITIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="residency-check"><input type="checkbox" checked={persist} disabled={!process.manageable || app.gpuResidencyBusy} onChange={(event) => setPersist(event.target.checked)} /><span>{text("monitor.residency.remember")}</span></label>
    </div>
    <div className="residency-actions">
      <button type="button" className="command-button memory-start" disabled={!process.manageable || app.gpuResidencyBusy} onClick={() => void apply()}><Save size={14} />{text("monitor.residency.apply")}</button>
      {canUndo && <button type="button" className="command-button" disabled={app.gpuResidencyBusy} onClick={() => void undo()}><RotateCcw size={14} />{text("shell.undo")}</button>}
      {process.appliedRule && <button type="button" className="command-button" disabled={app.gpuResidencyBusy} onClick={() => void app.removeGpuRule(process.identity.executablePath).then(() => setMessage(text("monitor.residency.ruleRemoved"))).catch((error) => setMessage(error instanceof Error ? error.message : String(error)))}><Trash2 size={14} />{text("monitor.residency.forget")}</button>}
      <button type="button" className="command-button danger-button" disabled={!process.manageable || app.gpuResidencyBusy} onClick={() => void close()} title={text("monitor.residency.closeProcess")}><OctagonX size={14} />{text("monitor.residency.closeProcess")}</button>
    </div>
    {forceVisible && <div className="residency-force-actions"><TriangleAlert size={16} /><span>{text("monitor.residency.didNotClose")}</span><button type="button" className="command-button danger-button" disabled={app.gpuResidencyBusy} onClick={() => void force(false)}>{text("monitor.residency.kill")}</button><button type="button" className="command-button danger-button" disabled={app.gpuResidencyBusy} onClick={() => void force(true)}>{text("monitor.residency.killTree")}</button><button type="button" className="icon-button" onClick={() => setForceVisible(false)} title={text("common.cancel")}><X size={14} /></button></div>}
    {app.gpuResidency?.agentAvailable && <div className="residency-resource-area">
      <div><strong>{text("monitor.residency.allocations")}</strong><span className={`agent-badge state-${process.agentState}`}><Unplug size={12} />{process.agentState}</span></div>
      {process.resourceGroups.length === 0
        ? <p>{process.agentMessage}</p>
        : process.resourceGroups.map((group) => <section key={group.kind}><header><b>{group.kind}</b><span>{group.count} / {bytes(group.bytes)}</span></header>{group.resources.map((resource) => <div className="residency-resource-row" key={resource.resourceId}><code>{resource.resourceId}</code><span>{resource.format}</span><span>{resource.dimensions}</span><strong>{bytes(resource.bytes)}</strong><em>{resource.priority}</em></div>)}</section>)}
    </div>}
    {message && <div className="residency-message">{message}</div>}
  </div>;
}

export function GpuResidencyWidget() {
  const app = useAppServices();
  const { text } = useLocale();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const snapshot = app.gpuResidency;
  const processes = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    if (!query) return snapshot?.processes ?? [];
    return (snapshot?.processes ?? []).filter((process) => `${process.name} ${process.identity.pid} ${process.identity.executablePath}`.toLocaleLowerCase().includes(query));
  }, [filter, snapshot?.processes]);

  return <section className="gpu-residency-panel">
    <header className="residency-header">
      <div><span className="eyebrow">Windows WDDM</span><h2><MemoryStick size={18} />{text("monitor.residency.title")}</h2></div>
      <div className="residency-header-actions"><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={text("monitor.residency.filter")} /><button type="button" className="icon-button" disabled={app.gpuResidencyBusy} onClick={app.refreshGpuResidency} title={text("common.refresh")}><RefreshCw size={15} /></button></div>
    </header>
    <div className="residency-summary">
      <div><span>{text("monitor.residency.physical")}</span><strong>{bytes(snapshot?.physicalUsedBytes ?? 0)} / {bytes(snapshot?.physicalTotalBytes ?? 0)}</strong><small>{(snapshot?.pressurePercent ?? 0).toFixed(1)}%</small></div>
      <div><span>{text("monitor.residency.tracked")}</span><strong>{bytes(snapshot?.trackedDedicatedBytes ?? 0)}</strong><small>dedicated</small></div>
      <div><span>{text("monitor.residency.shared")}</span><strong>{bytes(snapshot?.trackedSharedBytes ?? 0)}</strong><small>system RAM</small></div>
      <div><span>{text("monitor.residency.unaccounted")}</span><strong>{bytes(snapshot?.unaccountedBytes ?? 0)}</strong><small>{snapshot?.processes.length ?? 0} processes</small></div>
    </div>
    {app.gpuResidencyError && <div className="residency-error"><TriangleAlert size={15} />{app.gpuResidencyError}</div>}
    <div className="residency-source"><CircleGauge size={14} /><span>{snapshot?.source ?? text("common.waiting")}</span><small>{snapshot?.sourceWarning}</small></div>
    <div className="residency-process-list">
      <div className="residency-process-head"><span>{text("monitor.residency.process")}</span><span>VRAM</span><span>{text("monitor.residency.shared")}</span><span>GPU</span><span>{text("monitor.residency.policy")}</span></div>
      {processes.map((process) => {
        const key = `${process.identity.pid}:${process.identity.startedAt}`;
        const open = expanded === key;
        return <article className={`residency-process ${open ? "is-expanded" : ""}`} key={key}>
          <button type="button" className="residency-process-row" onClick={() => setExpanded(open ? null : key)}>
            <span className="residency-process-name">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Cpu size={15} /><b>{process.name}</b><small>PID {process.identity.pid}</small>{process.protected && <Shield size={12} />}</span>
            <strong>{bytes(process.dedicatedBytes)}</strong><span>{bytes(process.sharedBytes)}</span><span>{process.gpuPercent.toFixed(1)}%</span><em>{process.appliedRule?.preset ?? "live"}</em>
          </button>
          {open && <ProcessPolicyEditor process={process} />}
        </article>;
      })}
      {!processes.length && <div className="residency-empty">{snapshot ? text("monitor.residency.noProcesses") : text("common.waiting")}</div>}
    </div>
  </section>;
}
