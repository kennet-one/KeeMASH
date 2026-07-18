import type { KenUltraCatalog, KenUltraEdge, KenUltraNode } from "../types";

const priorityLabels = ["power down mode", "nmode", "tcl", "force coldreset", "fast boot", "memory profile", "overclocking feature", "xtu interface"];

export function searchKenUltra(nodes: KenUltraNode[], query: string, limit = 24): KenUltraNode[] {
  const normalized = query.trim().toLowerCase();
  return nodes
    .filter((node) => node.kind !== "option")
    .filter((node) => normalized || !node.performanceExcluded)
    .map((node) => {
      const label = node.label.trim().toLowerCase();
      const aliases = node.aliases.join(" ").toLowerCase();
      let score = node.performanceExcluded ? -80 : 0;
      if (!normalized) {
        const priority = priorityLabels.indexOf(label);
        if (priority >= 0) score += 100 - priority * 8;
      }
      else {
        if (label === normalized) score += 200;
        if (label.startsWith(normalized)) score += 100;
        if (label.includes(normalized)) score += 70;
        if ((node.help ?? "").toLowerCase().includes(normalized)) score += 25;
        if (aliases.includes(normalized) || node.id.toLowerCase().includes(normalized)) score += 20;
      }
      if (node.domain === "memory") score += 12;
      if (node.status !== "raw") score += 8;
      return { node, score };
    })
    .filter((entry) => normalized ? entry.score > 0 : entry.score > -20)
    .sort((a, b) => b.score - a.score || a.node.label.localeCompare(b.node.label))
    .slice(0, limit)
    .map((entry) => entry.node);
}

export function neighborhood(catalog: KenUltraCatalog, focusId: string, depth = 1, limit = 34): { nodes: KenUltraNode[]; edges: KenUltraEdge[] } {
  const visible = new Set([focusId]);
  let frontier = new Set([focusId]);
  for (let level = 0; level < depth; level += 1) {
    const next = new Set<string>();
    for (const edge of catalog.edges) {
      if (frontier.has(edge.from)) next.add(edge.to);
      if (frontier.has(edge.to)) next.add(edge.from);
      if (next.size >= limit) break;
    }
    next.forEach((id) => visible.add(id));
    frontier = next;
  }
  const nodes = catalog.nodes.filter((node) => visible.has(node.id) && node.kind !== "option").slice(0, limit + 1);
  const ids = new Set(nodes.map((node) => node.id));
  const edges = catalog.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  return { nodes, edges };
}

export function directEffects(catalog: KenUltraCatalog, nodeId: string): KenUltraEdge[] {
  return catalog.edges.filter((edge) => edge.from === nodeId && !["contains", "stored_in", "patched_by"].includes(edge.kind));
}
