import type { MeshNodeId } from "./operationalGraph";

export type CommandFeedbackPhase =
  | "sending"
  | "awaiting"
  | "confirmed"
  | "error"
  | "unconfirmed";

export interface CommandFeedback {
  id: number;
  command: string;
  owner: MeshNodeId;
  target: string;
  phase: CommandFeedbackPhase;
  startedAt: number;
  detail: string | null;
}

export interface CommandExpectation {
  owner: MeshNodeId;
  target: string;
  feedbackCommand: string | null;
  reply: RegExp;
}

export type CommandDeadlineAction = "wait" | "resync" | "unconfirmed";

const exact = (command: string, expectation: CommandExpectation): [RegExp, CommandExpectation] => [
  new RegExp(`^${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  expectation,
];

const commandExpectations: Array<[RegExp, CommandExpectation]> = [
  exact("garland", { owner: "garland", target: "device.garland", feedbackCommand: "garland_echo", reply: /^(garland_(?:on|off)|garl[01])$/ }),
  exact("bedside", { owner: "bedside_light", target: "device.bedside", feedbackCommand: "bedside_echo", reply: /^(?:bdsdl[01]|bedsi_(?:on|off))$/ }),
  exact("lam", { owner: "lampk", target: "device.lamp", feedbackCommand: "lamech", reply: /^La[01]$/ }),
  exact("powled", { owner: "kPowerLed", target: "device.powerLed", feedbackCommand: "pwech", reply: /^(?:feedpowled|powled)[01]$/ }),
  exact("pomp", { owner: "humidifier", target: "device.pump", feedbackCommand: "echo_turb", reply: /^(?:13[01]|15\d{4})$/ }),
  exact("flow", { owner: "humidifier", target: "device.flow", feedbackCommand: "echo_turb", reply: /^(?:16[01]|15\d{4})$/ }),
  exact("ion", { owner: "humidifier", target: "device.ionizer", feedbackCommand: "echo_turb", reply: /^(?:17[01]|15\d{4})$/ }),
  exact("HR0", { owner: "Kheater", target: "device.heaterRotation", feedbackCommand: "heho", reply: /^(?:090|H5.*r0v)/ }),
  exact("HR1", { owner: "Kheater", target: "device.heaterRotation", feedbackCommand: "heho", reply: /^(?:091|H5.*r1v)/ }),
  exact("hero", { owner: "Kheater", target: "device.heaterRotation", feedbackCommand: "heho", reply: /^(?:09[01]|H5)/ }),
  exact("jajo", { owner: "jajowar", target: "device.eggCooker", feedbackCommand: "jajoeh", reply: /^(?:jajo_(?:start|on)|jaeh)$/ }),
  [/^14[0-3]$/, { owner: "humidifier", target: "control.turboMode", feedbackCommand: "echo_turb", reply: /^(?:14[0-3]|15\d{4})$/ }],
  [/^18[0-3]$/, { owner: "humidifier", target: "control.humidifierColor", feedbackCommand: "echo_turb", reply: /^21[0-3]$/ }],
  [/^19(?:[0-9]|M)$/, { owner: "humidifier", target: "control.humidifierWaterLevel", feedbackCommand: "echo_turb", reply: /^20/ }],
  [/^he[0-5]$/, { owner: "Kheater", target: "control.heaterMode", feedbackCommand: "heho", reply: /^(?:25[0-4]|A5|H5)/ }],
  [/^W5/, { owner: "Kheater", target: "control.heaterTarget", feedbackCommand: "heho", reply: /^(?:R5|H5)/ }],
  exact("P50", { owner: "Kheater", target: "control.heaterPersistence", feedbackCommand: "heho", reply: /^H5.*p0(?:q[01])?$/ }),
  exact("P51", { owner: "Kheater", target: "control.heaterPersistence", feedbackCommand: "heho", reply: /^H5.*p1(?:q[01])?$/ }),
  exact("M50", { owner: "Kheater", target: "control.heaterModePersistence", feedbackCommand: "heho", reply: /^H5.*q0$/ }),
  exact("M51", { owner: "Kheater", target: "control.heaterModePersistence", feedbackCommand: "heho", reply: /^H5.*q1$/ }),
  exact("D50", { owner: "Kheater", target: "control.heaterDisplay", feedbackCommand: "D5Q", reply: /^D5S[01]0[01]$/ }),
  exact("D51", { owner: "Kheater", target: "control.heaterDisplay", feedbackCommand: "D5Q", reply: /^D5S[01]1[01]$/ }),
  exact("D5P0", { owner: "Kheater", target: "control.heaterDisplayPersistence", feedbackCommand: "D5Q", reply: /^D5S[01][01]0$/ }),
  exact("D5P1", { owner: "Kheater", target: "control.heaterDisplayPersistence", feedbackCommand: "D5Q", reply: /^D5S[01][01]1$/ }),
  exact("D5Q", { owner: "Kheater", target: "control.heaterDisplay", feedbackCommand: null, reply: /^D5S[01]{3}$/ }),
  [/^S5[BCPQD]/, { owner: "Kheater", target: "control.heaterSchedule", feedbackCommand: "S5Q", reply: /^S5[MPD]/ }],
  [/^PS[BCPQD]/, { owner: "kPowerLed", target: "control.powerLedSchedule", feedbackCommand: "PSQ", reply: /^PS[MPD]/ }],
  exact("ppm_echo", { owner: "esp_mixer", target: "sensor.ppm", feedbackCommand: null, reply: /^04/ }),
  exact("temp_echo", { owner: "esp_mixer", target: "sensor.temperatureC", feedbackCommand: null, reply: /^05/ }),
  exact("humi_echo", { owner: "esp_mixer", target: "sensor.humidityPercent", feedbackCommand: null, reply: /^06/ }),
  exact("lux_echo", { owner: "esp_mixer", target: "sensor.lux", feedbackCommand: null, reply: /^07/ }),
  exact("pm1", { owner: "humidifier", target: "sensor.particulate", feedbackCommand: null, reply: /^(?:10|11|12)/ }),
];

export function commandExpectation(command: string): CommandExpectation | null {
  return commandExpectations.find(([pattern]) => pattern.test(command))?.[1] ?? null;
}

export function matchingFeedback(
  pending: Record<string, CommandFeedback>,
  token: string,
): CommandFeedback[] {
  return Object.values(pending).filter((feedback) => {
    const expectation = commandExpectation(feedback.command);
    return expectation?.reply.test(token) ?? false;
  });
}

export function feedbackClass(feedback: CommandFeedback | undefined): string {
  return feedback ? ` feedback-${feedback.phase}` : "";
}

export function transitionFeedback(
  feedback: CommandFeedback,
  phase: CommandFeedbackPhase,
  detail: string | null = null,
): CommandFeedback {
  return { ...feedback, phase, detail };
}

export function commandDeadlineAction(
  feedback: CommandFeedback,
  now: number,
): CommandDeadlineAction {
  if (feedback.phase !== "awaiting") return "wait";
  const age = Math.max(0, now - feedback.startedAt);
  if (age >= 12_000) return "unconfirmed";
  if (age >= 4_000 && commandExpectation(feedback.command)?.feedbackCommand) return "resync";
  return "wait";
}
