import { describe, expect, it } from "vitest";
import { formatPumpStartAge, parseChoinkaStatus } from "./choinkaStatus";
import { initialLegacyState, parseLegacyLine } from "./protocol";
import { commandExpectation } from "./commandFeedback";
import { meshFeedbackOwner, meshNodeSnapshot, meshReplyOwner } from "./operationalGraph";

const reply = "exec=42 level=wet pump=0 block=1 mv=2050/2090 cal=1 cd=51000 stop=hardware_block tout=3";

describe("choinka application telemetry", () => {
  it("parses the deployed complete read-only result", () => {
    expect(parseChoinkaStatus(reply, 100)).toEqual({
      executionCount: 42, level: "wet", pumpOn: false, hardwareBlocked: true,
      voltageAbMv: 2050, voltageBaMv: 2090, calibrated: true, cooldownMs: 51000,
      stopReason: "hardware_block", timeoutCount: 3, lastStartAgeSeconds: null, receivedAt: 100,
    });
  });
  it("accepts older status without block without inventing its value", () => {
    expect(parseChoinkaStatus(reply.replace(" block=1", ""))?.hardwareBlocked).toBeNull();
  });
  it("distinguishes a measured start age, never started and older firmware", () => {
    expect(parseChoinkaStatus(reply + " last=0")?.lastStartAgeSeconds).toBe(0);
    expect(parseChoinkaStatus(reply + " last=3661")?.lastStartAgeSeconds).toBe(3661);
    expect(parseChoinkaStatus(reply + " last=-1")?.lastStartAgeSeconds).toBe(-1);
    expect(parseChoinkaStatus(reply)?.lastStartAgeSeconds).toBeNull();
    expect(parseChoinkaStatus(reply + " last=-2")).toBeNull();
    expect(formatPumpStartAge(3661)).toBe("01:01:01");
    expect(formatPumpStartAge(259200)).toBe("72:00:00");
  });
  it("rejects truncated, malformed and overflowing results", () => {
    for (const invalid of [reply.slice(0, -4), reply + " extra", reply.replace("pump=0", "pump=2"), reply.replace("exec=42", "exec=4294967296")]) {
      expect(parseChoinkaStatus(invalid)).toBeNull();
    }
  });
  it("keeps water telemetry isolated from humidifier and preserves the last valid sample", () => {
    const next = parseLegacyLine(initialLegacyState, reply);
    expect(next.controls.choinkaStatus?.pumpOn).toBe(false);
    expect(next.devices.pump).toBeNull();
    expect(initialLegacyState.controls.choinkaStatus).toBeNull();
    expect(parseLegacyLine(next, "pump status unavailable").controls.choinkaStatus).toEqual(next.controls.choinkaStatus);
    expect(parseLegacyLine(next, "pimpa").devices.pump).toBeNull();
    expect(parseLegacyLine(initialLegacyState, reply, "Kheater").controls.choinkaStatus).toBeNull();
  });
  it("routes the status request and recognizes its graph activity", () => {
    expect(commandExpectation("choinka.status")?.owner).toBe("choinka");
    expect(meshFeedbackOwner("choinka.status")).toBe("choinka");
    expect(meshReplyOwner(reply)).toBe("choinka");
    expect(meshNodeSnapshot("choinka", parseLegacyLine(initialLegacyState, reply))).toMatchObject({ knownSignals: 9, totalSignals: 10, state: "observed" });
    expect(meshNodeSnapshot("choinka", parseLegacyLine(initialLegacyState, reply + " last=10"))).toMatchObject({ knownSignals: 10, totalSignals: 10 });
  });
});
