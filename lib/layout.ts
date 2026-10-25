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

// ------------------------------------------------------------------ by parts

/*
 * A document with a skeleton is laid out the way it reads, like an outline:
 * its main point at the top, then one row per part in reading order, the
 * part on the left and what it contains to its right. Position then means
 * something (top to bottom is the order of the argument), every part hangs
 * off one spine on the left, and the slider fills the map in reading order.
 *
 * A single row of eight parts was tried first. It made the overview three
 * thousand pixels wide and unreadable at any zoom that showed all of it.
 */

export type PartColumn = { leadId: string | null; memberIds: string[] };

/**
 * Where a detail sits in an outline: the part it hangs from and the line it
 * is on. Each line has a rail under it. A detail's link to its own part runs
 * down to the rail, along it and up into the part, so it never passes behind
 * another box and its label can sit just under the detail it belongs to.
 */
export type OutlinePlace = {
  lead: string | null;
  lineTop: number;
  /** y of the rail under the line. */
  rail: number;
  /** Position on the line, from 0. */
  slot: number;
  /** x of the free gap to the right of the slot. */
  dropX: number;
};

export type OutlineLayout = {
  points: LaidOutPoint[];
  places: Map<string, OutlinePlace>;
  parts: Set<string>;
  /** x of the free corridor between the parts and their details. */
  corridorX: number;
};

/** Room on the left for the spine the part links run down. */
const SPINE_INDENT = 300;
/** The corridor between the parts and the first detail of each. */
const LEAD_TO_MEMBERS = 90;
/** Every detail gets a slot this wide, so the slots line up from row to row. */
const SLOT_WIDTH = 240;
const MEMBER_GAP_X = 100;
/** From the lowest box of a line to its rail: room for the labels. */
const RAIL_DROP = 30;
/** From a rail to the next line or row. */
const AFTER_RAIL = 18;
const PART_ROW_GAP = 34;
const MAIN_GAP = 56;
const MAX_PER_LINE = 3;
/** A link's label sits on the tick just under its detail. */
export const LABEL_BELOW = 15;
/** Two details on one line, not side by side, are joined over the top. */
const OVER_LINE = 9;

export function layoutByParts(
  concepts: Concept[],
  columns: PartColumn[],
  mainId: string | null,
  sizes: Record<string, NodeSize> = {}
): OutlineLayout {
  const byId = new Map(concepts.map((c) => [c.id, c]));
  const points: LaidOutPoint[] = [];
  const places = new Map<string, OutlinePlace>();
  const parts = new Set<string>();
  const main = mainId ? byId.get(mainId) : undefined;
  const left = main ? SPINE_INDENT : 0;
  let y = 0;

  if (main) {
    points.push({ id: main.id, x: 0, y: 0 });
    y = sizeOf(sizes, main).height + MAIN_GAP;
  }

  // One left edge for every row's details, so a gap between two slots is free
  // all the way down the map and a link can run along it.
  const leads = columns.map((c) => (c.leadId ? byId.get(c.leadId) : undefined)).filter((c): c is Concept => Boolean(c));
  const leadWidth = leads.length ? Math.max(...leads.map((c) => sizeOf(sizes, c).width)) : 0;
  const slotsLeft = left + (leadWidth ? leadWidth + LEAD_TO_MEMBERS : 0);
  const corridorX = left + leadWidth + LEAD_TO_MEMBERS / 2;

  const placeRow = (lead: Concept | undefined, members: Concept[]) => {
    const rowTop = y;
    let partBottom = rowTop;
    if (lead) {
      points.push({ id: lead.id, x: left, y: rowTop });
      parts.add(lead.id);
      partBottom = rowTop + sizeOf(sizes, lead).height;
    }
    if (!members.length) {
      y = partBottom + PART_ROW_GAP;
      return;
    }
    let lineTop = rowTop;
    let rail = rowTop;
    for (let i = 0; i < members.length; i += MAX_PER_LINE) {
      const line = members.slice(i, i + MAX_PER_LINE);
      const lineBottom = lineTop + Math.max(...line.map((c) => sizeOf(sizes, c).height));
      // The first line's rail also clears the part, which may be the taller.
      rail = Math.max(lineBottom, lead && lineTop < partBottom ? partBottom : lineBottom) + RAIL_DROP;
      line.forEach((c, slot) => {
        const s = sizeOf(sizes, c);
        const slotX = slotsLeft + slot * (SLOT_WIDTH + MEMBER_GAP_X);
        points.push({ id: c.id, x: Math.round(slotX + (SLOT_WIDTH - s.width) / 2), y: Math.round(lineTop) });
        places.set(c.id, { lead: lead?.id ?? null, lineTop, rail, slot, dropX: slotX + SLOT_WIDTH + MEMBER_GAP_X / 2 });
      });
      lineTop = rail + AFTER_RAIL;
    }
    y = Math.max(rail, partBottom) + AFTER_RAIL;
  };

  for (const col of columns) {
    const lead = col.leadId ? byId.get(col.leadId) : undefined;
    const members = col.memberIds.map((id) => byId.get(id)).filter((c): c is Concept => Boolean(c) && c!.id !== col.leadId);
    if (!lead && !members.length) continue;
    placeRow(lead, members);
  }

  // Anything a row did not claim still gets a place, in a last row.
  const placed = new Set(points.map((p) => p.id));
  const rest = concepts.filter((c) => !placed.has(c.id));
  if (rest.length) placeRow(undefined, rest);
  return { points, places, parts, corridorX };
}

