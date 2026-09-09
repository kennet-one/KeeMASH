import { describe, expect, it, vi } from "vitest";
import { initialLegacyState } from "./protocol";
import { applyTypedSensorEvent, markTypedSensorsDisconnected, reconcileTypedSensorInventory } from "./typedSensors";
import type { MeshEvent } from "../types";
const mixer = "08a6f765cea0", heater = "a0dd6c1028bc";
const inventory = { nodes: [{ mac: mixer, tag: "esp_mixer", node_session: 1 }, { mac: heater, tag: "Kheater", node_session: 2 }] };
function event(mac: string, id = 2, generation = 1, status = 1, sampleUptimeMs = generation * 1000): MeshEvent {
  return { channel: 5, messageId: generation, fields: { targetMac: mac }, data: { id, generation, status, value: 2534, scale10: -2, sampleUptimeMs } };
}
describe("typed SENSOR attribution", () => {
  it("handles subsecond samples against integer uptime without inventing a fresh timestamp", () => {
    const timed = { __receivedAt: 1000, nodes: [{ ...inventory.nodes[0], uptime_valid: true, uptime_s: 5 }] };
    const state = applyTypedSensorEvent(initialLegacyState, event(mixer, 2, 1, 1, 5500), timed, 1000);
    expect(state.typedSensors[mixer].metrics.temperatureC?.ageAtReceiptMs).toBe(499);
    expect(applyTypedSensorEvent(initialLegacyState, event(mixer, 2, 1, 1, 8000), timed, 1000).typedSensors[mixer].metrics.temperatureC?.ageAtReceiptMs).toBeNull();
  });
  it("anchors unknown age on later same-session inventory without renewing the sample", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10000);
    try {
      const state = applyTypedSensorEvent(initialLegacyState, event(mixer), inventory, 100);
      const timed = { __receivedAt: 10000, nodes: [{ ...inventory.nodes[0], uptime_valid: true, uptime_s: 40 }] };
      const next = reconcileTypedSensorInventory(state, timed);
      expect(next.typedSensors[mixer].metrics.temperatureC).toMatchObject({ ageAtReceiptMs: 39999, generation: 1, value: 25.34 });
      expect(applyTypedSensorEvent(next, event(mixer), timed, 12000)).toBe(next);
    } finally { clock.mockRestore(); }
  });
  it("isolates sources and metrics, including unknown providers", () => {
    let state = applyTypedSensorEvent(initialLegacyState, event(mixer), inventory, 100);
    state = applyTypedSensorEvent(state, { ...event(heater), data: { ...event(heater).data, value: 3000 } }, inventory, 200);
    state = applyTypedSensorEvent(state, event(heater, 3), inventory, 300);
    expect(state.sensors.temperatureC).toBe(25.34);
    expect(state.typedSensors[heater].metrics.temperatureC?.value).toBe(30);
    expect(state.typedSensors[heater].metrics.humidityPercent?.value).toBe(25.34);
    expect(state.nodeActivity.esp_mixer?.lastSeenAt).toBe(100);
    expect(applyTypedSensorEvent(state, event("aabbccddeeff"), null).typedSensors.aabbccddeeff.nodeId).toBeNull();
  });
  it("invalidates only the specified metric and never turns missing data into zero", () => {
    const state = applyTypedSensorEvent(initialLegacyState, event(mixer), inventory, 100);
    const invalid = applyTypedSensorEvent(state, event(mixer, 2, 2, 5), inventory, 200);
    expect(invalid.sensors.temperatureC).toBeNull();
    expect(invalid.typedSensors[mixer].metrics.temperatureC).toMatchObject({ valid: false, error: true });
    expect(applyTypedSensorEvent(state, { ...event(mixer), data: { ...event(mixer).data, value: null } }, inventory)).toBe(state);
  });
  it("does not renew duplicates or accept reordered data as a reboot", () => {
    const state = applyTypedSensorEvent(initialLegacyState, event(mixer, 2, 5), inventory, 100);
    expect(applyTypedSensorEvent(state, event(mixer, 2, 5), inventory, 500)).toBe(state);
    expect(applyTypedSensorEvent(state, event(mixer, 2, 1), inventory, 600)).toBe(state);
    const invalid = applyTypedSensorEvent(state, event(mixer, 2, 5, 3), inventory, 700);
    expect(invalid.typedSensors[mixer].metrics.temperatureC).toMatchObject({ value: 25.34, receivedAt: 100, stale: true });
    const failed = applyTypedSensorEvent(invalid, event(mixer, 2, 5, 4), inventory, 800);
    expect(failed.typedSensors[mixer].metrics.temperatureC).toMatchObject({ value: null, receivedAt: 100, error: true });
  });
  it("retains dedupe over reconnect and clears only a confirmed changed session", () => {
    const state = applyTypedSensorEvent(initialLegacyState, event(mixer, 2, 5), inventory, 100);
    const disconnected = markTypedSensorsDisconnected(state);
    expect(disconnected.typedSensors[mixer].connected).toBe(false);
    expect(applyTypedSensorEvent(disconnected, event(mixer, 2, 5), inventory, 1000)).toBe(disconnected);
    const restarted = reconcileTypedSensorInventory(disconnected, { nodes: [{ mac: mixer, tag: "esp_mixer", node_session: 3 }] });
    expect(restarted.typedSensors[mixer].metrics).toEqual({});
    expect(applyTypedSensorEvent(restarted, event(mixer), { nodes: [{ mac: mixer, tag: "esp_mixer", node_session: 3 }] }, 2000).typedSensors[mixer].metrics.temperatureC?.receivedAt).toBe(2000);
  });
});
