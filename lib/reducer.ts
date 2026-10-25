import type { Blocked, CallMeta, Concept, Excerpt, Kind, LogEntry, Model, Question, Relationship, Statement } from './types';
import { conceptDefaults, newId, noBlocks } from './types';
import type { ExtractPatch, ExtractPatchPL, ProposePatch, ProposePatchRT } from './schema';
import { capProposals, clearRejection, findDuplicate, isRejected, norm, saidThisTurn, wouldCreateCycle } from './guards';
import { place, pointsOf, type PlaceKind, type Point } from './place';
import { layoutLeftToRight, type NodeSize } from './layout';

/*
 * The pure core. No React, no network, no side effects.
 *
 * Every state change in the app goes through this file, whether it came from
 * the AI or from a button. That is what makes the patch log a real history
 * rather than a partial one, and it is why versioning can be added later
 * without touching anything else.
 */

const MAX_OPEN_QUESTIONS = 8;
const BAND_KINDS = new Set<Kind>(['QUESTION', 'PROBLEM']);

// ------------------------------------------------------------------ helpers

function visible(c: Concept | Relationship): boolean {
  if (c.status === 'REJECTED') return false;
  // A concept absorbed by a merge is still in the array, so the merge can be
  // undone (R1). It is not on the map.
  if ('absorbedInto' in c && c.absorbedInto) return false;
  return true;
}

function sameRelationship(r: Relationship, from: string, to: string, label: string): boolean {
  return r.from === from && r.to === to && norm(r.label) === norm(label);
}

/**
 * level(c) = 0 if it stands alone, else 1 + level(parent). Walked iteratively
 * off live belongsTo pointers rather than trusting a cached level on an
 * ancestor, so it is correct no matter what order concepts were touched in.
 */
function computeLevel(concepts: Concept[], id: string): number {
  const byId = new Map(concepts.map((c) => [c.id, c]));
  let level = 0;
  let curId: string | undefined = id;
  const seen = new Set<string>();
  while (curId) {
    const cur = byId.get(curId);
    if (!cur || !cur.belongsTo || seen.has(curId)) break;
    seen.add(curId);
    level++;
    curId = cur.belongsTo;
  }
  return level;
}

// ------------------------------------------------------------------ Call 1

/**
 * Apply what the speaker actually said.
 *
 * Everything created here is EXPLICIT + VALIDATED. The extract schema has no
 * way to express anything else, so this function does not have to trust the
 * model's judgement about its own certainty.
 */
export type WrittenEvidence = {
  chunkId: string;
  sourceId: string;
  locator: string;
  /** Reading order of the section, so the story can replay a document as written. */
  ord?: number;
};

