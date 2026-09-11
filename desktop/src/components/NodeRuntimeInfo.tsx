import { Activity } from "lucide-react";
import { useRef, useState, useSyncExternalStore } from "react";
import { useAppServices } from "../core/appServices";
import { useLocale } from "../i18n/locale";
import { bridge } from "../lib/bridge";
import { formatUptime, updateUptime, type UptimeAnchor, type UptimePeer } from "../lib/nodeUptime";

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let now = Date.now();
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) { now = Date.now(); timer = setInterval(() => { now = Date.now(); listeners.forEach(notify => notify()); }, 1000); }
  return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(timer); timer = undefined; } };
}

export function NodeRuntimeInfo({ nodeId }: { nodeId: string }) {
  const { meshInventory, meshStatus } = useAppServices();
  const { mode } = useLocale();
  const ua = mode === "uk";
  const time = Math.max(useSyncExternalStore(subscribe, () => now), Date.now());
  const inventory = meshInventory as { __receivedAt?: number; nodes?: Array<UptimePeer & { tag?: string; mac?: string }> } | null;
  const peer = inventory?.nodes?.find(item => item.tag?.toLowerCase() === nodeId.toLowerCase());
  const mac = peer?.mac ?? (nodeId === "node0" ? meshStatus.rootIdentity : null);
  const anchor = useRef<UptimeAnchor | null>(null);
  anchor.current = updateUptime(anchor.current, peer, meshStatus.connected, inventory?.__receivedAt ?? NaN, time);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = Boolean(mac && meshStatus.connected && meshStatus.transport === "wss" && meshStatus.address);
  const label = ua ? "Відкрити Task Monitor у браузері" : "Open Task Monitor in browser";
  const open = async () => {
    if (busy || !available || !mac) return;
    setBusy(true); setError(null);
    try { await bridge.mesh.openTaskMonitor(mac); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  return <span className="node-runtime-info">
    <small title={ua ? "Час від останнього запуску firmware" : "Time since the last firmware boot"}>{ua ? "Аптайм" : "Uptime"}: {formatUptime(anchor.current?.value ?? null, ua ? " д" : "d")}{anchor.current && !anchor.current.live ? ua ? " · останнє відоме" : " · last known" : ""}</small>
    <button type="button" className="widget-icon-button" title={available ? label : ua ? "HTTPS root недоступний" : "HTTPS root unavailable"} aria-label={label} disabled={!available || busy} onClick={() => void open()}><Activity size={16} /></button>
    {error && <small role="alert">{error}</small>}
  </span>;
}
