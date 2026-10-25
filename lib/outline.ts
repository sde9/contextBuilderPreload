import type { Blocked, Chunk, Cluster, Concept, Excerpt, LinkType, Model, Outline, PartPattern, Relationship, Source } from './types';
import { conceptDefaults, newId, noBlocks } from './types';
import type { OutlinePatch } from './schema';
import { norm } from './guards';

/*
 * The skeleton of one document, and the areas it gives the map.
 *
 * Bottom-up reading cut a document into sections, read each one blind and
 * then tried to group the pieces. Structure came last and was guessed from
 * loose boxes, so a long document came out flat, with islands. This file is
 * the top-down half: one outline per document (main point, parts in reading
 * order, typed links), checked against the text before any of it is drawn.
 *
 * Pure. No network. Everything here is driven by hand-written patches in
 * scripts/smoke-preload.ts.
 */

/** Short ids the outline call sees instead of chunk ids: "s1", "s2", ... */
export function sectionIdsFor(chunks: Chunk[]): Map<string, Chunk> {
  return new Map(chunks.map((c, i) => [`s${i + 1}`, c]));
}

/**
 * A model's copy of a sentence differs from the file in spacing, curly
 * quotes, dash width and case. Nothing else may differ.
 */
export function normForQuote(s: string): string {
  return s
    .replace(/[‘’‚‛′`]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const HEADING_LINE = /^#{1,6}\s+(.+?)\s*$/;
const MIN_QUOTE = 12;

/**
 * The chunk a quote comes from, or null. A short quote counts only when it is
 * a heading exactly, because "Pricing" will be found in half the sections.
 */
export function findQuote(chunks: Chunk[], quote: string): Chunk | null {
  const q = normForQuote(quote);
  if (!q) return null;
  if (q.length < MIN_QUOTE) {
    for (const c of chunks) {
      for (const line of c.text.split('\n')) {
        const m = line.match(HEADING_LINE);
        if (m && normForQuote(m[1]) === q) return c;
      }
    }
    return null;
  }
  for (const c of chunks) if (normForQuote(c.text).includes(q)) return c;
  return null;
}

/** A part named after a heading in its own sections is written down, even with no quote. */
function headingMatch(chunks: Chunk[], label: string): { chunk: Chunk; heading: string } | null {
  const want = normForQuote(label);
  if (!want) return null;
  for (const c of chunks) {
    for (const line of c.text.split('\n')) {
      const m = line.match(HEADING_LINE);
      if (!m) continue;
      const h = normForQuote(m[1]);
      // "5.5 The TOE Framework" is named "The TOE Framework" by the model.
      if (h === want || h.replace(/^[\d.]+\s+/, '') === want) return { chunk: c, heading: m[1].trim() };
    }
  }
  return null;
}

export type AppliedOutline = { model: Model; outline: Outline; blocked: Blocked };

/**
 * Apply one document's skeleton. Every item whose quote is found becomes a
 * green, cited concept with its own excerpt: the sentence itself, not the
 * whole section. Every item whose quote is missing or wrong becomes an orange
 * guess with no evidence. The model never decides which is which.
 */
export function applyOutline(model: Model, patch: OutlinePatch, chunks: Chunk[], source: Source): AppliedOutline {
  const blocked = noBlocks();
  const at = new Date().toISOString();
  const short = sectionIdsFor(chunks);
  const concepts: Concept[] = model.concepts.map((c) => ({ ...c }));
  const relationships: Relationship[] = model.relationships.map((r) => ({ ...r }));
  const excerpts: Excerpt[] = [...model.excerpts];

  const cite = (quote: string, scope: Chunk[]): Excerpt | null => {
    const chunk = findQuote(scope, quote) ?? (scope !== chunks ? findQuote(chunks, quote) : null);
    if (!chunk) return null;
    const ex: Excerpt = {
      id: newId('ex'),
      chunkId: chunk.id,
      sourceId: source.id,
      quote: quote.trim(),
      locator: chunk.locator,
      turn: 0,
      ord: chunk.ordinal,
    };
    excerpts.push(ex);
    return ex;
  };

  const make = (item: { label: string; note: string; kind: Concept['kind'] }, ex: Excerpt | null, skeleton: 'MAIN' | 'PART', order: number): Concept => {
    const c: Concept = {
      id: newId('c'),
      label: item.label.trim(),
      note: item.note?.trim() ?? '',
      origin: ex ? 'EXPLICIT' : 'INFERRED',
      status: ex ? 'VALIDATED' : 'PROPOSED',
      // An attribute of nothing is not an attribute; a question or problem is
      // not a part of a document's skeleton.
      kind: item.kind === 'ATTRIBUTE' || item.kind === 'QUESTION' || item.kind === 'PROBLEM' ? 'ENTITY' : item.kind,
      belongsTo: '',
      level: 0,
      evidence: ex ? [ex.id] : [],
      turn: model.turn,
      x: 0,
      y: 0,
      pinned: false,
      ...conceptDefaults(),
      skeleton,
      order,
    };
    concepts.push(c);
    return c;
  };

  // MAIN
  let mainId = '';
  if (patch.main?.label?.trim()) {
    const main = make(patch.main, cite(patch.main.quote, chunks), 'MAIN', -1);
    mainId = main.id;
  }

  // PARTS, in the order given, duplicates by label dropped.
  const tempToId = new Map<string, string>();
  if (mainId) tempToId.set('main', mainId);
  const partIds: string[] = [];
  const patterns: Record<string, PartPattern> = {};
  const sections: Record<string, string> = {};
  const seen = new Set<string>();

  for (const p of patch.parts ?? []) {
    const key = norm(p.label ?? '');
    if (!key || seen.has(key)) {
      blocked.duplicates++;
      continue;
    }
    seen.add(key);
    const own = (p.sectionIds ?? []).map((sid) => short.get(sid)).filter((c): c is Chunk => Boolean(c));
    if ((p.sectionIds ?? []).length !== own.length) blocked.invented += (p.sectionIds ?? []).length - own.length;

    let ex = cite(p.quote ?? '', own.length ? own : chunks);
    if (!ex) {
      const h = headingMatch(own.length ? own : chunks, p.label);
      if (h) ex = cite(h.heading, [h.chunk]);
    }
    const part = make(p, ex, 'PART', partIds.length);
    tempToId.set(p.tempId, part.id);
    partIds.push(part.id);
    patterns[part.id] = p.pattern;
    for (const c of own) if (!sections[c.id]) sections[c.id] = part.id;
  }

  // Every section belongs to a part: an unclaimed one joins the part before
  // it in reading order, or the first part when nothing comes before.
  if (partIds.length) {
    let last = partIds[0];
    for (const c of [...chunks].sort((a, b) => a.ordinal - b.ordinal)) {
      if (sections[c.id]) last = sections[c.id];
      else sections[c.id] = last;
    }
  }

  // LINKS between parts and main. Unknown handles are dropped and counted.
  for (const l of patch.links ?? []) {
    const from = tempToId.get(l.from);
    const to = tempToId.get(l.to);
    if (!from || !to || from === to) {
      blocked.invented++;
      continue;
    }
    if (relationships.some((r) => r.from === from && r.to === to && r.status !== 'REJECTED')) {
      blocked.duplicates++;
      continue;
    }
    const written = Boolean(l.quote && findQuote(chunks, l.quote));
    relationships.push({
      id: newId('r'),
      from,
      to,
      label: (l.label || l.type.toLowerCase().replace('_', ' ')).trim(),
      type: l.type as LinkType,
      origin: written ? 'EXPLICIT' : 'INFERRED',
      status: written ? 'VALIDATED' : 'PROPOSED',
      turn: model.turn,
      merges: [],
    });
  }

  const outline: Outline = { sourceId: source.id, mainId, partIds, patterns, sections };
  return {
    model: {
      ...model,
      concepts,
      relationships,
      excerpts,
      outlines: [...(model.outlines ?? []).filter((o) => o.sourceId !== source.id), outline],
      log: [...model.log, { turn: model.turn, at, kind: 'outline', payload: patch, blocked }],
    },
    outline,
    blocked,
  };
}

// ------------------------------------------------------------------ areas

function visibleC(c: Concept): boolean {
  return c.status !== 'REJECTED' && !c.absorbedInto;
}

/** Follow a merge to the concept that survived it. */
export function liveId(model: Model, id: string): string {
  const byId = new Map(model.concepts.map((c) => [c.id, c]));
  let cur = byId.get(id);
  const seen = new Set<string>();
  while (cur && cur.absorbedInto && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = byId.get(cur.absorbedInto);
  }
  return cur && visibleC(cur) ? cur.id : '';
}

/** The part a concept was read in: its earliest excerpt's section. */
export function partOf(model: Model, outline: Outline, concept: Concept): string {
  const excerpts = new Map(model.excerpts.map((e) => [e.id, e]));
  const own = concept.evidence
    .map((id) => excerpts.get(id))
    .filter((e): e is Excerpt => Boolean(e) && e!.sourceId === outline.sourceId)
    .sort((a, b) => (a.ord ?? a.turn) - (b.ord ?? b.turn));
  for (const e of own) {
    const part = outline.sections[e.chunkId];
    if (part) {
      const live = liveId(model, part);
      if (live) return live;
    }
  }
  return '';
}

/** The single outline a one-document map is organised by, with merges followed. */
export function activeOutline(model: Model): Outline | null {
  const outlines = model.outlines ?? [];
  const read = model.sources.filter((s) => s.parse === 'OK' && s.conceptCount !== 0);
  if (outlines.length !== 1 || read.length > 1) return null;
  const o = outlines[0];
  const partIds = [...new Set(o.partIds.map((id) => liveId(model, id)).filter(Boolean))];
  if (!partIds.length) return null;
  return { ...o, mainId: o.mainId ? liveId(model, o.mainId) : '', partIds };
}

const MAIN_DETAILS_PER_PART = 1;

/**
 * One area per part, in reading order, instead of a grouping the model
 * invents after the fact. A document's own structure is the grouping its
 * author meant, and it costs no call.
 *
 * Tiers follow the skeleton: the main point and the parts are the overview,
 * the best-connected detail of each part joins them at the middle level, and
 * everything else is detail.
 */
export function structureFromOutline(model: Model, outline: Outline): { model: Model; blocked: Blocked } {
  const blocked = noBlocks();
  const live = model.concepts.filter(visibleC);
  const partIds = [...new Set(outline.partIds.map((id) => liveId(model, id)).filter(Boolean))];
  const mainId = outline.mainId ? liveId(model, outline.mainId) : '';
  const partSet = new Set(partIds);

  const degree = new Map<string, number>();
  for (const r of model.relationships) {
    if (r.status === 'REJECTED') continue;
    degree.set(r.from, (degree.get(r.from) ?? 0) + 1);
    degree.set(r.to, (degree.get(r.to) ?? 0) + 1);
  }

  const members = new Map<string, string[]>(partIds.map((id) => [id, [id]]));
  const leftover: string[] = [];
  const placed = new Map<string, string>();
  for (const id of partIds) placed.set(id, id);

  for (const c of live) {
    if (c.id === mainId || partSet.has(c.id)) continue;
    const part = partOf(model, outline, c);
    if (part && members.has(part)) {
      members.get(part)!.push(c.id);
      placed.set(c.id, part);
    }
  }
  // A guess or a merged node with no section of its own sits with what it is linked to.
  for (const c of live) {
    if (c.id === mainId || placed.has(c.id)) continue;
    const link = model.relationships.find(
      (r) => r.status !== 'REJECTED' && (r.from === c.id || r.to === c.id) && placed.has(r.from === c.id ? r.to : r.from)
    );
    const part = link ? placed.get(link.from === c.id ? link.to : link.from) : undefined;
    if (part) {
      members.get(part)!.push(c.id);
      placed.set(c.id, part);
    } else {
      leftover.push(c.id);
    }
  }

  const byId = new Map(live.map((c) => [c.id, c]));
  const clusters: Cluster[] = partIds.map((id) => ({
    id: newId('cl'),
    label: byId.get(id)?.label ?? 'Part',
    memberIds: members.get(id) ?? [id],
    origin: 'INFERRED',
    confirmed: false,
  }));
  if (leftover.length) {
    clusters.push({ id: newId('cl'), label: 'Not yet grouped', memberIds: leftover, origin: 'INFERRED', confirmed: false });
  }
  const clusterOf = new Map<string, string>();
  for (const cl of clusters) for (const id of cl.memberIds) clusterOf.set(id, cl.id);

  const tier = new Map<string, 2 | 3>();
  for (const id of [mainId, ...partIds]) if (id) tier.set(id, 2);
  for (const [partId, ids] of members) {
    const details = ids.filter((id) => id !== partId).map((id) => byId.get(id)!).filter(Boolean);
    const ranked = [...details].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));
    ranked.forEach((c, i) => {
      const keep = c.status === 'CONTESTED' || (i < MAIN_DETAILS_PER_PART && c.kind !== 'ATTRIBUTE' && !c.belongsTo);
      tier.set(c.id, keep ? 2 : 3);
    });
  }
  for (const id of leftover) tier.set(id, 3);

  const order = new Map(partIds.map((id, i) => [id, i]));
  const concepts = model.concepts.map((c) => {
    const next: Concept = { ...c, clusterId: clusterOf.get(c.id) ?? '' };
    const t = tier.get(c.id);
    if (t) next.tier = t;
    if (c.id === mainId) next.skeleton = 'MAIN';
    if (order.has(c.id)) {
      next.skeleton = 'PART';
      next.order = order.get(c.id);
    }
    return next;
  });

  return {
    model: {
      ...model,
      concepts,
      clusters,
      log: [
        ...model.log,
        { turn: model.turn, at: new Date().toISOString(), kind: 'cluster', payload: { fromOutline: outline.sourceId, parts: partIds.length }, blocked },
      ],
    },
    blocked,
  };
}

/**
 * Which concepts a level shows on a map with a skeleton. Overview is the main
 * point and the parts, Main adds each part's best-connected details, and
 * Everything is everything. A part opened by double-click shows its contents
 * at any level.
 */
export function outlineLevel(model: Model, level: 1 | 2 | 3, openClusters: string[] = []): Concept[] {
  const live = model.concepts.filter(visibleC);
  const open = new Set(openClusters);
  if (level === 3) return live;
  if (level === 2) return live.filter((c) => c.skeleton || c.tier === 2 || open.has(c.clusterId));
  return live.filter((c) => c.skeleton || (c.clusterId && open.has(c.clusterId)));
}
