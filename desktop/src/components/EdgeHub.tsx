import { PanelLeft, PanelTop, Plus, ScanLine } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import type { HubDock, HubEdge } from "../core/runtimeTypes";
import { useWorkspace } from "../core/workspace";
import { useLocale } from "../i18n/locale";

const edgeOrder: HubEdge[] = ["left", "right", "top", "bottom"];

function nearestDock(clientX: number, clientY: number): HubDock {
  const width = Math.max(window.innerWidth, 1);
  const height = Math.max(window.innerHeight, 1);
  const distances: Record<HubEdge, number> = {
    left: clientX,
    right: width - clientX,
    top: clientY,
    bottom: height - clientY,
  };
  const edge = edgeOrder.reduce((closest, candidate) => distances[candidate] < distances[closest] ? candidate : closest, "right");
  const rawOffset = edge === "left" || edge === "right" ? clientY / height : clientX / width;
  return { edge, offset: Math.min(0.92, Math.max(0.08, rawOffset)) };
}

function hubStyle({ edge, offset }: HubDock): CSSProperties {
  const percent = `${offset * 100}%`;
  if (edge === "left") return { left: 8, top: percent };
  if (edge === "right") return { right: 8, top: percent };
  if (edge === "top") return { top: 8, left: percent };
  return { bottom: 8, left: percent };
}

export function EdgeHub({ onAddWidget }: { onAddWidget: () => void }) {
  const { text } = useLocale();
  const {
    profile,
    setHubDock,
    setImmersiveChrome,
    setSidebarMode,
    setTopbarVisible,
  } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<HubDock | null>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  const dock = preview ?? profile.hubDock;

  const pointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - state.x, event.clientY - state.y) > 5) state.moved = true;
    if (state.moved) {
      setOpen(false);
      setPreview(nearestDock(event.clientX, event.clientY));
    }
  };
  const pointerEnd = (event: PointerEvent<HTMLButtonElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (state.moved) {
      const next = nearestDock(event.clientX, event.clientY);
      setHubDock(next);
      setPreview(null);
    } else {
      setOpen((value) => !value);
    }
    drag.current = null;
  };

  const toggleSidebar = () => {
    setSidebarMode(profile.sidebarMode === "hidden" ? profile.sidebarRestoreMode : "hidden");
    setOpen(false);
  };

  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const edgeByKey: Partial<Record<string, HubEdge>> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "top",
      ArrowDown: "bottom",
    };
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    const edge = edgeByKey[event.key];
    if (!edge) return;
    event.preventDefault();
    setHubDock({ edge, offset: profile.hubDock.offset });
    setOpen(false);
  };

  return <div className={`edge-hub edge-${dock.edge}${open ? " is-open" : ""}${preview ? " is-dragging" : ""}`} style={hubStyle(dock)}>
    <button className="edge-drop" type="button" aria-label={text("shell.edgeHub")} aria-expanded={open} onKeyDown={keyDown} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd}><Plus size={19} /></button>
    {open && <div className="edge-hub-menu" role="menu">
      <button type="button" role="menuitem" onClick={() => { onAddWidget(); setOpen(false); }} title={text("shell.addWidget")}><Plus size={17} /><span>{text("shell.addWidget")}</span></button>
      <button type="button" role="menuitem" className={profile.topbarVisible ? "is-active" : ""} onClick={() => { setTopbarVisible(!profile.topbarVisible); setOpen(false); }} title={text("shell.toggleTopbar")}><PanelTop size={17} /><span>{text("shell.topbar")}</span></button>
      <button type="button" role="menuitem" className={profile.sidebarMode !== "hidden" ? "is-active" : ""} onClick={toggleSidebar} title={text("shell.toggleSidebar")}><PanelLeft size={17} /><span>{text("shell.sidebar")}</span></button>
      <button type="button" role="menuitem" className={profile.immersiveChrome ? "is-active" : ""} onClick={() => { setImmersiveChrome(!profile.immersiveChrome); setOpen(false); }} title={text("shell.immersiveChrome")}><ScanLine size={17} /><span>{text("shell.immersive")}</span></button>
    </div>}
  </div>;
}
