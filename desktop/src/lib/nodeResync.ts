import { meshFeedbackCommandsForTag } from "./operationalGraph";

export interface ResyncInventoryNode {
  tag: string;
  offline?: boolean;
}

export interface ResyncInventory {
  nodes?: ResyncInventoryNode[];
}

type StatusSender = (command: string) => Promise<boolean>;
type TimerHandle = ReturnType<typeof setTimeout>;

interface RefreshJob {
  token: number;
  timer: TimerHandle | null;
}

export class NodeResyncCoordinator {
  private readonly liveTags = new Set<string>();
  private readonly syncedTags = new Set<string>();
  private readonly jobs = new Map<string, RefreshJob>();
  private connected = false;
  private disposed = false;
  private nextToken = 0;

  constructor(
    private readonly send: StatusSender,
    private readonly retryDelaysMs: readonly number[] = [2_000, 5_000],
  ) {}

  setConnected(connected: boolean): void {
    if (this.disposed || this.connected === connected) return;
    this.connected = connected;
    this.cancelJobs();
    this.syncedTags.clear();
    if (connected) this.refreshUnsynced();
  }

  updateInventory(inventory: ResyncInventory | null | undefined): void {
    if (this.disposed) return;
    const next = new Set(
      (inventory?.nodes ?? [])
        .filter((node) => !node.offline && typeof node.tag === "string" && node.tag.length > 0)
        .map((node) => node.tag.toLowerCase()),
    );
    for (const tag of this.liveTags) {
      if (next.has(tag)) continue;
      this.syncedTags.delete(tag);
      this.cancelJob(tag);
    }
    this.liveTags.clear();
    for (const tag of next) this.liveTags.add(tag);
    if (this.connected) this.refreshUnsynced();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelJobs();
    this.liveTags.clear();
    this.syncedTags.clear();
  }

  private refreshUnsynced(): void {
    for (const tag of this.liveTags) {
      if (this.syncedTags.has(tag)) continue;
      this.syncedTags.add(tag);
      const commands = meshFeedbackCommandsForTag(tag);
      if (commands.length > 0) this.startAttempt(tag, commands, 0);
    }
  }

  private startAttempt(tag: string, commands: string[], attempt: number): void {
    this.cancelJob(tag);
    const token = ++this.nextToken;
    this.jobs.set(tag, { token, timer: null });
    void this.runAttempt(tag, commands, attempt, token);
  }

  private async runAttempt(tag: string, commands: string[], attempt: number, token: number): Promise<void> {
    let successful = true;
    for (const command of commands) {
      if (!this.isCurrent(tag, token)) return;
      if (!await this.send(command)) successful = false;
    }
    if (!this.isCurrent(tag, token)) return;
    if (successful || attempt >= this.retryDelaysMs.length) {
      this.jobs.delete(tag);
      return;
    }
    const job = this.jobs.get(tag);
    if (!job) return;
    job.timer = setTimeout(() => {
      if (this.isCurrent(tag, token)) this.startAttempt(tag, commands, attempt + 1);
    }, this.retryDelaysMs[attempt]);
  }

  private isCurrent(tag: string, token: number): boolean {
    return !this.disposed && this.connected && this.liveTags.has(tag) &&
      this.jobs.get(tag)?.token === token;
  }

  private cancelJob(tag: string): void {
    const job = this.jobs.get(tag);
    if (job?.timer !== null && job?.timer !== undefined) clearTimeout(job.timer);
    this.jobs.delete(tag);
  }

  private cancelJobs(): void {
    for (const tag of [...this.jobs.keys()]) this.cancelJob(tag);
  }
}
