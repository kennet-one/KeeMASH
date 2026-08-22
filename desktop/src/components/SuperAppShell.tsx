import { Activity, AlertTriangle, Check, Cpu, Languages, Menu, PackageOpen, PanelLeftClose, PanelLeftOpen, Radio, RotateCcw, Settings2, Sparkles, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocale, type LocaleMode } from "../i18n/locale";
import type { TranslationKey } from "../i18n/catalog";
import { useAppServices } from "../core/appServices";
import type { MotionLevel } from "../core/runtimeTypes";
import type { WorkspaceId } from "../core/moduleTypes";
import { useWorkspace } from "../core/workspace";
import { homeDefinition, moduleById, moduleDefinitions } from "../modules/registry";
import { EdgeHub } from "./EdgeHub";
import { ModuleManager } from "./ModuleManager";
import { UpdateControl } from "./UpdateControl";
import { WidgetWorkspace } from "./WidgetWorkspace";

function LocaleControl() {
  const { mode, setMode, text } = useLocale();
  const modes: LocaleMode[] = ["en", "uk"];
  return <div className="locale-control shell-locale" role="group" aria-label={text("locale.selector")}><Languages size={15} />{modes.map((item) => <button type="button" key={item} className={mode === item ? "is-active" : ""} onClick={() => setMode(item)}>{item === "en" ? "EN" : "UA"}</button>)}</div>;
}

function MotionControl({ value, onChange }: { value: MotionLevel; onChange: (value: MotionLevel) => void }) {
  const { text } = useLocale();
  const levels: MotionLevel[] = ["full", "calm", "off"];
  return <div className="motion-control" role="group" aria-label={text("shell.motion")}><Sparkles size={14} />{levels.map((level) => <button type="button" key={level} className={value === level ? "is-active" : ""} onClick={() => onChange(level)}>{text(`shell.motion${level[0].toUpperCase()}${level.slice(1)}` as TranslationKey)}</button>)}</div>;
}

function gpuMemory(bytes: number): string {
  if (!bytes) return "shared";
  return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
}

function GlobalSettings({ preset, onPreset }: { preset: "default" | "compact" | "monitoring"; onPreset: (preset: "default" | "compact" | "monitoring") => void }) {
  const app = useAppServices();
  const { text } = useLocale();
  const [open, setOpen] = useState(false);
  const status = app.graphicsRuntime;
  const selectedLuid = status?.selected.luid ?? null;
  const selectedLabel = status?.selected.name ?? text("graphics.loading");
  const choose = (luid: string | null) => {
    if (luid === selectedLuid || app.graphicsRuntimeBusy) return;
    void app.setMasterGpu(luid);
  };
  return <div className={`global-settings${open ? " is-open" : ""}`}>
    <button className="global-settings-trigger" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={text("graphics.settings")} title={text("graphics.settings")}>
      <Settings2 size={16} /><span>{selectedLabel}</span>
    </button>
    {open && <div className="global-settings-popover" role="dialog" aria-label={text("graphics.settings")}>
      <header><div><span className="eyebrow">KeeMASH</span><h2>{text("graphics.settings")}</h2></div><Settings2 size={18} /></header>
      <label className="settings-field"><span>{text("shell.preset")}</span><select value={preset} onChange={(event) => onPreset(event.target.value as typeof preset)}><option value="default">{text("shell.default")}</option><option value="compact">{text("shell.compact")}</option><option value="monitoring">{text("shell.monitoring")}</option></select></label>
      <section className="master-gpu-picker">
        <div className="settings-section-title"><Cpu size={15} /><div><strong>{text("graphics.master")}</strong><span>{text("graphics.restartHint")}</span></div></div>
        <button type="button" className={selectedLuid === null ? "is-selected" : ""} onClick={() => choose(null)} disabled={app.graphicsRuntimeBusy}>
          <span><strong>{text("graphics.auto")}</strong><small>{text("graphics.windowsDefault")}</small></span>{selectedLuid === null && <Check size={16} />}
        </button>
        {status?.adapters.map((adapter) => <button type="button" key={adapter.luid} className={selectedLuid === adapter.luid ? "is-selected" : ""} onClick={() => choose(adapter.luid)} disabled={app.graphicsRuntimeBusy || !adapter.available}>
          <span><strong>{adapter.name}</strong><small>{text(adapter.preference === "minimumPower" ? "graphics.energySaving" : adapter.preference === "highPerformance" ? "graphics.highPerformance" : "graphics.systemRank")} · {gpuMemory(adapter.dedicatedVideoBytes)}</small></span>{selectedLuid === adapter.luid && <Check size={16} />}
        </button>)}
      </section>
      {(status?.fallbackReason || app.graphicsRuntimeError) && <div className="graphics-warning"><AlertTriangle size={15} /><span>{app.graphicsRuntimeError ?? status?.fallbackReason}</span></div>}
      {status?.restartRequired && <div className="graphics-restart"><span>{text("graphics.restartRequired")}</span><div><button type="button" className="settings-secondary" onClick={() => setOpen(false)}>{text("graphics.later")}</button><button type="button" className="settings-primary" disabled={app.graphicsRuntimeBusy} onClick={() => void app.restartForGraphics()}><RotateCcw size={14} />{text("graphics.restartNow")}</button></div></div>}
    </div>}
  </div>;
}

