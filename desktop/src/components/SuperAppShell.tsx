import { Activity, ChevronLeft, ChevronRight, Languages, Menu, PackageOpen, PanelLeftClose, PanelLeftOpen, Radio, RotateCcw, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocale, type LocaleMode } from "../i18n/locale";
import type { TranslationKey } from "../i18n/catalog";
import { useAppServices } from "../core/appServices";
import type { WorkspaceId } from "../core/moduleTypes";
import { useWorkspace } from "../core/workspace";
import { homeDefinition, moduleById, moduleDefinitions } from "../modules/registry";
import { UpdateControl } from "./UpdateControl";
import { WidgetWorkspace } from "./WidgetWorkspace";
import { ModuleManager } from "./ModuleManager";

function LocaleControl() {
  const { mode, setMode, text } = useLocale();
  const modes: LocaleMode[] = ["en", "uk"];
  return <div className="locale-control shell-locale" role="group" aria-label={text("locale.selector")}><Languages size={15} />{modes.map((item) => <button type="button" key={item} className={mode === item ? "is-active" : ""} onClick={() => setMode(item)}>{item === "en" ? "EN" : "UA"}</button>)}</div>;
}

export function SuperAppShell() {
  const app = useAppServices();
  const { text } = useLocale();
  const { profile, setActiveWorkspace, setSidebarCollapsed, applyPreset, runtimeState } = useWorkspace();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [modulesOpen, setModulesOpen] = useState(false);
  const activeDefinition = profile.activeWorkspace === "home" ? homeDefinition : moduleById.get(profile.activeWorkspace);
  const activeDescription = profile.activeWorkspace === "home" ? text("shell.homeDescription") : text(`modules.${profile.activeWorkspace}Description` as TranslationKey);
  const linkState = app.serialStatus.connected ? (app.legacyState.online ? "online" : "serial") : "offline";
  const navigate = (workspace: WorkspaceId) => { setActiveWorkspace(workspace); setModulesOpen(false); setDrawerOpen(false); };

  useEffect(() => {
    if (profile.activeWorkspace !== "home" && !profile.enabledModules[profile.activeWorkspace]) setActiveWorkspace("home");
  }, [profile.activeWorkspace, profile.enabledModules, setActiveWorkspace]);

  return <div className={`super-app-shell${profile.sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
    <aside className={`app-sidebar${drawerOpen ? " is-open" : ""}`}>
      <div className="sidebar-brand"><span className="brand-mark"><Activity size={21} /></span><div><strong>KeeMASH</strong><span>Command Center</span></div></div>
      <nav className="module-nav" aria-label={text("shell.modules")}>
        <button type="button" className={!modulesOpen && profile.activeWorkspace === "home" ? "is-active" : ""} onClick={() => navigate("home")} title={text("shell.home")}><homeDefinition.icon size={19} /><span>{text("shell.home")}</span></button>
        {moduleDefinitions.map((module) => { const Icon = module.icon; const state = runtimeState(module.id); return <button type="button" key={module.id} className={!modulesOpen && profile.activeWorkspace === module.id ? "is-active" : ""} disabled={!profile.enabledModules[module.id]} onClick={() => navigate(module.id)} title={module.title}><Icon size={19} /><span>{module.title}</span><i className={`module-state-dot state-${state}`} /></button>; })}
      </nav>
      <div className="sidebar-bottom"><button type="button" className={modulesOpen ? "is-active" : ""} onClick={() => { setModulesOpen(true); setDrawerOpen(false); }} title={text("shell.moduleManager")}><PackageOpen size={19} /><span>{text("shell.modules")}</span></button><button type="button" onClick={() => setSidebarCollapsed(!profile.sidebarCollapsed)} title={text(profile.sidebarCollapsed ? "shell.expand" : "shell.collapse")}>{profile.sidebarCollapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}<span>{text(profile.sidebarCollapsed ? "shell.expand" : "shell.collapse")}</span></button></div>
    </aside>
    {drawerOpen && <button className="sidebar-scrim" type="button" aria-label={text("shell.closeNavigation")} onClick={() => setDrawerOpen(false)} />}

    <header className="shell-topbar">
      <button className="mobile-menu-button" type="button" onClick={() => setDrawerOpen(true)} aria-label={text("shell.openNavigation")}><Menu size={20} /></button>
      <div className="page-title"><span>{modulesOpen ? text("shell.system") : activeDescription}</span><h1>{modulesOpen ? text("shell.modules") : profile.activeWorkspace === "home" ? text("shell.home") : activeDefinition?.title}</h1></div>
      <div className="shell-actions">
        <div className="preset-control" title={text("shell.preset")}><Settings2 size={15} /><select value={profile.preset} onChange={(event) => applyPreset(event.target.value as "default" | "compact" | "monitoring")}><option value="default">{text("shell.default")}</option><option value="compact">{text("shell.compact")}</option><option value="monitoring">{text("shell.monitoring")}</option></select><RotateCcw size={13} /></div>
        <LocaleControl />
        <UpdateControl status={app.updateStatus} busy={app.updateBusy} error={app.updateError} onCheck={app.checkUpdate} onInstall={app.installUpdate} />
        <div className={`link-pill state-${linkState}`}><Radio size={16} /><span>{app.serialStatus.path ?? "No port"}</span><span className="link-dot" /></div>
      </div>
    </header>

    <main className="super-workspace">{modulesOpen ? <ModuleManager /> : <WidgetWorkspace workspace={profile.activeWorkspace} />}</main>
    <footer className="super-statusbar"><span>{app.serialStatus.error ?? text(app.serialStatus.connected ? "shell.serialActive" : "shell.serialIdle")}</span><span>{app.legacyState.lastLine ? text("app.lastReply", { line: app.legacyState.lastLine }) : text("app.noReply")}</span></footer>
    <button className="sidebar-edge-toggle" type="button" onClick={() => setSidebarCollapsed(!profile.sidebarCollapsed)} aria-label="Toggle sidebar">{profile.sidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}</button>
  </div>;
}
