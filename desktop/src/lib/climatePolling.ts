export const CLIMATE_INTERVALS = [10_000, 30_000, 60_000] as const;
export type ClimateQueryResult = "ok" | "unsupported" | "retry";

// One lifecycle owns every heater metadata query; unsupported extensions are
// retried only after a new connection, not at every display interval.
export class ClimatePoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private enabled = false;
  private disposed = false;
  private intervalMs = 10_000;
  private generation = 0;
  private unsupported = new Set<string>();
  constructor(private readonly send: (command: string) => Promise<ClimateQueryResult>) {}

  configure(enabled: boolean, intervalMs: number): void {
    const reconnect = enabled && !this.enabled;
    this.enabled = enabled;
    this.intervalMs = CLIMATE_INTERVALS.includes(intervalMs as 10_000) ? intervalMs : 10_000;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!enabled) { this.generation++; return; }
    if (reconnect) this.unsupported.clear();
    if (!this.running) void this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    this.enabled = false;
    this.generation++;
    if (this.timer !== null) clearTimeout(this.timer);
  }

  private async refresh(): Promise<void> {
    if (this.running || !this.enabled || this.disposed) return;
    this.running = true;
    const generation = this.generation;
    try {
      for (const command of ["heater.climate?", "heater.source?", "heater.relay?", "S5Q", "S5D", "D5Q"]) {
        if (!this.enabled || this.disposed || generation !== this.generation) break;
        if (this.unsupported.has(command)) continue;
        try {
          const result = await this.send(command);
          if (generation !== this.generation || !this.enabled || this.disposed) break;
          if (result === "unsupported") this.unsupported.add(command);
        } catch { /* The next bounded cycle retries transport failures. */ }
      }
    } finally {
      this.running = false;
      if (this.enabled && !this.disposed) this.timer = setTimeout(() => void this.refresh(), this.intervalMs);
    }
  }
}
