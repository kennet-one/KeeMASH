import { CloudRain, Droplets, Gauge, RefreshCw, Sun, Wind } from "lucide-react";
import { LocalizedText, useLocale } from "../i18n/locale";
import type { WeatherSnapshot } from "../types";
import { TechnicalTerm } from "./TechnicalTerm";

function value(input: number | null | undefined, unit: string, digits = 0): string {
  return input === null || input === undefined ? "--" : `${input.toFixed(digits)}${unit}`;
}
function clock(input: string | null | undefined): string { return input ? input.slice(11, 16) : "--:--"; }

export function WeatherPanel({ weather, loading, onRefresh }: { weather: WeatherSnapshot | null; loading: boolean; onRefresh: () => void }) {
  const { text } = useLocale();
  return (
    <section className="weather-band" aria-label={text("weather.section")}>
      <div className="section-heading weather-heading">
        <div><span className="eyebrow"><LocalizedText textKey="weather.outside" /></span><h2>{value(weather?.current.temperatureC, " C", 1)}</h2></div>
        <button className="icon-button" type="button" onClick={onRefresh} title={text("weather.refresh")} aria-label={text("weather.refresh")}><RefreshCw size={16} className={loading ? "spin" : ""} /></button>
      </div>
      <div className="weather-metrics">
        <div><Droplets size={16} /><LocalizedText textKey="weather.humidity" /><strong>{value(weather?.current.humidityPercent, "%")}</strong></div>
        <div><Wind size={16} /><LocalizedText textKey="weather.wind" /><strong>{value(weather?.current.windKmh, " km/h", 1)}</strong></div>
        <div><CloudRain size={16} /><LocalizedText textKey="weather.rain" /><strong>{value(weather?.current.precipitationMm, " mm", 1)}</strong></div>
        <div><Gauge size={16} /><TechnicalTerm term="PM2.5" /><strong>{value(weather?.air.pm25, "", 1)}</strong></div>
        <div><Sun size={16} /><LocalizedText textKey="weather.sun" /><strong>{clock(weather?.daily.sunrise)} / {clock(weather?.daily.sunset)}</strong></div>
        <div><span className="weather-symbol">H/L</span><LocalizedText textKey="weather.today" /><strong>{value(weather?.daily.temperatureMaxC, " C", 1)} / {value(weather?.daily.temperatureMinC, " C", 1)}</strong></div>
      </div>
    </section>
  );
}
