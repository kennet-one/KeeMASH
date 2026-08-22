import { Bluetooth, Bug, KeyRound, RefreshCw, Send, ShieldCheck, Wifi } from "lucide-react";
import { FormEvent, useState } from "react";
import { LocalizedText, useLocale } from "../i18n/locale";
import type { RootStatus } from "../types";

interface ConnectionBarProps {
  status: RootStatus;
  autoRefresh: boolean;
  autoRefreshMinutes: number;
  debugEnabled: boolean;
  busy: boolean;
  onPair: () => void;
  onRevoke: () => void;
  onRefresh: () => void;
  onAutoRefreshChange: (enabled: boolean) => void;
  onAutoRefreshMinutesChange: (minutes: number) => void;
  onDebugChange: (enabled: boolean) => void;
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
  const TransportIcon = props.status.transport === "ble" ? Bluetooth : Wifi;
  const identity = props.status.rootIdentity ?? "node0";
  const detail = props.status.connected
    ? `${props.status.transport.toUpperCase()}${props.status.latencyMs === null ? "" : ` · ${props.status.latencyMs} ms`}`
    : props.status.reconnectPhase;

  return (
    <section className="connection-strip" aria-label={text("connection.section")}>
      <div className="connection-cluster">
        <div className={`root-link-state${props.status.connected ? " is-active" : ""}`}>
          <TransportIcon size={18} />
          <span className="root-link-identity">{identity}</span>
          <span className="root-link-detail">{detail}</span>
          {props.status.paired && <ShieldCheck size={15} aria-label={props.status.security} />}
        </div>
        {!props.status.paired ? (
          <button className="command-button primary-button" type="button" onClick={props.onPair}>
            <KeyRound size={16} /> pair root
          </button>
        ) : (
          <button className="icon-button" type="button" onClick={props.onRevoke} title="Forget KeeLink pairing" aria-label="Forget KeeLink pairing">
            <KeyRound size={16} />
          </button>
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
      {props.status.lastError && <span className="connection-error" title={props.status.lastError}>{props.status.lastError}</span>}
    </section>
  );
}
