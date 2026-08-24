import { describe, expect, it } from "vitest";
import { initialLegacyState } from "./protocol";
import { resolveSignalBinding, signalEndpointsFor } from "./signalGraph";

describe("signal graph", () => {
  it("filters temperature providers and marks the deployed legacy route", () => {
    const endpoints = signalEndpointsFor("temperatureC");
    expect(endpoints.some((endpoint) => endpoint.id === "esp_mixer.temperatureC" && endpoint.routingDeployed)).toBe(true);
  });

  it("does not substitute a missing provider", () => {
    expect(resolveSignalBinding("future.temperatureC", initialLegacyState)).toEqual({ endpoint: null, available: false, routingDeployed: false });
  });
});
