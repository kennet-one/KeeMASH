import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { bridge } from "../lib/bridge";
import { directEffects, neighborhood, searchKenUltra } from "../lib/kenultra";
import type { KenUltraCatalog, KenUltraEdge, KenUltraNode } from "../types";
import { useWorkspace } from "./workspace";

export type InspectorTab = "meaning" | "links" | "whatif";

export interface EnjoyState {
  catalog: KenUltraCatalog | null;
  sourcePath: string;
  loading: boolean;
  error: string | null;
  query: string;
  selectedId: string;
  selected?: KenUltraNode;
  depth: number;
  tab: InspectorTab;
  proposed: string;
  results: KenUltraNode[];
  focusNodes: KenUltraNode[];
  focusEdges: KenUltraEdge[];
  effects: KenUltraEdge[];
  nodeById: Map<string, KenUltraNode>;
  setQuery: (value: string) => void;
  select: (id: string) => void;
  setDepth: (value: number) => void;
  setTab: (value: InspectorTab) => void;
  setProposed: (value: string) => void;
  reload: () => void;
}

const EnjoyContext = createContext<EnjoyState | null>(null);

export function EnjoyModuleProvider({ children }: { children: ReactNode }) {
  const { runtimeState } = useWorkspace();
  const demanded = runtimeState("enjoy") === "active" || runtimeState("enjoy") === "background";
  const [catalog, setCatalog] = useState<KenUltraCatalog | null>(null);
  const [sourcePath, setSourcePath] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [depth, setDepth] = useState(1);
  const [tab, setTab] = useState<InspectorTab>("meaning");
  const [proposed, setProposed] = useState("");

  const load = useCallback(async () => {
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
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (demanded && !catalog && !loading && !error) void load();
  }, [catalog, demanded, error, load, loading]);

  const nodeById = useMemo(() => new Map(catalog?.nodes.map((node) => [node.id, node]) ?? []), [catalog]);
  const focus = useMemo(() => catalog && selectedId ? neighborhood(catalog, selectedId, depth) : { nodes: [], edges: [] }, [catalog, depth, selectedId]);
  const value = useMemo<EnjoyState>(() => ({
    catalog, sourcePath, loading, error, query, selectedId, selected: nodeById.get(selectedId), depth, tab, proposed,
    results: searchKenUltra(catalog?.nodes ?? [], query), focusNodes: focus.nodes, focusEdges: focus.edges,
    effects: catalog && selectedId ? directEffects(catalog, selectedId) : [], nodeById,
    setQuery, select: (id) => { setSelectedId(id); setTab("meaning"); }, setDepth, setTab, setProposed,
    reload: () => { void load(); },
  }), [catalog, depth, error, focus.edges, focus.nodes, load, loading, nodeById, proposed, query, selectedId, sourcePath, tab]);

  return <EnjoyContext.Provider value={value}>{children}</EnjoyContext.Provider>;
}

export function useEnjoy(): EnjoyState {
  const value = useContext(EnjoyContext);
  if (!value) throw new Error("Enjoy widgets require EnjoyModuleProvider");
  return value;
}
