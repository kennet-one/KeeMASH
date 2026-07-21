import { AlertTriangle, ArrowRight, Database, Focus, MemoryStick, RotateCcw, Search, ShieldCheck, Sparkles } from "lucide-react";
import { useEnjoy } from "../core/enjoyState";
import { LocalizedText, useLocale } from "../i18n/locale";
import type { KenUltraNode } from "../types";
import { TechnicalTerm } from "./TechnicalTerm";

function nodeClass(node: KenUltraNode): string {
  return `kind-${node.kind} risk-${node.risk}${node.performanceExcluded ? " is-excluded" : ""}`;
}

function EnjoyUnavailable() {
  const state = useEnjoy();
  const { text } = useLocale();
  if (state.loading) return <div className="enjoy-widget-state"><Sparkles size={24} /><LocalizedText textKey="enjoy.warming" /></div>;
  if (!state.error && state.catalog) return null;
  return <div className="enjoy-widget-state"><AlertTriangle size={24} /><strong><LocalizedText textKey="enjoy.catalogFailed" /></strong><span>{text("common.operationFailed")}</span>{state.error && <code>{state.error}</code>}<button className="command-button" type="button" onClick={state.reload}><RotateCcw size={15} /><LocalizedText textKey="common.retry" /></button></div>;
}

export function EnjoySearchWidget() {
  const state = useEnjoy();
  const { text } = useLocale();
  if (state.loading || state.error || !state.catalog) return <EnjoyUnavailable />;
  return <div className="enjoy-search-widget">
    <label className="brain-search"><Search size={15} /><input value={state.query} onChange={(event) => state.setQuery(event.target.value)} placeholder={text("enjoy.searchPlaceholder")} /></label>
    <div className="brain-results">{state.results.map((node) => <button key={node.id} type="button" className={`brain-result ${node.id === state.selectedId ? "is-active" : ""}`} onClick={() => state.select(node.id)}><span>{node.label}</span><small>{node.kind} · {node.domain}</small></button>)}</div>
    <div className="brain-source"><Database size={14} /><span title={state.sourcePath}>{text("enjoy.localCatalog", { count: state.catalog.stats.questions.toLocaleString() })}</span></div>
  </div>;
}

export function EnjoyGraphWidget() {
  const state = useEnjoy();
  const { text } = useLocale();
  if (state.loading || state.error || !state.catalog) return <EnjoyUnavailable />;
  const neighbors = state.focusNodes.filter((node) => node.id !== state.selectedId).slice(0, 18);
  return <div className="enjoy-graph-widget">
    <div className="brain-stage-bar"><div><Sparkles size={15} /><LocalizedText textKey="enjoy.mode" /></div><div className="depth-control" role="group" aria-label={text("enjoy.graphDepth")}>{[1, 2].map((value) => <button key={value} type="button" className={state.depth === value ? "is-active" : ""} onClick={() => state.setDepth(value)}>{text("enjoy.hop", { count: value })}</button>)}</div></div>
    <div className="focus-field"><div className="focus-grid" aria-hidden="true" />
      {state.selected && <button type="button" className={`focus-core ${nodeClass(state.selected)}`} onClick={() => state.setTab("meaning")}><MemoryStick size={22} /><strong>{state.selected.label}</strong><span>{state.selected.status} · {state.selected.confidence}</span></button>}
      {neighbors.map((node, index) => { const angle = (index / Math.max(neighbors.length, 1)) * Math.PI * 2 - Math.PI / 2; const radius = index % 3 === 0 ? 38 : 45; return <button key={node.id} type="button" className={`orbit-node ${nodeClass(node)}`} style={{ left: `${50 + Math.cos(angle) * radius}%`, top: `${50 + Math.sin(angle) * radius}%` }} onClick={() => state.select(node.id)} title={`${node.kind} · ${node.confidence}`}><span>{node.label}</span><small>{node.kind}</small></button>; })}
      <div className="brain-counts"><span>{text("enjoy.forms", { count: state.catalog.stats.forms })}</span><span>{state.catalog.stats.varStores} VarStores</span><span>{text("enjoy.options", { count: state.catalog.stats.options.toLocaleString() })}</span></div>
    </div>
  </div>;
}

export function EnjoyInspectorWidget() {
  const state = useEnjoy();
  const { text } = useLocale();
  if (state.loading || state.error || !state.catalog) return <EnjoyUnavailable />;
  const selected = state.selected;
  if (!selected) return <div className="enjoy-widget-state"><Focus size={24} /><LocalizedText textKey="common.waiting" /></div>;
  return <div className="enjoy-inspector-widget">
    <div className="inspector-kicker"><Focus size={14} /><span>{selected.kind} · {selected.domain}</span></div>
    <div className="inspector-title"><h2>{selected.label}</h2><TechnicalTerm term={selected.label} showLabel={false} fallback /></div>
    <div className="brain-badges"><span>{selected.confidence}</span><span>{selected.status}</span><span className={`risk-${selected.risk}`}>{text("enjoy.risk", { risk: selected.risk })}</span></div>
    <div className="brain-tabs"><button type="button" className={state.tab === "meaning" ? "is-active" : ""} onClick={() => state.setTab("meaning")}><LocalizedText textKey="enjoy.meaning" /></button><button type="button" className={state.tab === "links" ? "is-active" : ""} onClick={() => state.setTab("links")}><LocalizedText textKey="enjoy.links" /></button><button type="button" className={state.tab === "whatif" ? "is-active" : ""} onClick={() => state.setTab("whatif")}><LocalizedText textKey="enjoy.whatIf" /></button></div>
    {state.tab === "meaning" && <div className="brain-tab-body"><p>{selected.help || text("enjoy.noHelp")}</p><dl><dt>Form</dt><dd>{selected.formTitle ?? "-"}</dd><dt><TechnicalTerm term="QuestionId" /></dt><dd>{selected.questionId ?? "-"}</dd><dt><TechnicalTerm term="VarStore" /></dt><dd>{selected.varStoreName ?? "-"}</dd><dt>Offset</dt><dd>{selected.varOffset ?? "-"}</dd></dl></div>}
    {state.tab === "links" && <div className="brain-tab-body brain-link-list">{state.focusEdges.filter((edge) => edge.from === selected.id || edge.to === selected.id).slice(0, 80).map((edge) => { const other = state.nodeById.get(edge.from === selected.id ? edge.to : edge.from); return <button type="button" key={edge.id} className={edge.speculative ? "is-speculative" : ""} onClick={() => other && state.select(other.id)}><span>{edge.label}</span><strong>{other?.label ?? text("common.unknown")}</strong><small>{edge.confidence}</small></button>; })}</div>}
    {state.tab === "whatif" && <div className="brain-tab-body">{selected.performanceExcluded ? <div className="brain-warning"><ShieldCheck size={16} /><LocalizedText textKey="enjoy.performanceBlocked" /></div> : <><label className="scenario-input"><LocalizedText textKey="enjoy.proposedValue" /><input value={state.proposed} onChange={(event) => state.setProposed(event.target.value)} placeholder={text("enjoy.valuePlaceholder")} /></label><h3><LocalizedText textKey="enjoy.directEffects" /></h3>{state.effects.length === 0 && <div className="unknown-effect"><LocalizedText textKey="enjoy.noEffect" /></div>}{state.effects.map((edge) => <div key={edge.id} className={`scenario-effect ${edge.speculative ? "is-speculative" : ""}`}><ArrowRight size={14} /><span>{edge.label}</span><strong>{state.nodeById.get(edge.to)?.label ?? edge.to}</strong><small>{edge.confidence}</small></div>)}</>}</div>}
  </div>;
}
