import { describe, expect, it } from "vitest";
import { climateProviders, climateProviderState, type ClimateProvider } from "./climateSources";
import { initialLegacyState } from "./protocol";

describe("climate source capability and freshness", () => {
  const mac = "807d3ab9150c";
  it("keeps an inventory temperature provider selectable before its first sample", () => {
    const providers = climateProviders(initialLegacyState, { nodes: [{ mac, tag: "esp_mixer" }] }, null);
    expect(providers).toHaveLength(1);
    expect(climateProviderState(providers[0], 1000)).toBe("waiting");
    expect(climateProviders(initialLegacyState, { nodes: [{ mac, tag: "esp_mixer" }] }, mac)).toEqual([]);
  });
  it("distinguishes stale, invalid, unknown age and disconnected samples", () => {
    const source: ClimateProvider = { mac, nodeId: "esp_mixer", tag: "esp_mixer", connected: true,
      metric: { value: 23, valid: true, stale: false, error: false, calibrated: true,
        generation: 1, sampleUptimeMs: 1000, messageId: 1, receivedAt: 1000, ageAtReceiptMs: 0 } };
    expect(climateProviderState(source, 1001)).toBe("fresh");
    expect(climateProviderState(source, 201000)).toBe("stale");
    source.metric!.ageAtReceiptMs = null;
    expect(climateProviderState(source, 1001)).toBe("waiting");
    source.metric!.error = true;
    expect(climateProviderState(source, 1001)).toBe("invalid");
    source.connected = false;
    expect(climateProviderState(source, 1001)).toBe("offline");
  });
});
