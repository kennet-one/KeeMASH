import { expect, it, vi } from "vitest";
import { LatencyRefresh } from "./latencyRefresh";

it("keeps a second visible representation registered when the first closes", async () => {
  const send = vi.fn(async () => undefined);
  const service = new LatencyRefresh(send, () => false);
  const target = { mac: "001122334455", owner: "lampk", command: "lamech" };
  const closeFirst = service.register("lampk", target);
  const closeSecond = service.register("lampk", target);
  service.setConnected(true);
  closeFirst();
  await service.tick(0);
  expect(send).toHaveBeenCalledTimes(1);
  closeSecond();
  await service.tick(30000);
  expect(send).toHaveBeenCalledTimes(1);
});

it("serializes visible queries, bounds retries and pauses on OTA", async () => {
  let finish!: () => void;
  const send = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const service = new LatencyRefresh(send, () => false);
  service.setConnected(true);
  const hide = service.register("a", { mac: "001122334455", owner: "lampk", command: "lamech" });
  const first = service.tick(0);
  await service.tick(5000);
  expect(send).toHaveBeenCalledTimes(1);
  finish(); await first;
  await service.tick(29999);
  expect(send).toHaveBeenCalledTimes(1);
  service.pause(30000);
  await service.tick(74000);
  expect(send).toHaveBeenCalledTimes(1);
  hide(); await service.tick(76000);
  expect(send).toHaveBeenCalledTimes(1);
});

it("reuses fresh measurements and never queries while disconnected", async () => {
  const send = vi.fn(async () => undefined);
  let fresh = true;
  const service = new LatencyRefresh(send, () => fresh);
  service.register("a", { mac: "001122334455", owner: "lampk", command: "lamech" });
  await service.tick(0);
  service.setConnected(true); await service.tick(1000);
  expect(send).not.toHaveBeenCalled();
  fresh = false; await service.tick(2000);
  expect(send).toHaveBeenCalledTimes(1);
});
