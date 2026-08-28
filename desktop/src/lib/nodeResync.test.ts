import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeResyncCoordinator } from "./nodeResync";

const inventory = { nodes: [{ tag: "node0" }, { tag: "humidifier" }] };

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("node status resync", () => {
  it("refreshes a node once when it appears in a connected inventory", async () => {
    const send = vi.fn(async (_command: string) => true);
    const coordinator = new NodeResyncCoordinator(send);
    coordinator.setConnected(true);
    coordinator.updateInventory(inventory);
    await flushPromises();

    expect(send.mock.calls.map(([command]) => command)).toEqual(["echo_turb", "pm1"]);

    coordinator.updateInventory(inventory);
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });

  it("starts a new refresh cycle after reconnect", async () => {
    const send = vi.fn(async (_command: string) => true);
    const coordinator = new NodeResyncCoordinator(send);
    coordinator.updateInventory(inventory);
    coordinator.setConnected(true);
    await flushPromises();
    coordinator.setConnected(false);
    coordinator.setConnected(true);
    await flushPromises();

    expect(send.mock.calls.map(([command]) => command)).toEqual([
      "echo_turb", "pm1", "echo_turb", "pm1",
    ]);
    coordinator.dispose();
  });

  it("retries a transient route failure with bounded backoff", async () => {
    vi.useFakeTimers();
    const send = vi.fn((_command: string): Promise<boolean> => Promise.resolve(true))
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const coordinator = new NodeResyncCoordinator(send, [2_000, 5_000]);
    coordinator.setConnected(true);
    coordinator.updateInventory(inventory);
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(send).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(4);
    coordinator.dispose();
  });

  it("cancels pending retries when the node disappears", async () => {
    vi.useFakeTimers();
    const send = vi.fn(async (_command: string) => false);
    const coordinator = new NodeResyncCoordinator(send, [2_000, 5_000]);
    coordinator.setConnected(true);
    coordinator.updateInventory(inventory);
    await flushPromises();
    expect(send).toHaveBeenCalledTimes(2);

    coordinator.updateInventory({ nodes: [{ tag: "node0" }] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(2);
    coordinator.dispose();
  });
});
