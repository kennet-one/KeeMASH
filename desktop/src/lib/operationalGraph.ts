import type { DeviceKey, LegacyState, SensorKey } from "./protocol";
import { parseChoinkaStatus } from "./choinkaStatus";

export type MeshDomainId = "lighting" | "climate";
export type MeshNodeId = string;

export interface LiveMeshInventoryNode {
  mac: string;
  tag: string;
  offline?: boolean;
  app_stale?: boolean;
  telemetry_fresh?: boolean;
}

export interface LiveMeshInventory {
  nodes: LiveMeshInventoryNode[];
}

export interface MeshNodeDefinition {
  id: MeshNodeId;
  tag: string;
  domains: MeshDomainId[];
  roleKey: string;
  devices: DeviceKey[];
  sensors: SensorKey[];
  feedbackCommands: string[];
  replyPatterns: RegExp[];
}

export interface MeshGraphEdge {
  from: "node0" | MeshDomainId;
  to: MeshDomainId | MeshNodeId;
  kind: "routes" | "contains";
}

export interface GraphPoint {
  x: number;
  y: number;
}

export type MeshNodeRuntimeState = "observed" | "waiting" | "error";

export interface MeshNodeSnapshot {
  definition: MeshNodeDefinition;
  state: MeshNodeRuntimeState;
  knownSignals: number;
  totalSignals: number;
  lastSeenAt: number | null;
  error: string | null;
}

export const meshNodeDefinitions: MeshNodeDefinition[] = [
  {
    id: "node0",
    tag: "node0",
    domains: ["lighting", "climate"],
    roleKey: "controls.nodeRoleRoot",
    devices: [],
    sensors: [],
    feedbackCommands: [],
    replyPatterns: [/^(hello|kyy)$/],
  },
  {
    id: "garland",
    tag: "garland",
    domains: ["lighting"],
    roleKey: "controls.nodeRoleLighting",
    devices: ["garland"],
    sensors: [],
    feedbackCommands: ["garland_echo"],
    replyPatterns: [/^(garland_(on|off)|garl[01])$/],
  },
  {
    id: "esp_mixer",
    tag: "esp_mixer",
    domains: ["lighting", "climate"],
    roleKey: "controls.nodeRoleEnvironment",
    devices: [],
    sensors: ["ppm", "temperatureC", "humidityPercent", "lux"],
    // The old sens_echo handler emits four painlessMesh frames back-to-back.
    // Spacing the individual requests in the existing refresh queue avoids burst loss.
    feedbackCommands: ["ppm_echo", "temp_echo", "humi_echo", "lux_echo"],
    replyPatterns: [/^(04|05|06|07)/],
  },
  {
    id: "bedside_light",
    tag: "bedside_light",
    domains: ["lighting"],
    roleKey: "controls.nodeRoleLighting",
    devices: ["bedside"],
    sensors: [],
    feedbackCommands: ["bedside_echo"],
    replyPatterns: [/^(bdsdl[01]|bedsi_(on|off))$/],
  },
  {
    id: "lampk",
    tag: "lampk",
    domains: ["lighting"],
    roleKey: "controls.nodeRoleLighting",
    devices: ["lamp"],
    sensors: [],
    feedbackCommands: ["lamech"],
    replyPatterns: [/^La[01]$/],
  },
  {
    id: "kPowerLed",
    tag: "kPowerLed",
    domains: ["lighting"],
    roleKey: "controls.nodeRoleLighting",
    devices: ["powerLed"],
    sensors: [],
    feedbackCommands: ["pwech", "PSQ"],
    replyPatterns: [/^(feedpowled[01]|powled[01]|PS[MPD])/],
  },
  {
    id: "humidifier",
    tag: "humidifier",
    domains: ["climate"],
    roleKey: "controls.nodeRoleAir",
    devices: ["pump", "flow", "ionizer"],
    sensors: ["pm1", "pm25", "pm10"],
    feedbackCommands: ["echo_turb", "pm1"],
    replyPatterns: [/^(10|11|12|13|14|15|16|17|20|21)/],
  },
  {
    id: "choinka",
    tag: "choinka",
    domains: ["climate"],
    roleKey: "controls.nodeRoleWater",
    devices: [],
    sensors: [],
    feedbackCommands: ["choinka.status"],
    replyPatterns: [/^(pimpa|pomp[01])$/],
  },
  {
    id: "Kheater",
    tag: "Kheater",
    domains: ["climate"],
    roleKey: "controls.nodeRoleHeat",
    devices: ["heater", "heaterRotation"],
    sensors: [],
    feedbackCommands: ["heho", "D5Q"],
    replyPatterns: [/^(09|25|R5|A5|H5|D5S|S5[MPD])/],
  },
  {
    id: "jajowar",
    tag: "jajowar",
    domains: ["climate"],
    roleKey: "controls.nodeRoleAppliance",
    devices: ["eggCooker"],
    sensors: [],
    feedbackCommands: ["jajoeh"],
    replyPatterns: [/^(jajo_start|jajo_on|jaeh)$/],
  },
];

export const meshGraphEdges: MeshGraphEdge[] = [
  { from: "node0", to: "lighting", kind: "routes" },
  { from: "node0", to: "climate", kind: "routes" },
  ...meshNodeDefinitions
    .filter((node) => node.id !== "node0")
    .flatMap((node) => node.domains.map((domain) => ({ from: domain, to: node.id, kind: "contains" as const }))),
];

export const meshFeedbackCommands = meshNodeDefinitions
  .flatMap((node) => node.feedbackCommands)
  .filter((command, index, commands) => commands.indexOf(command) === index);

