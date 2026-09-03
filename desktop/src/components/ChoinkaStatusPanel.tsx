import { Activity, Droplets, RefreshCw, ShieldCheck, Timer, Waves } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppServices } from "../core/appServices";
import { useLocale } from "../i18n/locale";
import { CHOINKA_STALE_MS, formatPumpStartAge, type ChoinkaStatus } from "../lib/choinkaStatus";
import { feedbackClass, type CommandFeedback } from "../lib/commandFeedback";

interface Props {
  status: ChoinkaStatus | null;
  feedback?: CommandFeedback;
  onSend: (command: string, options?: { quiet?: boolean; trackFeedback?: boolean }) => Promise<boolean>;
}

export function ChoinkaStatusPanel({ status, feedback, onSend }: Props) {
  const { text } = useLocale();
  const { meshStatus } = useAppServices();
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const sender = useRef(onSend);
  useEffect(() => { sender.current = onSend; }, [onSend]);
  const refresh = useCallback(async (automatic = false) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try { await sender.current("choinka.status", automatic ? { quiet: true, trackFeedback: false } : undefined); }
    finally { running.current = false; setBusy(false); }
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  // Inventory resync owns the initial/reconnect request; this only refreshes an
  // already observed application while its widget is mounted.
  const observed = status !== null;
  useEffect(() => {
    if (!meshStatus.connected || !observed) return;
    const timer = window.setInterval(() => void refresh(true), 15_000);
    return () => window.clearInterval(timer);
  }, [meshStatus.connected, observed, refresh]);

  const age = status ? Math.max(0, now - status.receivedAt) : null;
  const stale = !meshStatus.connected || age === null || age > CHOINKA_STALE_MS;
  const bit = (value: boolean | null | undefined) => value == null ? "?" : value ? "ON" : "OFF";
  const stop = status ? text(`controls.choinkaStop_${status.stopReason}`) : "--";
  return <section className={`choinka-status${stale ? " is-stale" : ""}`} aria-label={text("controls.choinkaParameters")}>
    <header>
      <div><Waves size={20} /><strong>{text("controls.choinkaParameters")}</strong></div>
      <span role="status">{age === null ? text("controls.choinkaWaiting") : `${text(stale ? "controls.choinkaStale" : "controls.choinkaFresh")} · ${Math.floor(age / 1_000)} s`}</span>
      <button type="button" className={`icon-button${feedbackClass(feedback)}`} disabled={!meshStatus.connected || busy} aria-busy={busy} title={text("controls.choinkaRefresh")} aria-label={text("controls.choinkaRefresh")} onClick={() => void refresh()}><RefreshCw size={17} /></button>
    </header>
    <dl className="choinka-parameters">
      <div><dt><Droplets size={16} />{text("controls.choinkaLevel")}</dt><dd>{status ? text(`controls.choinkaLevel_${status.level}`) : "--"}</dd></div>
      <div className={status?.pumpOn && !stale ? "is-active" : ""}><dt><Waves size={16} />{text("controls.pump")}</dt><dd>{bit(status?.pumpOn)}</dd></div>
      <div className={status?.hardwareBlocked ? "is-warning" : ""}><dt><ShieldCheck size={16} />{text("controls.choinkaBlock")}</dt><dd>{bit(status?.hardwareBlocked)}</dd></div>
      <div><dt><Timer size={16} />{text("controls.choinkaCooldown")}</dt><dd>{status ? `${Math.ceil(status.cooldownMs / 1_000)} s` : "--"}</dd></div>
      <div><dt>{text("controls.choinkaVoltage")} A → B</dt><dd>{status ? `${status.voltageAbMv} mV` : "--"}</dd></div>
      <div><dt>{text("controls.choinkaVoltage")} B → A</dt><dd>{status ? `${status.voltageBaMv} mV` : "--"}</dd></div>
      <div><dt>{text("controls.choinkaCalibration")}</dt><dd>{status ? text(status.calibrated ? "controls.choinkaCalibrated" : "controls.choinkaApproximate") : "--"}</dd></div>
      <div className={status && status.timeoutCount > 0 ? "is-warning" : ""}><dt><Activity size={16} />{text("controls.choinkaTimeouts")}</dt><dd>{status?.timeoutCount ?? "--"}</dd></div>
      <div className="choinka-stop"><dt>{text("controls.choinkaStop")}</dt><dd>{stop}</dd></div>
      <div className="choinka-stop" title={text("controls.choinkaLastStartHint")}><dt><Timer size={16} />{text("controls.choinkaLastStart")}</dt><dd>{status?.lastStartAgeSeconds == null ? text("controls.choinkaNoData") : status.lastStartAgeSeconds < 0 ? text("controls.choinkaNeverStarted") : formatPumpStartAge(status.lastStartAgeSeconds)}</dd></div>
    </dl>
  </section>;
}
