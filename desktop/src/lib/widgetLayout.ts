import type { LayoutItem } from "react-grid-layout";

// Grow content-sized items, then resolve overlaps without reordering columns.
export function fitWidgetLayout(items: readonly LayoutItem[], heights: Record<string, number>, gap: number): LayoutItem[] {
  const placed: LayoutItem[] = [];
  for (const source of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const minimum = Math.max(source.minH ?? 1, Math.ceil(((heights[source.i] ?? 0) + gap) / (42 + gap)));
    const item = { ...source, minH: minimum, h: Math.max(source.h, minimum) };
    if (item.maxH !== undefined && item.maxH < minimum) item.maxH = minimum;
    let collision: LayoutItem | undefined;
    while ((collision = placed.find(other => item.x < other.x + other.w && item.x + item.w > other.x && item.y < other.y + other.h && item.y + item.h > other.y))) {
      item.y = collision.y + collision.h;
    }
    placed.push(item);
  }
  return placed;
}
