import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, BrainCircuit, Database, Focus, MemoryStick, RotateCcw, Search, ShieldCheck, Sparkles } from "lucide-react";
import { bridge } from "../lib/bridge";
import { directEffects, neighborhood, searchKenUltra } from "../lib/kenultra";
import type { KenUltraCatalog, KenUltraNode } from "../types";

function nodeClass(node: KenUltraNode): string {
  return `kind-${node.kind} risk-${node.risk}${node.performanceExcluded ? " is-excluded" : ""}`;
}

export function EnjoyView() {
  const [catalog, setCatalog] = useState<KenUltraCatalog | null>(null);
  const [sourcePath, setSourcePath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [depth, setDepth] = useState(1);
  const [tab, setTab] = useState<"meaning" | "links" | "whatif">("meaning");
  const [proposed, setProposed] = useState("");

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const envelope = await bridge.kenultra.load();
      setCatalog(envelope.catalog);
      setSourcePath(envelope.sourcePath);
      const initial = envelope.catalog.nodes.find((node) => node.label.trim().toLowerCase() === "power down mode")
        ?? envelope.catalog.nodes.find((node) => node.domain === "memory" && node.kind === "question")
        ?? envelope.catalog.nodes[0];
      setSelectedId((current) => envelope.catalog.nodes.some((node) => node.id === current) ? current : initial?.id ?? "");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const nodeById = useMemo(() => new Map(catalog?.nodes.map((node) => [node.id, node]) ?? []), [catalog]);
  const selected = nodeById.get(selectedId);
  const results = useMemo(() => searchKenUltra(catalog?.nodes ?? [], query), [catalog, query]);
  const focusGraph = useMemo(() => catalog && selectedId ? neighborhood(catalog, selectedId, depth) : { nodes: [], edges: [] }, [catalog, selectedId, depth]);
  const effects = useMemo(() => catalog && selectedId ? directEffects(catalog, selectedId) : [], [catalog, selectedId]);

  if (loading) return <section className="enjoy-loading"><BrainCircuit size={34} /><strong>Warming BIOS Brain</strong><span>Loading local sanitized vectors</span></section>;
  if (error || !catalog) return (
    <section className="enjoy-empty">
      <AlertTriangle size={30} />
      <h2>KenULTRABIOS catalog не підключився</h2>
      <p>{error ?? "Unknown catalog error"}</p>
      <code>%USERPROFILE%\Desktop\grafs\KenULTRABIOS-Brain\.kenultra\mash-bridge.json</code>
      <button className="command-button" type="button" onClick={() => void load()}><RotateCcw size={16} />Повторити</button>
    </section>
  );

  const neighbors = focusGraph.nodes.filter((node) => node.id !== selectedId);
  return (
    <section className="enjoy-view view-enter">
      <aside className="brain-search-panel">
        <div className="enjoy-section-title"><Search size={15} /><span>Vector focus</span></div>
        <label className="brain-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Power Down, tCL, VarStore..." /></label>
        <div className="brain-results">
          {results.map((node) => (
            <button key={node.id} type="button" className={`brain-result ${node.id === selectedId ? "is-active" : ""}`} onClick={() => { setSelectedId(node.id); setTab("meaning"); }}>
              <span>{node.label}</span><small>{node.kind} · {node.domain}</small>
            </button>
          ))}
        </div>
        <div className="brain-source"><Database size={14} /><span title={sourcePath}>Local catalog · {catalog.stats.questions.toLocaleString()} questions</span></div>
      </aside>

      <div className="brain-stage">
        <div className="brain-stage-bar">
          <div><Sparkles size={15} /><span>Enjoy Mode</span><b>SIMULATION ONLY</b></div>
          <div className="depth-control" role="group" aria-label="Graph depth">
            {[1, 2].map((value) => <button key={value} type="button" className={depth === value ? "is-active" : ""} onClick={() => setDepth(value)}>{value} hop</button>)}
          </div>
        </div>
        <div className="focus-field">
          <div className="focus-grid" aria-hidden="true" />
          {selected && (
            <button type="button" className={`focus-core ${nodeClass(selected)}`} onClick={() => setTab("meaning")}>
              <MemoryStick size={22} />
              <strong>{selected.label}</strong>
              <span>{selected.status} · {selected.confidence}</span>
            </button>
          )}
          {neighbors.slice(0, 18).map((node, index) => {
            const angle = (index / Math.max(neighbors.slice(0, 18).length, 1)) * Math.PI * 2 - Math.PI / 2;
            const radius = index % 3 === 0 ? 38 : 45;
            const left = 50 + Math.cos(angle) * radius;
            const top = 50 + Math.sin(angle) * radius;
            return (
              <button key={node.id} type="button" className={`orbit-node ${nodeClass(node)}`} style={{ left: `${left}%`, top: `${top}%` }} onClick={() => { setSelectedId(node.id); setTab("meaning"); }} title={`${node.kind} · ${node.confidence}`}>
                <span>{node.label}</span><small>{node.kind}</small>
              </button>
            );
          })}
          <div className="brain-counts"><span>{catalog.stats.forms} forms</span><span>{catalog.stats.varStores} VarStores</span><span>{catalog.stats.options.toLocaleString()} options</span></div>
        </div>
      </div>

      <aside className="brain-inspector">
        {selected && <>
          <div className="inspector-kicker"><Focus size={14} /><span>{selected.kind} · {selected.domain}</span></div>
          <h2>{selected.label}</h2>
          <div className="brain-badges"><span>{selected.confidence}</span><span>{selected.status}</span><span className={`risk-${selected.risk}`}>risk: {selected.risk}</span></div>
          {(selected.risk === "high" || selected.risk === "regulatory") && <div className="brain-warning"><AlertTriangle size={16} /><span>{selected.risk === "regulatory" ? "Regulatory: виключено з performance scenarios." : "Recovery plan required before any real hardware action."}</span></div>}
          <div className="brain-tabs">
            <button type="button" className={tab === "meaning" ? "is-active" : ""} onClick={() => setTab("meaning")}>Meaning</button>
            <button type="button" className={tab === "links" ? "is-active" : ""} onClick={() => setTab("links")}>Links</button>
            <button type="button" className={tab === "whatif" ? "is-active" : ""} onClick={() => setTab("whatif")}>What-if</button>
          </div>
          {tab === "meaning" && <div className="brain-tab-body">
            <p>{selected.help || "IFR визначає структуру, але окремого help-тексту нема."}</p>
            <dl><dt>Form</dt><dd>{selected.formTitle ?? "—"}</dd><dt>QuestionId</dt><dd>{selected.questionId ?? "—"}</dd><dt>VarStore</dt><dd>{selected.varStoreName ?? "—"}</dd><dt>Offset</dt><dd>{selected.varOffset ?? "—"}</dd></dl>
          </div>}
          {tab === "links" && <div className="brain-tab-body brain-link-list">
            {focusGraph.edges.filter((edge) => edge.from === selected.id || edge.to === selected.id).slice(0, 80).map((edge) => {
              const other = nodeById.get(edge.from === selected.id ? edge.to : edge.from);
              return <button type="button" key={edge.id} className={edge.speculative ? "is-speculative" : ""} onClick={() => other && setSelectedId(other.id)}><span>{edge.label}</span><strong>{other?.label ?? "Unknown"}</strong><small>{edge.confidence}</small></button>;
            })}
          </div>}
          {tab === "whatif" && <div className="brain-tab-body">
            {selected.performanceExcluded ? <div className="brain-warning"><ShieldCheck size={16} />Performance simulation blocked.</div> : <>
              <label className="scenario-input"><span>Proposed value</span><input value={proposed} onChange={(event) => setProposed(event.target.value)} placeholder="Enabled / 20 / Custom" /></label>
              <h3>Direct graph effects</h3>
              {effects.length === 0 && <div className="unknown-effect">Unknown: доведеного effect edge ще нема.</div>}
              {effects.map((edge) => <div key={edge.id} className={`scenario-effect ${edge.speculative ? "is-speculative" : ""}`}><ArrowRight size={14} /><span>{edge.label}</span><strong>{nodeById.get(edge.to)?.label ?? edge.to}</strong><small>{edge.confidence}</small></div>)}
              <div className="brain-safety"><ShieldCheck size={15} /><span>No BIOS/NVRAM/SPD writes. One change at a time.</span></div>
            </>}
          </div>}
        </>}
      </aside>
    </section>
  );
}
