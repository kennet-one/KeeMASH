import {
  Cloud,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Droplets,
  Gauge,
  Moon,
  RefreshCw,
  Sun,
  Wind,
  type LucideIcon,
} from "lucide-react";
import { LocalizedText, useLocale } from "../i18n/locale";
import type { WeatherSnapshot } from "../types";
import { TechnicalTerm } from "./TechnicalTerm";

function value(input: number | null | undefined, unit: string, digits = 0): string {
  return input === null || input === undefined ? "--" : `${input.toFixed(digits)}${unit}`;
}
function clock(input: string | null | undefined): string { return input ? input.slice(11, 16) : "--:--"; }

export type WeatherCondition = "clear" | "cloud" | "rain" | "snow" | "storm";
export type PrecipitationKind = "rain" | "snow";

const snowCodes = new Set([71, 73, 75, 77, 85, 86]);
const rainCodes = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82]);
const stormCodes = new Set([95, 96, 99]);

export function weatherCondition(weather: WeatherSnapshot | null): WeatherCondition {
  const code = weather?.current.weatherCode;
  if ((weather?.current.snowfallCm ?? 0) > 0 || (code !== null && code !== undefined && snowCodes.has(code))) return "snow";
  if (code !== null && code !== undefined && stormCodes.has(code)) return "storm";
  if ((weather?.current.rainMm ?? 0) > 0 || (code !== null && code !== undefined && rainCodes.has(code))) return "rain";
  if ((weather?.current.cloudPercent ?? 0) >= 45 || (code !== null && code !== undefined && code >= 1)) return "cloud";
  return "clear";
}

export function precipitationKind(weather: WeatherSnapshot | null): PrecipitationKind {
  const currentCode = weather?.current.weatherCode;
  const dailyCode = weather?.daily.weatherCode;
  return (weather?.current.snowfallCm ?? 0) > 0 ||
    (weather?.daily.snowfallSumCm ?? 0) > 0 ||
    (currentCode !== null && currentCode !== undefined && snowCodes.has(currentCode)) ||
    (dailyCode !== null && dailyCode !== undefined && snowCodes.has(dailyCode))
    ? "snow"
    : "rain";
}

function conditionIcon(condition: WeatherCondition, isDay: boolean | null | undefined): LucideIcon {
  if (condition === "snow") return CloudSnow;
  if (condition === "storm") return CloudLightning;
  if (condition === "rain") return CloudRain;
  if (condition === "cloud") return isDay === false ? Cloud : CloudSun;
  return isDay === false ? Moon : Sun;
}

export function WeatherPanel({ weather, loading, onRefresh }: { weather: WeatherSnapshot | null; loading: boolean; onRefresh: () => void }) {
  const { text } = useLocale();
  const condition = weatherCondition(weather);
  const precipitation = precipitationKind(weather);
  const ConditionIcon = conditionIcon(condition, weather?.current.isDay);
  const PrecipitationIcon = precipitation === "snow" ? CloudSnow : CloudRain;
  return (
    <section className={`weather-band weather-${condition}`} aria-label={text("weather.section")}>
      <div className="section-heading weather-heading">
        <div className="weather-primary"><span className={`weather-condition-icon condition-${condition}`}><ConditionIcon size={22} /></span><span><span className="eyebrow"><LocalizedText textKey="weather.outside" /></span><h2>{value(weather?.current.temperatureC, " C", 1)}</h2></span></div>
        <button className="icon-button" type="button" onClick={onRefresh} title={text("weather.refresh")} aria-label={text("weather.refresh")}><RefreshCw size={16} className={loading ? "spin" : ""} /></button>
      </div>
      <div className="weather-metrics">
        <div className="weather-metric motion-humidity"><Droplets size={16} /><LocalizedText textKey="weather.humidity" /><strong>{value(weather?.current.humidityPercent, "%")}</strong></div>
        <div className="weather-metric motion-wind"><Wind size={16} /><LocalizedText textKey="weather.wind" /><strong>{value(weather?.current.windKmh, " km/h", 1)}</strong></div>
        <div className={`weather-metric motion-${precipitation}`}><PrecipitationIcon size={16} /><LocalizedText textKey="weather.precipitation" /><strong className="precipitation-value"><span>{text("weather.chanceNow", { value: value(weather?.current.precipitationProbabilityPercent, "%") })}</span><small>{text("weather.chanceToday", { value: value(weather?.daily.precipitationProbabilityMaxPercent, "%") })} · {value(weather?.daily.precipitationSumMm, " mm", 1)}</small></strong></div>
        <div className="weather-metric motion-air"><Gauge size={16} /><TechnicalTerm term="PM2.5" /><strong>{value(weather?.air.pm25, "", 1)}</strong></div>
        <div className="weather-metric motion-sun"><Sun size={16} /><LocalizedText textKey="weather.sun" /><strong>{clock(weather?.daily.sunrise)} / {clock(weather?.daily.sunset)}</strong></div>
        <div className="weather-metric motion-temperature"><span className="weather-symbol">H/L</span><LocalizedText textKey="weather.today" /><strong>{value(weather?.daily.temperatureMaxC, " C", 1)} / {value(weather?.daily.temperatureMinC, " C", 1)}</strong></div>
      </div>
    </section>
  );
}