export function meshFeedbackCommandsForTag(tag: string): string[] {
  return meshNodeDefinitions.find((node) => node.tag.toLowerCase() === tag.toLowerCase())
    ?.feedbackCommands ?? [];
}

export function meshFeedbackOwner(command: string): MeshNodeId | null {
  const owners = meshNodeDefinitions.filter((node) => node.feedbackCommands.includes(command));
  return owners.length === 1 ? owners[0].id : null;
}

const nodeByTag = new Map(meshNodeDefinitions.map((node) => [node.tag.toLowerCase(), node.id]));

export function meshEdgesForDomain(domain: MeshDomainId, inventory?: unknown): MeshGraphEdge[] {
  const live = inventoryNodes(inventory);
  if (!live) return meshGraphEdges.filter((edge) =>
    (edge.from === "node0" && edge.to === domain) || edge.from === domain
  );
  const nodes = definitionsForInventory(live).filter((node) => node.id !== "node0" && node.domains.includes(domain));
  return [
    { from: "node0", to: domain, kind: "routes" },
    ...nodes.map((node) => ({ from: domain, to: node.id, kind: "contains" as const })),
  ];
}

export function graphEdgePath(from: GraphPoint, to: GraphPoint): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) > Math.abs(dy)) {
    const middleX = from.x + dx / 2;
    return `M ${from.x} ${from.y} C ${middleX} ${from.y}, ${middleX} ${to.y}, ${to.x} ${to.y}`;
  }
  const direction = dy >= 0 ? 1 : -1;
  const busY = from.y + direction * Math.min(24, Math.max(12, Math.abs(dy) * 0.32));
  const radius = Math.min(7, Math.abs(to.x - from.x) / 2, Math.abs(to.y - busY) / 2);
  if (radius < 1) return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  const horizontalDirection = to.x >= from.x ? 1 : -1;
  return [
    `M ${from.x} ${from.y}`,
    `L ${from.x} ${busY - direction * radius}`,
    `Q ${from.x} ${busY} ${from.x + horizontalDirection * radius} ${busY}`,
    `L ${to.x - horizontalDirection * radius} ${busY}`,
    `Q ${to.x} ${busY} ${to.x} ${busY + direction * radius}`,
    `L ${to.x} ${to.y}`,
  ].join(" ");
}

export function meshNodeIdForTag(tag: string): MeshNodeId | null {
  return nodeByTag.get(tag.toLowerCase()) ?? null;
}

export function meshReplyOwner(line: string): MeshNodeId | null {
  if (parseChoinkaStatus(line)) return "choinka";
  return meshNodeDefinitions.find((node) => node.replyPatterns.some((pattern) => pattern.test(line)))?.id ?? null;
}

export function meshNodesForDomain(domain: MeshDomainId, state: LegacyState, inventory?: unknown): MeshNodeSnapshot[] {
  const live = inventoryNodes(inventory);
  const definitions = live ? definitionsForInventory(live) : meshNodeDefinitions;
  return definitions
    .filter((node) => node.id !== "node0" && node.domains.includes(domain))
    .map((definition) => snapshotForDefinition(definition, state, live));
}

export function meshNodeSnapshot(nodeId: MeshNodeId, state: LegacyState, inventory?: unknown): MeshNodeSnapshot | null {
  const definition = meshNodeDefinitions.find((node) => node.id === nodeId);
  return definition ? snapshotForDefinition(definition, state, inventoryNodes(inventory)) : null;
}

function snapshotForDefinition(definition: MeshNodeDefinition, state: LegacyState, live: LiveMeshInventoryNode[] | null): MeshNodeSnapshot {
  const activity = state.nodeActivity[definition.id];
  const knownDevices = definition.devices.filter((key) => state.devices[key] !== null).length;
  const knownSensors = definition.sensors.filter((key) => state.sensors[key] !== null).length;
  const choinka = definition.id === "choinka" ? state.controls.choinkaStatus : null;
  const knownSignals = knownDevices + knownSensors + (choinka ? choinka.hardwareBlocked === null ? 8 : 9 : 0);
  const totalSignals = definition.devices.length + definition.sensors.length + (definition.id === "choinka" ? 9 : 0);
  const lastSeenAt = activity?.lastSeenAt ?? null;
  const error = activity?.lastError ?? null;
  const liveNode = live?.find((node) => node.tag.toLowerCase() === definition.tag.toLowerCase());
  return {
    definition,
    state: liveNode?.offline || error ? "error" : liveNode?.telemetry_fresh || lastSeenAt !== null || knownSignals > 0 ? "observed" : "waiting",
    knownSignals,
    totalSignals,
    lastSeenAt,
    error,
  };
}

function inventoryNodes(inventory: unknown): LiveMeshInventoryNode[] | null {
  if (!inventory || typeof inventory !== "object") return null;
  const nodes = (inventory as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return null;
  return nodes.filter((node): node is LiveMeshInventoryNode => Boolean(
    node && typeof node === "object" &&
    typeof (node as LiveMeshInventoryNode).mac === "string" &&
    typeof (node as LiveMeshInventoryNode).tag === "string"
  ));
}

function definitionsForInventory(nodes: LiveMeshInventoryNode[]): MeshNodeDefinition[] {
  const known = new Map(meshNodeDefinitions.map((definition) => [definition.tag.toLowerCase(), definition]));
  return nodes
    .filter((node) => !node.offline)
    .map((node) => known.get(node.tag.toLowerCase()) ?? {
      id: `unknown:${node.mac}`,
      tag: node.tag || node.mac,
      domains: ["lighting", "climate"],
      roleKey: "controls.nodeRoleUnknown",
      devices: [],
      sensors: [],
      feedbackCommands: [],
      replyPatterns: [],
    });
}
