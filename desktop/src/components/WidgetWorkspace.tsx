import { Eye, EyeOff, GripHorizontal, Pin, Plus, RotateCcw, X } from "lucide-react";
import { Suspense, useMemo, useState } from "react";
import { ResponsiveGridLayout, useContainerWidth, type LayoutItem, type ResponsiveLayouts } from "react-grid-layout";
import type { AppBreakpoint, WidgetInstance } from "../core/workspace";
import { useWorkspace } from "../core/workspace";
import type { WorkspaceId } from "../core/moduleTypes";
import { useLocale } from "../i18n/locale";
import { moduleById, moduleDefinitions, widgetById, widgetDefinitions } from "../modules/registry";

const breakpoints = { lg: 1100, md: 820, sm: 520, xs: 0 };
const cols = { lg: 12, md: 8, sm: 4, xs: 1 };

function withMissingItems(layouts: ResponsiveLayouts<AppBreakpoint>, instances: WidgetInstance[]): ResponsiveLayouts<AppBreakpoint> {
  const next: Partial<Record<AppBreakpoint, LayoutItem[]>> = {};
  for (const breakpoint of Object.keys(cols) as AppBreakpoint[]) {
    const current = [...(layouts[breakpoint] ?? [])];
    let bottom = current.reduce((value, item) => Math.max(value, item.y + item.h), 0);
    for (const instance of instances) {
      if (current.some((item) => item.i === instance.instanceId)) continue;
      const definition = widgetById.get(instance.widgetId);
      const requested = definition?.sizes[breakpoint] ?? { w: cols[breakpoint], h: 4 };
      current.push({ i: instance.instanceId, x: 0, y: bottom, w: Math.min(cols[breakpoint], requested.w), h: requested.h, minW: requested.minW ?? 1, minH: requested.minH ?? 2, maxW: requested.maxW, maxH: requested.maxH });
      bottom += requested.h;
    }
    next[breakpoint] = current;
  }
  return next as ResponsiveLayouts<AppBreakpoint>;
}

function WidgetCard({ workspace, instance, editing }: { workspace: WorkspaceId; instance: WidgetInstance; editing: boolean }) {
  const { text } = useLocale();
  const { profile, setWidgetKeepAlive, setWidgetVisible } = useWorkspace();
  const definition = widgetById.get(instance.widgetId);
  if (!definition) return null;
  const moduleEnabled = profile.enabledModules[definition.moduleId];
  const granted = profile.grants[definition.moduleId] ?? [];
  const missing = definition.capabilities.filter((capability) => !granted.includes(capability));
  const Icon = definition.icon;
  const Content = definition.component;
  return <section className={`widget-card${editing ? " is-editing" : ""}`}>
    <header className="widget-header">
      <span className="widget-title"><Icon size={16} /><strong>{definition.title}</strong><small>{moduleById.get(definition.moduleId)?.title}</small></span>
      <span className="widget-actions">
        {definition.keepAlive && <button className={`widget-icon-button${instance.keepAlive ? " is-active" : ""}`} type="button" onClick={() => setWidgetKeepAlive(workspace, instance.instanceId, !instance.keepAlive)} title={text(instance.keepAlive ? "shell.stopKeepAlive" : "shell.keepAlive")} aria-pressed={instance.keepAlive}><Pin size={14} /></button>}
        <button className="widget-icon-button" type="button" onClick={() => setWidgetVisible(workspace, instance.instanceId, false)} title={text("shell.hideWidget")} aria-label={`${text("shell.hideWidget")}: ${definition.title}`}><EyeOff size={15} /></button>
        {editing && <span className="widget-drag-handle" title={text("shell.moveWidget")}><GripHorizontal size={16} /></span>}
      </span>
    </header>
    <div className="widget-content">
      {!moduleEnabled ? <div className="widget-unavailable">{text("shell.moduleDisabled")}</div> : missing.length ? <div className="widget-unavailable">{text("shell.permissionRequired", { permissions: missing.join(", ") })}</div> : <Suspense fallback={<div className="widget-unavailable">{text("shell.loadingWidget")}</div>}><Content /></Suspense>}
    </div>
  </section>;
}

