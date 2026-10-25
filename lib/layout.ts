import dagre from 'dagre';
import type { Concept, Kind, Relationship } from './types';

/*
 * Layout, not placement (see place.ts for the distinction).
 *
 * Runs after every turn, and on demand from "Tidy up". Sugiyama-style ranking
 * (dagre, rankdir LR) is what actually guarantees no overlap and clean
 * branching, and it is the same class of algorithm Miro runs when it imports
 * a .mmd file. That import looked better than the canvas for one reason only:
 * a .mmd carries no coordinates, so Miro laid the whole graph out at once
 * instead of placing nodes one at a time.
 *
 * Edge labels are part of the layout, not decoration on top of it. dagre
 * reserves a rank for them when an edge carries width and height, which is
 * what stops "is paid by" from landing on top of a box.
 *
 * dagre ranks every unconnected node at column 0 alongside real roots, so
 * separate conversation threads (or a lone node with no edges yet) would
 * otherwise land interleaved with the main flow. Each connected component
 * gets its own dagre pass and its own horizontal band, stacked top to
 * bottom, so unrelated groups never share a level.
 *
 * QUESTION and PROBLEM concepts skip the dagre pass entirely. They are not
 * part of the concept map's hierarchy — they are read as a separate band
 * underneath it, left to right in the order they were created. Their edge
 * back to their subject still renders; it just runs downward into the band.
 */

export const DEFAULT_WIDTH = 220;
export const DEFAULT_HEIGHT = 80;

/** Fallback box per kind, used until React Flow has measured the real node. */
export const KIND_DEFAULT_SIZE: Record<Kind, NodeSize> = {
  ENTITY: { width: 220, height: 80 },
  ATTRIBUTE: { width: 150, height: 46 },
  ACTOR: { width: 200, height: 76 },
  STEP: { width: 210, height: 76 },
  RULE: { width: 200, height: 84 },
  QUESTION: { width: 260, height: 110 },
  PROBLEM: { width: 260, height: 110 },
  CLAIM: { width: 240, height: 88 },
};

/*
 * dagre halves ranksep and doubles every minlen to make room for edge labels,
 * so RANK_SEP is roughly twice the gap that ends up on screen.
 */
const RANK_SEP = 110;
const NODE_SEP = 44;
const EDGE_SEP = 26;
const MARGIN = 40;
const COMPONENT_GAP = 90;
/** Gap between the bottom of the main map and the questions/problems band. */
const BAND_GAP = 90;
/** Horizontal gap between adjacent items inside the band. */
const BAND_ITEM_GAP = 36;

/** Mirrors .edge-label in globals.css: 11px text, nowrap, 7px padding a side. */
const LABEL_CHAR_WIDTH = 6.1;
const LABEL_PADDING = 18;
const LABEL_HEIGHT = 24;
/** A proposed edge carries a tick and a cross next to its text. */
const LABEL_ACTIONS_WIDTH = 46;

const BAND_KINDS = new Set<Kind>(['QUESTION', 'PROBLEM']);

export type NodeSize = { width: number; height: number };
export type LaidOutPoint = { id: string; x: number; y: number };

