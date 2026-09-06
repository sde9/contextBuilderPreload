import type { Blocked, Concept, Model, Source } from './types';
import { ROLE_LABEL, addBlocks, newId, noBlocks } from './types';
import { applyExtract, applyPropose, contextPayload, visibleConcepts, visibleRelationships } from './reducer';
import { applyMerge, combineSourceModels, enforceCitations, shortlistPairs, sourcesOf } from './merge';
import { applyClusters, assignTiers, crossingRatio, worstCrossings } from './cluster';
import {
  CLUSTER_JSON_SCHEMA,
  ClusterPatch,
  EXTRACT_JSON_SCHEMA,
  ExtractPatch,
  MERGE_JSON_SCHEMA,
  MergePatch,
  PROPOSE_JSON_SCHEMA,
  ProposePatch,
} from './schema';
import {
  CLUSTER_SYSTEM,
  EXTRACT_SYSTEM,
  MERGE_SYSTEM,
  PROPOSE_SYSTEM,
  clusterUser,
  extractDocumentUser,
  mergeUser,
  proposeUser,
} from './prompts';
import { structured } from './llm';
import { loadDocs, saveDocs } from './runStore';

/*
 * The stages, server side. One call to `step` does one unit of work and
 * returns, which is what keeps the progress screen honest (R4, R11): the
 * client is not waiting on a black box, it is watching a queue drain.
 *
 * Nothing here decides anything about the map. Every state change goes
 * through the pure reducers in reducer.ts, merge.ts and cluster.ts, which is
 * why the offline smoke script can prove them without a key (R13).
 */

const MAX_CHUNKS_PER_SOURCE = 40;
const CHUNK_CONCURRENCY = 4;
const MERGE_PAIR_LIMIT = 120;
const CLUSTER_ATTEMPTS = 2;
const GOOD_CROSSING = 0.35;

const extractModel = () => process.env.EXTRACT_MODEL || 'claude-haiku-4-5-20251001';
const proposeModel = () => process.env.PROPOSE_MODEL || 'claude-sonnet-5';
const mergeModel = () => process.env.MERGE_MODEL || process.env.PROPOSE_MODEL || 'claude-sonnet-5';
const clusterModel = () => process.env.CLUSTER_MODEL || process.env.PROPOSE_MODEL || 'claude-sonnet-5';

export type StepResult = { model: Model; note: string; blocked: Blocked };

function stamp(model: Model, patch: Partial<NonNullable<Model['run']>>): Model {
  const run = model.run ?? {
    id: model.sessionId,
    stage: 'IDLE' as const,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    currentSourceId: '',
    failedStage: '',
    failedWhy: '',
  };
  return { ...model, run: { ...run, ...patch } };
}

async function pooled<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ------------------------------------------------------------------ stage 1

/**
 * Read one document into its own map.
 *
 * Chunks are sent in parallel against the same starting concept list rather
 * than one after another. That means two chunks can both report "Deposit",
 * and the duplicate guard in the reducer collapses them, which is precisely
 * the job that guard already does inside one spoken turn. Sequential calls
 * would be slightly better at matching and about six times slower.
 */
async function readSource(model: Model, source: Source): Promise<{ doc: Model; blocked: Blocked; failed: number }> {
  const chunks = model.chunks.filter((c) => c.sourceId === source.id).slice(0, MAX_CHUNKS_PER_SOURCE);

  let doc: Model = {
    ...model,
    sources: [source],
    chunks,
    statements: [],
    excerpts: [],
    concepts: [],
    relationships: [],
    questions: [],
    clusters: [],
    log: [],
    turn: 0,
  };

  const patches = await pooled(chunks, CHUNK_CONCURRENCY, async (chunk) => {
    try {
      const { value } = await structured(
        {
          model: extractModel(),
          system: EXTRACT_SYSTEM,
          user: extractDocumentUser({
            sourceName: source.name,
            role: ROLE_LABEL[source.role],
            locator: chunk.locator,
            text: chunk.text,
            concepts: [],
          }),
          schemaName: 'extract_patch',
          jsonSchema: EXTRACT_JSON_SCHEMA,
          temperature: 0,
          maxTokens: 2000,
        },
        ExtractPatch
      );
      return { chunk, patch: value };
    } catch (e) {
      // R11. One unreadable chunk must not lose the other thirty-nine.
      console.error('[preload:read]', source.name, chunk.locator, (e as Error).message);
      return { chunk, patch: null };
    }
  });

  let blocked = noBlocks();
  for (const { chunk, patch } of patches) {
    if (!patch) continue;
    const applied = applyExtract(doc, patch, chunk.text.slice(0, 1200), {
      chunkId: chunk.id,
      sourceId: source.id,
      locator: chunk.locator,
    });
    doc = applied.model;
    blocked = addBlocks(blocked, applied.blocked);
  }

  const cited = enforceCitations(doc);
  return {
    doc: cited.model,
    blocked: addBlocks(blocked, cited.blocked),
    failed: patches.filter((p) => !p.patch).length,
  };
}