export function SuperAppShell() {
  const app = useAppServices();
  const { text } = useLocale();
  const {
    profile,
    setActiveWorkspace,
    setSidebarMode,
    setMotionLevel,
    applyPreset,
    runtimeState,
    canUndo,
    lastAction,
    runtimeError,
    undo,
  } = useWorkspace();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [modulesOpen, setModulesOpen] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [undoVisible, setUndoVisible] = useState(false);
  const activeDefinition = profile.activeWorkspace === "home" ? homeDefinition : moduleById.get(profile.activeWorkspace);
  const activeDescription = profile.activeWorkspace === "home" ? text("shell.homeDescription") : text(`modules.${profile.activeWorkspace}Description` as TranslationKey);
  const linkState = app.meshStatus.connected ? "online" : app.serialStatus.connected ? "serial" : "offline";
  const navigate = (workspace: WorkspaceId) => { setActiveWorkspace(workspace); setModulesOpen(false); setDrawerOpen(false); setCatalogOpen(false); };
  const sidebarVisible = profile.sidebarMode !== "hidden" && !profile.immersiveChrome;
  const topbarVisible = profile.topbarVisible && !profile.immersiveChrome;
  const statusbarVisible = profile.statusbarVisible && !profile.immersiveChrome;

  useEffect(() => {
    if (profile.activeWorkspace !== "home" && !profile.enabledModules[profile.activeWorkspace]) setActiveWorkspace("home");
  }, [profile.activeWorkspace, profile.enabledModules, setActiveWorkspace]);

  useEffect(() => {
    if (!lastAction || !canUndo) return;
    setUndoVisible(true);
    const timer = window.setTimeout(() => setUndoVisible(false), 4_500);
    return () => window.clearTimeout(timer);
  }, [canUndo, lastAction]);

  return <div className={`super-app-shell sidebar-${profile.sidebarMode} motion-${profile.motionLevel}${profile.immersiveChrome ? " immersive-chrome" : ""}${topbarVisible ? "" : " topbar-hidden"}${statusbarVisible ? "" : " statusbar-hidden"}`}>
    <aside className={`app-sidebar${drawerOpen ? " is-open" : ""}`} aria-hidden={!sidebarVisible && !drawerOpen}>
      <button className="sidebar-brand" type="button" onClick={() => setSidebarMode("hidden")} title={text("shell.hideSidebar")}><span className="brand-mark"><Activity size={21} /></span><span className="brand-copy"><strong>KeeMASH</strong><span>Command Center</span></span></button>
      <nav className="module-nav" aria-label={text("shell.modules")}>
        <button type="button" className={!modulesOpen && profile.activeWorkspace === "home" ? "is-active" : ""} onClick={() => navigate("home")} title={text("shell.home")}><homeDefinition.icon size={19} /><span>{text("shell.home")}</span></button>
        {moduleDefinitions.map((module) => { const Icon = module.icon; const state = runtimeState(module.id); return <button type="button" key={module.id} className={!modulesOpen && profile.activeWorkspace === module.id ? "is-active" : ""} disabled={!profile.enabledModules[module.id]} onClick={() => navigate(module.id)} title={module.title}><Icon size={19} /><span>{module.title}</span><i className={`module-state-dot state-${state}`} /></button>; })}
      </nav>
      <div className="sidebar-bottom"><button type="button" className={modulesOpen ? "is-active" : ""} onClick={() => { setModulesOpen(true); setDrawerOpen(false); setCatalogOpen(false); }} title={text("shell.moduleManager")}><PackageOpen size={19} /><span>{text("shell.modules")}</span></button><button type="button" onClick={() => setSidebarMode(profile.sidebarMode === "rail" ? "expanded" : "rail")} title={text(profile.sidebarMode === "rail" ? "shell.expand" : "shell.collapse")}>{profile.sidebarMode === "rail" ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}<span>{text(profile.sidebarMode === "rail" ? "shell.expand" : "shell.collapse")}</span></button></div>
    </aside>
    {drawerOpen && <button className="sidebar-scrim" type="button" aria-label={text("shell.closeNavigation")} onClick={() => setDrawerOpen(false)} />}

    <header className="shell-topbar">
      <button className="mobile-menu-button" type="button" onClick={() => setDrawerOpen(true)} aria-label={text("shell.openNavigation")}><Menu size={20} /></button>
      <div className="page-title"><span>{modulesOpen ? text("shell.system") : activeDescription}</span><h1>{modulesOpen ? text("shell.modules") : profile.activeWorkspace === "home" ? text("shell.home") : activeDefinition?.title}</h1></div>
      <div className="shell-actions">
        <GlobalSettings preset={profile.preset} onPreset={applyPreset} />
        <MotionControl value={profile.motionLevel} onChange={setMotionLevel} />
        <LocaleControl />
        <UpdateControl status={app.updateStatus} busy={app.updateBusy} error={app.updateError} onCheck={app.checkUpdate} onInstall={app.installUpdate} />
        <div className={`link-pill state-${linkState}`}><Radio size={16} /><span>{app.meshStatus.connected ? `${app.meshStatus.transport.toUpperCase()} · ${app.meshStatus.rootIdentity ?? "node0"}` : app.serialStatus.path ?? "Root offline"}</span><span className="link-dot" /></div>
      </div>
    </header>

    <main className="super-workspace">{modulesOpen ? <ModuleManager /> : <WidgetWorkspace workspace={profile.activeWorkspace} catalogOpen={catalogOpen} catalogEdge={profile.hubDock.edge} onCatalogOpenChange={setCatalogOpen} />}</main>
    <footer className="super-statusbar"><span>{app.meshStatus.lastError ?? (app.meshStatus.connected ? `KeeLink ${app.meshStatus.transport.toUpperCase()} · ${app.meshStatus.security}` : app.meshStatus.reconnectPhase)}</span><span>{app.legacyState.lastLine ? text("app.lastReply", { line: app.legacyState.lastLine }) : text("app.noReply")}</span></footer>
    <EdgeHub onAddWidget={() => { setModulesOpen(false); setCatalogOpen(true); }} />
    {undoVisible && canUndo && <div className="undo-toast" role="status"><span>{text("shell.changeApplied")}</span><button type="button" onClick={() => { undo(); setUndoVisible(false); }}><Undo2 size={15} />{text("shell.undo")}</button></div>}
    {runtimeError && <div className="runtime-error-toast" role="alert">{runtimeError}</div>}
  </div>;
}
