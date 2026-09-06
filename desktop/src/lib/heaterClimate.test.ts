import { describe, expect, it } from "vitest";
import { parseHeaterClimate, parseHeaterSourceStatus, parseHeaterRelay } from "./heaterClimate";
import { initialLegacyState, parseLegacyLine } from "./protocol";
import { matchingFeedback } from "./commandFeedback";

const internal = "HC1 s=1 r=0 z=0 v=00000005 i=2534 h=4821 ia=1 e=32767 ea=65535 m=000000000000 t=2534";
describe("heater climate contract", () => {
  it("keeps local climate distinct from legacy mixer values and H5 outputs", () => {
    const state = parseLegacyLine(parseLegacyLine(initialLegacyState, "0520.0"), internal);
    expect(state.sensors.temperatureC).toBe(20);
    expect(state.controls.heaterClimate).toMatchObject({ internalTemperatureC: 25.34, internalHumidityPercent: 48.21, effectiveTemperatureC: 25.34 });
    expect(state.devices.heater).toBeNull();
    expect(state.controls.heaterClimate?.externalTemperatureC).toBeNull();
    expect(state.controls.heaterClimate?.externalAgeSeconds).toBeNull();
  });
  it("keeps saved/applied independent from the active fallback source", () => {
    const binding = parseHeaterSourceStatus("HZ1 saved=1 applied=1 rev=00000005 enabled=1 source=08a6f765cea0 err=0");
    expect(binding).toMatchObject({ saved: true, applied: true, enabled: true });
    const climate = parseHeaterClimate(internal.replace("r=0 z=0", "r=1 z=1"));
    expect(climate).toMatchObject({ actualSource: "internal", fallback: "externalUnavailable" });
    expect(parseHeaterSourceStatus("HZ1 saved=0 applied=0 rev=00000005 enabled=0 source=000000000000 err=4354")?.error).toBe(4354);
  });
  it("rejects malformed fields and does not manufacture zero values", () => {
    expect(parseHeaterClimate(internal.replace("i=2534", "i=no"))).toBeNull();
    expect(parseHeaterClimate(internal + " s=2")).toBeNull();
    expect(parseHeaterClimate(internal.replace("i=2534", "i=32767"))?.internalTemperatureC).toBeNull();
    expect(parseHeaterClimate("H5m0a0f0l0h0r0v0c0s5t?")).toBeNull();
  });
  it("only confirms the requested saved source", () => {
    const pending = { source: { id: 1, command: "heater.source:zone:08a6f765cea0", owner: "Kheater", target: "control.heaterSource", phase: "awaiting" as const, startedAt: 0, detail: null } };
    expect(matchingFeedback(pending, "HZ1 saved=1 applied=0 rev=00000006 enabled=1 source=08a6f765cea0 err=0")).toHaveLength(1);
    expect(matchingFeedback(pending, "HZ1 saved=1 applied=1 rev=00000005 enabled=0 source=000000000000 err=0")).toHaveLength(0);
    expect(matchingFeedback(pending, "HZ1 saved=0 applied=0 rev=00000006 enabled=1 source=08a6f765cea0 err=1")).toHaveLength(0);
  });
  it("validates authoritative relay protection status", () => {
    expect(parseHeaterRelay("HP1 interval=30 hold=12 hysteresis=20")).toMatchObject({ intervalSeconds: 30, holdSeconds: 12, hysteresisC: .2 });
    expect(parseHeaterRelay("HP1 interval=1 hold=0 hysteresis=20")).toBeNull();
  });
});