// ------------------------------------------------------------------ stage 2

async function mergeAll(model: Model): Promise<{ model: Model; note: string; blocked: Blocked }> {
  const docs = await loadDocs(model.run!.id);
  const combined = combineSourceModels(docs.length ? docs : [model], model.sources);
  let working = combined.model;
  let blocked = combined.blocked;

  const pairs = shortlistPairs(working, MERGE_PAIR_LIMIT);
  if (!pairs.length) {
    return { model: working, note: 'Nothing overlapped between the documents.', blocked };
  }

  const byId = new Map(working.concepts.map((c) => [c.id, c]));
  const nameOf = new Map(model.sources.map((s) => [s.id, s.name]));
  const describe = (c: Concept) =>
    sourcesOf(working, c)
      .map((sid) => nameOf.get(sid) ?? sid)
      .join(' + ') || 'the AI';

  const { value } = await structured(
    {
      model: mergeModel(),
      system: MERGE_SYSTEM,
      user: mergeUser({
        title: working.title,
        sources: model.sources.map((s) => ({ id: s.id, name: s.name, role: ROLE_LABEL[s.role] })),
        pairs: pairs.map((p) => {
          const a = byId.get(p.aId)!;
          const b = byId.get(p.bId)!;
          return {
            aId: a.id,
            aLabel: a.label,
            aNote: a.note,
            aSource: describe(a),
            bId: b.id,
            bLabel: b.label,
            bNote: b.note,
            bSource: describe(b),
            why: p.why === 'NEAR_LABEL' ? 'similar names' : 'they connect to the same thing',
          };
        }),
      }),
      schemaName: 'merge_patch',
      jsonSchema: MERGE_JSON_SCHEMA,
      maxTokens: 4000,
    },
    MergePatch
  );

  const applied = applyMerge(working, value);
  working = applied.model;
  blocked = addBlocks(blocked, applied.blocked);

  const cited = enforceCitations(working);
  working = cited.model;
  blocked = addBlocks(blocked, cited.blocked);

  const same = value.decisions.filter((d) => d.verdict === 'SAME').length;
  const conflicts = applied.blocked.conflicts;
  return {
    model: working,
    note: `${pairs.length} pairs looked at, ${same} merged, ${conflicts} left contested.`,
    blocked,
  };
}

// ------------------------------------------------------------------ stage 3

async function structure(model: Model): Promise<{ model: Model; note: string; blocked: Blocked }> {
  const live = visibleConcepts(model);
  if (live.length < 8) {
    // Too small to need areas. One honest group beats five invented ones.
    const applied = applyClusters(model, { areas: [{ label: model.title, memberIds: live.map((c) => c.id) }] });
    return { model: applied.model, note: 'Small map, left as one area.', blocked: applied.blocked };
  }

  let best: { model: Model; ratio: number; blocked: Blocked } | null = null;
  let crossings: { from: string; to: string; label: string }[] = [];

  for (let attempt = 0; attempt < CLUSTER_ATTEMPTS; attempt++) {
    const { value } = await structured(
      {
        model: clusterModel(),
        system: CLUSTER_SYSTEM,
        user: clusterUser({
          title: model.title,
          concepts: live.map((c) => ({ id: c.id, label: c.label, kind: c.kind })),
          relationships: visibleRelationships(model).map((r) => ({ from: r.from, to: r.to, label: r.label })),
          crossings,
        }),
        schemaName: 'cluster_patch',
        jsonSchema: CLUSTER_JSON_SCHEMA,
        maxTokens: 4000,
      },
      ClusterPatch
    );

    const applied = applyClusters(model, value);
    const ratio = crossingRatio(applied.model);
    if (!best || ratio < best.ratio) best = { model: applied.model, ratio, blocked: applied.blocked };
    // Good enough is good enough. A second call costs money and rarely helps.
    if (ratio <= GOOD_CROSSING) break;
    crossings = worstCrossings(applied.model);
  }

  const chosen = best!;
  return {
    model: assignTiers(chosen.model),
    note: `${chosen.model.clusters.length} areas, ${Math.round(chosen.ratio * 100)}% of links cross between them.`,
    blocked: chosen.blocked,
  };
}

// ------------------------------------------------------------------ stage 4

