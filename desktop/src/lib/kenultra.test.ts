import { describe, expect, it } from "vitest";
import type { KenUltraCatalog } from "../types";
import { directEffects, neighborhood, searchKenUltra } from "./kenultra";

const catalog: KenUltraCatalog = {
  schemaVersion: 1,
  generatedAt: "2026-07-18T00:00:00Z",
  safety: { mode: "read-only-simulation", firmwareWrite: false, rawFirmwareIncluded: false, privateInventoryIncluded: false },
  stats: { forms: 1, questions: 2, options: 0, varStores: 1 },
  nodes: [
    { id: "power", kind: "question", label: "Power Down Mode", domain: "memory", status: "strong-signal", risk: "medium", confidence: "observed", aliases: [] },
    { id: "evidence", kind: "evidence", label: "86.5 ns", domain: "memory", status: "observed", risk: "low", confidence: "observed", aliases: [] },
    { id: "sar", kind: "question", label: "WiFi SAR", domain: "wifi-regulatory", status: "do-not-tune", risk: "regulatory", confidence: "ifr-fact", aliases: [], performanceExcluded: true },
  ],
  edges: [{ id: "edge", from: "power", to: "evidence", kind: "measured_by", label: "measured by AIDA", confidence: "observed" }],
};

describe("KenULTRABIOS Enjoy helpers", () => {
  it("prioritizes memory focus and keeps SAR out of the default surface", () => {
    expect(searchKenUltra(catalog.nodes, "")[0]?.id).toBe("power");
    expect(searchKenUltra(catalog.nodes, "").some((node) => node.id === "sar")).toBe(false);
  });

  it("builds a bounded focus neighborhood", () => {
    expect(neighborhood(catalog, "power").nodes.map((node) => node.id)).toEqual(["power", "evidence"]);
  });

  it("returns only direct simulation effects", () => {
    expect(directEffects(catalog, "power")[0]?.confidence).toBe("observed");
  });
});