export function applyExtract(
  model: Model,
  patch: ExtractPatch | ExtractPatchPL,
  statementText: string,
  /**
   * Preload passes this. The only difference it makes is which array the
   * evidence record lands in: statements for speech, excerpts for a document.
   * evidence[] on a concept holds ids from either, so nothing below changes.
   */
  written?: WrittenEvidence
): { model: Model; blocked: Blocked } {
  const blocked = noBlocks();
  const turn = model.turn + 1;
  const at = new Date().toISOString();

  const statement: Statement | Excerpt = written
    ? {
        id: newId('ex'),
        chunkId: written.chunkId,
        sourceId: written.sourceId,
        quote: statementText,
        locator: written.locator,
        turn,
        ...(written.ord !== undefined ? { ord: written.ord } : {}),
      }
    : { id: newId('st'), text: statementText, at, turn };

  const concepts = model.concepts.map((c) => ({ ...c }));
  const relationships = model.relationships.map((r) => ({ ...r }));
  let rejected = model.rejected;

  const tempMap: Record<string, string> = {};
  const created: string[] = [];
  const createdFrom = new Map<string, (ExtractPatch | ExtractPatchPL)['concepts'][number]>();

  for (const pc of patch.concepts) {
    if (!pc.label.trim()) continue;

    // Does this restate something we already have? Two ways to find out: the
    // model told us, or the labels normalise to the same thing.
    let existing = pc.matchesExistingId
      ? concepts.find((c) => c.id === pc.matchesExistingId && visible(c))
      : undefined;

    if (!existing) {
      const dup = findDuplicate({ ...model, concepts }, pc.label);
      if (dup) {
        existing = concepts.find((c) => c.id === dup.id);
        if (existing) blocked.duplicates++;
      }
    }

    if (existing) {
      tempMap[pc.tempId] = existing.id;

      // An orange guess the speaker has now said out loud becomes green.
      // Origin stays INFERRED: "the AI guessed right" is a different fact from
      // "the human said it", and that difference is the only evidence we have
      // about whether the proposals are any good.
      if (existing.status === 'PROPOSED') existing.status = 'VALIDATED';
      if (!existing.evidence.includes(statement.id)) existing.evidence.push(statement.id);
      if (!existing.note && pc.note) existing.note = pc.note;
      existing.turn = turn;
      continue;
    }

    const id = newId('c');
    tempMap[pc.tempId] = id;
    created.push(id);
    createdFrom.set(id, pc);
    concepts.push({
      id,
      label: pc.label.trim(),
      note: pc.note ?? '',
      origin: 'EXPLICIT',
      status: 'VALIDATED',
      kind: pc.kind,
      belongsTo: '',
      level: 0,
      evidence: [statement.id],
      turn,
      x: 0,
      y: 0,
      pinned: false,
      ...conceptDefaults(),
    });

    // Saying something out loud lifts an earlier rejection of the same label.
    // Rejecting is meant to be cheap and safe, not a permanent ban on a word.
    rejected = clearRejection({ ...model, rejected }, pc.label);
  }

  const resolve = (ref: string): string | undefined => {
    if (tempMap[ref]) return tempMap[ref];
    return concepts.some((c) => c.id === ref && visible(c)) ? ref : undefined;
  };

  // Ownership. Resolved after tempMap is complete, so belongsTo can point at
  // a concept created earlier or later in the same turn.
  for (const [id, pc] of createdFrom) {
    const c = concepts.find((x) => x.id === id)!;
    const raw = (pc.belongsTo || '').trim();
    const parentId = raw ? resolve(raw) : undefined;
    const parent = parentId ? concepts.find((x) => x.id === parentId) : undefined;

    if (parent && !BAND_KINDS.has(parent.kind) && !wouldCreateCycle(concepts, id, parent.id)) {
      c.belongsTo = parent.id;
    } else {
      if (raw && parent && wouldCreateCycle(concepts, id, parent.id)) blocked.cycles++;
      c.belongsTo = '';
    }

    // An attribute with nothing to be a property of is not a property.
    if (c.kind === 'ATTRIBUTE' && !c.belongsTo) c.kind = 'ENTITY';
  }
  for (const id of created) {
    const c = concepts.find((x) => x.id === id)!;
    c.level = computeLevel(concepts, id);
  }

  for (const pr of patch.relationships) {
    const from = resolve(pr.from);
    const to = resolve(pr.to);
    if (!from || !to || from === to) continue;

    const dup = relationships.find((r) => sameRelationship(r, from, to, pr.label) && visible(r));
    if (dup) {
      if (dup.status === 'PROPOSED') dup.status = 'VALIDATED';
      continue;
    }

    relationships.push({
      id: newId('r'),
      from,
      to,
      label: (pr.label || 'relates to').trim(),
      origin: 'EXPLICIT',
      status: 'VALIDATED',
      turn,
      merges: [],
    });
  }

  // Place new nodes near whatever they connect to. Existing nodes never move.
  const taken = pointsOf(concepts.filter((c) => !created.includes(c.id)));
  layoutNewNodes(concepts, relationships, created, taken, 'extract');

  const next: Model = {
    ...model,
    turn,
    title: model.title === 'Untitled session' && concepts[0] ? concepts[0].label : model.title,
    statements: written ? model.statements : [...model.statements, statement as Statement],
    excerpts: written ? [...model.excerpts, statement as Excerpt] : model.excerpts,
    concepts,
    relationships,
    rejected,
    log: [...model.log, { turn, at, kind: 'extract', payload: patch, blocked }],
  };

  return { model: next, blocked };
}

function pointOfIn(concepts: Concept[], id: string): Point | undefined {
  const c = concepts.find((x) => x.id === id);
  return c ? { x: c.x, y: c.y } : undefined;
}

function childCount(
  parentId: string,
  concepts: Concept[],
  relationships: Relationship[]
): number {
  const ok = new Set(concepts.filter((c) => c.status !== 'REJECTED').map((c) => c.id));
  return relationships.filter((r) => visible(r) && r.from === parentId && ok.has(r.to)).length;
}

