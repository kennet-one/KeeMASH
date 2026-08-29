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

  it("maps humidifier aggregate state", () => {
    const humidifier = parseLegacyLine(initialLegacyState, "152010");
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

  it("parses legacy device aliases without cross-node state collisions", () => {
    const garland = parseLegacyLine(initialLegacyState, "garl1");
    const bedside = parseLegacyLine(garland, "bedsi_on");
    const ambiguous = parseLegacyLine(bedside, "powled1");
    const powerLed = parseLegacyLine(ambiguous, "powled1", "kPowerLed");
    expect(powerLed.devices.garland).toBe(true);
    expect(powerLed.devices.bedside).toBe(true);
    expect(ambiguous.devices.powerLed).toBeNull();
    expect(powerLed.devices.powerLed).toBe(true);
  });

  it("parses compact authoritative heater status", () => {
    const next = parseLegacyLine(
      initialLegacyState,
      "H5m5a1f1l0h1r1v1c0s0t234p1q1",
    );
    expect(next.controls.heaterMode).toBe(5);
    expect(next.controls.heaterStatus).toMatchObject({
      autoEnabled: true,
      fanOn: true,
      lowHeatOn: false,
      highHeatOn: true,
      rotationOn: true,
      temperatureValid: true,
      cooldownActive: false,
      stopReason: "none",
      acceptedTemperatureC: 23.4,
      setpointPersistent: true,
      modePersistent: true,
    });
    expect(next.devices.heater).toBe(true);
    expect(next.devices.heaterRotation).toBe(true);
  });

  it("keeps old heater snapshots compatible and parses disabled target persistence", () => {
    const legacy = parseLegacyLine(initialLegacyState, "H5m0a0f0l0h0r0v0c0s5t?");
    const current = parseLegacyLine(legacy, "H5m0a0f0l0h0r0v0c0s5t?p0");
    expect(legacy.controls.heaterStatus.setpointPersistent).toBeNull();
    expect(current.controls.heaterStatus.setpointPersistent).toBe(false);
    expect(current.controls.heaterStatus.modePersistent).toBeNull();
  });

  it("does not infer heater power from a setpoint reply", () => {
    const next = parseLegacyLine(initialLegacyState, "R527.4");
    expect(next.controls.heaterTargetC).toBe(27.4);
    expect(next.devices.heater).toBeNull();
  });

  it("loads authoritative Power LED schedule metadata and points", () => {
    const metadata = parseLegacyLine(initialLegacyState, "PSM1234ABCD2111011");
    const first = parseLegacyLine(metadata, "PSP1234ABCD0116817F");
    const second = parseLegacyLine(first, "PSP1234ABCD1156407F");
    expect(second.devices.powerLed).toBe(true);
    expect(second.controls.powerLedSchedule).toMatchObject({
      generation: 0x1234abcd,
      enabled: true,
      persistenceEnabled: true,
      clockValid: true,
      activeIndex: 0,
      nextIndex: 1,
      outputOn: true,
    });
    expect(second.controls.powerLedSchedule.points).toEqual([
      { enabled: true, minuteOfDay: 360, stateOn: true, daysMask: 0x7f },
      { enabled: true, minuteOfDay: 1380, stateOn: false, daysMask: 0x7f },
    ]);
  });

  it("keeps schedule runtime diagnostics alongside metadata updates", () => {
    const powerDiagnostic = parseLegacyLine(initialLegacyState, "PSD1234ABCD17043A120000000A");
    const powerMetadata = parseLegacyLine(powerDiagnostic, "PSM1234ABCD2111011");
    expect(powerMetadata.controls.powerLedSchedule.diagnostics).toMatchObject({
      generation: 0x1234abcd,
      localMinute: 0x43a,
      lastKind: "scheduled",
    });

    const heaterDiagnostic = parseLegacyLine(powerMetadata, "S5D1234ABCD17043A0100000005");
    expect(heaterDiagnostic.controls.heaterSchedule.diagnostics).toMatchObject({
      generation: 0x1234abcd,
      lastIndex: 0,
      lastKind: "catchUp",
      lastApplyAgeSeconds: 5,
    });
  });
});
