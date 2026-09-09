import { meshNodeDefinitions, meshNodeIdForTag, type LiveMeshInventory } from "./operationalGraph";
import type { LegacyState } from "./protocol";
import { normalizeMeshMac, type TypedSensorMetric } from "./typedSensors";

export interface ClimateProvider {
  mac: string;
  nodeId: string | null;
  tag: string;
  connected: boolean;
  metric?: TypedSensorMetric;
}

export function climateProviders(state: LegacyState, inventory: Partial<LiveMeshInventory> | null, heaterMac: string | null): ClimateProvider[] {
  const sources = new Map<string, ClimateProvider>();
  for (const source of Object.values(state.typedSensors)) {
    if (source.metrics.temperatureC !== undefined) sources.set(source.mac, {
      mac: source.mac, nodeId: source.nodeId, tag: source.tag ?? source.mac,
      connected: source.connected, metric: source.metrics.temperatureC,
    });
  }
  for (const node of inventory?.nodes ?? []) {
    const mac = normalizeMeshMac(node.mac);
    const nodeId = meshNodeIdForTag(node.tag);
    if (!mac) continue;
    const old = sources.get(mac);
    if (old || meshNodeDefinitions.some(item => item.id === nodeId && item.sensors.includes("temperatureC"))) {
      sources.set(mac, { ...old, mac, nodeId, tag: node.tag || mac, connected: node.offline !== true });
    }
  }
  return [...sources.values()].filter(source => source.mac !== heaterMac && source.nodeId !== "Kheater");
}

export function climateProviderState(source: ClimateProvider, now: number): "offline" | "waiting" | "unknownAge" | "error" | "invalid" | "stale" | "fresh" {
  if (!source.connected) return "offline";
  const metric = source.metric;
  if (!metric) return "waiting";
  if (metric.error) return "error";
  if (!metric.valid && !metric.stale) return "invalid";
  if (metric.stale) return "stale";
  if (metric.ageAtReceiptMs === null) return "unknownAge";
  return metric.ageAtReceiptMs + Math.max(0, now - metric.receivedAt) >= 30_000 ? "stale" : "fresh";
}
