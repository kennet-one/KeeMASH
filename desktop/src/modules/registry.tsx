import { lazy } from "react";
import { Activity, BedDouble, BrainCircuit, Cable, CloudSun, CookingPot, Cpu, Droplets, Gauge, Heater, Lamp, LayoutDashboard, Lightbulb, ListTree, MemoryStick, Network, Radio, Search, ServerCog, Sparkles, TerminalSquare, Thermometer, TreePine } from "lucide-react";
import type { ModuleDefinition, WidgetDefinition } from "../core/moduleTypes";

const Connection = lazy(() => import("./MainModuleWidgets").then((module) => ({ default: module.ConnectionModuleWidget })));
const Weather = lazy(() => import("./MainModuleWidgets").then((module) => ({ default: module.WeatherModuleWidget })));
const Sensors = lazy(() => import("./MainModuleWidgets").then((module) => ({ default: module.SensorsModuleWidget })));
const Lighting = lazy(() => import("./MainModuleWidgets").then((module) => ({ default: module.LightingModuleWidget })));
const Climate = lazy(() => import("./MainModuleWidgets").then((module) => ({ default: module.ClimateModuleWidget })));
const EspMixer = lazy(() => import("./MainModuleWidgets").then((module) => ({ default: module.EspMixerModuleWidget })));
const Humidifier = lazy(() => import("./MainModuleWidgets").then((module) => ({ default: module.HumidifierModuleWidget })));
const PowerLed = lazy(() => import("./MainModuleWidgets").then((module) => ({ default: module.PowerLedModuleWidget })));
const Kheater = lazy(() => import("./MainModuleWidgets").then((module) => ({ default: module.HeaterModuleWidget })));
const Garland = lazy(() => import("./MainModuleWidgets").then((module) => ({ default: module.GarlandModuleWidget })));
const Bedside = lazy(() => import("./MainModuleWidgets").then((module) => ({ default: module.BedsideModuleWidget })));
const Lampk = lazy(() => import("./MainModuleWidgets").then((module) => ({ default: module.LampModuleWidget })));
const Jajowar = lazy(() => import("./MainModuleWidgets").then((module) => ({ default: module.EggCookerModuleWidget })));
const Choinka = lazy(() => import("./MainModuleWidgets").then((module) => ({ default: module.ChoinkaModuleWidget })));
const Console = lazy(() => import("./MainModuleWidgets").then((module) => ({ default: module.ConsoleModuleWidget })));
const Summary = lazy(() => import("./MonitorModuleWidgets").then((module) => ({ default: module.SummaryModuleWidget })));
const Thermals = lazy(() => import("./MonitorModuleWidgets").then((module) => ({ default: module.ThermalsModuleWidget })));
const Vram = lazy(() => import("./MonitorModuleWidgets").then((module) => ({ default: module.VramModuleWidget })));
const Residency = lazy(() => import("./MonitorModuleWidgets").then((module) => ({ default: module.GpuResidencyModuleWidget })));
const Pcie = lazy(() => import("./MonitorModuleWidgets").then((module) => ({ default: module.PcieModuleWidget })));
const Compute = lazy(() => import("./MonitorModuleWidgets").then((module) => ({ default: module.ComputeModuleWidget })));
const Details = lazy(() => import("./MonitorModuleWidgets").then((module) => ({ default: module.DetailsModuleWidget })));
const CccDaemon = lazy(() => import("./MonitorModuleWidgets").then((module) => ({ default: module.CccDaemonModuleWidget })));
const EnjoySearchWidget = lazy(() => import("../components/EnjoyWidgets").then((module) => ({ default: module.EnjoySearchWidget })));
const EnjoyGraphWidget = lazy(() => import("../components/EnjoyWidgets").then((module) => ({ default: module.EnjoyGraphWidget })));
const EnjoyInspectorWidget = lazy(() => import("../components/EnjoyWidgets").then((module) => ({ default: module.EnjoyInspectorWidget })));

