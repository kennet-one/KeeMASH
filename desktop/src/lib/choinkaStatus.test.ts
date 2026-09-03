import { describe, expect, it } from "vitest";
import { electrodeFaultKeys, formatPumpStartAge, parseChoinkaStatus } from "./choinkaStatus";
import { initialLegacyState, parseLegacyLine } from "./protocol";
import { commandExpectation } from "./commandFeedback";
import { meshFeedbackOwner, meshNodeSnapshot, meshReplyOwner } from "./operationalGraph";

const reply = "exec=42 level=wet pump=0 block=1 mv=2050/2090 cal=1 cd=51000 stop=hardware_block tout=3";

describe("choinka application telemetry", () => {
  it("fits compact diagnostics in CONTROL and routes them to the water widget", () => {
    const compact = "C6 exec=42 l=0 p=0 b=1 v=100/2200 c=1 d=51000 s=3 t=3 a=-1 x=4 z=55/64";
    expect(parseChoinkaStatus(compact)).toMatchObject({ level: "unknown", stopReason: "sensor_unknown", electrodeTestFlags: 4, lowAbMv: 55 });
    expect(meshReplyOwner(compact)).toBe("choinka");
    expect(commandExpectation("choinka.status")?.reply.test(compact)).toBe(true);
    const max = "C6 exec=4294967295 l=2 p=0 b=0 v=65535/65535 c=1 d=4294967295 s=6 t=4294967295 a=9999999999999 x=15 z=65535/65535 m=1";
    expect(max.length).toBeLessThanOrEqual(128);
    expect(parseChoinkaStatus(max)).not.toBeNull();
    expect(parseChoinkaStatus(compact + " m=0")?.electrodeTestEnforced).toBe(false);
    expect(parseChoinkaStatus(compact + " m=1")?.electrodeTestEnforced).toBe(true);
    expect(parseChoinkaStatus(compact)?.electrodeTestEnforced).toBeNull();
    expect(parseChoinkaStatus(compact + " m=2")).toBeNull();
    for (const invalid of [compact.replace("l=0", "l=3"), compact.replace("x=4", "x=16"), compact.replace("s=3", "s=7"), compact.replace("exec=42", "exec=4294967296")]) {
      expect(parseChoinkaStatus(invalid)).toBeNull();
    }
  });
  it("parses the deployed complete read-only result", () => {
    expect(parseChoinkaStatus(reply, 100)).toEqual({
      executionCount: 42, level: "wet", pumpOn: false, hardwareBlocked: true,
      voltageAbMv: 2050, voltageBaMv: 2090, calibrated: true, cooldownMs: 51000,
      stopReason: "hardware_block", timeoutCount: 3, lastStartAgeSeconds: null, receivedAt: 100,
      electrodeTestFlags: null, electrodeTestEnforced: null, lowAbMv: null, lowBaMv: null,
    });
  });
  it("accepts older status without block without inventing its value", () => {
    expect(parseChoinkaStatus(reply.replace(" block=1", ""))?.hardwareBlocked).toBeNull();
  });
  it("parses optional electrical diagnostics and preserves old firmware compatibility", () => {
    const line = reply + " last=30 st=0 low=55/64";
    expect(parseChoinkaStatus(line)).toMatchObject({ electrodeTestFlags: 0, lowAbMv: 55, lowBaMv: 64 });
    expect(meshReplyOwner(line)).toBe("choinka");
    expect(parseLegacyLine(initialLegacyState, line, "choinka").controls.choinkaStatus?.electrodeTestFlags).toBe(0);
    expect(parseChoinkaStatus(reply + " st=1 low=-1/-1")).toMatchObject({ electrodeTestFlags: 1, lowAbMv: -1 });
    expect(parseChoinkaStatus(reply)?.electrodeTestFlags).toBeNull();
    expect(electrodeFaultKeys(6)).toEqual(["controls.choinkaTestNotLow", "controls.choinkaTestAsymmetry"]);
    expect(electrodeFaultKeys(0)).toEqual([]);
  });
  it("rejects invalid or incomplete electrical diagnostics", () => {
    for (const suffix of [" st=16 low=0/0", " st=0", " low=0/0", " st=0 low=-2/0", " st=0 low=0/", " st=-1 low=0/0"]) {
      expect(parseChoinkaStatus(reply + suffix)).toBeNull();
    }
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
