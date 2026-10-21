// Core meta-model. Flexible ontology, fixed structure.
// The conversation decides WHAT exists. This file decides HOW it is stored.
//
// Preload additions live at the bottom, under "PRELOAD". Everything above the
// divider is unchanged from the real-time prototype except for four new fields
// on Concept, one new Status, and three new counters on Blocked.

export type Origin = 'EXPLICIT' | 'INFERRED' | 'USER';

/**
 * CONTESTED is new. Two or more sources say something incompatible about the
 * same concept, and the reducer will never pick a winner (R8). It is visible
 * on the canvas, like VALIDATED and PROPOSED, and unlike REJECTED.
 */
export type Status = 'VALIDATED' | 'PROPOSED' | 'REJECTED' | 'CONTESTED';

/**
 * Kind classifies the role a piece of information plays in an explanation,
 * not what it is in the world. SERVICE, CUSTOMER, INVOICE would be a business
 * taxonomy: it would fit a rental company and break on a recipe. Things,
 * properties, people, steps, rules, questions and problems exist in every
 * subject. The domain meaning stays in the free-text label, which no schema
 * constrains.
 */
export type Kind =
  | 'ENTITY' // a thing that stands on its own: Costume Rental, Unison Choir
  | 'ATTRIBUTE' // a property of something else: home delivery, $160 per term
  | 'ACTOR' // a person, role or organisation: Client, Support Team
  | 'STEP' // one step in a sequence
  | 'RULE' // a constraint, policy or condition
  | 'QUESTION' // an open question: "Who are the clients?"
  | 'PROBLEM'; // a pain point: "Dresses are expensive to rent"

export const KINDS: Kind[] = ['ENTITY', 'ATTRIBUTE', 'ACTOR', 'STEP', 'RULE', 'QUESTION', 'PROBLEM'];

/** Pre-Kind saves carried viewHint. Tolerant mapping so old .context.json files still load. */
const LEGACY_KIND_MAP: Record<string, Kind> = {
  STRUCTURE: 'ENTITY',
  FLOW: 'STEP',
  ACTOR: 'ACTOR',
  RULE: 'RULE',
};

/**
 * Tolerant read for a concept coming from a file rather than the reducer.
 * `kind` wins if present and valid; else `viewHint` is mapped; else ENTITY.
 */
export function resolveKind(raw: { kind?: unknown; viewHint?: unknown }): Kind {
  if (typeof raw.kind === 'string' && (KINDS as string[]).includes(raw.kind)) return raw.kind as Kind;
  if (typeof raw.viewHint === 'string' && LEGACY_KIND_MAP[raw.viewHint]) return LEGACY_KIND_MAP[raw.viewHint];
  return 'ENTITY';
}

/** Something the speaker said out loud. The written sibling is Excerpt, below. */
export type Statement = {
  id: string;
  text: string;
  at: string;
  turn: number;
};

export type Concept = {
  id: string;
  label: string;
  /** Description when EXPLICIT. Reason for the guess when INFERRED. */
  note: string;
  origin: Origin;
  status: Status;
  kind: Kind;
  /** Id of the concept this is a property or part of. "" when it stands alone. */
  belongsTo: string;
  /** Derived, never sent by the LLM. 0 = stands alone, +1 per step of ownership. */
  level: number;
  /**
   * Statement ids AND excerpt ids this concept came from. One list on purpose:
   * every function that already walks it keeps working (R2, R10).
   */
  evidence: string[];
  turn: number;
  x: number;
  y: number;
  /** True once the user has dragged it. Placement never touches pinned nodes. */
  pinned: boolean;

  // ---- preload ----------------------------------------------------------
  /** R3. Detail level inside a cluster. 2 = main, 3 = detail. */
  tier: 2 | 3;
  /** R6. Which area this belongs to. "" until the cluster pass runs. */
  clusterId: string;
  /** R1. Ids this node absorbed during a merge, newest last. Split pops them. */
  mergedFrom: string[];
  /** Set when this node WAS absorbed. Points at the survivor. "" normally. */
  absorbedInto: string;
  /** R8. Present only on a CONTESTED node. */
  contest: Contest | null;
};

/** One side of a disagreement between documents. */
export type Reading = {
  /** Excerpt id, so the quote and its locator are one lookup away. */
  evidenceId: string;
  sourceId: string;
  /** The label that side of the argument wanted. */
  label: string;
  /** One line on what this source claims. */
  summary: string;
};

export type Contest = {
  /** Strongest source role first. Order is presentation, never authority. */
  readings: Reading[];
  why: string;
  resolved: 'NONE' | 'KEPT_FIRST' | 'KEPT_SECOND' | 'SPLIT';
};

