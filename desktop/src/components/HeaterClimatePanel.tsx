import { Check, Droplets, RefreshCw, Save, Thermometer } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAppServices } from "../core/appServices";
import { useWorkspace } from "../core/workspace";
import { useLocale } from "../i18n/locale";
import { bridge } from "../lib/bridge";
import { ClimatePoller } from "../lib/climatePolling";
import { parseHeaterClimate, parseHeaterSourceStatus, parseHeaterRelay, type HeaterRelayStatus, type HeaterClimateStatus } from "../lib/heaterClimate";
import { normalizeMeshMac } from "../lib/typedSensors";
import type { LegacyState } from "../lib/protocol";

export function HeaterClimatePanel({ state }: { state: LegacyState }) {
  const app = useAppServices();
  const { profile, setSignalBinding } = useWorkspace();
  const { text } = useLocale();
  const [now, setNow] = useState(Date.now());
  const [queried, setQueried] = useState<HeaterClimateStatus | null>(null);
  const [sourceStatus, setSourceStatus] = useState(state.controls.heaterSource);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("internal");
  const [edited, setEdited] = useState(false);
  const [relay, setRelay] = useState<HeaterRelayStatus | null>(null);
  const [relayBusy, setRelayBusy] = useState(false);
  const pollerRef = useRef<ClimatePoller | null>(null);
  const queryEpoch = useRef(0);
  const climate = state.controls.heaterClimate && (!queried || state.controls.heaterClimate.receivedAt > queried.receivedAt)
    ? state.controls.heaterClimate : queried;
  const saved = state.controls.heaterSource && (!sourceStatus || state.controls.heaterSource.receivedAt > sourceStatus.receivedAt)
    ? state.controls.heaterSource : sourceStatus;
  const latest = useRef(climate);
  latest.current = climate;
  const [displayed, setDisplayed] = useState(climate);
  const binding = profile.signalBindings["Kheater.inputTemperature"];
  const requested = binding?.zoneEnabled && binding.sourceMac ? binding.sourceMac : "internal";
  const inventory = app.meshInventory as { nodes?: Array<{ tag: string; mac: string; offline?: boolean; node_session?: number; v2_session?: number }> } | null;
  const heater = inventory?.nodes?.find((node) => node.tag?.toLowerCase() === "kheater");
  const heaterMac = normalizeMeshMac(heater?.mac);
  const connectionKey = `${app.meshStatus.connected}:${heaterMac}:${heater?.node_session ?? heater?.v2_session ?? 0}`;
  const previousConnectionKey = useRef("");
  const providers = Object.values(state.typedSensors).filter((source) =>
    source.mac !== heaterMac && source.nodeId !== "Kheater" && source.metrics.temperatureC !== undefined);
  const sourceName = (mac: string | null) => mac === null || mac === "internal" ? "INT · AHT30"
    : providers.find((source) => source.mac === mac)?.tag ?? mac;

  useEffect(() => {
    if (!edited) setDraft(saved ? saved.enabled && saved.sourceMac ? saved.sourceMac : "internal" : requested);
  }, [saved?.enabled, saved?.sourceMac, requested, edited]);

  useEffect(() => {
    let active = true;
    const poller = new ClimatePoller(async (command) => {
      const epoch = queryEpoch.current;
      const result = await bridge.mesh.send("Kheater", command);
      if (!active || epoch !== queryEpoch.current) return "retry";
      if (result.status !== 0) {
        const notSupported = result.status === 1 || result.status === 0x106 || /unsupported|not[ _]supported/i.test(result.text);
        if (command === "heater.climate?" && notSupported) setUnsupported(true);
        return notSupported ? "unsupported" : "retry";
      }
      const nextClimate = parseHeaterClimate(result.text);
      const nextSource = parseHeaterSourceStatus(result.text);
      if (nextClimate) { setQueried(nextClimate); setUnsupported(false); }
      if (nextSource) setSourceStatus(nextSource);
      const nextRelay = parseHeaterRelay(result.text);
      if (nextRelay) setRelay(nextRelay);
      return "ok";
    });
    pollerRef.current = poller;
    return () => { active = false; poller.dispose(); pollerRef.current = null; };
  }, []);
  useEffect(() => {
    queryEpoch.current++;
    if (connectionKey !== previousConnectionKey.current) {
      previousConnectionKey.current = connectionKey;
      setQueried(null); setSourceStatus(null); setRelay(null); setUnsupported(false);
      pollerRef.current?.configure(false, profile.meshTelemetryIntervalMs);
    }
    pollerRef.current?.configure(app.meshStatus.connected && heaterMac !== null, profile.meshTelemetryIntervalMs);
    if (!app.meshStatus.connected) { setQueried(null); setSourceStatus(null); setRelay(null); }
  }, [app.meshStatus.connected, heaterMac, connectionKey, profile.meshTelemetryIntervalMs]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    setDisplayed(latest.current);
    const timer = setInterval(() => setDisplayed(latest.current), profile.meshTelemetryIntervalMs);
    return () => clearInterval(timer);
  }, [profile.meshTelemetryIntervalMs, climate?.actualSource, climate?.fallback, climate?.zoneEnabled,
    climate?.appliedRevision, climate?.internalTemperatureC === null, climate?.internalHumidityPercent === null,
    climate?.effectiveTemperatureC === null, climate === null]);

  const connected = app.meshStatus.connected;
  const receiptAge = climate ? Math.max(0, now - climate.receivedAt) / 1_000 : Infinity;
  const internalAge = climate?.internalAgeSeconds == null ? null : climate.internalAgeSeconds + receiptAge;
  const externalAge = climate?.externalAgeSeconds == null ? null : climate.externalAgeSeconds + receiptAge;
  const localValid = connected && internalAge !== null && internalAge < 10 && climate?.internalTemperatureC !== null;
  const humidityValid = connected && internalAge !== null && internalAge < 10 && climate?.internalHumidityPercent !== null;
  const activeAge = climate?.actualSource === "zone" ? externalAge : internalAge;
  const effectiveValid = connected && climate?.actualSource !== "none" && activeAge !== null &&
    activeAge < (climate?.actualSource === "zone" ? 30 : 10) && climate?.effectiveTemperatureC !== null;
  const ageLabel = (age: number | null) => age === null ? text("common.unknown") : text("climate.sampleAge", { seconds: Math.floor(age) });
  const displayValue = (value: number | null | undefined, valid: boolean, unit: string) => valid && value != null ? `${value.toFixed(1)} ${unit}` : "--";
  const displayedAge = displayed ? Math.max(0, now - displayed.receivedAt) / 1_000 : 0;
  const sampleAge = (external = false) => {
    const age = external ? displayed?.externalAgeSeconds : displayed?.internalAgeSeconds;
    return age == null ? null : age + displayedAge;
  };
  const shownInternalFresh = sampleAge() !== null && sampleAge()! < 10;
  const shownEffectiveFresh = sampleAge(displayed?.actualSource === "zone") !== null &&
    sampleAge(displayed?.actualSource === "zone")! < (displayed?.actualSource === "zone" ? 30 : 10);
  const providerAvailable = (source: typeof providers[number]) => {
    const metric = source.metrics.temperatureC;
    return source.connected && metric?.valid && !metric.stale && !metric.error &&
      now - metric.receivedAt + (metric.ageAtReceiptMs ?? 0) < 30_000;
  };

  const applySource = async () => {
    if (busy || !connected) return;
    const mac = draft === "internal" ? null : normalizeMeshMac(draft);
    if (draft !== "internal" && (!mac || mac === heaterMac || (Number.parseInt(mac.slice(0, 2), 16) & 1) !== 0)) {
      setError(text("climate.invalidSource")); return;
    }
    const provider = providers.find((source) => source.mac === mac);
    setSignalBinding("Kheater.inputTemperature", mac ? `${provider?.nodeId ?? mac}.temperatureC` : "Kheater.temperatureC", mac !== null, mac);
    setBusy(true);
    setError(null);
    try {
      const result = await bridge.mesh.send("Kheater", mac ? `heater.source:zone:${mac}` : "heater.source:internal");
      if (result.status !== 0) throw new Error(result.text || `KeeLink ${result.status}`);
      const status = parseHeaterSourceStatus(result.text);
      if (!status || !status.saved || status.error !== 0 || status.enabled !== (mac !== null) ||
          (mac !== null && status.sourceMac !== mac)) throw new Error(text("climate.notConfirmed"));
      setSourceStatus(status);
      setEdited(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };

  const applyRelay = async (seconds: number) => {
    if (relayBusy || !connected || ![10, 30, 60].includes(seconds)) return;
    setRelayBusy(true);
    setError(null);
    try {
      const result = await bridge.mesh.send("Kheater", `heater.relay:${seconds}`);
      const status = parseHeaterRelay(result.text);
      if (result.status !== 0 || !status || status.intervalSeconds !== seconds) throw new Error(result.text || text("climate.notConfirmed"));
      setRelay(status);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setRelayBusy(false); }
  };

  return <section className="heater-climate-panel" aria-label={text("climate.localClimate")}>
    <div className="heater-climate-readings">
      <div className={localValid && shownInternalFresh ? "" : "is-stale"}><Thermometer size={18} /><span>{text("climate.internalTemperature")}</span><strong>{displayValue(displayed?.internalTemperatureC, localValid, "°C")}</strong><small>AHT30 · {ageLabel(sampleAge())}{(!localValid || !shownInternalFresh) && climate ? ` · ${text("climate.stale")}` : ""}</small></div>
      <div className={humidityValid && shownInternalFresh ? "" : "is-stale"}><Droplets size={18} /><span>{text("climate.internalHumidity")}</span><strong>{displayValue(displayed?.internalHumidityPercent, humidityValid, "%")}</strong><small>AHT30 · {ageLabel(sampleAge())}{(!humidityValid || !shownInternalFresh) && climate ? ` · ${text("climate.stale")}` : ""}</small></div>
      <div className={effectiveValid && shownEffectiveFresh ? "" : "is-stale"}><Thermometer size={18} /><span>{text("climate.effectiveTemperature")}</span><strong>{displayValue(displayed?.effectiveTemperatureC, effectiveValid, "°C")}</strong><small>{climate?.actualSource === "internal" ? "INT" : climate?.actualSource === "zone" ? "ZONE" : "--"} · {ageLabel(sampleAge(climate?.actualSource === "zone"))}{(!effectiveValid || !shownEffectiveFresh) && climate ? ` · ${text("climate.stale")}` : ""}</small></div>
    </div>
    <div className="heater-zone-control">
      <label><span>{text("controls.inputSource")}</span><select value={draft} disabled={busy} onChange={(event) => { setDraft(event.target.value); setEdited(true); }}>
        <option value="internal">INT · AHT30</option>
        {providers.map((source) => <option key={source.mac} value={source.mac}>{source.tag ?? source.mac} · {source.mac}{!providerAvailable(source) ? ` · ${text("controls.sourceUnavailable")}` : ""}</option>)}
        {draft !== "internal" && !providers.some((source) => source.mac === draft) && <option value={draft}>{draft} · {text("controls.sourceUnavailable")}</option>}
      </select></label>
      <button type="button" onClick={() => void applySource()} disabled={busy || !connected || !heaterMac || unsupported} title={text("climate.applySource")} aria-label={text("climate.applySource")} aria-busy={busy}>{busy ? <RefreshCw size={17} /> : <Save size={17} />}</button>
    </div>
    <dl className="heater-zone-status">
      <div><dt>{text("climate.requested")}</dt><dd>{sourceName(requested)}</dd></div>
      <div><dt>{text("climate.saved")}</dt><dd>{saved?.saved ? <><Check size={12} />{sourceName(saved.enabled ? saved.sourceMac : null)}</> : "--"}</dd></div>
      <div><dt>{text("climate.applied")}</dt><dd>{connected && saved?.applied && saved.error === 0 ? `rev ${saved.revision}` : text("common.waiting")}</dd></div>
      <div><dt>{text("climate.active")}</dt><dd>{connected && receiptAge < 10 ? climate?.actualSource === "zone" ? sourceName(climate.configuredSourceMac) : climate?.actualSource === "internal" ? "INT · AHT30" : "--" : "--"}</dd></div>
    </dl>
    <div className="heater-zone-control" title={text("climate.relayHint")}>
      <label><span>{text("climate.relayInterval")}</span><select value={relay?.intervalSeconds ?? ""} disabled={!relay || !connected || relayBusy} aria-busy={relayBusy} onChange={(event) => void applyRelay(Number(event.target.value))}>
        {!relay && <option value="">{text("climate.relayWaiting")}</option>}
        {[10, 30, 60].map((seconds) => <option key={seconds} value={seconds}>{text("climate.seconds", { seconds })}</option>)}
      </select></label>
      {relay && <small>{relay.hysteresisC.toFixed(1)} °C</small>}
    </div>
    {climate?.fallback && climate.fallback !== "none" && <p className="heater-climate-warning" role="status">{text(`climate.fallback.${climate.fallback}`)}</p>}
    {unsupported && <p className="heater-climate-warning">{text("climate.unsupported")}</p>}
    {(error || saved?.error) && <p className="heater-climate-warning" role="alert">{error ?? `KeeLink ${saved?.error}`}</p>}
  </section>;
}