const full = { lg: { w: 12, h: 4 }, md: { w: 8, h: 4 }, sm: { w: 4, h: 5 }, xs: { w: 1, h: 7 } };
const mediumNode = { lg: { w: 6, h: 4 }, md: { w: 8, h: 4 }, sm: { w: 4, h: 5 }, xs: { w: 1, h: 7 } };
const compactNode = { lg: { w: 3, h: 3 }, md: { w: 4, h: 3 }, sm: { w: 2, h: 4 }, xs: { w: 1, h: 5 } };
const statusNode = { lg: { w: 6, h: 3 }, md: { w: 4, h: 3 }, sm: { w: 4, h: 4 }, xs: { w: 1, h: 5 } };
const airNode = { lg: { w: 6, h: 6 }, md: { w: 8, h: 7 }, sm: { w: 4, h: 8 }, xs: { w: 1, h: 11 } };
const powerNode = { lg: { w: 6, h: 9 }, md: { w: 8, h: 9 }, sm: { w: 4, h: 10 }, xs: { w: 1, h: 14 } };
const heaterNode = { lg: { w: 6, h: 10 }, md: { w: 8, h: 10 }, sm: { w: 4, h: 12 }, xs: { w: 1, h: 16 } };

export const widgetDefinitions: WidgetDefinition[] = [
  { id: "main.connection", moduleId: "main", title: "node0", description: "KeeLink root, refresh and command controls", icon: Cable, component: Connection, singleton: true, sizes: full, capabilities: ["mesh.read", "mesh.command"] },
  { id: "main.weather", moduleId: "main", title: "Weather", description: "Outside weather and air quality", icon: CloudSun, component: Weather, singleton: true, sizes: full, capabilities: ["weather.read", "network.external"] },
  { id: "main.sensors", moduleId: "main", title: "Mesh sensors", description: "Live environmental readings from the mesh", icon: Thermometer, component: Sensors, singleton: true, sizes: full, capabilities: ["mesh.read", "mesh.command"] },
  { id: "main.lighting", moduleId: "main", title: "Lighting overview", description: "Optional lighting domain graph", icon: Lightbulb, component: Lighting, singleton: true, sizes: full, capabilities: ["mesh.read"] },
  { id: "main.climate", moduleId: "main", title: "Climate overview", description: "Optional climate domain graph", icon: Heater, component: Climate, singleton: true, sizes: full, capabilities: ["mesh.read"] },
  { id: "main.node.esp_mixer", moduleId: "main", title: "esp_mixer", description: "CO2, temperature, humidity and illuminance", icon: Thermometer, component: EspMixer, singleton: true, sizes: mediumNode, capabilities: ["mesh.read", "mesh.command"] },
  { id: "main.node.humidifier", moduleId: "main", title: "humidifier", description: "Air, water and particulate controls", icon: Droplets, component: Humidifier, singleton: true, sizes: airNode, capabilities: ["mesh.read", "mesh.command"] },
  { id: "main.node.kpowerled", moduleId: "main", title: "kPowerLed", description: "Power LED state and autonomous schedule", icon: Lightbulb, component: PowerLed, singleton: true, sizes: powerNode, capabilities: ["mesh.read", "mesh.command"] },
  { id: "main.node.kheater", moduleId: "main", title: "Kheater", description: "Heater operation, source and autonomous schedule", icon: Heater, component: Kheater, singleton: true, sizes: heaterNode, capabilities: ["mesh.read", "mesh.command"] },
  { id: "main.node.garland", moduleId: "main", title: "garland", description: "Garland endpoint", icon: Sparkles, component: Garland, singleton: true, sizes: compactNode, capabilities: ["mesh.read", "mesh.command"] },
  { id: "main.node.bedside_light", moduleId: "main", title: "bedside_light", description: "Bedside lighting endpoint", icon: BedDouble, component: Bedside, singleton: true, sizes: compactNode, capabilities: ["mesh.read", "mesh.command"] },
  { id: "main.node.lampk", moduleId: "main", title: "lampk", description: "Lamp endpoint", icon: Lamp, component: Lampk, singleton: true, sizes: compactNode, capabilities: ["mesh.read", "mesh.command"] },
  { id: "main.node.jajowar", moduleId: "main", title: "jajowar", description: "Timed appliance endpoint", icon: CookingPot, component: Jajowar, singleton: true, sizes: compactNode, capabilities: ["mesh.read", "mesh.command"] },
  { id: "main.node.choinka", moduleId: "main", title: "choinka", description: "Water-level and pump node status", icon: TreePine, component: Choinka, singleton: true, sizes: statusNode, capabilities: ["mesh.read", "mesh.command"] },
  { id: "main.console", moduleId: "main", title: "Console", description: "Bounded mesh event log", icon: TerminalSquare, component: Console, singleton: true, keepAlive: true, sizes: full, capabilities: ["mesh.read", "background.run"] },
  { id: "monitor.summary", moduleId: "monitor", title: "Resource summary", description: "CPU, RAM, GPU and VRAM overview", icon: Cpu, component: Summary, singleton: true, sizes: full, capabilities: ["resources.read"] },
  { id: "monitor.thermals", moduleId: "monitor", title: "Thermals and DIMMs", description: "Low-level temperatures, clocks and memory modules", icon: MemoryStick, component: Thermals, singleton: true, sizes: full, capabilities: ["resources.read", "hardware.lowlevel"] },
  { id: "monitor.vram", moduleId: "monitor", title: "VRAM chip thermals", description: "Exact per-chip HWiNFO temperatures and history", icon: MemoryStick, component: Vram, singleton: true, keepAlive: true, sizes: full, capabilities: ["resources.read", "hardware.lowlevel", "background.run"] },
  { id: "monitor.residency", moduleId: "monitor", title: "VRAM Residency", description: "Per-process GPU memory, priorities and safe process control", icon: ServerCog, component: Residency, singleton: true, keepAlive: true, sizes: full, capabilities: ["resources.read", "process.control", "process.inject", "background.run"] },
  { id: "monitor.pcie", moduleId: "monitor", title: "PCIe bus", description: "NVIDIA PCIe throughput and link state", icon: Activity, component: Pcie, singleton: true, keepAlive: true, sizes: full, capabilities: ["resources.read", "hardware.lowlevel", "background.run"] },
  { id: "monitor.compute", moduleId: "monitor", title: "Compute history", description: "CPU and GPU history", icon: Gauge, component: Compute, singleton: true, keepAlive: true, sizes: full, capabilities: ["resources.read", "background.run"] },
  { id: "monitor.details", moduleId: "monitor", title: "System details", description: "Network, memory and hardware details", icon: Network, component: Details, singleton: true, sizes: full, capabilities: ["resources.read"] },
  { id: "monitor.ccc", moduleId: "monitor", title: "CCC daemon", description: "CocoIndex daemon RAM, VRAM, threads and lifecycle", icon: Cpu, component: CccDaemon, singleton: true, keepAlive: true, sizes: full, capabilities: ["resources.read", "hardware.lowlevel", "background.run"] },
  { id: "enjoy.search", moduleId: "enjoy", title: "Knowledge search", description: "Search the KenULTRABIOS knowledge catalog", icon: Search, component: EnjoySearchWidget, singleton: true, sizes: full, capabilities: ["knowledge.read", "hardware.lowlevel"] },
  { id: "enjoy.graph", moduleId: "enjoy", title: "Knowledge graph", description: "Explore relationships and live module context", icon: BrainCircuit, component: EnjoyGraphWidget, singleton: true, sizes: full, capabilities: ["knowledge.read", "resources.read", "mesh.read", "hardware.lowlevel"] },
  { id: "enjoy.inspector", moduleId: "enjoy", title: "Inspector and What-if", description: "Inspect, simulate and invoke approved low-level workflows", icon: ListTree, component: EnjoyInspectorWidget, singleton: true, sizes: full, capabilities: ["knowledge.read", "mesh.command", "firmware.manage", "updates.manage", "hardware.lowlevel"] },
];

