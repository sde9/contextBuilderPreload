import type { Concept, Kind } from './types';

/*
 * Placement, not layout.
 *
 * Existing nodes never move. New nodes find a free spot near whatever they
 * connect to, fanning out by kind sector so the map reads as structure
 * rather than a blob. Proposals land one ring farther out, on the far side
 * of the parent, so green stays readable and orange reads as "around the edge".
 *
 * QUESTION and PROBLEM never reach this file — they live in the band
 * layout.ts draws below the map, and the reducer gives them a coarse
 * fallback position instead of calling place().
 */

const GOLDEN_ANGLE = 2.399963229728653;
const FIRST_RING = 280;
const RING_STEP = 110;
const MIN_GAP = 200;
const PROPOSE_RING_OFFSET = 1;

/** Preferred direction per concept kind — keeps siblings in readable arcs. */
const SECTOR: Record<Kind, number> = {
  ENTITY: Math.PI,
  ATTRIBUTE: Math.PI * 0.15,
  ACTOR: Math.PI * 0.52,
  STEP: 0,
  RULE: -Math.PI * 0.52,
  QUESTION: Math.PI * 0.85,
  PROBLEM: -Math.PI * 0.85,
  CLAIM: Math.PI * 0.3,
};

export type Point = { x: number; y: number };
export type PlaceKind = 'extract' | 'propose';

export type PlaceOpts = {
  kind?: PlaceKind;
  /** How many nodes already hang off this parent — spreads siblings apart. */
  siblingIndex?: number;
  conceptKind?: Kind;
};

function far(p: Point, taken: Point[]): boolean {
  return taken.every((t) => Math.hypot(t.x - p.x, t.y - p.y) >= MIN_GAP);
}

export function place(
  parent: Point | undefined,
  index: number,
  taken: Point[],
  opts: PlaceOpts = {}
): Point {
  const { kind = 'extract', siblingIndex = 0, conceptKind = 'ENTITY' } = opts;
  const anchor: Point = parent ?? { x: 0, y: 0 };

  if (!parent && taken.length === 0) return { x: 0, y: 0 };

  const sector = SECTOR[conceptKind] ?? 0;
  const proposalFlip = kind === 'propose' ? Math.PI * 0.42 : 0;
  const siblingSpread = siblingIndex * GOLDEN_ANGLE * 0.55;
  const ringStart = kind === 'propose' ? PROPOSE_RING_OFFSET : 0;

  for (let ring = 0; ring < 16; ring++) {
    const radius = FIRST_RING + (ring + ringStart) * RING_STEP;
    for (let step = 0; step < 12; step++) {
      const angle = sector + proposalFlip + siblingSpread + GOLDEN_ANGLE * (index + step * 2 + ring);
      const p = {
        x: Math.round(anchor.x + radius * Math.cos(angle)),
        y: Math.round(anchor.y + radius * Math.sin(angle) * 0.68),
      };
      if (far(p, taken)) return p;
    }
  }

  const lowest = taken.reduce((m, t) => Math.max(m, t.y), anchor.y);
  const lateral = (siblingIndex + index) % 7;
  return { x: anchor.x + (lateral - 3) * MIN_GAP, y: lowest + MIN_GAP + ringStart * 40 };
}

export function pointsOf(concepts: Concept[]): Point[] {
  return concepts.filter((c) => c.status !== 'REJECTED').map((c) => ({ x: c.x, y: c.y }));
}
