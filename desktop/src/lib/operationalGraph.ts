import type { DeviceKey, LegacyState, SensorKey } from "./protocol";

export type MeshDomainId = "lighting" | "climate";
export type MeshNodeId =
  | "node0"
  | "garland"
  | "red_led"
  | "esp_mixer"
  | "bedside_light"
  | "lampk"
  | "kPowerLed"
  | "humidifier"
  | "choinka"
  | "Kheater"
  | "jajowar";

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
    id: "red_led",
    tag: "red_led",
    domains: ["lighting"],
    roleKey: "controls.nodeRoleEffects",
    devices: ["redLed"],
    sensors: ["speed"],
    feedbackCommands: ["red_led_echo"],
    replyPatterns: [/^(redled_(on|off)|01|02|03)/],
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
    feedbackCommands: ["pwech"],
    replyPatterns: [/^(feedpowled[01]|powled[01])$/],
  },
  {
    id: "humidifier",
    tag: "humidifier",
    domains: ["climate"],
    roleKey: "controls.nodeRoleAir",
    devices: ["humidifier", "pump", "flow", "ionizer"],
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
    // KeeMASH has no legacy choinka status contract yet. Keep the node in the
    // graph without inventing a command or borrowing humidifier pump state.
    feedbackCommands: [],
    replyPatterns: [/^(pimpa|pomp[01])$/],
  },
  {
    id: "Kheater",
    tag: "Kheater",
    domains: ["climate"],
    roleKey: "controls.nodeRoleHeat",
    devices: ["heater", "heaterRotation"],
    sensors: [],
    feedbackCommands: ["heho"],
    replyPatterns: [/^(09|25|R5|A5)/],
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

const nodeByTag = new Map(meshNodeDefinitions.map((node) => [node.tag.toLowerCase(), node.id]));

export function meshNodeIdForTag(tag: string): MeshNodeId | null {
  return nodeByTag.get(tag.toLowerCase()) ?? null;
}

export function meshReplyOwner(line: string): MeshNodeId | null {
  return meshNodeDefinitions.find((node) => node.replyPatterns.some((pattern) => pattern.test(line)))?.id ?? null;
}

export function meshNodesForDomain(domain: MeshDomainId, state: LegacyState): MeshNodeSnapshot[] {
  return meshNodeDefinitions
    .filter((node) => node.id !== "node0" && node.domains.includes(domain))
    .map((definition) => {
      const activity = state.nodeActivity[definition.id];
      const knownDevices = definition.devices.filter((key) => state.devices[key] !== null).length;
      const knownSensors = definition.sensors.filter((key) => state.sensors[key] !== null).length;
      const knownSignals = knownDevices + knownSensors;
      const totalSignals = definition.devices.length + definition.sensors.length;
      const lastSeenAt = activity?.lastSeenAt ?? null;
      const error = activity?.lastError ?? null;
      return {
        definition,
        state: error ? "error" : lastSeenAt !== null || knownSignals > 0 ? "observed" : "waiting",
        knownSignals,
        totalSignals,
        lastSeenAt,
        error,
      };
    });
}
