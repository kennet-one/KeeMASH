import { meshNodeDefinitions, type MeshNodeId } from "./operationalGraph";
import type { LegacyState, SensorKey } from "./protocol";

export interface SignalProvider {
  nodeId: MeshNodeId;
  label: string;
  endpoints: SignalEndpoint[];
}

export interface SignalEndpoint {
  id: string;
  nodeId: MeshNodeId;
  signal: SensorKey;
  unit: string;
  routingDeployed: boolean;
}

export interface SignalBindingStatus {
  endpoint: SignalEndpoint | null;
  available: boolean;
  routingDeployed: boolean;
}

const units: Partial<Record<SensorKey, string>> = {
  temperatureC: "C",
  humidityPercent: "%",
  ppm: "ppm",
  lux: "lx",
};

export const signalProviders: SignalProvider[] = meshNodeDefinitions
  .filter((node) => node.sensors.length > 0)
  .map((node) => ({
    nodeId: node.id,
    label: node.tag,
    endpoints: node.sensors.map((signal) => ({
      id: `${node.id}.${signal}`,
      nodeId: node.id,
      signal,
      unit: units[signal] ?? "",
      routingDeployed: node.id === "esp_mixer" && signal === "temperatureC",
    })),
  }));

export function signalEndpointsFor(signal: SensorKey): SignalEndpoint[] {
  return signalProviders.flatMap((provider) => provider.endpoints).filter((endpoint) => endpoint.signal === signal);
}

export function resolveSignalBinding(endpointId: string, state: LegacyState): SignalBindingStatus {
  const endpoint = signalProviders.flatMap((provider) => provider.endpoints).find((item) => item.id === endpointId) ?? null;
  if (!endpoint) return { endpoint: null, available: false, routingDeployed: false };
  const activity = state.nodeActivity[endpoint.nodeId];
  const sensorSeen = state.sensorUpdatedAt[endpoint.signal];
  const lastSeen = Math.max(activity?.lastSeenAt ?? 0, sensorSeen ?? 0);
  return {
    endpoint,
    available: lastSeen > 0 && Date.now() - lastSeen < 180_000 && state.sensors[endpoint.signal] !== null,
    routingDeployed: endpoint.routingDeployed,
  };
}
