import type { SerialPortInfo } from "../types";

export function preferredStartupPort(
  ports: SerialPortInfo[],
  savedPort: string | null,
): string | null {
  if (savedPort && ports.some((port) => port.path === savedPort)) return savedPort;
  return ports.find((port) => port.path.toUpperCase() === "COM4")?.path ?? null;
}
