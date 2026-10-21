import type { Blocked, Concept, Model, Reading, Relationship, Source, Status } from './types';
import { ROLE_RANK, addBlocks, newId, noBlocks } from './types';
import { norm } from './guards';
import type { MergePatch } from './schema';

/*
 * Stage 2. The only genuinely new reducer in preload, and the one place where
 * a mistake is expensive.
 *
 * Pure: no React, no network, no side effects. Every path here is driven from
 * hand-written patches in scripts/smoke-preload.ts before a single model call
 * exists (R13).
 *
 * The shape of the work:
 *
 *   combineSourceModels   concatenate the per-document maps, and merge the
 *                         pairs that are obviously the same thing. No model.
 *   shortlistPairs        three cheap filters cut ~80,000 comparisons to a
 *                         few hundred. Only these reach the model.
 *   applyMerge            apply the model's verdicts, with R7 enforced here
 *                         rather than asked for in the prompt.
 *   splitConcept          undo one merge. This is what makes R1 true.
 *   resolveContest        a person decides. Nothing is deleted (R8).
 */

const EXACT_AUTO = 'exact';

// ------------------------------------------------------------------ helpers

function visibleC(c: Concept): boolean {
  return c.status !== 'REJECTED' && !c.absorbedInto;
}

/** Which documents a concept can cite. Empty for anything the AI proposed. */
export function sourcesOf(model: Model, concept: Concept): string[] {
  const byId = new Map(model.excerpts.map((e) => [e.id, e]));
  const out: string[] = [];
  for (const id of concept.evidence) {
    const ex = byId.get(id);
    if (ex && !out.includes(ex.sourceId)) out.push(ex.sourceId);
  }
  return out;
}

/** R9. Strongest role wins the label and gets listed first in a conflict. */
function rankOf(model: Model, concept: Concept): number {
  const roleById = new Map(model.sources.map((s) => [s.id, s.role]));
  const ranks = sourcesOf(model, concept).map((sid) => ROLE_RANK[roleById.get(sid) ?? 'UNKNOWN']);
  return ranks.length ? Math.min(...ranks) : ROLE_RANK.UNKNOWN;
}

function trigrams(s: string): Set<string> {
  const t = ` ${norm(s)} `;
  const out = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

/** Dice coefficient over trigrams. 1 = identical, 0 = nothing shared. */
export function similarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return (2 * shared) / (A.size + B.size);
}

function neighbours(model: Model): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const c of model.concepts) adj.set(c.id, new Set());
  for (const r of model.relationships) {
    if (r.status === 'REJECTED' || r.from === r.to) continue;
    adj.get(r.from)?.add(r.to);
    adj.get(r.to)?.add(r.from);
  }
  return adj;
}

// ------------------------------------------------------------------ the merge itself

/**
 * Fold `absorbedId` into `keepId`.
 *
 * Evidence is unioned, so the survivor cites both documents. Edges are
 * repointed, and each repointed edge records what it used to point at, which
 * is the entire mechanism behind splitConcept. Nothing is deleted.
 */
function mergeInto(
  concepts: Concept[],
  relationships: Relationship[],
  keepId: string,
  absorbedId: string,
  keepLabel: string
): void {
  const keep = concepts.find((c) => c.id === keepId);
  const gone = concepts.find((c) => c.id === absorbedId);
  if (!keep || !gone || keep.id === gone.id) return;

  keep.label = keepLabel;
  keep.note = keep.note || gone.note;
  for (const e of gone.evidence) if (!keep.evidence.includes(e)) keep.evidence.push(e);
  if (!keep.mergedFrom.includes(absorbedId)) keep.mergedFrom.push(absorbedId);
  // A merged node is at least as central as either half.
  if (gone.tier === 2) keep.tier = 2;

  gone.absorbedInto = keepId;

  for (const c of concepts) {
    if (c.belongsTo === absorbedId) c.belongsTo = keepId;
  }

  for (const r of relationships) {
    const touchesFrom = r.from === absorbedId;
    const touchesTo = r.to === absorbedId;
    if (!touchesFrom && !touchesTo) continue;

    // An edge can be repointed more than once as the map consolidates, so
    // each repoint is recorded rather than overwriting the last one.
    const prevStatus = r.status;
    if (touchesFrom) {
      r.from = keepId;
      r.merges = [...r.merges, { absorbedId, end: 'from', prevStatus }];
    }
    if (touchesTo) {
      r.to = keepId;
      r.merges = [...r.merges, { absorbedId, end: 'to', prevStatus }];
    }

    // A self-loop, or an edge that now duplicates one already there, is
    // parked rather than deleted so the split can bring it back.
    const selfLoop = r.from === r.to;
    const dup = relationships.some(
      (o) =>
        o.id !== r.id &&
        o.status !== 'REJECTED' &&
        o.from === r.from &&
        o.to === r.to &&
        norm(o.label) === norm(r.label)
    );
    if (selfLoop || dup) r.status = 'REJECTED';
  }
}

