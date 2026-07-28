import { describe, expect, it } from "vitest";
import { initialLegacyState, parseLegacyLine } from "./protocol";

describe("legacy protocol parser", () => {
  it("tracks bridge heartbeat and device replies", () => {
    const online = parseLegacyLine(initialLegacyState, "hello\r");
    const powered = parseLegacyLine(online, "feedpowled1");
    expect(online.online).toBe(true);
    expect(powered.devices.powerLed).toBe(true);
  });

  it("parses sensor values without losing previous state", () => {
    const temperature = parseLegacyLine(initialLegacyState, "05-3.75");
    const humidity = parseLegacyLine(temperature, "0648.2");
    expect(humidity.sensors.temperatureC).toBe(-3.75);
    expect(humidity.sensors.humidityPercent).toBe(48.2);
    expect(humidity.nodeActivity.esp_mixer?.lastSeenAt).not.toBeNull();
    expect(humidity.sensorUpdatedAt.humidityPercent).toBeTypeOf("number");
  });

  it("accepts CRC-suffixed sensor bodies forwarded by older bridges", () => {
    const ppm = parseLegacyLine(initialLegacyState, "041184*AF");
    expect(ppm.sensors.ppm).toBe(1184);
  });

  it("parses mesh command failures without changing device state", () => {
    const powered = parseLegacyLine(initialLegacyState, "feedpowled1");
    const failed = parseLegacyLine(powered, "ERR:OFFLINE:humidifier");
    expect(failed.commandError).toEqual({ code: "OFFLINE", owner: "humidifier" });
    expect(failed.devices.powerLed).toBe(true);
  });

  it("rejects malformed command failure tokens", () => {
    const next = parseLegacyLine(initialLegacyState, "ERR:OFFLINE:bad owner");
    expect(next.commandError).toBeNull();
  });

  it("maps brightness and humidifier aggregate state", () => {
    const brightness = parseLegacyLine(initialLegacyState, "02128");
    const humidifier = parseLegacyLine(brightness, "152010");
    expect(brightness.controls.redBrightness).toBe(5);
    expect(humidifier.controls.turboMode).toBe(2);
    expect(humidifier.devices.pump).toBe(true);
    expect(humidifier.devices.flow).toBe(false);
    expect(humidifier.devices.ionizer).toBe(true);
  });

  it("reports egg-cooker completion", () => {
    const state = parseLegacyLine(initialLegacyState, "jajo_on");
    expect(state.notificationKey).toBe("notification.eggCookerCompleted");
    expect(state.devices.eggCooker).toBe(true);
  });
});
