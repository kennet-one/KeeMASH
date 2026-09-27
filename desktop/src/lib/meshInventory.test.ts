import { describe, expect, it } from "vitest";
import { mergeMeshInventory } from "./meshInventory";

describe("mesh inventory reconciliation", () => {
  it("preserves runtime uptime while accepting Fabric identity and connectivity", () => {
    const legacy = { __receivedAt: 10, nodes: [{
      mac: "80:7d:3a:b9:15:0c", tag: "esp_mixer", uptime_valid: true, uptime_s: 42,
      node_session: 7, telemetry_fresh: true, offline: false,
    }] };
    const fabric = { revision: 9, nodes: [{
      mac: "807d3ab9150c", tag: "esp_mixer", nodeId: "node-id", bootSession: 8, online: true,
    }] };
    expect(mergeMeshInventory(legacy, fabric, 20)).toEqual({
      __receivedAt: 20,
      revision: 9,
      nodes: [{
        mac: "807d3ab9150c", tag: "esp_mixer", uptime_valid: true, uptime_s: 42,
        node_session: 7, telemetry_fresh: true, offline: false, nodeId: "node-id",
        bootSession: 8, online: true,
      }],
    });
  });

  it("maps Fabric online state to the common offline field", () => {
    const merged = mergeMeshInventory(null, { nodes: [{ mac: "807d3ab9150c", tag: "esp_mixer", online: false }] }, 30) as { nodes: Array<Record<string, unknown>> };
    expect(merged.nodes[0].offline).toBe(true);
  });

  it("lets the newest legacy route state replace an older Fabric state", () => {
    const fabric = { nodes: [{ mac: "807d3ab9150c", tag: "esp_mixer", online: false }] };
    const legacy = { nodes: [{ mac: "807d3ab9150c", tag: "esp_mixer", offline: false }] };
    const merged = mergeMeshInventory(fabric, legacy, 40) as { nodes: Array<Record<string, unknown>> };
    expect(merged.nodes[0]).toMatchObject({ offline: false, online: true });
  });
});
