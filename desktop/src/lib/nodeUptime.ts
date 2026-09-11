export interface UptimePeer { uptime_valid?: boolean; uptime_s?: number; node_session?: number; offline?: boolean; stale?: boolean }
export interface UptimeAnchor { reported: number; session?: number; at: number; value: number; live: boolean }

export function updateUptime(previous: UptimeAnchor | null, peer: UptimePeer | undefined, connected: boolean, receivedAt: number, now: number): UptimeAnchor | null {
  if (!peer || peer.uptime_valid !== true || !Number.isSafeInteger(peer.uptime_s) || peer.uptime_s! < 0) return null;
  const fresh = connected && !peer.offline && !peer.stale && Number.isFinite(receivedAt) && now >= receivedAt && now - receivedAt < 120_000;
  const changed = !previous || previous.session !== peer.node_session || previous.reported !== peer.uptime_s;
  const anchor = changed ? { reported: peer.uptime_s!, session: peer.node_session, at: receivedAt, value: peer.uptime_s!, live: fresh } : previous;
  // A reconnect needs a new authoritative uptime before interpolation resumes.
  const live = fresh && (changed || anchor.live);
  return { ...anchor, live, value: live ? anchor.reported + Math.floor(Math.max(0, now - anchor.at) / 1000) : anchor.value };
}

export function formatUptime(seconds: number | null, daySuffix = "d"): string {
  if (seconds === null || !Number.isSafeInteger(seconds) || seconds < 0) return "--";
  const days = Math.floor(seconds / 86400);
  const clock = [Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, "0")).join(":");
  return days ? `${days}${daySuffix} ${clock}` : clock;
}
