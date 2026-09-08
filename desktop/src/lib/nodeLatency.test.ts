import { expect, it } from "vitest";
import { getNodeLatency, recordNodeLatency, setLatencyConnection } from "./nodeLatency";

it("isolates peers and rejects late measurements from an earlier transport session", () => {
  setLatencyConnection(100, "wss");
  const event = { mac: "001122334455", connectionId: 100, correlationId: 12, rttMs: 15, transport: "wss" };
  recordNodeLatency(event, 1000);
  recordNodeLatency({ ...event, mac: "001122334466", rttMs: 41 }, 1100);
  expect(getNodeLatency(event.mac)?.rttMs).toBe(15);
  recordNodeLatency(event, 2000);
  expect(getNodeLatency(event.mac)?.receivedAt).toBe(1000);
  setLatencyConnection(101, "wss");
  expect(getNodeLatency(event.mac)).toBeUndefined();
  recordNodeLatency(event, 3000);
  expect(getNodeLatency(event.mac)).toBeUndefined();
  recordNodeLatency({ ...event, connectionId: 101, transport: "ble" }, 3100);
  expect(getNodeLatency(event.mac)).toBeUndefined();
  recordNodeLatency({ ...event, connectionId: 101 }, 3200);
  expect(getNodeLatency(event.mac)?.receivedAt).toBe(3200);
  setLatencyConnection(0, "none");
});
