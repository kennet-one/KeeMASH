import { Activity, Languages, Menu, PackageOpen, PanelLeftClose, PanelLeftOpen, Radio, RotateCcw, Settings2, Sparkles, Undo2 } from "lucide-react";
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
  const linkState = app.serialStatus.connected ? (app.legacyState.online ? "online" : "serial") : "offline";
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
        <div className="preset-control" title={text("shell.preset")}><Settings2 size={15} /><select value={profile.preset} onChange={(event) => applyPreset(event.target.value as "default" | "compact" | "monitoring")}><option value="default">{text("shell.default")}</option><option value="compact">{text("shell.compact")}</option><option value="monitoring">{text("shell.monitoring")}</option></select><RotateCcw size={13} /></div>
        <MotionControl value={profile.motionLevel} onChange={setMotionLevel} />
        <LocaleControl />
        <UpdateControl status={app.updateStatus} busy={app.updateBusy} error={app.updateError} onCheck={app.checkUpdate} onInstall={app.installUpdate} />
        <div className={`link-pill state-${linkState}`}><Radio size={16} /><span>{app.serialStatus.path ?? "No port"}</span><span className="link-dot" /></div>
      </div>
    </header>

    <main className="super-workspace">{modulesOpen ? <ModuleManager /> : <WidgetWorkspace workspace={profile.activeWorkspace} catalogOpen={catalogOpen} catalogEdge={profile.hubDock.edge} onCatalogOpenChange={setCatalogOpen} />}</main>
    <footer className="super-statusbar"><span>{app.serialStatus.error ?? text(app.serialStatus.connected ? "shell.serialActive" : "shell.serialIdle")}</span><span>{app.legacyState.lastLine ? text("app.lastReply", { line: app.legacyState.lastLine }) : text("app.noReply")}</span></footer>
    <EdgeHub onAddWidget={() => { setModulesOpen(false); setCatalogOpen(true); }} />
    {undoVisible && canUndo && <div className="undo-toast" role="status"><span>{text("shell.changeApplied")}</span><button type="button" onClick={() => { undo(); setUndoVisible(false); }}><Undo2 size={15} />{text("shell.undo")}</button></div>}
    {runtimeError && <div className="runtime-error-toast" role="alert">{runtimeError}</div>}
  </div>;
}