/** Undo one merge. R1: a merge the model judged is always reversible. */
export function splitConcept(model: Model, keepId: string, absorbedId: string): Model {
  const concepts = model.concepts.map((c) => ({ ...c, evidence: [...c.evidence], mergedFrom: [...c.mergedFrom] }));
  const relationships = model.relationships.map((r) => ({ ...r }));

  const keep = concepts.find((c) => c.id === keepId);
  const gone = concepts.find((c) => c.id === absorbedId);
  if (!keep || !gone || gone.absorbedInto !== keepId) return model;

  gone.absorbedInto = '';
  keep.mergedFrom = keep.mergedFrom.filter((id) => id !== absorbedId);
  // Evidence ids are unique to the pass that created them, so the survivor's
  // own citations can never collide with the absorbed node's.
  keep.evidence = keep.evidence.filter((e) => !gone.evidence.includes(e));

  for (const r of relationships) {
    const trace = [...r.merges].reverse().find((t) => t.absorbedId === absorbedId);
    if (!trace) continue;
    if (trace.end === 'from') r.from = absorbedId;
    else r.to = absorbedId;
    r.status = trace.prevStatus;
    r.merges = r.merges.filter((t) => t !== trace);
  }

  for (const c of concepts) {
    if (c.belongsTo === keepId && gone.evidence.some((e) => c.evidence.includes(e))) c.belongsTo = absorbedId;
  }

  // A split contest is no longer a contest.
  if (keep.status === 'CONTESTED') {
    keep.status = 'VALIDATED';
    keep.contest = keep.contest ? { ...keep.contest, resolved: 'SPLIT' } : null;
  }

  return {
    ...model,
    concepts,
    relationships,
    log: [
      ...model.log,
      { turn: model.turn, at: new Date().toISOString(), kind: 'split' as const, payload: { keepId, absorbedId } },
    ],
  };
}

// ------------------------------------------------------------------ combine

/**
 * Concatenate the per-document maps, then merge the pairs nobody needs a model
 * to decide: same normalised label, same kind. This is exactly the rule
 * real-time already applies inside one turn, so applying it across documents
 * introduces no new judgement.
 */
export function combineSourceModels(models: Model[], sources: Source[]): { model: Model; blocked: Blocked } {
  const blocked = noBlocks();
  const ordered = [...models].sort((a, b) => {
    const ra = a.sources[0] ? ROLE_RANK[a.sources[0].role] : ROLE_RANK.UNKNOWN;
    const rb = b.sources[0] ? ROLE_RANK[b.sources[0].role] : ROLE_RANK.UNKNOWN;
    return ra - rb;
  });

  const base = ordered[0] ?? null;
  const combined: Model = {
    schemaVersion: '0.2',
    sessionId: base?.sessionId ?? newId('s'),
    title: base?.title ?? 'Untitled session',
    goal: '',
    turn: 1,
    statements: ordered.flatMap((m) => m.statements),
    concepts: ordered.flatMap((m) => m.concepts.map((c) => ({ ...c, evidence: [...c.evidence], mergedFrom: [...c.mergedFrom] }))),
    relationships: ordered.flatMap((m) => m.relationships.map((r) => ({ ...r }))),
    questions: [],
    rejected: [],
    log: [],
    sources,
    chunks: ordered.flatMap((m) => m.chunks),
    excerpts: ordered.flatMap((m) => m.excerpts),
    clusters: [],
    run: null,
  };

  // Exact matches, strongest source first so the survivor is the formal one.
  const seen = new Map<string, string>(); // normalised label + kind -> surviving id
  const byRank = [...combined.concepts]
    .filter(visibleC)
    .sort((a, b) => rankOf(combined, a) - rankOf(combined, b));

  for (const c of byRank) {
    const current = combined.concepts.find((x) => x.id === c.id)!;
    if (!visibleC(current)) continue;
    const key = `${norm(current.label)}|${current.kind}`;
    if (!norm(current.label)) continue;
    const winner = seen.get(key);
    if (winner && winner !== current.id) {
      mergeInto(combined.concepts, combined.relationships, winner, current.id, combined.concepts.find((x) => x.id === winner)!.label);
      blocked.duplicates++;
      continue;
    }
    seen.set(key, current.id);
  }

  combined.log.push({
    turn: 1,
    at: new Date().toISOString(),
    kind: 'merge',
    payload: { auto: EXACT_AUTO, merged: blocked.duplicates },
    blocked,
  });

  return { model: combined, blocked };
}

