import { describe, expect, it } from "vitest";
import {
  commandDeadlineAction,
  commandExpectation,
  matchingFeedback,
  transitionFeedback,
  type CommandFeedback,
} from "./commandFeedback";

function pending(command: string): Record<string, CommandFeedback> {
  const expectation = commandExpectation(command);
  if (!expectation) throw new Error(`missing expectation for ${command}`);
  return {
    [expectation.target]: {
      id: 1,
      command,
      owner: expectation.owner,
      target: expectation.target,
      phase: "awaiting",
      startedAt: 1,
      detail: null,
    },
  };
}

describe("command feedback expectations", () => {
  it("matches only the reply for the active action", () => {
    expect(matchingFeedback(pending("flow"), "161")).toHaveLength(1);
    expect(matchingFeedback(pending("flow"), "131")).toHaveLength(0);
  });

  it("accepts aggregate humidifier replies for independent controls", () => {
    const active = {
      ...pending("pomp"),
      ...Object.fromEntries(Object.entries(pending("flow")).map(([key, value]) => [key, { ...value, id: 2 }])),
    };
    expect(matchingFeedback(active, "152010").map((item) => item.target).sort()).toEqual([
      "device.flow",
      "device.pump",
    ]);
  });

  it("keeps heater and lighting aliases scoped to their owners", () => {
    expect(commandExpectation("he5")?.owner).toBe("Kheater");
    expect(matchingFeedback(pending("he5"), "H5m5a1f0l0h0r0v0c0s0t?")).toHaveLength(1);
    expect(matchingFeedback(pending("powled"), "powled1")).toHaveLength(1);
    expect(matchingFeedback(pending("garland"), "garl0")).toHaveLength(1);
  });

  it("confirms rotation only from the requested authoritative state", () => {
    expect(commandExpectation("HR1")).toMatchObject({ owner: "Kheater", target: "device.heaterRotation" });
    expect(matchingFeedback(pending("HR1"), "091")).toHaveLength(1);
    expect(matchingFeedback(pending("HR1"), "090")).toHaveLength(0);
    expect(matchingFeedback(pending("HR1"), "H5m0a0f0l0h0r1v0c0s5t?")).toHaveLength(1);
    expect(matchingFeedback(pending("HR1"), "H5m0a0f0l0h0r0v0c0s5t?")).toHaveLength(0);
  });

  it("tracks display state and persistence independently", () => {
    expect(matchingFeedback(pending("D50"), "D5S100")).toHaveLength(1);
    expect(matchingFeedback(pending("D50"), "D5S110")).toHaveLength(0);
    expect(matchingFeedback(pending("D5P1"), "D5S101")).toHaveLength(1);
    expect(matchingFeedback(pending("D5P1"), "D5S100")).toHaveLength(0);
  });

  it("does not track retired Red LED commands", () => {
    expect(commandExpectation("power")).toBeNull();
    expect(commandExpectation("01_mode_4")).toBeNull();
    expect(commandExpectation("02_bri_5")).toBeNull();
    expect(commandExpectation("redl_sp+")).toBeNull();
  });

  it("tracks heater persistence independently and requires authoritative status", () => {
    expect(commandExpectation("P51")?.target).toBe("control.heaterPersistence");
    expect(matchingFeedback(pending("P51"), "R526.7")).toHaveLength(0);
    expect(matchingFeedback(pending("P51"), "H5m0a0f0l0h0r0v0c0s5t?p1")).toHaveLength(1);
    expect(matchingFeedback(pending("P51"), "H5m0a0f0l0h0r0v0c0s5t?p0")).toHaveLength(0);
    expect(commandExpectation("M51")?.target).toBe("control.heaterModePersistence");
    expect(matchingFeedback(pending("M51"), "H5m0a0f0l0h0r0v0c0s5t?p1q1")).toHaveLength(1);
    expect(matchingFeedback(pending("M51"), "H5m0a0f0l0h0r0v0c0s5t?p1q0")).toHaveLength(0);
    expect(matchingFeedback(pending("M50"), "H5m0a0f0l0h0r0v0c0s5t?p1q0")).toHaveLength(1);
  });

  it("routes schedule transactions to the heater and waits for schedule status", () => {
    expect(commandExpectation("S5Q")).toMatchObject({ owner: "Kheater", target: "control.heaterSchedule" });
    expect(commandExpectation("S5B1234ABCD211")).toMatchObject({ owner: "Kheater", target: "control.heaterSchedule" });
  });

  it("routes Power LED schedule transactions and accepts authoritative replies", () => {
    expect(commandExpectation("PSQ")).toMatchObject({ owner: "kPowerLed", target: "control.powerLedSchedule" });
    expect(commandExpectation("PSB1234ABCD211")).toMatchObject({ owner: "kPowerLed", target: "control.powerLedSchedule" });
    expect(matchingFeedback(pending("PSQ"), "PSM1234ABCD11110F1")).toHaveLength(1);
    expect(matchingFeedback(pending("PSQ"), "feedpowled1")).toHaveLength(0);
    expect(matchingFeedback(pending("PSD"), "PSD1234ABCD17043A120000000A")).toHaveLength(1);
  });

  it("routes heater diagnostics without confusing them with metadata", () => {
    expect(commandExpectation("S5D")).toMatchObject({ owner: "Kheater", target: "control.heaterSchedule" });
    expect(matchingFeedback(pending("S5D"), "S5D1234ABCD17043A0100000005")).toHaveLength(1);
  });

  it("transitions a control without changing its command identity", () => {
    const feedback = pending("flow")["device.flow"];
    expect(transitionFeedback(feedback, "confirmed")).toMatchObject({
      id: feedback.id,
      target: feedback.target,
      phase: "confirmed",
      detail: null,
    });
    expect(transitionFeedback(feedback, "error", "OFFLINE")).toMatchObject({
      phase: "error",
      detail: "OFFLINE",
    });
  });

  it("requests one status resync before becoming unconfirmed", () => {
    const feedback = pending("flow")["device.flow"];
    expect(commandDeadlineAction(feedback, feedback.startedAt + 3_999)).toBe("wait");
    expect(commandDeadlineAction(feedback, feedback.startedAt + 4_000)).toBe("resync");
    expect(commandDeadlineAction(feedback, feedback.startedAt + 11_999)).toBe("resync");
    expect(commandDeadlineAction(feedback, feedback.startedAt + 12_000)).toBe("unconfirmed");
    expect(commandDeadlineAction(transitionFeedback(feedback, "confirmed"), feedback.startedAt + 20_000)).toBe("wait");
  });
});
