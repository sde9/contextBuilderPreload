import type { Concept, Model } from './types';

/*
 * The prompt asks. These enforce.
 *
 * Three failure modes are the ones most likely to embarrass you in front of a
 * stakeholder: duplicate nodes piling up, a rejected item reappearing, and the
 * map flooding after one sentence. None of them are acceptable as "the model
 * usually gets it right".
 */

const STOPWORDS = /\b(the|a|an|of|for|to|and|our|my|your|their|its)\b/g;

export function norm(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(STOPWORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(\w)s$/, '$1'); // crude singularise: "members" -> "member"
}

/** Guard 1. Existing visible concept with the same normalised label. */
export function findDuplicate(model: Model, label: string): Concept | undefined {
  const n = norm(label);
  if (!n) return undefined;
  return model.concepts.find((c) => c.status !== 'REJECTED' && norm(c.label) === n);
}

/**
 * Guard 2. Rejection ledger.
 *
 * This blocks INFERENCE, not speech. If the user rejects "Customer" and then
 * says "the customer pays monthly", the concept should come back green, and
 * the ledger entry is cleared. Rejecting is meant to be a cheap, safe action,
 * not a permanent ban on a word.
 */
export function isRejected(model: Model, label: string): boolean {
  const n = norm(label);
  return model.rejected.some((r) => r.label === n);
}

export function clearRejection(model: Model, label: string): Model['rejected'] {
  const n = norm(label);
  return model.rejected.filter((r) => r.label !== n);
}

/** Guard 3. Per-turn proposal cap. Overflow is not dropped, it becomes questions. */
export function capProposals<T>(items: T[], cap: number): { keep: T[]; overflow: T[] } {
  if (items.length <= cap) return { keep: items, overflow: [] };
  return { keep: items.slice(0, cap), overflow: items.slice(cap) };
}

/**
 * Guard 4. belongsTo must stay a forest, never a cycle.
 *
 * Ownership is single-parent, so a cycle can only form when the proposed
 * parent is already a descendant of the child (or is the child itself).
 * Walk up from the candidate parent; hitting the child anywhere on that walk
 * means linking them would close a loop.
 */
export function wouldCreateCycle(concepts: Concept[], childId: string, newParentId: string): boolean {
  if (childId === newParentId) return true;
  const byId = new Map(concepts.map((c) => [c.id, c]));
  const seen = new Set<string>();
  let cur: string | undefined = newParentId;
  while (cur) {
    if (cur === childId) return true;
    if (seen.has(cur)) return false; // already-corrupt chain elsewhere; not this link's problem
    seen.add(cur);
    cur = byId.get(cur)?.belongsTo || undefined;
  }
  return false;
}
