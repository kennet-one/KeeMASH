import { normalizeMeshMac } from "./typedSensors";

type InventoryRecord = Record<string, unknown>;

function nodesOf(value: unknown): InventoryRecord[] {
  if (!value || typeof value !== "object") return [];
  const nodes = (value as InventoryRecord).nodes;
  return Array.isArray(nodes)
    ? nodes.filter((node): node is InventoryRecord => Boolean(node && typeof node === "object"))
    : [];
}

function mergeNode(previous: InventoryRecord | undefined, incoming: InventoryRecord): InventoryRecord {
  const merged = { ...previous, ...incoming };
  if (typeof incoming.offline === "boolean") return { ...merged, online: !incoming.offline };
  if (typeof incoming.online === "boolean") return { ...merged, offline: !incoming.online };
  return merged;
}

/** Merge identity-only Fabric graph snapshots with richer runtime inventory by MAC. */
export function mergeMeshInventory(previous: unknown, incoming: unknown, receivedAt = Date.now()): unknown {
  if (!incoming || typeof incoming !== "object") return incoming;
  const currentNodes = nodesOf(incoming);
  if (!Array.isArray((incoming as InventoryRecord).nodes)) return { ...(incoming as InventoryRecord), __receivedAt: receivedAt };

  const previousByMac = new Map<string, InventoryRecord>();
  for (const node of nodesOf(previous)) {
    const mac = normalizeMeshMac(node.mac);
    if (mac) previousByMac.set(mac, node);
  }

  const nodes = currentNodes.map((node) => {
    const mac = normalizeMeshMac(node.mac);
    return mergeNode(mac ? previousByMac.get(mac) : undefined, node);
  });
  return { ...(previous as InventoryRecord | null), ...(incoming as InventoryRecord), nodes, __receivedAt: receivedAt };
}
