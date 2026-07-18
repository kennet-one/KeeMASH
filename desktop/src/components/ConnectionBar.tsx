import { Bug, Cable, RefreshCw, Send, Unplug } from "lucide-react";
import { FormEvent, useState } from "react";
import { LocalizedText, useLocale } from "../i18n/locale";
import type { SerialPortInfo, SerialStatus } from "../types";

interface ConnectionBarProps {
  ports: SerialPortInfo[]; selectedPort: string; status: SerialStatus; autoRefresh: boolean;
  autoRefreshMinutes: number; debugEnabled: boolean; busy: boolean;
  onPortChange: (path: string) => void; onRescan: () => void; onConnect: () => void;
  onDisconnect: () => void; onRefresh: () => void; onAutoRefreshChange: (enabled: boolean) => void;
  onAutoRefreshMinutesChange: (minutes: number) => void; onDebugChange: (enabled: boolean) => void;
  onSend: (command: string) => void;
}

export function ConnectionBar(props: ConnectionBarProps) {
  const { text } = useLocale();
  const [rawCommand, setRawCommand] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const command = rawCommand.trim();
    if (!command) return;
    props.onSend(command);
    setRawCommand("");
  };
  return (
    <section className="connection-strip" aria-label={text("connection.section")}>
      <div className="connection-cluster">
        <Cable size={18} />
        <select className="field compact-field" value={props.selectedPort} onChange={(event) => props.onPortChange(event.target.value)} disabled={props.status.connected} aria-label={text("connection.serialPort")}>
          {props.ports.length === 0 && <option value="">{text("connection.noPorts")}</option>}
          {props.ports.map((port) => <option key={port.path} value={port.path}>{port.path}{port.manufacturer ? ` - ${port.manufacturer}` : ""}</option>)}
        </select>
        <button className="icon-button" type="button" onClick={props.onRescan} title={text("connection.rescan")} aria-label={text("connection.rescan")}><RefreshCw size={17} /></button>
        {props.status.connected ? (
          <button className="command-button danger-button" type="button" onClick={props.onDisconnect}><Unplug size={16} /><LocalizedText textKey="connection.disconnect" /></button>
        ) : (
          <button className="command-button primary-button" type="button" onClick={props.onConnect} disabled={!props.selectedPort || props.busy}><Cable size={16} /><LocalizedText textKey="connection.connect" /></button>
        )}
      </div>
      <div className="connection-cluster center-cluster">
        <button className="command-button" type="button" onClick={props.onRefresh} disabled={!props.status.connected || props.busy}><RefreshCw size={16} className={props.busy ? "spin" : ""} /><LocalizedText textKey="common.refresh" /></button>
        <label className={`inline-toggle${props.autoRefresh ? " is-active" : ""}`}>
          <input type="checkbox" checked={props.autoRefresh} onChange={(event) => props.onAutoRefreshChange(event.target.checked)} />
          <LocalizedText textKey="connection.auto" />
        </label>
        <select className="field tiny-field" value={props.autoRefreshMinutes} onChange={(event) => props.onAutoRefreshMinutesChange(Number(event.target.value))} disabled={!props.autoRefresh} aria-label={text("connection.interval")}>
          {[60, 45, 30, 15].map((minutes) => <option key={minutes} value={minutes}>{minutes} min</option>)}
        </select>
        <label className={`inline-toggle${props.debugEnabled ? " is-active" : ""}`}>
          <input type="checkbox" checked={props.debugEnabled} onChange={(event) => props.onDebugChange(event.target.checked)} />
          <Bug size={15} /><LocalizedText textKey="connection.debug" />
        </label>
      </div>
      <form className="raw-command" onSubmit={submit}>
        <input className="field" value={rawCommand} onChange={(event) => setRawCommand(event.target.value)} placeholder={text("connection.command")} maxLength={256} aria-label={text("connection.rawCommand")} />
        <button className="icon-button" type="submit" disabled={!props.status.connected || !rawCommand.trim()} title={text("connection.send")} aria-label={text("connection.send")}><Send size={17} /></button>
      </form>
    </section>
  );
}
