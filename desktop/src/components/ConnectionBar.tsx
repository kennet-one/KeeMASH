import { Bug, Cable, RefreshCw, Send, Unplug } from "lucide-react";
import { FormEvent, useState } from "react";
import type { SerialPortInfo, SerialStatus } from "../types";

interface ConnectionBarProps {
  ports: SerialPortInfo[];
  selectedPort: string;
  status: SerialStatus;
  autoRefresh: boolean;
  autoRefreshMinutes: number;
  debugEnabled: boolean;
  busy: boolean;
  onPortChange: (path: string) => void;
  onRescan: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onRefresh: () => void;
  onAutoRefreshChange: (enabled: boolean) => void;
  onAutoRefreshMinutesChange: (minutes: number) => void;
  onDebugChange: (enabled: boolean) => void;
  onSend: (command: string) => void;
}

export function ConnectionBar({
  ports,
  selectedPort,
  status,
  autoRefresh,
  autoRefreshMinutes,
  debugEnabled,
  busy,
  onPortChange,
  onRescan,
  onConnect,
  onDisconnect,
  onRefresh,
  onAutoRefreshChange,
  onAutoRefreshMinutesChange,
  onDebugChange,
  onSend,
}: ConnectionBarProps) {
  const [rawCommand, setRawCommand] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const command = rawCommand.trim();
    if (!command) return;
    onSend(command);
    setRawCommand("");
  };

  return (
    <section className="connection-strip" aria-label="Connection">
      <div className="connection-cluster">
        <Cable size={18} />
        <select
          className="field compact-field"
          value={selectedPort}
          onChange={(event) => onPortChange(event.target.value)}
          disabled={status.connected}
          aria-label="Serial port"
        >
          {ports.length === 0 && <option value="">No serial ports</option>}
          {ports.map((port) => (
            <option key={port.path} value={port.path}>
              {port.path}{port.manufacturer ? ` - ${port.manufacturer}` : ""}
            </option>
          ))}
        </select>
        <button className="icon-button" type="button" onClick={onRescan} title="Rescan serial ports">
          <RefreshCw size={17} />
        </button>
        {status.connected ? (
          <button className="command-button danger-button" type="button" onClick={onDisconnect}>
            <Unplug size={16} /> Disconnect
          </button>
        ) : (
          <button
            className="command-button primary-button"
            type="button"
            onClick={onConnect}
            disabled={!selectedPort || busy}
          >
            <Cable size={16} /> Connect
          </button>
        )}
      </div>

      <div className="connection-cluster center-cluster">
        <button className="command-button" type="button" onClick={onRefresh} disabled={!status.connected || busy}>
          <RefreshCw size={16} className={busy ? "spin" : ""} /> Refresh
        </button>
        <label className={`inline-toggle${autoRefresh ? " is-active" : ""}`}>
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(event) => onAutoRefreshChange(event.target.checked)}
          />
          Auto
        </label>
        <select
          className="field tiny-field"
          value={autoRefreshMinutes}
          onChange={(event) => onAutoRefreshMinutesChange(Number(event.target.value))}
          disabled={!autoRefresh}
          aria-label="Auto refresh interval"
        >
          {[60, 45, 30, 15].map((minutes) => (
            <option key={minutes} value={minutes}>{minutes} min</option>
          ))}
        </select>
        <label className={`inline-toggle${debugEnabled ? " is-active" : ""}`}>
          <input
            type="checkbox"
            checked={debugEnabled}
            onChange={(event) => onDebugChange(event.target.checked)}
          />
          <Bug size={15} /> Debug
        </label>
      </div>

      <form className="raw-command" onSubmit={submit}>
        <input
          className="field"
          value={rawCommand}
          onChange={(event) => setRawCommand(event.target.value)}
          placeholder="Command"
          maxLength={256}
          aria-label="Raw command"
        />
        <button className="icon-button" type="submit" disabled={!status.connected || !rawCommand.trim()} title="Send command">
          <Send size={17} />
        </button>
      </form>
    </section>
  );
}
