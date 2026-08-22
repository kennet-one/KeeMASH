import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";

export type ModuleId = "main" | "monitor" | "enjoy";
export type WorkspaceId = "home" | ModuleId;

export type ModuleCapability =
  | "mesh.read"
  | "mesh.command"
  | "serial.read"
  | "serial.command"
  | "resources.read"
  | "weather.read"
  | "knowledge.read"
  | "network.external"
  | "hardware.lowlevel"
  | "process.control"
  | "process.inject"
  | "firmware.manage"
  | "updates.manage"
  | "background.run";

export interface WidgetSize {
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
}

export interface WidgetDefinition {
  id: string;
  moduleId: ModuleId;
  title: string;
  description: string;
  icon: LucideIcon;
  component: ComponentType;
  singleton?: boolean;
  keepAlive?: boolean;
  sizes: Record<"lg" | "md" | "sm" | "xs", WidgetSize>;
  capabilities: ModuleCapability[];
}

export interface ModuleDefinition {
  id: ModuleId;
  title: string;
  description: string;
  version: string;
  icon: LucideIcon;
  capabilities: ModuleCapability[];
  widgetIds: string[];
  trusted: true;
}

export type RuntimeState = "active" | "background" | "idle" | "disabled";