export type Point = { x: number; y: number };
/** A link drawn along fixed points, with its label at a fixed place. */
export type Route = { points: Point[]; label: Point };
type Box = { x: number; y: number; width: number; height: number };

/**
 * The path of a link on an outline, or null to leave it to React Flow.
 *
 *   a detail and its own part     down to the rail, along it, up into the
 *                                 part; the label under the detail
 *   a detail and the main point   out into the free gap on the detail's
 *                                 right, up above the first row, into the
 *                                 main point's right side
 *   a detail and another part     down to the rail, along it to the
 *                                 corridor, along the corridor to the part
 *   two details on one line       over the top of the line, unless they sit
 *                                 side by side
 *
 * Links between the main point and the parts are the spine and are drawn
 * elsewhere; anything else falls back to React Flow's own routing.
 */
export function routeOutlineLink(
  from: string,
  to: string,
  boxes: Map<string, Box>,
  layout: OutlineLayout,
  mainId: string | null
): Route | null {
  const a = boxes.get(from);
  const b = boxes.get(to);
  if (!a || !b) return null;
  const pa = layout.places.get(from);
  const pb = layout.places.get(to);
  const bottom = (r: Box): Point => ({ x: r.x + r.width / 2, y: r.y + r.height });
  const midY = (r: Box) => r.y + r.height / 2;
  const reverse = (r: Route): Route => ({ points: [...r.points].reverse(), label: r.label });

  const ownPart = (member: Box, place: OutlinePlace, part: Box): Route => {
    const m = bottom(member);
    const p = bottom(part);
    return { points: [m, { x: m.x, y: place.rail }, { x: p.x, y: place.rail }, p], label: { x: m.x, y: m.y + LABEL_BELOW } };
  };
  if (pa?.lead && pa.lead === to) return ownPart(a, pa, b);
  if (pb?.lead && pb.lead === from) return reverse(ownPart(b, pb, a));

  const toMain = (member: Box, place: OutlinePlace, main: Box): Route => {
    const y = midY(member);
    const top = midY(main);
    return {
      points: [
        { x: member.x + member.width, y },
        { x: place.dropX, y },
        { x: place.dropX, y: top },
        { x: main.x + main.width, y: top },
      ],
      label: { x: place.dropX, y },
    };
  };
  if (pa && mainId && to === mainId) return toMain(a, pa, b);
  if (pb && mainId && from === mainId) return reverse(toMain(b, pb, a));

  const otherPart = (member: Box, place: OutlinePlace, part: Box): Route => {
    const m = bottom(member);
    const y = midY(part);
    // A little under the rail, so it does not merge with the line's own links.
    const rail = place.rail + 7;
    return {
      points: [m, { x: m.x, y: rail }, { x: layout.corridorX, y: rail }, { x: layout.corridorX, y }, { x: part.x + part.width, y }],
      label: { x: layout.corridorX, y: (rail + y) / 2 },
    };
  };
  if (pa && layout.parts.has(to)) return otherPart(a, pa, b);
  if (pb && layout.parts.has(from)) return reverse(otherPart(b, pb, a));

  if (pa && pb && pa.lineTop === pb.lineTop && Math.abs(pa.slot - pb.slot) > 1) {
    const y = pa.lineTop - OVER_LINE;
    const ax = a.x + a.width / 2;
    const bx = b.x + b.width / 2;
    return { points: [{ x: ax, y: a.y }, { x: ax, y }, { x: bx, y }, { x: bx, y: b.y }], label: { x: (ax + bx) / 2, y } };
  }
  return null;
}

/**
 * An SVG path through the points, with the corners rounded like React Flow's
 * own step edges.
 */
export function roundedPath(points: Point[], radius = 8): string {
  const pts = points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 0.5);
  if (pts.length < 2) return '';
  let d = `M ${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [p0, p1, p2] = [pts[i - 1], pts[i], pts[i + 1]];
    const d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const d2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const r = Math.min(radius, d1 / 2, d2 / 2);
    const ax = p1.x + ((p0.x - p1.x) / d1) * r;
    const ay = p1.y + ((p0.y - p1.y) / d1) * r;
    const bx = p1.x + ((p2.x - p1.x) / d2) * r;
    const by = p1.y + ((p2.y - p1.y) / d2) * r;
    d += ` L ${ax},${ay} Q ${p1.x},${p1.y} ${bx},${by}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L ${last.x},${last.y}`;
}

export type HandlePick = { sourceHandle?: string; targetHandle?: string };

/**
 * Which sides an edge leaves and enters by. Left to right uses the default
 * handles, so the live canvas, which never passes ids, is unchanged. A link
 * between two boxes in the same column runs out of the bottom and into the
 * top instead of looping round the side.
 */
export function pickHandles(a: Box, b: Box): HandlePick {
  const dx = b.x + b.width / 2 - (a.x + a.width / 2);
  const dy = b.y + b.height / 2 - (a.y + a.height / 2);
  if (Math.abs(dx) >= Math.abs(dy) * 0.9) return dx >= 0 ? {} : { sourceHandle: 'sl', targetHandle: 'tr' };
  return dy >= 0 ? { sourceHandle: 'sb', targetHandle: 'tt' } : { sourceHandle: 'st', targetHandle: 'tb' };
}

export function sizeFor(concept: Concept, sizes: Record<string, NodeSize> = {}): NodeSize {
  return sizeOf(sizes, concept);
}