// ------------------------------------------------------------------ shortlist

export type Pair = {
  aId: string;
  bId: string;
  why: 'NEAR_LABEL' | 'SHARED_NEIGHBOUR';
  score: number;
};

export const NEAR_LABEL_MIN = 0.45;

/**
 * Three filters, no model.
 *
 * Filter three is the one that earns its keep: "hire period" and "rental
 * window" share no words and both attach to Booking.
 */
export function shortlistPairs(model: Model, limit = 240): Pair[] {
  const live = model.concepts.filter(visibleC);
  const adj = neighbours(model);
  const bySource = new Map(live.map((c) => [c.id, sourcesOf(model, c).join(',')]));
  const pairs = new Map<string, Pair>();

  const add = (a: Concept, b: Concept, why: Pair['why'], score: number) => {
    if (a.id === b.id) return;
    // Nothing to reconcile inside one document: stage 1 already deduped it.
    const sa = bySource.get(a.id) ?? '';
    const sb = bySource.get(b.id) ?? '';
    if (sa && sa === sb) return;
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    const existing = pairs.get(key);
    if (existing && existing.score >= score) return;
    pairs.set(key, { aId: a.id < b.id ? a.id : b.id, bId: a.id < b.id ? b.id : a.id, why, score });
  };

  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      if (a.kind !== b.kind) continue;

      const sim = similarity(a.label, b.label);
      if (sim >= NEAR_LABEL_MIN) {
        add(a, b, 'NEAR_LABEL', sim);
        continue;
      }
      const na = norm(a.label);
      const nb = norm(b.label);
      if (na && nb && (na.includes(nb) || nb.includes(na))) {
        add(a, b, 'NEAR_LABEL', 0.6);
        continue;
      }

      const sharedNeighbour = [...(adj.get(a.id) ?? [])].some((n) => adj.get(b.id)?.has(n));
      if (sharedNeighbour) add(a, b, 'SHARED_NEIGHBOUR', 0.3 + sim);
    }
  }

  return [...pairs.values()].sort((x, y) => y.score - x.score).slice(0, limit);
}

// ------------------------------------------------------------------ apply

function readingFor(model: Model, c: Concept, summary: string): Reading {
  const excerptIds = new Set(model.excerpts.map((e) => e.id));
  const evidenceId = c.evidence.find((e) => excerptIds.has(e)) ?? '';
  const sourceId = sourcesOf(model, c)[0] ?? '';
  return { evidenceId, sourceId, label: c.label, summary: summary || c.note };
}

/**
 * R7 is enforced here, not asked for in the prompt.
 *
 * An unknown id drops the decision. A keepLabel matching neither input falls
 * back to A's label. Both increment `invented`, so a prompt that starts
 * hallucinating shows up as a number rather than as a wrong map.
 */
export function applyMerge(model: Model, patch: MergePatch, cap = 60): { model: Model; blocked: Blocked } {
  const blocked = noBlocks();
  const at = new Date().toISOString();

  const concepts = model.concepts.map((c) => ({ ...c, evidence: [...c.evidence], mergedFrom: [...c.mergedFrom] }));
  const relationships = model.relationships.map((r) => ({ ...r }));
  const working: Model = { ...model, concepts, relationships };

  const alive = (id: string) => {
    const c = concepts.find((x) => x.id === id);
    return c && visibleC(c) ? c : undefined;
  };

  let applied = 0;

  for (const d of patch.decisions) {
    if (applied >= cap) {
      blocked.capped++;
      continue;
    }

    const a = alive(d.aId);
    const b = alive(d.bId);
    if (!a || !b || a.id === b.id) {
      blocked.invented++;
      continue;
    }

    // R7. The only labels allowed are the two that already exist. RELATED
    // keeps both nodes, so it has no label to choose and none is checked.
    let keepLabel = d.keepLabel?.trim() ?? '';
    if (d.verdict !== 'RELATED' && keepLabel !== a.label && keepLabel !== b.label) {
      blocked.invented++;
      keepLabel = '';
    }

    // R9. Strongest role survives; the model does not get to choose that.
    const [strong, weak] = rankOf(working, a) <= rankOf(working, b) ? [a, b] : [b, a];

    if (d.verdict === 'SAME') {
      mergeInto(concepts, relationships, strong.id, weak.id, keepLabel || strong.label);
      applied++;
      continue;
    }

    if (d.verdict === 'RELATED') {
      const label = d.relationLabel?.trim();
      if (!label) {
        blocked.invented++;
        continue;
      }
      const dup = relationships.some(
        (r) => r.status !== 'REJECTED' && r.from === a.id && r.to === b.id && norm(r.label) === norm(label)
      );
      if (dup) {
        blocked.duplicates++;
        continue;
      }
      relationships.push({
        id: newId('r'),
        from: strong.id,
        to: weak.id,
        label,
        origin: 'INFERRED',
        status: 'PROPOSED',
        turn: model.turn,
        merges: [],
      });
      applied++;
      continue;
    }

    if (d.verdict === 'CONFLICT') {
      const readings = [
        readingFor(working, strong, d.conflictSummary),
        readingFor(working, weak, d.conflictSummary),
      ];
      mergeInto(concepts, relationships, strong.id, weak.id, keepLabel || strong.label);
      const survivor = concepts.find((c) => c.id === strong.id)!;
      survivor.status = 'CONTESTED';
      survivor.contest = { readings, why: d.conflictSummary?.trim() || 'Two sources disagree.', resolved: 'NONE' };
      blocked.conflicts++;
      applied++;
      continue;
    }
  }

  const next: Model = {
    ...model,
    concepts,
    relationships,
    log: [...model.log, { turn: model.turn, at, kind: 'merge', payload: patch, blocked }],
  };

  return { model: next, blocked };
}

