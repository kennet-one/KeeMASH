import { CloudRain, Droplets, Gauge, RefreshCw, Sun, Wind } from "lucide-react";
import type { WeatherSnapshot } from "../types";

function value(value: number | null | undefined, unit: string, digits = 0): string {
  return value === null || value === undefined ? "--" : `${value.toFixed(digits)}${unit}`;
}

function clock(value: string | null | undefined): string {
  if (!value) return "--:--";
  return value.slice(11, 16);
}

interface WeatherPanelProps {
  weather: WeatherSnapshot | null;
  loading: boolean;
  onRefresh: () => void;
}

export function WeatherPanel({ weather, loading, onRefresh }: WeatherPanelProps) {
  return (
    <section className="weather-band" aria-label="Outside weather">
      <div className="section-heading weather-heading">
        <div>
          <span className="eyebrow">Outside</span>
          <h2>{value(weather?.current.temperatureC, " C", 1)}</h2>
        </div>
        <button className="icon-button" type="button" onClick={onRefresh} title="Refresh weather">
          <RefreshCw size={16} className={loading ? "spin" : ""} />
        </button>
      </div>
      <div className="weather-metrics">
        <div><Droplets size={16} /><span>Humidity</span><strong>{value(weather?.current.humidityPercent, "%")}</strong></div>
        <div><Wind size={16} /><span>Wind</span><strong>{value(weather?.current.windKmh, " km/h", 1)}</strong></div>
        <div><CloudRain size={16} /><span>Rain</span><strong>{value(weather?.current.precipitationMm, " mm", 1)}</strong></div>
        <div><Gauge size={16} /><span>PM2.5</span><strong>{value(weather?.air.pm25, "", 1)}</strong></div>
        <div><Sun size={16} /><span>Sun</span><strong>{clock(weather?.daily.sunrise)} / {clock(weather?.daily.sunset)}</strong></div>
        <div><span className="weather-symbol">H/L</span><span>Today</span><strong>{value(weather?.daily.temperatureMaxC, " C", 1)} / {value(weather?.daily.temperatureMinC, " C", 1)}</strong></div>
      </div>
    </section>
  );
}