function sizeOf(sizes: Record<string, NodeSize>, concept: Concept): NodeSize {
  const s = sizes[concept.id];
  return s ?? KIND_DEFAULT_SIZE[concept.kind] ?? { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
}

/**
 * Estimated, not measured. The labels are single-line and short, so a
 * per-character estimate is within a few pixels, and measuring them would
 * mean a render pass before every layout.
 */
export function edgeLabelSize(label: string, proposed: boolean): NodeSize {
  const text = (label ?? '').trim();
  if (!text && !proposed) return { width: 0, height: 0 };
  const width = Math.round(text.length * LABEL_CHAR_WIDTH + LABEL_PADDING + (proposed ? LABEL_ACTIONS_WIDTH : 0));
  return { width, height: LABEL_HEIGHT };
}

/** Connected components over the undirected relationship graph, in first-seen order. */
function connectedComponents(concepts: Concept[], relationships: Relationship[]): Concept[][] {
  const byId = new Map(concepts.map((c) => [c.id, c]));
  const adjacency = new Map<string, Set<string>>();
  for (const c of concepts) adjacency.set(c.id, new Set());
  for (const r of relationships) {
    if (r.from === r.to) continue;
    if (!adjacency.has(r.from) || !adjacency.has(r.to)) continue;
    adjacency.get(r.from)!.add(r.to);
    adjacency.get(r.to)!.add(r.from);
  }

  const seen = new Set<string>();
  const groups: Concept[][] = [];

  for (const c of concepts) {
    if (seen.has(c.id)) continue;
    const group: Concept[] = [];
    const queue = [c.id];
    seen.add(c.id);
    while (queue.length) {
      const id = queue.shift()!;
      group.push(byId.get(id)!);
      for (const next of adjacency.get(id) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    groups.push(group);
  }

  return groups;
}

function layoutComponent(
  concepts: Concept[],
  relationships: Relationship[],
  sizes: Record<string, NodeSize>
): { id: string; x: number; y: number; width: number; height: number }[] {
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({
    rankdir: 'LR',
    nodesep: NODE_SEP,
    ranksep: RANK_SEP,
    edgesep: EDGE_SEP,
    marginx: MARGIN,
    marginy: MARGIN,
    ranker: 'network-simplex',
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const c of concepts) {
    const { width, height } = sizeOf(sizes, c);
    g.setNode(c.id, { width, height });
  }

  const nodeIds = new Set(concepts.map((c) => c.id));
  for (const r of relationships) {
    if (r.from === r.to) continue;
    if (!nodeIds.has(r.from) || !nodeIds.has(r.to)) continue;
    const { width, height } = edgeLabelSize(r.label, r.status === 'PROPOSED');
    // Named edge, so two relationships between the same pair both survive.
    g.setEdge(r.from, r.to, { width, height, labelpos: 'c' }, r.id);
  }

  dagre.layout(g);

  // dagre positions are node centers; React Flow positions are top-left.
  return concepts.map((c) => {
    const n = g.node(c.id);
    return { id: c.id, x: n.x - n.width / 2, y: n.y - n.height / 2, width: n.width, height: n.height };
  });
}

export function layoutLeftToRight(
  concepts: Concept[],
  relationships: Relationship[],
  sizes: Record<string, NodeSize> = {}
): LaidOutPoint[] {
  const mapConcepts = concepts.filter((c) => !BAND_KINDS.has(c.kind));
  const bandConcepts = concepts.filter((c) => BAND_KINDS.has(c.kind));
  const mapIds = new Set(mapConcepts.map((c) => c.id));
  const mapRelationships = relationships.filter(
    (r) => r.from !== r.to && mapIds.has(r.from) && mapIds.has(r.to)
  );

  const components = connectedComponents(mapConcepts, mapRelationships)
    // Bigger, more-connected groups read as "the" structure — put them first.
    .sort((a, b) => b.length - a.length);

  const out: LaidOutPoint[] = [];
  let yCursor = 0;
  let minX = 0;
  let maxBottom = 0;
  let sawAny = false;

  for (const group of components) {
    const groupIds = new Set(group.map((c) => c.id));
    const groupRels = mapRelationships.filter((r) => groupIds.has(r.from) && groupIds.has(r.to));
    const laid = layoutComponent(group, groupRels, sizes);

    const top = Math.min(...laid.map((p) => p.y));
    const bottom = Math.max(...laid.map((p) => p.y + p.height));
    const shift = yCursor - top;

    for (const p of laid) {
      const x = Math.round(p.x);
      const y = Math.round(p.y + shift);
      out.push({ id: p.id, x, y });
      minX = sawAny ? Math.min(minX, x) : x;
      maxBottom = Math.max(maxBottom, y + p.height);
      sawAny = true;
    }
    yCursor += (bottom - top) + COMPONENT_GAP;
  }

  // Questions and problems: one row, left to right in creation order,
  // starting under the whole map rather than under any single component.
  if (bandConcepts.length) {
    const bandY = sawAny ? maxBottom + BAND_GAP : 0;
    let x = sawAny ? minX : 0;
    for (const c of bandConcepts) {
      const { width } = sizeOf(sizes, c);
      out.push({ id: c.id, x, y: bandY });
      x += width + BAND_ITEM_GAP;
    }
  }

  return out;
}
