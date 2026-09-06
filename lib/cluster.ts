import type { Blocked, Cluster, Concept, Model } from './types';
import { newId, noBlocks } from './types';
import type { ClusterPatch } from './schema';

/*
 * Stage 3. Levels, so several hundred nodes stay readable (R3).
 *
 * Two separate jobs that people confuse:
 *
 *   clusters   WHICH area a concept belongs to. The model proposes this, and
 *              a deterministic check over the graph grades the answer.
 *   tier       HOW MUCH DETAIL a concept is. Almost never needs the model:
 *              an attribute is detail, anything owned by something else is
 *              detail, and a cluster with too many main concepts demotes its
 *              least connected ones.
 *
 * R6: an area is a Cluster, drawn as a container. It never becomes a concept,
 * because nobody wrote it down and a green node has to cite a sentence.
 *
 * Pure. No network.
 */

const MAX_MAIN_PER_CLUSTER = 20;

function visibleC(c: Concept): boolean {
  return c.status !== 'REJECTED' && !c.absorbedInto;
}

function degrees(model: Model): Map<string, number> {
  const d = new Map<string, number>();
  for (const c of model.concepts) d.set(c.id, 0);
  for (const r of model.relationships) {
    if (r.status === 'REJECTED') continue;
    d.set(r.from, (d.get(r.from) ?? 0) + 1);
    d.set(r.to, (d.get(r.to) ?? 0) + 1);
  }
  return d;
}

/**
 * Tier needs no model in the ordinary case. Detail is detail because of what
 * the concept IS, not because of anything a reader wants.
 */
export function assignTiers(model: Model): Model {
  const deg = degrees(model);
  const live = model.concepts.filter(visibleC);

  const tierOf = new Map<string, 2 | 3>();
  for (const c of live) {
    const detail = c.kind === 'ATTRIBUTE' || Boolean(c.belongsTo);
    tierOf.set(c.id, detail ? 3 : 2);
  }

  // A cluster crowded with main concepts pushes its least connected down.
  const byCluster = new Map<string, Concept[]>();
  for (const c of live) {
    if (tierOf.get(c.id) !== 2) continue;
    const key = c.clusterId || '';
    byCluster.set(key, [...(byCluster.get(key) ?? []), c]);
  }
  for (const [, members] of byCluster) {
    if (members.length <= MAX_MAIN_PER_CLUSTER) continue;
    const ranked = [...members].sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0));
    for (const c of ranked.slice(MAX_MAIN_PER_CLUSTER)) tierOf.set(c.id, 3);
  }

  return {
    ...model,
    concepts: model.concepts.map((c) => {
      const t = tierOf.get(c.id);
      return t && t !== c.tier ? { ...c, tier: t } : c;
    }),
  };
}

/**
 * How badly a grouping cuts through the graph. 0 means every edge stays inside
 * an area, 1 means every edge crosses. This is the number that grades the
 * model's answer without asking it a second time.
 */
export function crossingRatio(model: Model): number {
  const clusterOf = new Map(model.concepts.map((c) => [c.id, c.clusterId]));
  let crossing = 0;
  let total = 0;
  for (const r of model.relationships) {
    if (r.status === 'REJECTED') continue;
    const a = clusterOf.get(r.from);
    const b = clusterOf.get(r.to);
    if (a === undefined || b === undefined || !a || !b) continue;
    total++;
    if (a !== b) crossing++;
  }
  return total ? crossing / total : 0;
}

