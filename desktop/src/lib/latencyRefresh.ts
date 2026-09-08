export interface LatencyTarget { mac: string; owner: string; command: string }

export class LatencyRefresh {
  private targets = new Map<symbol, LatencyTarget>();
  private attempts = new Map<string, number>();
  private running = false;
  private connected = false;
  private pauseUntil = 0;
  constructor(private send: (target: LatencyTarget) => Promise<unknown>,
    private fresh: (mac: string, now: number) => boolean) {}
  setConnected(value: boolean): void { this.connected = value; }
  pause(now: number): void { this.pauseUntil = now + 45_000; }
  register(key: string, target: LatencyTarget): () => void {
    const registration = Symbol(key);
    if (this.targets.size < 64) this.targets.set(registration, target);
    return () => { this.targets.delete(registration); };
  }
  async tick(now: number): Promise<void> {
    if (!this.connected || this.running || now < this.pauseUntil) return;
    const target = [...this.targets.values()].filter(item =>
      now - (this.attempts.get(item.mac) ?? -Infinity) >= 30_000 && !this.fresh(item.mac, now))
      .sort((a, b) => (this.attempts.get(a.mac) ?? -Infinity) - (this.attempts.get(b.mac) ?? -Infinity))[0];
    if (!target) return;
    if (this.attempts.size >= 64 && !this.attempts.has(target.mac)) {
      const oldest = [...this.attempts].sort((a, b) => a[1] - b[1])[0];
      if (oldest) this.attempts.delete(oldest[0]);
    }
    this.attempts.set(target.mac, now);
    this.running = true;
    try { await this.send(target); } catch { /* Next bounded attempt retries. */ }
    finally { this.running = false; }
  }
}