/**
 * QUESTION and PROBLEM never go through place() — they live in the band
 * layout.ts draws below the map, so a coarse fallback near the parent is
 * enough to hold them until the next layout pass repositions them.
 */
function placeNew(
  parent: Point | undefined,
  parentId: string | undefined,
  batchIndex: number,
  taken: Point[],
  concepts: Concept[],
  relationships: Relationship[],
  kind: PlaceKind,
  conceptKind: Kind
): Point {
  if (BAND_KINDS.has(conceptKind)) {
    const anchor = parent ?? { x: 0, y: 0 };
    return { x: anchor.x, y: anchor.y + 260 };
  }
  const siblings = parentId ? childCount(parentId, concepts, relationships) : 0;
  return place(parent, batchIndex, taken, { kind, siblingIndex: siblings + batchIndex, conceptKind });
}

function layoutNewNodes(
  concepts: Concept[],
  relationships: Relationship[],
  created: string[],
  taken: Point[],
  kind: PlaceKind
): void {
  created.forEach((id, i) => {
    const c = concepts.find((x) => x.id === id)!;
    const link = relationships.find(
      (r) => visible(r) && (r.from === id || r.to === id) && !created.includes(r.from === id ? r.to : r.from)
    );
    const parentId = link ? (link.from === id ? link.to : link.from) : undefined;
    const parent = parentId ? pointOfIn(concepts, parentId) : undefined;
    const p = placeNew(parent, parentId, i, taken, concepts, relationships, kind, c.kind);
    c.x = p.x;
    c.y = p.y;
    taken.push(p);
  });
}

// ------------------------------------------------------------------ Call 2

/**
 * Apply what the AI thinks is missing.
 *
 * Everything created here is INFERRED + PROPOSED. Guards run before anything
 * lands: rejected labels are dropped, duplicates are dropped, and anything
 * past the cap becomes a question instead of a node.
 */
/**
 * Real-time options. Preload passes none, and then applyPropose behaves
 * exactly as it did before they existed.
 */
export type ProposeOptions = {
  /**
   * Most new questions per turn, QUESTION concepts and the question list
   * counted together. Undefined means no limit beyond MAX_OPEN_QUESTIONS.
   */
  questionCap?: number;
  /**
   * This turn's statement. A proposal whose words were all just said is an
   * echo of the speaker, not a guess, so it is dropped.
   */
  latestStatement?: string;
};

type QuestionIn = { text: string; usefulness: number; why?: string };