/** The pairs that cross. Fed back to the model on the second attempt. */
export function worstCrossings(model: Model, limit = 12): { from: string; to: string; label: string }[] {
  const clusterOf = new Map(model.concepts.map((c) => [c.id, c.clusterId]));
  const labelOf = new Map(model.concepts.map((c) => [c.id, c.label]));
  const out: { from: string; to: string; label: string }[] = [];
  for (const r of model.relationships) {
    if (r.status === 'REJECTED') continue;
    const a = clusterOf.get(r.from);
    const b = clusterOf.get(r.to);
    if (!a || !b || a === b) continue;
    out.push({ from: labelOf.get(r.from) ?? r.from, to: labelOf.get(r.to) ?? r.to, label: r.label });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Apply a grouping. Unknown ids are dropped and counted, the same way the
 * merge treats them (R7, R12). Anything the model forgot lands in one honest
 * "Not yet grouped" area rather than disappearing.
 */
export function applyClusters(model: Model, patch: ClusterPatch): { model: Model; blocked: Blocked } {
  const blocked = noBlocks();
  const live = new Set(model.concepts.filter(visibleC).map((c) => c.id));
  const taken = new Set<string>();
  const clusters: Cluster[] = [];

  for (const area of patch.areas) {
    const label = area.label?.trim();
    if (!label) {
      blocked.invented++;
      continue;
    }
    const memberIds = area.memberIds.filter((id) => {
      if (!live.has(id)) {
        blocked.invented++;
        return false;
      }
      if (taken.has(id)) {
        blocked.duplicates++;
        return false;
      }
      taken.add(id);
      return true;
    });
    if (!memberIds.length) continue;
    clusters.push({ id: newId('cl'), label, memberIds, origin: 'INFERRED', confirmed: false });
  }

  const leftover = [...live].filter((id) => !taken.has(id));
  if (leftover.length) {
    clusters.push({
      id: newId('cl'),
      label: 'Not yet grouped',
      memberIds: leftover,
      origin: 'INFERRED',
      confirmed: false,
    });
  }

  const clusterOf = new Map<string, string>();
  for (const cl of clusters) for (const id of cl.memberIds) clusterOf.set(id, cl.id);

  const next: Model = {
    ...model,
    clusters,
    concepts: model.concepts.map((c) => ({ ...c, clusterId: clusterOf.get(c.id) ?? '' })),
    log: [
      ...model.log,
      { turn: model.turn, at: new Date().toISOString(), kind: 'cluster' as const, payload: patch, blocked },
    ],
  };

  return { model: assignTiers(next), blocked };
}

export type ClusterEdge = { from: string; to: string; weight: number };

/** Level 1 draws one line per pair of areas, thickened by how much crosses it. */
export function clusterEdges(model: Model): ClusterEdge[] {
  const clusterOf = new Map(model.concepts.map((c) => [c.id, c.clusterId]));
  const weights = new Map<string, ClusterEdge>();
  for (const r of model.relationships) {
    if (r.status === 'REJECTED') continue;
    const a = clusterOf.get(r.from);
    const b = clusterOf.get(r.to);
    if (!a || !b || a === b) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const existing = weights.get(key);
    if (existing) existing.weight++;
    else weights.set(key, { from: a < b ? a : b, to: a < b ? b : a, weight: 1 });
  }
  return [...weights.values()].sort((x, y) => y.weight - x.weight);
}

export type Level = 1 | 2 | 3;

/** Which concepts a level shows. Level 1 shows none: the canvas draws areas. */
export function conceptsAtLevel(model: Model, level: Level, openClusters: string[] = []): Concept[] {
  const live = model.concepts.filter(visibleC);
  const open = new Set(openClusters);
  if (level === 3) return live;
  if (level === 2) return live.filter((c) => c.tier === 2 || open.has(c.clusterId));
  return live.filter((c) => open.has(c.clusterId));
}

export type Coverage = {
  sourceId: string;
  name: string;
  concepts: number;
  /** Concepts only this document supports. Where the map is fragile. */
  unique: number;
};

/**
 * Stage 4's cheap half. A section resting on one informal source is not wrong,
 * but a BA should know before quoting it back as settled scope.
 */
export function coverage(model: Model, sourcesOf: (m: Model, c: Concept) => string[]): Coverage[] {
  const counts = new Map<string, { concepts: number; unique: number }>();
  for (const s of model.sources) counts.set(s.id, { concepts: 0, unique: 0 });

  for (const c of model.concepts) {
    if (!visibleC(c)) continue;
    const ids = sourcesOf(model, c);
    for (const sid of ids) {
      const row = counts.get(sid);
      if (!row) continue;
      row.concepts++;
      if (ids.length === 1) row.unique++;
    }
  }

  return model.sources.map((s) => ({
    sourceId: s.id,
    name: s.name,
    concepts: counts.get(s.id)?.concepts ?? 0,
    unique: counts.get(s.id)?.unique ?? 0,
  }));
}
