import { describe, expect, it } from "vitest";
import { formatUptime, updateUptime } from "./nodeUptime";

describe("node uptime", () => {
  const peer = { uptime_valid: true, uptime_s: 100, node_session: 1 };
  it("formats days and rejects unknown values without showing zero", () => {
    expect(formatUptime(184465)).toBe("2d 03:14:25");
    expect(formatUptime(184465, " д")).toBe("2 д 03:14:25");
    expect(formatUptime(0)).toBe("00:00:00");
    expect(formatUptime(null)).toBe("--");
    expect(updateUptime(null, { uptime_valid: false }, true, 0, 0)).toBeNull();
  });
  it("does not re-anchor duplicate reports", () => {
    const first = updateUptime(null, peer, true, 1000, 1000);
    expect(updateUptime(first, peer, true, 4000, 6000)?.value).toBe(105);
  });
  it("freezes offline and waits for authoritative data on reconnect", () => {
    const first = updateUptime(null, peer, true, 1000, 6000);
    const offline = updateUptime(first, peer, false, 1000, 7000);
    expect(offline?.value).toBe(105);
    expect(updateUptime(offline, peer, true, 9000, 10000)?.live).toBe(false);
    expect(updateUptime(offline, { ...peer, uptime_s: 120 }, true, 10000, 10000)?.value).toBe(120);
  });
  it("resets after a new boot and rejects stale inventory", () => {
    const first = updateUptime(null, peer, true, 0, 1000);
    expect(updateUptime(first, { ...peer, node_session: 2, uptime_s: 2 }, true, 2000, 2000)?.value).toBe(2);
    expect(updateUptime(first, peer, true, 0, 130000)?.live).toBe(false);
  });
});