/**
 * R8. A person decides, and the losing reading stays in the record with its
 * citation. "Keep this one" is a decision, never a deletion.
 */
export function resolveContest(
  model: Model,
  conceptId: string,
  choice: 'KEPT_FIRST' | 'KEPT_SECOND' | 'SPLIT'
): Model {
  const target = model.concepts.find((c) => c.id === conceptId);
  if (!target?.contest) return model;

  if (choice === 'SPLIT') {
    const absorbed = target.mergedFrom[target.mergedFrom.length - 1];
    if (!absorbed) return model;
    return splitConcept(model, conceptId, absorbed);
  }

  const reading = choice === 'KEPT_FIRST' ? target.contest.readings[0] : target.contest.readings[1];

  return {
    ...model,
    concepts: model.concepts.map((c) =>
      c.id === conceptId
        ? {
            ...c,
            status: 'VALIDATED' as const,
            label: reading?.label || c.label,
            origin: 'USER' as const, // R5. A person made this call.
            contest: c.contest ? { ...c.contest, resolved: choice } : null,
          }
        : c
    ),
    log: [
      ...model.log,
      { turn: model.turn, at: new Date().toISOString(), kind: 'resolve' as const, payload: { conceptId, choice } },
    ],
  };
}

// ------------------------------------------------------------------ R2

/**
 * R2. A VALIDATED or CONTESTED concept has to be able to name its sentence.
 * One that cannot is refused rather than quietly shown as a fact.
 *
 * Runs after every document pass. It is the guard that stops a parsing bug
 * turning into confident green nodes nobody can check.
 */
export function enforceCitations(model: Model): { model: Model; blocked: Blocked } {
  const blocked = noBlocks();
  const known = new Set<string>([...model.statements.map((s) => s.id), ...model.excerpts.map((e) => e.id)]);

  const concepts = model.concepts.map((c) => {
    if (c.status !== 'VALIDATED' && c.status !== 'CONTESTED') return c;
    const cited = c.evidence.filter((e) => known.has(e));
    if (cited.length) return c.evidence.length === cited.length ? c : { ...c, evidence: cited };
    blocked.uncited++;
    return { ...c, status: 'REJECTED' as const };
  });

  if (!blocked.uncited && concepts.every((c, i) => c === model.concepts[i])) {
    return { model, blocked };
  }

  const gone = new Set(concepts.filter((c) => c.status === 'REJECTED').map((c) => c.id));
  const relationships = model.relationships.map((r) =>
    gone.has(r.from) || gone.has(r.to) ? { ...r, status: 'REJECTED' as const } : r
  );

  return { model: { ...model, concepts, relationships }, blocked };
}

export { addBlocks };

/** What the merge screen shows: how many nodes cite more than one document. */
export function corroboration(model: Model): { multi: number; single: number; uncited: number } {
  let multi = 0;
  let single = 0;
  let uncited = 0;
  for (const c of model.concepts) {
    if (!visibleC(c)) continue;
    const n = sourcesOf(model, c).length;
    if (n === 0) uncited++;
    else if (n === 1) single++;
    else multi++;
  }
  return { multi, single, uncited };
}

/** Status kept for a relationship the caller wants to restore by hand. */
export type PrevStatus = Status;