export type Relationship = {
  id: string;
  from: string;
  to: string;
  label: string;
  origin: Origin;
  status: Status;
  turn: number;
  /**
   * One entry per merge that repointed an end of this edge, oldest first. An
   * edge can be repointed more than once, so this is a list rather than a
   * single record. Keeping it is what makes a merge reversible (R1) without
   * a second copy of the graph.
   */
  merges: MergeTrace[];
};

export type MergeTrace = { absorbedId: string; end: 'from' | 'to'; prevStatus: Status };

export type Question = {
  id: string;
  text: string;
  /** One short line on why this matters for the session goal. "" when the AI gave none. */
  why: string;
  usefulness: number;
  status: 'OPEN' | 'DONE';
  turn: number;
  /**
   * Set when the user dismissed it. DONE alone is ambiguous: the open-list cap
   * also retires questions to DONE. Only a dismissed question is a closed topic.
   */
  dismissedAt: string;
};

/**
 * How often each guard fired. If these numbers stay high the prompt is
 * failing, and that is worth knowing. The user should never see the effect.
 */
export type Blocked = {
  duplicates: number;
  rejected: number;
  capped: number;
  unattached: number;
  cycles: number;
  /** R7. A merge decision naming an unknown id, or a label from neither input. */
  invented: number;
  /** R2. A green concept that arrived with no evidence. Refused. */
  uncited: number;
  /** Contested nodes created. Not a failure, but the number to watch. */
  conflicts: number;
};

export const noBlocks = (): Blocked => ({
  duplicates: 0,
  rejected: 0,
  capped: 0,
  unattached: 0,
  cycles: 0,
  invented: 0,
  uncited: 0,
  conflicts: 0,
});

export function addBlocks(a: Blocked, b: Blocked): Blocked {
  return {
    duplicates: a.duplicates + b.duplicates,
    rejected: a.rejected + b.rejected,
    capped: a.capped + b.capped,
    unattached: a.unattached + b.unattached,
    cycles: a.cycles + b.cycles,
    invented: a.invented + b.invented,
    uncited: a.uncited + b.uncited,
    conflicts: a.conflicts + b.conflicts,
  };
}

export type LogEntry = {
  turn: number;
  at: string;
  kind: 'extract' | 'propose' | 'confirm' | 'reject' | 'merge' | 'split' | 'cluster' | 'resolve' | 'edit' | 'goal';
  payload: unknown;
  /** Guard activity, so prompt failures are measurable rather than invisible. */
  blocked?: Blocked;
  /** Which model answered, how long it took and what it cost. Real-time calls only. */
  meta?: CallMeta;
};

export type Usage = { input: number; output: number };

export type CallMeta = { model: string; ms: number; usage: Usage | null };

// ==========================================================================
// PRELOAD
// ==========================================================================

/**
 * R9. What kind of document this is. The system guesses from the filename and
 * the content, the user corrects it, and the merge uses it as the tiebreaker
 * for which reading gets listed first in a conflict.
 */
export type SourceRole = 'SPEC' | 'DATA' | 'REFERENCE' | 'NOTES' | 'TRANSCRIPT' | 'UNKNOWN';

export const SOURCE_ROLES: SourceRole[] = ['SPEC', 'DATA', 'REFERENCE', 'NOTES', 'TRANSCRIPT', 'UNKNOWN'];

/** Merge order, strongest first. The map grows around what was formally written. */
export const ROLE_RANK: Record<SourceRole, number> = {
  SPEC: 0,
  DATA: 1,
  REFERENCE: 2,
  NOTES: 3,
  TRANSCRIPT: 4,
  UNKNOWN: 5,
};

export const ROLE_LABEL: Record<SourceRole, string> = {
  SPEC: 'spec',
  DATA: 'data',
  REFERENCE: 'reference',
  NOTES: 'notes',
  TRANSCRIPT: 'transcript',
  UNKNOWN: 'unknown',
};

export type Source = {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  /** Dedupes the same file dropped twice. */
  hash: string;
  addedAt: string;
  role: SourceRole;
  /** R11. Nothing that fails is hidden. */
  parse: 'PENDING' | 'OK' | 'EMPTY' | 'FAILED';
  parseNote: string;
  chunkCount: number;
  /** Filled in after stage 1. */
  conceptCount: number;
};

export type Chunk = {
  id: string;
  sourceId: string;
  ordinal: number;
  text: string;
  /** "p.18" · "§ Pricing" · "00:14:22" · "¶ 3". What a citation points at. */
  locator: string;
};