export function applyPropose(
  model: Model,
  patch: ProposePatch | ProposePatchRT,
  cap = 5,
  opts: ProposeOptions = {}
): { model: Model; blocked: Blocked } {
  const blocked = noBlocks();
  const at = new Date().toISOString();
  const turn = model.turn;

  const concepts = model.concepts.map((c) => ({ ...c }));
  const relationships = model.relationships.map((r) => ({ ...r }));

  const seenThisTurn = new Set<string>();
  const filtered = patch.concepts.filter((pc) => {
    if (!pc.label.trim()) return false;

    const anchor = concepts.find((c) => c.id === pc.attachTo && visible(c));
    if (!anchor) {
      blocked.unattached++;
      return false;
    }
    if (isRejected(model, pc.label)) {
      blocked.rejected++;
      return false;
    }
    if (findDuplicate({ ...model, concepts }, pc.label)) {
      blocked.duplicates++;
      return false;
    }
    if (opts.latestStatement && pc.kind !== 'QUESTION' && saidThisTurn(pc.label, opts.latestStatement)) {
      blocked.duplicates++;
      return false;
    }
    const n = norm(pc.label);
    if (seenThisTurn.has(n)) {
      blocked.duplicates++;
      return false;
    }
    seenThisTurn.add(n);
    return true;
  });

  // Questions are rationed per turn when a cap is set. QUESTION concepts hang
  // off something concrete, so they are served first; the list gets the rest.
  let questionBudget = opts.questionCap ?? Number.POSITIVE_INFINITY;
  const candidates = filtered.filter((pc) => {
    if (pc.kind !== 'QUESTION') return true;
    if (questionBudget > 0) {
      questionBudget--;
      return true;
    }
    blocked.capped++;
    return false;
  });

  const { keep, overflow } = capProposals(candidates, cap);
  blocked.capped += overflow.length;

  const taken = pointsOf(concepts);
  const createdIds: string[] = [];
  keep.forEach((pc, i) => {
    const id = newId('c');
    const anchor = concepts.find((c) => c.id === pc.attachTo)!;

    let kind: Kind = pc.kind;
    let belongsTo = '';
    if (pc.isPropertyOfTarget && !BAND_KINDS.has(anchor.kind)) {
      kind = 'ATTRIBUTE';
      belongsTo = anchor.id;
    }
    if (kind === 'ATTRIBUTE' && !belongsTo) kind = 'ENTITY';

    const parent = pointOfIn(concepts, pc.attachTo);
    const p = placeNew(parent, pc.attachTo, i, taken, concepts, relationships, 'propose', kind);
    taken.push(p);

    concepts.push({
      id,
      label: pc.label.trim(),
      note: pc.why ?? '',
      origin: 'INFERRED',
      status: 'PROPOSED',
      kind,
      belongsTo,
      level: 0,
      evidence: [],
      turn,
      x: p.x,
      y: p.y,
      pinned: false,
      ...conceptDefaults(),
    });
    createdIds.push(id);

    relationships.push({
      id: newId('r'),
      from: pc.attachTo,
      to: id,
      label: (pc.relationLabel || 'relates to').trim(),
      origin: 'INFERRED',
      status: 'PROPOSED',
      turn,
      merges: [],
    });
  });

  for (const id of createdIds) {
    const c = concepts.find((x) => x.id === id)!;
    c.level = computeLevel(concepts, id);
  }

  // Wiring between concepts that already both exist — no new nodes, so no
  // placement and no room for the concept cap. A tighter cap of its own:
  // "fewer, better" applies double to something that reads as a claim about
  // how two established parts of the map relate.
  const relCandidates = patch.relationships.filter((pr) => {
    if (!pr.label.trim() || pr.from === pr.to) return false;
    const from = concepts.find((c) => c.id === pr.from && visible(c));
    const to = concepts.find((c) => c.id === pr.to && visible(c));
    if (!from || !to) {
      blocked.unattached++;
      return false;
    }
    if (relationships.some((r) => sameRelationship(r, pr.from, pr.to, pr.label) && visible(r))) {
      blocked.duplicates++;
      return false;
    }
    return true;
  });

  const relCap = Math.min(cap, 3);
  const { keep: relKeep, overflow: relOverflow } = capProposals(relCandidates, relCap);
  blocked.capped += relOverflow.length;

  const seenPairs = new Set<string>();
  for (const pr of relKeep) {
    const pairKey = `${pr.from}|${pr.to}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    relationships.push({
      id: newId('r'),
      from: pr.from,
      to: pr.to,
      label: pr.label.trim(),
      origin: 'INFERRED',
      status: 'PROPOSED',
      turn,
      merges: [],
    });
  }

  // Overflow is never lost. It becomes a question instead of a node.
  const overflowQuestions: QuestionIn[] = overflow.map((pc) => ({
    text: `${pc.label}${pc.label.trim().endsWith('?') ? '' : '?'} ${pc.why}`.trim(),
    usefulness: 3,
    why: '',
  }));

  let incoming: QuestionIn[] = [...(patch.questions as QuestionIn[]), ...overflowQuestions];
  if (opts.questionCap !== undefined) {
    // Most useful first, then whatever the per-turn budget still allows.
    const listed = [...(patch.questions as QuestionIn[])].sort((a, b) => (b.usefulness || 0) - (a.usefulness || 0));
    const all = [...listed, ...overflowQuestions];
    incoming = all.slice(0, Math.max(0, questionBudget));
    blocked.capped += all.length - incoming.length;
  }

  const questions = mergeQuestions(model.questions, incoming, turn);

  const next: Model = {
    ...model,
    concepts,
    relationships,
    questions,
    log: [...model.log, { turn, at, kind: 'propose', payload: patch, blocked }],
  };

  return { model: next, blocked };
}

function mergeQuestions(current: Question[], incoming: QuestionIn[], turn: number): Question[] {
  const out = current.map((q) => ({ ...q }));
  // Every question ever asked, open or not. A dismissed question asked again
  // in the same words is therefore never re-added.
  const seen = new Set(out.map((q) => norm(q.text)));

  for (const q of incoming) {
    const n = norm(q.text);
    if (!q.text.trim() || seen.has(n)) continue;
    seen.add(n);
    out.push({
      id: newId('q'),
      text: q.text.trim(),
      why: (q.why ?? '').trim(),
      usefulness: Math.max(1, Math.min(5, Math.round(q.usefulness || 3))),
      status: 'OPEN',
      turn,
      dismissedAt: '',
    });
  }

  // Keep the open list short enough that the count stays meaningful.
  const open = out.filter((q) => q.status === 'OPEN').sort((a, b) => b.usefulness - a.usefulness);
  const keep = new Set(open.slice(0, MAX_OPEN_QUESTIONS).map((q) => q.id));
  return out.map((q) => (q.status === 'OPEN' && !keep.has(q.id) ? { ...q, status: 'DONE' as const } : q));
}

// ------------------------------------------------------------------ user actions

export function confirmConcept(model: Model, conceptId: string): Model {
  const concepts = model.concepts.map((c) =>
    c.id === conceptId ? { ...c, status: 'VALIDATED' as const } : c
  );

  // An edge that was proposed alongside the node is confirmed with it, but
  // only when the thing at the other end is already established.
  const relationships = model.relationships.map((r) => {
    if (r.status !== 'PROPOSED') return r;
    if (r.from !== conceptId && r.to !== conceptId) return r;
    const otherId = r.from === conceptId ? r.to : r.from;
    const other = concepts.find((c) => c.id === otherId);
    return other?.status === 'VALIDATED' ? { ...r, status: 'VALIDATED' as const } : r;
  });

  return {
    ...model,
    concepts,
    relationships,
    log: [
      ...model.log,
      { turn: model.turn, at: new Date().toISOString(), kind: 'confirm' as const, payload: { conceptId } },
    ],
  };
}

export function rejectConcept(model: Model, conceptId: string): Model {
  const target = model.concepts.find((c) => c.id === conceptId);
  if (!target) return model;

  // Children re-parent to the rejected node's own parent rather than being
  // orphaned or dragged down with it.
  const newParent = target.belongsTo || '';
  let concepts = model.concepts.map((c) => (c.id === conceptId ? { ...c, status: 'REJECTED' as const } : c));
  const childIds = concepts.filter((c) => c.belongsTo === conceptId).map((c) => c.id);
  if (childIds.length) {
    concepts = concepts.map((c) => (c.belongsTo === conceptId ? { ...c, belongsTo: newParent } : c));
    for (const id of childIds) {
      concepts = concepts.map((c) => (c.id === id ? { ...c, level: computeLevel(concepts, id) } : c));
    }
  }

  return {
    ...model,
    concepts,
    relationships: model.relationships.map((r) =>
      r.from === conceptId || r.to === conceptId ? { ...r, status: 'REJECTED' as const } : r
    ),
    rejected: [
      ...model.rejected.filter((r) => r.label !== norm(target.label)),
      { label: norm(target.label), why: target.note, turn: model.turn },
    ],
    log: [
      ...model.log,
      {
        turn: model.turn,
        at: new Date().toISOString(),
        kind: 'reject' as const,
        payload: { conceptId, label: target.label },
      },
    ],
  };
}

/**
 * A relationship can be proposed on its own now (cross-cluster wiring, see
 * applyPropose), with no concept attached to confirm or reject it through.
 * It needs the same yes/no as a proposed concept, just addressed directly.
 */
export function confirmRelationship(model: Model, relationshipId: string): Model {
  return {
    ...model,
    relationships: model.relationships.map((r) =>
      r.id === relationshipId ? { ...r, status: 'VALIDATED' as const } : r
    ),
  };
}

export function rejectRelationship(model: Model, relationshipId: string): Model {
  return {
    ...model,
    relationships: model.relationships.map((r) =>
      r.id === relationshipId ? { ...r, status: 'REJECTED' as const } : r
    ),
  };
}

/**
 * Explicit, user-triggered restructuring. Unlike place.ts, this touches every
 * visible node at once and is the only thing in the app allowed to do so.
 * Repositioning is itself a decision, so nodes come out unpinned.
 */
export function applyAutoLayout(model: Model, sizes: Record<string, NodeSize> = {}): Model {
  const concepts = visibleConcepts(model);
  const relationships = visibleRelationships(model);
  const points = new Map(layoutLeftToRight(concepts, relationships, sizes).map((p) => [p.id, p]));

  return {
    ...model,
    concepts: model.concepts.map((c) => {
      const p = points.get(c.id);
      return p ? { ...c, x: p.x, y: p.y, pinned: false } : c;
    }),
  };
}

export function moveConcept(model: Model, conceptId: string, x: number, y: number): Model {
  return {
    ...model,
    concepts: model.concepts.map((c) =>
      c.id === conceptId ? { ...c, x: Math.round(x), y: Math.round(y), pinned: true } : c
    ),
  };
}

export function dismissQuestion(model: Model, questionId: string, at = new Date().toISOString()): Model {
  return {
    ...model,
    questions: model.questions.map((q) =>
      q.id === questionId ? { ...q, status: 'DONE' as const, dismissedAt: at } : q
    ),
  };
}

/**
 * The session goal. Asked before the first statement and editable later.
 * While the title is still the default, the goal becomes the title, so files
 * are named after what the session was for.
 */
export function setGoal(model: Model, text: string): Model {
  const goal = text.trim();
  if (goal === model.goal) return model;
  const title = model.title === 'Untitled session' && goal ? goal.slice(0, 60) : model.title;
  return {
    ...model,
    goal,
    title,
    log: [...model.log, { turn: model.turn, at: new Date().toISOString(), kind: 'goal' as const, payload: { goal } }],
  };
}

/**
 * Stamp the newest log entry of a kind with the call that produced it. The
 * reducer cannot know the model name or the token count, so the store adds
 * them once the response is in.
 */
export function withCallMeta(model: Model, kind: LogEntry['kind'], meta: CallMeta): Model {
  for (let i = model.log.length - 1; i >= 0; i--) {
    if (model.log[i].kind === kind) {
      const log = model.log.slice();
      log[i] = { ...log[i], meta };
      return { ...model, log };
    }
  }
  return model;
}

// ------------------------------------------------------------------ selectors

export const visibleConcepts = (m: Model) => m.concepts.filter(visible);
export const visibleRelationships = (m: Model) => {
  const ok = new Set(visibleConcepts(m).map((c) => c.id));
  return m.relationships.filter((r) => visible(r) && ok.has(r.from) && ok.has(r.to));
};
export const openQuestions = (m: Model) =>
  m.questions.filter((q) => q.status === 'OPEN').sort((a, b) => b.usefulness - a.usefulness);

/** How much of the conversation a proposal call carries, in characters. */
export const CONVERSATION_CHAR_LIMIT = 40000;

/**
 * Every statement, oldest first, as "T3: text". When the whole conversation
 * is over the limit, the newest statements go in full and the oldest are cut.
 */
export function conversationWindow(m: Model, limit = CONVERSATION_CHAR_LIMIT): { lines: string[]; omitted: number } {
  const lines: string[] = [];
  let used = 0;
  for (let i = m.statements.length - 1; i >= 0; i--) {
    const s = m.statements[i];
    const line = `T${s.turn}: ${s.text}`;
    if (used + line.length > limit && lines.length > 0) break;
    lines.push(line);
    used += line.length;
  }
  lines.reverse();
  return { lines, omitted: m.statements.length - lines.length };
}

/**
 * Topics the user has closed: questions they dismissed, and question boxes
 * they rejected. The AI is told never to ask these again.
 */
export function closedQuestions(m: Model): string[] {
  const dismissed = m.questions.filter((q) => q.dismissedAt).map((q) => q.text);
  const rejected = m.concepts.filter((c) => c.kind === 'QUESTION' && c.status === 'REJECTED').map((c) => c.label);
  return [...dismissed, ...rejected];
}

/** The compact projection sent to the LLM. Never the whole model. */
export function contextPayload(m: Model) {
  const conversation = conversationWindow(m);
  return {
    goal: m.goal,
    conversation: conversation.lines,
    omittedStatements: conversation.omitted,
    // Filled in when questions can be answered (Release 2). Empty until then.
    answeredQuestions: [] as { text: string; answer: string }[],
    closedQuestions: closedQuestions(m),
    title: m.title,
    concepts: visibleConcepts(m).map((c) => ({
      id: c.id,
      label: c.label,
      note: c.note,
      status: c.status,
      kind: c.kind,
    })),
    relationships: visibleRelationships(m).map((r) => ({
      from: r.from,
      to: r.to,
      label: r.label,
      status: r.status,
    })),
    rejected: m.rejected.map((r) => ({ label: r.label, why: r.why })),
    openQuestions: openQuestions(m).map((q) => q.text),
    recentStatements: m.statements.slice(-3).map((s) => s.text),
  };
}