function WidgetCatalog({ workspace, onClose }: { workspace: WorkspaceId; onClose: () => void }) {
  const { text } = useLocale();
  const { profile, addWidget, setWidgetVisible } = useWorkspace();
  const [query, setQuery] = useState("");
  const [moduleFilter, setModuleFilter] = useState<"all" | "main" | "monitor" | "enjoy">(workspace === "home" ? "all" : workspace);
  const instances = profile.instances[workspace];
  const candidates = widgetDefinitions.filter((widget) => profile.enabledModules[widget.moduleId] && (moduleFilter === "all" || widget.moduleId === moduleFilter) && `${widget.title} ${widget.description}`.toLowerCase().includes(query.toLowerCase()));
  return <aside className="widget-drawer" aria-label={text("shell.addWidget")}>
    <header><div><span>Workspace</span><h2>{text("shell.addWidget")}</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label={text("update.close")}><X size={18} /></button></header>
    <input className="field widget-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text("shell.searchWidgets")} />
    <div className="widget-filter"><button type="button" className={moduleFilter === "all" ? "is-active" : ""} onClick={() => setModuleFilter("all")}>{text("shell.all")}</button>{moduleDefinitions.map((module) => <button type="button" className={moduleFilter === module.id ? "is-active" : ""} key={module.id} onClick={() => setModuleFilter(module.id)}>{module.title}</button>)}</div>
    <div className="widget-catalog-list">{candidates.map((widget) => {
      const instance = instances.find((item) => item.widgetId === widget.id);
      const visible = instance?.visible ?? false;
      const Icon = widget.icon;
      return <article key={widget.id}><span className="catalog-icon"><Icon size={18} /></span><div><strong>{widget.title}</strong><span>{widget.description}</span></div><button className={`widget-icon-button${visible ? " is-active" : ""}`} type="button" title={text(visible ? "shell.hideWidget" : "shell.showWidget")} onClick={() => instance ? setWidgetVisible(workspace, instance.instanceId, !visible) : addWidget(workspace, widget.id)}>{visible ? <Eye size={16} /> : <Plus size={16} />}</button></article>;
    })}</div>
  </aside>;
}

export function WidgetWorkspace({ workspace }: { workspace: WorkspaceId }) {
  const { text } = useLocale();
  const { profile, setLayout, setWidgetVisible } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const { width, containerRef, mounted } = useContainerWidth();
  const instances = profile.instances[workspace] ?? [];
  const visible = instances.filter((instance) => instance.visible && widgetById.has(instance.widgetId));
  const layouts = useMemo(() => withMissingItems(profile.layouts[workspace], instances), [instances, profile.layouts, workspace]);
  const hidden = instances.filter((instance) => !instance.visible);

  return <div className="workspace-stage">
    <div className="workspace-toolbar">
      <span>{text("shell.widgets", { count: visible.length })}{hidden.length ? ` · ${text("shell.hidden", { count: hidden.length })}` : ""}</span>
      <div><button className={`command-button${editing ? " is-active" : ""}`} type="button" onClick={() => setEditing((value) => !value)}><GripHorizontal size={16} />{text(editing ? "shell.done" : "shell.editLayout")}</button><button className="command-button primary-button" type="button" onClick={() => setCatalogOpen(true)}><Plus size={16} />{text("shell.addWidget")}</button></div>
    </div>
    {visible.length ? <div className="widget-grid-host" ref={containerRef}>{mounted && <ResponsiveGridLayout<AppBreakpoint> width={width} className="widget-grid" breakpoints={breakpoints} cols={cols} layouts={layouts} rowHeight={42} margin={{ lg: [12, 12], md: [10, 10], sm: [8, 8], xs: [8, 8] }} containerPadding={[0, 0]} dragConfig={{ enabled: editing, handle: ".widget-drag-handle", cancel: "button,input,select,textarea" }} resizeConfig={{ enabled: editing, handles: ["se"] }} onLayoutChange={(_, next) => setLayout(workspace, next)}>{visible.map((instance) => <div key={instance.instanceId}><WidgetCard workspace={workspace} instance={instance} editing={editing} /></div>)}</ResponsiveGridLayout>}</div> : <div className="empty-workspace"><EyeOff size={28} /><h2>{text("shell.noWidgets")}</h2><p>{text("shell.noWidgetsHint")}</p><button className="command-button primary-button" type="button" onClick={() => setCatalogOpen(true)}><Plus size={16} />{text("shell.addWidget")}</button></div>}
    {hidden.length > 0 && !catalogOpen && <button className="restore-widgets" type="button" onClick={() => hidden.forEach((instance) => setWidgetVisible(workspace, instance.instanceId, true))}><RotateCcw size={14} />{text("shell.restoreHidden")}</button>}
    {catalogOpen && <><button className="drawer-scrim" type="button" aria-label={text("update.close")} onClick={() => setCatalogOpen(false)} /><WidgetCatalog workspace={workspace} onClose={() => setCatalogOpen(false)} /></>}
  </div>;
}
