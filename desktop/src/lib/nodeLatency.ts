import { useEffect, useRef, useSyncExternalStore } from "react";
import { normalizeMeshMac } from "./typedSensors";
import { bridge } from "./bridge";
import { LatencyRefresh } from "./latencyRefresh";

export interface NodeLatency { mac: string; correlationId: number; connectionId: number; rttMs: number; transport: string; receivedAt: number }
let snapshot: Record<string, NodeLatency> = {};
let connectionId = 0;
let transport = "none";
const listeners = new Set<() => void>();
export const latencyRefresh = new LatencyRefresh(
  target => bridge.mesh.send(target.owner, target.command),
  (mac, now) => Boolean(snapshot[mac] && now - snapshot[mac].receivedAt < 30_000),
);
export function clearNodeLatencies(): void { snapshot = {}; listeners.forEach(listener => listener()); }
export function setLatencyConnection(id: number, kind: string): void {
  if (connectionId === id && transport === kind) return;
  connectionId = id;
  transport = kind;
  clearNodeLatencies();
}
export function getNodeLatency(mac: string): NodeLatency | undefined { return snapshot[mac]; }
export function recordNodeLatency(event: Omit<NodeLatency, "receivedAt">, now = Date.now()): void {
  if (connectionId <= 0 || event.connectionId !== connectionId || event.transport !== transport) return;
  const mac = normalizeMeshMac(event.mac);
  if (!Number.isInteger(event.correlationId) || event.correlationId <= 0 || event.correlationId > 0xffffffff) return;
  if (!mac || !Number.isFinite(event.rttMs) || event.rttMs < 0 || event.rttMs > 30_000) return;
  if (snapshot[mac]?.correlationId === event.correlationId) return;
  if (!snapshot[mac] && Object.keys(snapshot).length >= 64) return;
  snapshot = { ...snapshot, [mac]: { ...event, mac, receivedAt: now } };
  listeners.forEach(listener => listener());
}

export function useLatencyProbe(mac: string | null, owner: string, command: string | undefined, enabled: boolean) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!mac || !command || !enabled || !ref.current) return;
    let unregister: (() => void) | undefined;
    const key = `${owner}:${mac}`;
    const observer = new IntersectionObserver(entries => {
      unregister?.(); unregister = undefined;
      if (entries.some(entry => entry.isIntersecting)) unregister = latencyRefresh.register(key, { mac, owner, command });
    });
    observer.observe(ref.current);
    return () => { observer.disconnect(); unregister?.(); };
  }, [mac, owner, command, enabled]);
  return ref;
}
export function useNodeLatency(mac: string | null): NodeLatency | undefined {
  const values = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot);
  return mac ? values[mac] : undefined;
}