async function probe(model: Model): Promise<{ model: Model; note: string; blocked: Blocked }> {
  const payload = contextPayload(model);
  if (!payload.concepts.length) return { model, note: 'Nothing to probe.', blocked: noBlocks() };

  const { value } = await structured(
    {
      model: proposeModel(),
      system: PROPOSE_SYSTEM,
      user: proposeUser({
        ...payload,
        recentStatements: model.sources.map((s) => `${s.name} (${ROLE_LABEL[s.role]})`),
      }),
      schemaName: 'propose_patch',
      jsonSchema: PROPOSE_JSON_SCHEMA,
      maxTokens: 3000,
    },
    ProposePatch
  );

  const applied = applyPropose(model, value, Number(process.env.PROPOSAL_CAP) || 8);
  return {
    model: applied.model,
    note: `${applied.model.questions.filter((q) => q.status === 'OPEN').length} questions the documents do not answer.`,
    blocked: applied.blocked,
  };
}

// ------------------------------------------------------------------ the step

/** One unit of work. Called repeatedly by the client until stage is READY. */
export async function step(model: Model): Promise<StepResult> {
  const stage = model.run?.stage ?? 'IDLE';

  try {
    if (stage === 'IDLE') {
      const readable = model.sources.filter((s) => s.parse === 'OK');
      if (!readable.length) {
        return {
          model: stamp(model, { stage: 'FAILED', failedStage: 'PARSING', failedWhy: 'No file produced any text.' }),
          note: 'Nothing to read.',
          blocked: noBlocks(),
        };
      }
      return { model: stamp(model, { stage: 'READING' }), note: 'Starting.', blocked: noBlocks() };
    }

    if (stage === 'READING') {
      const next = model.sources.find((s) => s.parse === 'OK' && s.conceptCount === 0);
      if (!next) {
        return { model: stamp(model, { stage: 'MERGING', currentSourceId: '' }), note: 'All documents read.', blocked: noBlocks() };
      }

      const { doc, blocked, failed } = await readSource(model, next);
      const found = visibleConcepts(doc).length;
      const attempted = model.chunks.filter((c) => c.sourceId === next.id).slice(0, MAX_CHUNKS_PER_SOURCE).length;

      // R11. Every call failing is a broken key or a bad model name, not a
      // quiet document. Say so and stop, rather than looping on the same file.
      if (attempted > 0 && failed === attempted) {
        return {
          model: stamp(model, {
            stage: 'FAILED',
            failedStage: 'READING',
            failedWhy: `Every request for ${next.name} failed. Check the key and the model name in .env.local, then resume.`,
          }),
          note: `${next.name}: could not be read.`,
          blocked,
        };
      }

      const docs = await loadDocs(model.run!.id);
      await saveDocs(model.run!.id, [...docs, doc]);

      // -1 means "read, found nothing", which is different from 0, "not read
      // yet". Without that difference the stage picks the same file forever.
      const withCounts: Model = {
        ...model,
        sources: model.sources.map((s) => (s.id === next.id ? { ...s, conceptCount: found > 0 ? found : -1 } : s)),
      };

      return {
        model: stamp(withCounts, { currentSourceId: next.id }),
        note: found > 0 ? `${next.name}: ${found} concepts.` : `${next.name}: nothing worth recording.`,
        blocked,
      };
    }

    if (stage === 'MERGING') {
      const out = await mergeAll(model);
      return { model: stamp(out.model, { stage: 'STRUCTURING' }), note: out.note, blocked: out.blocked };
    }

    if (stage === 'STRUCTURING') {
      const out = await structure(model);
      return { model: stamp(out.model, { stage: 'PROBING' }), note: out.note, blocked: out.blocked };
    }

    if (stage === 'PROBING') {
      const out = await probe(model);
      return {
        model: stamp(out.model, { stage: 'READY', finishedAt: new Date().toISOString() }),
        note: out.note,
        blocked: out.blocked,
      };
    }

    return { model, note: '', blocked: noBlocks() };
  } catch (e) {
    // R11. The stage that failed names itself, and everything before it stays.
    const why = (e as Error).message;
    console.error('[preload:step]', stage, why);
    return {
      model: stamp(model, { stage: 'FAILED', failedStage: stage, failedWhy: why }),
      note: `${stage} failed.`,
      blocked: noBlocks(),
    };
  }
}

/** Resume after a failure: go back to the stage that broke and try again. */
export function retry(model: Model): Model {
  const failed = model.run?.failedStage;
  const back =
    failed === 'READING' ? 'READING' : failed === 'MERGING' ? 'MERGING' : failed === 'STRUCTURING' ? 'STRUCTURING' : failed === 'PROBING' ? 'PROBING' : 'IDLE';
  return stamp(model, { stage: back as NonNullable<Model['run']>['stage'], failedStage: '', failedWhy: '' });
}

export function newRunId(): string {
  return newId('run').replace(/[^A-Za-z0-9_-]/g, '');
}