/** The written sibling of Statement. Both live in evidence[]. */
export type Excerpt = {
  id: string;
  chunkId: string;
  sourceId: string;
  /** The sentence, verbatim. Never paraphrased. */
  quote: string;
  locator: string;
  turn: number;
};

/**
 * R6. An area. Drawn as a labelled container, never as a concept, because
 * nobody wrote it down and a green node has to be able to cite a sentence.
 */
export type Cluster = {
  id: string;
  label: string;
  memberIds: string[];
  origin: 'INFERRED' | 'USER';
  confirmed: boolean;
};

export type RunStage =
  | 'IDLE'
  | 'PARSING'
  | 'READING'
  | 'MERGING'
  | 'STRUCTURING'
  | 'PROBING'
  | 'READY'
  | 'FAILED';

export const RUN_STAGE_LABEL: Record<RunStage, string> = {
  IDLE: 'waiting',
  PARSING: 'reading the files',
  READING: 'finding concepts',
  MERGING: 'merging what overlaps',
  STRUCTURING: 'grouping into areas',
  PROBING: 'looking for gaps',
  READY: 'ready',
  FAILED: 'stopped',
};

export type Run = {
  id: string;
  stage: RunStage;
  startedAt: string;
  finishedAt: string;
  /** Which source is being read right now, for the progress screen. */
  currentSourceId: string;
  failedStage: string;
  failedWhy: string;
};

export type Model = {
  schemaVersion: '0.1' | '0.2';
  sessionId: string;
  title: string;
  /**
   * Real-time only. What the user wants to get out of the conversation, asked
   * before the first statement. Every proposal is judged against it. "" in
   * Preload and in files saved before the goal existed.
   */
  goal: string;
  turn: number;
  statements: Statement[];
  concepts: Concept[];
  relationships: Relationship[];
  questions: Question[];
  /** Normalised labels the user threw out. Permanent. Blocks inference, not speech. */
  rejected: { label: string; why: string; turn: number }[];
  log: LogEntry[];

  // ---- preload ----------------------------------------------------------
  sources: Source[];
  chunks: Chunk[];
  excerpts: Excerpt[];
  clusters: Cluster[];
  run: Run | null;
};

export function emptyModel(sessionId: string): Model {
  return {
    schemaVersion: '0.2',
    sessionId,
    title: 'Untitled session',
    goal: '',
    turn: 0,
    statements: [],
    concepts: [],
    relationships: [],
    questions: [],
    rejected: [],
    log: [],
    sources: [],
    chunks: [],
    excerpts: [],
    clusters: [],
    run: null,
  };
}

/** Every field a concept needs that the reducer does not set explicitly. */
export function conceptDefaults(): Pick<
  Concept,
  'tier' | 'clusterId' | 'mergedFrom' | 'absorbedInto' | 'contest'
> {
  return { tier: 2, clusterId: '', mergedFrom: [], absorbedInto: '', contest: null };
}

/**
 * Tolerant read for a whole model coming from a file. A 0.1 save has no
 * sources, no excerpts and no per-concept preload fields; it still loads.
 */
export function normaliseModel(raw: Partial<Model> & { sessionId?: string }): Model {
  const base = emptyModel(raw.sessionId || newId('s'));
  const concepts = (raw.concepts ?? []).map((c) => ({
    ...conceptDefaults(),
    ...c,
    kind: resolveKind(c as { kind?: unknown; viewHint?: unknown }),
    mergedFrom: c.mergedFrom ?? [],
    absorbedInto: c.absorbedInto ?? '',
    contest: c.contest ?? null,
    tier: (c.tier === 3 ? 3 : 2) as 2 | 3,
    clusterId: c.clusterId ?? '',
  }));
  const relationships = (raw.relationships ?? []).map((r) => ({ ...r, merges: r.merges ?? [] }));
  const questions = (raw.questions ?? []).map((q) => ({ ...q, why: q.why ?? '', dismissedAt: q.dismissedAt ?? '' }));
  return {
    ...base,
    ...raw,
    schemaVersion: '0.2',
    goal: typeof raw.goal === 'string' ? raw.goal : '',
    concepts,
    relationships,
    questions,
    sources: raw.sources ?? [],
    chunks: raw.chunks ?? [],
    excerpts: raw.excerpts ?? [],
    clusters: raw.clusters ?? [],
    run: raw.run ?? null,
    log: raw.log ?? [],
  };
}

/** Short sortable id. Good enough for a session that lives in one browser tab. */
export function newId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 7);
  return `${prefix}_${t}${r}`;
}
