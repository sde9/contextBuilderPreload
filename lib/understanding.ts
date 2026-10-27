import type { Concept, Model, Relationship, Statement, Status } from './types';
import { questionState } from './types';
import { visibleConcepts, visibleRelationships } from './reducer';

/*
 * Selectors that help a person understand the live map, following KVIF
 * (Knowledge Visualisation Interaction Framework, Enabler Research, Aug 2026).
 * Pure: no React, no network. Nothing here changes the model.
 *
 *   conceptLineage   P2, P9  where a box came from, and what happened to it
 *   foldedDetails    P5, P6  green details folded into their owner
 *   turnChanges      P5      what this turn added or touched
 *   replayAt         P11     the map as it stood after an earlier turn
 */

// ------------------------------------------------------------------ lineage (P2, P9)

export type LineageStatus = 'SAID' | 'GUESS' | 'GUESS_CONFIRMED' | 'CONTESTED';

export type LineageEvent = { turn: number; text: string };

export type Lineage = {
  concept: Concept;
  status: LineageStatus;
  /** The person's own words this box came from, oldest first. */
  sources: { statementId: string; turn: number; text: string; answerTo: string }[];
  /** Why the AI guessed it. Only for guesses. */
  why: string;
  /** What the guess was attached to when it was proposed. */
  guessedFrom: { id: string; label: string } | null;
  /** What happened to it, oldest first: said again, confirmed, changed by an answer, checked in a recap. */
  events: LineageEvent[];
  links: { direction: 'out' | 'in'; label: string; otherId: string; otherLabel: string; proposed: boolean }[];
  owner: { id: string; label: string } | null;
  details: { id: string; label: string; note: string }[];
  questions: { id: string; text: string; state: string }[];
};

function statusOf(c: Concept): LineageStatus {
  if (c.status === 'CONTESTED') return 'CONTESTED';
  if (c.status === 'PROPOSED') return 'GUESS';
  return c.origin === 'INFERRED' ? 'GUESS_CONFIRMED' : 'SAID';
}

export function conceptLineage(m: Model, id: string): Lineage | null {
  const concept = m.concepts.find((c) => c.id === id);
  if (!concept) return null;

  const label = new Map(m.concepts.map((c) => [c.id, c.label]));
  const byStatement = new Map(m.statements.map((s) => [s.id, s]));
  const questionWords = (qid: string) =>
    m.questions.find((q) => q.id === qid)?.text ?? m.concepts.find((c) => c.id === qid)?.label ?? '';

  const sources = concept.evidence
    .map((e) => byStatement.get(e))
    .filter((s): s is Statement => Boolean(s))
    .sort((a, b) => a.turn - b.turn)
    .map((s) => ({ statementId: s.id, turn: s.turn, text: s.text, answerTo: s.questionId ? questionWords(s.questionId) : '' }));

  const events: LineageEvent[] = [];
  const born = concept.bornTurn ?? sources[0]?.turn ?? concept.turn;
  events.push({
    turn: born,
    text: concept.origin === 'INFERRED' ? 'The AI guessed it' : 'Recorded from what was said',
  });
  // Said again after it first appeared: a guess the person then said out loud, or a restatement.
  sources.forEach((s, i) => {
    if (concept.origin !== 'INFERRED' && s.turn <= born) return;
    const first = concept.origin === 'INFERRED' && i === 0;
    const text = s.answerTo
      ? `Said in the answer to “${s.answerTo}”`
      : first
        ? 'Said out loud, so it is no longer a guess'
        : 'Said again';
    events.push({ turn: s.turn, text });
  });
  for (const entry of m.log) {
    const p = entry.payload as Record<string, unknown> | null;
    if (!p) continue;
    if (entry.kind === 'confirm' && p.conceptId === id) events.push({ turn: entry.turn, text: 'You confirmed it' });
    if (entry.kind === 'answer' && Array.isArray(p.changes)) {
      for (const ch of p.changes as { id: string; before: { label: string; note: string } }[]) {
        if (ch.id !== id) continue;
        const was = [ch.before.label, ch.before.note].filter(Boolean).join(', ');
        events.push({ turn: entry.turn, text: `Changed by the answer to “${String(p.question ?? '')}”. It was: ${was}` });
      }
    }
    if (entry.kind === 'ground' && Array.isArray(p.conceptIds) && (p.conceptIds as string[]).includes(id)) {
      events.push({
        turn: entry.turn,
        text: p.verdict === 'RIGHT' ? 'You said the read-back was right' : 'You corrected the read-back',
      });
    }
  }
  events.sort((a, b) => a.turn - b.turn);

  const rels = visibleRelationships(m).filter((r) => r.from === id || r.to === id);
  const guessLink =
    concept.origin === 'INFERRED' ? m.relationships.find((r) => r.to === id && r.origin === 'INFERRED' && r.turn === concept.bornTurn) ?? m.relationships.find((r) => r.to === id && r.origin === 'INFERRED') : undefined;

  return {
    concept,
    status: statusOf(concept),
    sources,
    why: concept.origin === 'INFERRED' ? concept.note : '',
    guessedFrom: guessLink && label.get(guessLink.from) ? { id: guessLink.from, label: label.get(guessLink.from)! } : null,
    events,
    links: rels.map((r) => {
      const out = r.from === id;
      const other = out ? r.to : r.from;
      return { direction: out ? 'out' : 'in', label: r.label, otherId: other, otherLabel: label.get(other) ?? other, proposed: r.status === 'PROPOSED' };
    }),
    owner: concept.belongsTo && label.get(concept.belongsTo) ? { id: concept.belongsTo, label: label.get(concept.belongsTo)! } : null,
    details: visibleConcepts(m)
      .filter((c) => c.belongsTo === id)
      .map((c) => ({ id: c.id, label: c.label, note: c.note })),
    questions: m.questions
      .filter((q) => q.anchorId === id)
      .map((q) => ({ id: q.id, text: q.text, state: questionState(q) })),
  };
}

