import {
  Activity,
  AirVent,
  BedDouble,
  CookingPot,
  Droplets,
  Fan,
  Gauge,
  Heater,
  Lamp,
  Lightbulb,
  RefreshCw,
  RotateCw,
  Sparkles,
  Thermometer,
  Waves,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { DeviceKey, LegacyState } from "../lib/protocol";
import type { WeatherSnapshot } from "../types";
import { WeatherPanel } from "./WeatherPanel";

export interface ConsoleEntry {
  id: number;
  timestamp: number;
  direction: "rx" | "tx" | "system";
  text: string;
}

interface DeviceActionProps {
  label: string;
  icon: LucideIcon;
  state: boolean | null;
  onClick: () => void;
}

function DeviceAction({ label, icon: Icon, state, onClick }: DeviceActionProps) {
  const stateClass = state === true ? " is-on" : state === false ? " is-off" : " is-unknown";
  return (
    <button className={`device-action${stateClass}`} type="button" onClick={onClick}>
      <span className="device-icon"><Icon size={19} /></span>
      <span>{label}</span>
      <span className="device-state">{state === null ? "?" : state ? "ON" : "OFF"}</span>
    </button>
  );
}

interface SensorMetricProps {
  label: string;
  value: number | null;
  unit: string;
  icon: LucideIcon;
  command: string;
  onSend: (command: string) => void;
}

function SensorMetric({ label, value, unit, icon: Icon, command, onSend }: SensorMetricProps) {
  return (
    <div className="sensor-metric">
      <Icon size={17} />
      <span>{label}</span>
      <strong>{value === null ? "--" : Number(value.toFixed(2))}<small>{unit}</small></strong>
      <button className="metric-refresh" type="button" onClick={() => onSend(command)} title={`Refresh ${label}`}>
        <RefreshCw size={13} />
      </button>
    </div>
  );
}

interface ControlsViewProps {
  state: LegacyState;
  weather: WeatherSnapshot | null;
  weatherLoading: boolean;
  consoleEntries: ConsoleEntry[];
  onWeatherRefresh: () => void;
  onSend: (command: string) => void;
}

const redModes = ["Rainbow", "Rainbow G", "BPM", "Red", "Juggle", "Sinelon", "Confetti", "Green", "Rasta", "White"];
const percentOptions = Array.from({ length: 11 }, (_, index) => `${index * 10}%`);
const turboModes = ["OFF", "L", "M", "H"];
const humidifierColors = ["Black", "Red", "Green", "White"];
const heaterModes = ["OFF", "Fan", "Low", "High", "Max", "AUTO"];

export function ControlsView({
  state,
  weather,
  weatherLoading,
  consoleEntries,
  onWeatherRefresh,
  onSend,
}: ControlsViewProps) {
  const [speed, setSpeed] = useState("");
  const [heaterTarget, setHeaterTarget] = useState(state.controls.heaterTargetC);

  useEffect(() => setHeaterTarget(state.controls.heaterTargetC), [state.controls.heaterTargetC]);

  const device = (key: DeviceKey) => state.devices[key];
  const submitSpeed = () => {
    const trimmed = speed.trim();
    if (!trimmed) return;
    onSend(`05${trimmed}`);
    setSpeed("");
  };

  return (
    <div className="view-stack view-enter">
      <WeatherPanel weather={weather} loading={weatherLoading} onRefresh={onWeatherRefresh} />

      <section className="sensor-strip" aria-label="Mesh sensors">
        <SensorMetric label="CO2" value={state.sensors.ppm} unit=" ppm" icon={Activity} command="ppm_echo" onSend={onSend} />
        <SensorMetric label="Temp" value={state.sensors.temperatureC} unit=" C" icon={Thermometer} command="temp_echo" onSend={onSend} />
        <SensorMetric label="Humidity" value={state.sensors.humidityPercent} unit="%" icon={Droplets} command="humi_echo" onSend={onSend} />
        <SensorMetric label="Lux" value={state.sensors.lux} unit=" lx" icon={Lightbulb} command="lux_echo" onSend={onSend} />
        <SensorMetric label="Pressure" value={state.sensors.pressure} unit="" icon={Gauge} command="atm_echo" onSend={onSend} />
        <SensorMetric label="PM2.5" value={state.sensors.pm25} unit="" icon={AirVent} command="pm1" onSend={onSend} />
      </section>

      <div className="control-grid">
        <section className="control-panel lighting-panel">
          <div className="section-heading">
            <div><span className="eyebrow">Nodes</span><h2>Lighting</h2></div>
            <Sparkles size={19} />
          </div>
          <div className="device-grid">
            <DeviceAction label="Garland" icon={Sparkles} state={device("garland")} onClick={() => onSend("garland")} />
            <DeviceAction label="Red LED" icon={Zap} state={device("redLed")} onClick={() => onSend("power")} />
            <DeviceAction label="Bedside" icon={BedDouble} state={device("bedside")} onClick={() => onSend("bedside")} />
            <DeviceAction label="Lamp" icon={Lamp} state={device("lamp")} onClick={() => onSend("lam")} />
            <DeviceAction label="Power LED" icon={Lightbulb} state={device("powerLed")} onClick={() => onSend("powled")} />
          </div>
          <div className="control-row three-column-row">
            <label>Mode
              <select value={state.controls.redMode} onChange={(event) => onSend(`01_mode_${event.target.value}`)}>
                {redModes.map((mode, index) => <option key={mode} value={index}>{mode}</option>)}
              </select>
            </label>
            <label>Brightness
              <select value={state.controls.redBrightness} onChange={(event) => onSend(`02_bri_${Number(event.target.value) <= 9 ? event.target.value : "M"}`)}>
                {percentOptions.map((option, index) => <option key={option} value={index}>{option}</option>)}
              </select>
            </label>
            <label>Speed
              <span className="step-control">
                <button type="button" onClick={() => onSend("redl_sp-")}>-</button>
                <input value={speed} onChange={(event) => setSpeed(event.target.value)} onKeyDown={(event) => event.key === "Enter" && submitSpeed()} placeholder={state.sensors.speed?.toString() ?? "--"} />
                <button type="button" onClick={() => onSend("redl_sp+")}>+</button>
              </span>
            </label>
          </div>
        </section>

        <section className="control-panel climate-panel">
          <div className="section-heading">
            <div><span className="eyebrow">Nodes</span><h2>Climate</h2></div>
            <Droplets size={19} />
          </div>
          <div className="device-grid climate-devices">
            <DeviceAction label="Humidifier" icon={Droplets} state={device("humidifier")} onClick={() => onSend("huOn")} />
            <DeviceAction label="Pump" icon={Waves} state={device("pump")} onClick={() => onSend("pomp")} />
            <DeviceAction label="Flow" icon={Activity} state={device("flow")} onClick={() => onSend("flow")} />
            <DeviceAction label="Ionizer" icon={Zap} state={device("ionizer")} onClick={() => onSend("ion")} />
            <DeviceAction label="Rotation" icon={RotateCw} state={device("heaterRotation")} onClick={() => onSend("hero")} />
            <DeviceAction label="Egg cooker" icon={CookingPot} state={device("eggCooker")} onClick={() => onSend("jajo")} />
          </div>
          <div className="control-row three-column-row">
            <label>Turbo
              <select value={state.controls.turboMode} onChange={(event) => onSend(`14${event.target.value}`)}>
                {turboModes.map((mode, index) => <option key={mode} value={index}>{mode}</option>)}
              </select>
            </label>
            <label>Water
              <select value={state.controls.humidifierWaterLevel} onChange={(event) => onSend(`19${Number(event.target.value) <= 9 ? event.target.value : "M"}`)}>
                {percentOptions.map((option, index) => <option key={option} value={index}>{option}</option>)}
              </select>
            </label>
            <label>Color
              <select value={state.controls.humidifierColor} onChange={(event) => onSend(`18${event.target.value}`)}>
                {humidifierColors.map((color, index) => <option key={color} value={index}>{color}</option>)}
              </select>
            </label>
          </div>
          <div className="heater-row">
            <span className="heater-label"><Heater size={17} /> Heater</span>
            <span className="mode-readout">{heaterModes[state.controls.heaterMode] ?? "Unknown"}</span>
            <label>Target
              <input
                type="number"
                min="0"
                max="45"
                step="0.1"
                value={heaterTarget}
                onChange={(event) => setHeaterTarget(Number(event.target.value))}
                onBlur={() => onSend(`W5${heaterTarget.toFixed(2)}`)}
                onKeyDown={(event) => event.key === "Enter" && onSend(`W5${heaterTarget.toFixed(2)}`)}
              />
            </label>
          </div>
        </section>

        <section className="control-panel console-panel">
          <div className="section-heading">
            <div><span className="eyebrow">Transport</span><h2>Console</h2></div>
            <Fan size={19} />
          </div>
          <div className="console-list" role="log" aria-live="polite">
            {consoleEntries.slice(-120).map((entry) => (
              <div className={`console-line line-${entry.direction}`} key={entry.id}>
                <time>{new Date(entry.timestamp).toLocaleTimeString([], { hour12: false })}</time>
                <span>{entry.direction.toUpperCase()}</span>
                <code>{entry.text}</code>
              </div>
            ))}
            {consoleEntries.length === 0 && <div className="console-empty">No traffic</div>}
          </div>
        </section>
      </div>
    </div>
  );
}