export const moduleDefinitions: ModuleDefinition[] = [
  { id: "main", title: "Main", description: "Mesh controls and KeeLink operations", version: "1.0.0", icon: Radio, trusted: true, capabilities: ["mesh.read", "mesh.command", "weather.read", "network.external", "background.run"], widgetIds: widgetDefinitions.filter((widget) => widget.moduleId === "main").map((widget) => widget.id) },
  { id: "monitor", title: "Monitor", description: "Host telemetry and low-level sensors", version: "1.1.0", icon: Cpu, trusted: true, capabilities: ["resources.read", "hardware.lowlevel", "process.control", "process.inject", "background.run"], widgetIds: widgetDefinitions.filter((widget) => widget.moduleId === "monitor").map((widget) => widget.id) },
  { id: "enjoy", title: "Enjoy", description: "KenULTRABIOS interactive system brain", version: "1.0.0", icon: BrainCircuit, trusted: true, capabilities: ["mesh.read", "mesh.command", "serial.read", "serial.command", "resources.read", "weather.read", "knowledge.read", "network.external", "hardware.lowlevel", "firmware.manage", "updates.manage", "background.run"], widgetIds: widgetDefinitions.filter((widget) => widget.moduleId === "enjoy").map((widget) => widget.id) },
];

export const widgetById = new Map(widgetDefinitions.map((widget) => [widget.id, widget]));
export const moduleById = new Map(moduleDefinitions.map((module) => [module.id, module]));
export const homeDefinition = { id: "home" as const, title: "Home", description: "Cross-module command dashboard", icon: LayoutDashboard };