/** One-line label for a status, in plain words. Never stronger than the evidence (P3). */
export const LINEAGE_STATUS_TEXT: Record<LineageStatus, string> = {
  SAID: 'From what was said',
  GUESS: 'A guess. Waiting for a yes or no',
  GUESS_CONFIRMED: 'A guess you confirmed',
  CONTESTED: 'Sources disagree',
};

// ------------------------------------------------------------------ folded details (P5, P6)

/**
 * Green details that can sit inside their owner as small chips instead of
 * as boxes of their own: an ATTRIBUTE, confirmed, whose owner is on the map,
 * and whose only links are to that owner. A detail linked to anything else
 * is more than a detail, and a guess still needs its own yes or no, so both
 * stay as boxes.
 */
export function foldedDetails(m: Model): { folded: Set<string>; byOwner: Map<string, Concept[]> } {
  const shown = visibleConcepts(m);
  const onMap = new Set(shown.map((c) => c.id));
  const rels = visibleRelationships(m);
  const candidates = new Map<string, Concept>();
  for (const c of shown) {
    if (c.kind !== 'ATTRIBUTE' || c.status !== 'VALIDATED' || !c.belongsTo || !onMap.has(c.belongsTo)) continue;
    const linksElsewhere = rels.some((r) => (r.from === c.id || r.to === c.id) && r.from !== c.belongsTo && r.to !== c.belongsTo);
    if (!linksElsewhere) candidates.set(c.id, c);
  }
  // A detail that has details of its own stays a box, and its details fold
  // into it. Folding it too would hide them with it.
  for (const c of [...candidates.values()]) {
    if (candidates.has(c.belongsTo)) candidates.delete(c.belongsTo);
  }
  const folded = new Set(candidates.keys());
  const byOwner = new Map<string, Concept[]>();
  for (const c of candidates.values()) byOwner.set(c.belongsTo, [...(byOwner.get(c.belongsTo) ?? []), c]);
  return { folded, byOwner };
}

// ------------------------------------------------------------------ this turn (P5)

/** Boxes added or said again in the newest turn. The canvas marks them for a moment. */
export function turnChanges(m: Model): Set<string> {
  if (m.turn === 0) return new Set();
  return new Set(visibleConcepts(m).filter((c) => c.turn === m.turn).map((c) => c.id));
}

// ------------------------------------------------------------------ replay (P11)

/** The turn a concept first appeared. Older files have no bornTurn: the earliest evidence stands in. */
export function bornTurnOf(m: Model, c: Concept): number {
  if (c.bornTurn !== undefined) return c.bornTurn;
  const turns = c.evidence
    .map((e) => m.statements.find((s) => s.id === e)?.turn)
    .filter((t): t is number => typeof t === 'number');
  return turns.length ? Math.min(...turns) : c.turn;
}

export type ReplayFrame = {
  turn: number;
  /** Status of each concept that existed after this turn. A concept not in the map was still to come. */
  concepts: Map<string, Status>;
  /** Links that existed after this turn, with their status then. */
  relationships: Map<string, Status>;
  /** What was said at this turn. */
  said: Statement[];
};

/**
 * The map as it stood after turn t, over the concepts on the map now. A
 * concept the person later rejected is not on the map now and is left out,
 * so every replayed box has a place in today's layout. A guess shows orange
 * until the turn it was confirmed: by the Confirm button, by being said, or
 * in a recap.
 */
export function replayAt(m: Model, t: number): ReplayFrame {
  const confirmedAt = new Map<string, number>();
  const mark = (id: string, turn: number) => confirmedAt.set(id, Math.min(confirmedAt.get(id) ?? Infinity, turn));
  for (const e of m.log) {
    const p = e.payload as Record<string, unknown> | null;
    if (!p) continue;
    if (e.kind === 'confirm' && typeof p.conceptId === 'string') mark(p.conceptId, e.turn);
    if (e.kind === 'ground' && p.verdict === 'RIGHT' && Array.isArray(p.conceptIds)) for (const id of p.conceptIds as string[]) mark(id, e.turn);
  }
  const statementTurn = new Map(m.statements.map((s) => [s.id, s.turn]));

  const concepts = new Map<string, Status>();
  for (const c of visibleConcepts(m)) {
    const born = bornTurnOf(m, c);
    if (born > t) continue;
    let status: Status = c.status;
    if (c.origin === 'INFERRED' && c.status === 'VALIDATED') {
      for (const ev of c.evidence) {
        const st = statementTurn.get(ev);
        if (st !== undefined) mark(c.id, st);
      }
      const at = confirmedAt.get(c.id);
      status = at !== undefined && at <= t ? 'VALIDATED' : 'PROPOSED';
    }
    concepts.set(c.id, status);
  }

  const relationships = new Map<string, Status>();
  for (const r of visibleRelationships(m) as Relationship[]) {
    if (r.turn > t || !concepts.has(r.from) || !concepts.has(r.to)) continue;
    const endsGuessed = concepts.get(r.from) === 'PROPOSED' || concepts.get(r.to) === 'PROPOSED';
    relationships.set(r.id, r.status === 'PROPOSED' || (r.origin === 'INFERRED' && endsGuessed) ? 'PROPOSED' : r.status);
  }

  return { turn: t, concepts, relationships, said: m.statements.filter((s) => s.turn === t) };
}
