import { describe, expect, it } from "vitest";
import { initialLegacyState, parseLegacyLine } from "./protocol";
import { meshFeedbackCommands, meshGraphEdges, meshNodesForDomain, meshReplyOwner } from "./operationalGraph";

describe("operational mesh graph", () => {
  it("drives refresh commands without the lossy sensor burst", () => {
    expect(meshFeedbackCommands).not.toContain("sens_echo");
    expect(meshFeedbackCommands).not.toContain("choinka");
    expect(meshFeedbackCommands).toEqual(expect.arrayContaining(["ppm_echo", "temp_echo", "humi_echo", "lux_echo"]));
    expect(new Set(meshFeedbackCommands).size).toBe(meshFeedbackCommands.length);
  });

  it("connects both domain abstractions to node0 and their participating nodes", () => {
    expect(meshGraphEdges).toContainEqual({ from: "node0", to: "lighting", kind: "routes" });
    expect(meshGraphEdges).toContainEqual({ from: "node0", to: "climate", kind: "routes" });
    expect(meshGraphEdges).toContainEqual({ from: "climate", to: "esp_mixer", kind: "contains" });
  });

  it("maps legacy replies to their graph owners", () => {
    expect(meshReplyOwner("041280")).toBe("esp_mixer");
    expect(meshReplyOwner("0648.2")).toBe("esp_mixer");
    expect(meshReplyOwner("feedpowled1")).toBe("kPowerLed");
    expect(meshReplyOwner("131")).toBe("humidifier");
    expect(meshReplyOwner("unknown")).toBeNull();
  });

  it("exposes observed signal counts from parser activity", () => {
    const next = parseLegacyLine(initialLegacyState, "0648.2");
    const mixer = meshNodesForDomain("climate", next).find((node) => node.definition.id === "esp_mixer");
    expect(mixer?.state).toBe("observed");
    expect(mixer?.knownSignals).toBe(1);
    expect(mixer?.totalSignals).toBe(4);

    const choinka = meshNodesForDomain("climate", next).find((node) => node.definition.id === "choinka");
    expect(choinka?.knownSignals).toBe(0);
    expect(choinka?.totalSignals).toBe(0);
  });
});
