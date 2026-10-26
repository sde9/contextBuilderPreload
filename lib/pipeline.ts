import type { Blocked, Chunk, Concept, Model, Source } from './types';
import { ROLE_LABEL, addBlocks, newId, noBlocks } from './types';
import { applyExtract, applyPropose, contextPayload, visibleConcepts, visibleRelationships } from './reducer';
import { applyMerge, combineSourceModels, enforceCitations, shortlistPairs, sourcesOf } from './merge';
import { applyClusters, assignTiers, crossingRatio, worstCrossings } from './cluster';
import { activeOutline, applyOutline, sectionIdsFor, structureFromOutline } from './outline';
import {
  CLUSTER_JSON_SCHEMA,
  ClusterPatch,
  EXTRACT_PL_JSON_SCHEMA,
  ExtractPatchPL,
  MERGE_JSON_SCHEMA,
  OUTLINE_JSON_SCHEMA,
  OutlinePatch,
  MergePatch,
  PROPOSE_JSON_SCHEMA,
  ProposePatch,
} from './schema';
import {
  CLUSTER_SYSTEM,
  EXTRACT_SYSTEM,
  MERGE_SYSTEM,
  OUTLINE_SYSTEM,
  PROPOSE_SYSTEM,
  clusterUser,
  extractDocumentUser,
  mergeUser,
  outlineUser,
  proposeUser,
} from './prompts';
import { structured } from './llm';
import { loadDocs, saveDoc } from './runStore';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Chunks stop at 2400 characters; this only guards a single giant paragraph. */
const QUOTE_CHARS = 4000;

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
/**
 * Pairs per merge call. One decision is about 60 output tokens, so 120 pairs
 * in one call overran the 4000-token answer and MERGING failed on every
 * document big enough to fill the shortlist (110 concepts, 27 Oct 2026).
 */
const MERGE_BATCH = 30;
const CLUSTER_ATTEMPTS = 2;
const GOOD_CROSSING = 0.35;

const extractModel = () => process.env.EXTRACT_MODEL || 'claude-haiku-4-5-20251001';
const proposeModel = () => process.env.PROPOSE_MODEL || 'claude-sonnet-5';
const mergeModel = () => process.env.MERGE_MODEL || process.env.PROPOSE_MODEL || 'claude-sonnet-5';
const outlineModel = () => process.env.OUTLINE_MODEL || process.env.PROPOSE_MODEL || 'claude-sonnet-5';

/** Below this a failed section is not worth halving: it failed for another reason. */
const SPLIT_MIN_CHARS = 500;
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
 * Split a section that failed into two halves at the paragraph break nearest
 * the middle, or at the nearest sentence end when it is one long paragraph.
 * A section usually fails because it is too long for one answer, and half of
 * it is not.
 */
export function halves(text: string): [string, string] | null {
  if (text.length < SPLIT_MIN_CHARS) return null;
  const paras = text.split(/\n\n+/);
  if (paras.length >= 2) {
    let acc = 0;
    let best = 1;
    let bestDiff = Infinity;
    for (let i = 1; i < paras.length; i++) {
      acc += paras[i - 1].length + 2;
      const diff = Math.abs(acc - text.length / 2);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    return [paras.slice(0, best).join('\n\n'), paras.slice(best).join('\n\n')];
  }
  const mid = Math.floor(text.length / 2);
  const after = text.indexOf('. ', mid);
  const before = text.lastIndexOf('. ', mid);
  const cut = after < 0 ? before : before < 0 ? after : mid - before <= after - mid ? before : after;
  if (cut <= 0) return [text.slice(0, mid), text.slice(mid)];
  return [text.slice(0, cut + 1), text.slice(cut + 2)];
}

type Piece = { chunk: Chunk; text: string; patch: ExtractPatchPL };
type ChunkRead = { pieces: Piece[]; unread: { locator: string; why: string }[] };

/**
 * Read one document into its own map, top down.
 *
 * First one outline call over the whole document: its main point, its parts
 * in reading order, and how they connect, each checked against the text.
 * Then every section is read in parallel, knowing that skeleton, so a section
 * that talks about a part attaches to it instead of starting a new island.
 * Without an outline (the call failed, or the document is a single short
 * section) the sections are read exactly as before.
 *
 * Chunks are sent in parallel against the same starting concept list rather
 * than one after another. That means two chunks can both report "Deposit",
 * and the duplicate guard in the reducer collapses them, which is precisely
 * the job that guard already does inside one spoken turn. Sequential calls
 * would be slightly better at matching and about six times slower.
 */
async function readSource(
  model: Model,
  source: Source
): Promise<{ doc: Model; blocked: Blocked; failed: number; attempted: number; unread: { locator: string; why: string }[]; parts: number; outlineNote: string }> {
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
    outlines: [],
    log: [],
    turn: 0,
  };
  let blocked = noBlocks();

  // ---- the skeleton
  let outlineNote = '';
  let parts = 0;
  if (chunks.length) {
    try {
      const short = sectionIdsFor(chunks);
      const { value } = await structured(
        {
          model: outlineModel(),
          system: OUTLINE_SYSTEM,
          user: outlineUser({
            sourceName: source.name,
            role: ROLE_LABEL[source.role],
            title: model.title,
            sections: [...short].map(([id, c]) => ({ id, locator: c.locator, text: c.text })),
          }),
          schemaName: 'outline_patch',
          jsonSchema: OUTLINE_JSON_SCHEMA,
          maxTokens: 4000,
        },
        OutlinePatch
      );
      const applied = applyOutline(doc, value, chunks, source);
      doc = applied.model;
      blocked = addBlocks(blocked, applied.blocked);
      parts = applied.outline.partIds.length;
    } catch (e) {
      // The sections are still read. A map without a skeleton is the old map,
      // not no map.
      console.error('[preload:outline]', source.name, (e as Error).message);
      outlineNote = `no outline (${(e as Error).message.slice(0, 120)})`;
    }
  }

  const outline = (doc.outlines ?? []).find((o) => o.sourceId === source.id) ?? null;
  const skeleton = doc.concepts.filter((c) => c.skeleton && c.status !== 'REJECTED');
  const known = skeleton.map((c) => ({ id: c.id, label: c.label, note: c.note, status: c.status }));
  const byId = new Map(skeleton.map((c) => [c.id, c]));

  const extract = async (chunk: Chunk, text: string): Promise<ExtractPatchPL> => {
    const partId = outline?.sections[chunk.id] ?? '';
    const part = partId ? byId.get(partId) : undefined;
    const { value } = await structured(
      {
        model: extractModel(),
        system: EXTRACT_SYSTEM,
        user: extractDocumentUser({
          sourceName: source.name,
          role: ROLE_LABEL[source.role],
          locator: chunk.locator,
          text,
          concepts: known,
          part: part ? { id: part.id, label: part.label } : null,
        }),
        schemaName: 'extract_patch',
        jsonSchema: EXTRACT_PL_JSON_SCHEMA,
        temperature: 0,
        maxTokens: 4000,
      },
      ExtractPatchPL
    );
    return value;
  };

  // ---- the sections
  const reads = await pooled(chunks, CHUNK_CONCURRENCY, async (chunk): Promise<ChunkRead> => {
    try {
      return { pieces: [{ chunk, text: chunk.text, patch: await extract(chunk, chunk.text) }], unread: [] };
    } catch (e) {
      // R11. One unreadable chunk must not lose the other thirty-nine, and a
      // long one gets a second chance in two halves before it is given up.
      console.error('[preload:read]', source.name, chunk.locator, (e as Error).message);
      const split = halves(chunk.text);
      if (!split) return { pieces: [], unread: [{ locator: chunk.locator, why: (e as Error).message }] };
      const out: ChunkRead = { pieces: [], unread: [] };
      for (const [i, text] of split.entries()) {
        try {
          out.pieces.push({ chunk, text, patch: await extract(chunk, text) });
        } catch (e2) {
          console.error('[preload:read]', source.name, chunk.locator, `half ${i + 1}`, (e2 as Error).message);
          out.unread.push({ locator: `${chunk.locator}, ${i === 0 ? 'first' : 'second'} half`, why: (e2 as Error).message });
        }
      }
      return out;
    }
  });

  for (const read of reads) {
    for (const { chunk, text, patch } of read.pieces) {
      // The whole section, not its first 1200 characters: the evidence panel
      // cuts it for display, and a concept from the second half of a section
      // used to cite text that never mentioned it.
      const applied = applyExtract(doc, patch, text.slice(0, QUOTE_CHARS), {
        chunkId: chunk.id,
        sourceId: source.id,
        locator: chunk.locator,
        ord: chunk.ordinal,
      });
      doc = applied.model;
      blocked = addBlocks(blocked, applied.blocked);
    }
  }

  const cited = enforceCitations(doc);
  return {
    doc: cited.model,
    blocked: addBlocks(blocked, cited.blocked),
    failed: reads.filter((r) => r.pieces.length === 0).length,
    attempted: chunks.length,
    unread: reads.flatMap((r) => r.unread),
    parts,
    outlineNote,
  };
}

// ------------------------------------------------------------------ stage 2

async function mergeAll(model: Model): Promise<{ model: Model; note: string; blocked: Blocked }> {
  const docs = await loadDocs(model.run!.id, model.sources.map((s) => s.id));
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

  const sourcesForPrompt = model.sources.map((s) => ({ id: s.id, name: s.name, role: ROLE_LABEL[s.role] }));
  const batches: (typeof pairs)[] = [];
  for (let i = 0; i < pairs.length; i += MERGE_BATCH) batches.push(pairs.slice(i, i + MERGE_BATCH));

  const results = await Promise.allSettled(
    batches.map((batch) =>
      structured(
        {
          model: mergeModel(),
          system: MERGE_SYSTEM,
          user: mergeUser({
            title: working.title,
            sources: sourcesForPrompt,
            pairs: batch.map((p) => {
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
          maxTokens: 6000,
        },
        MergePatch
      )
    )
  );

  // A failed batch costs only its own pairs: they stay as separate boxes, which
  // is the safe default. Only when every batch fails does the stage fail.
  const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof structured<MergePatch>>>> => r.status === 'fulfilled');
  if (!ok.length) throw (results[0] as PromiseRejectedResult).reason;
  const skippedPairs = results.reduce((n, r, i) => (r.status === 'rejected' ? n + batches[i].length : n), 0);
  const value: MergePatch = { decisions: ok.flatMap((r) => r.value.value.decisions) };

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
    note:
      `${pairs.length} pairs looked at, ${same} merged, ${conflicts} left contested.` +
      (skippedPairs ? ` ${skippedPairs} pairs not checked: the AI call for them failed, so they stay as separate boxes.` : ''),
    blocked,
  };
}

// ------------------------------------------------------------------ stage 3

async function structure(model: Model): Promise<{ model: Model; note: string; blocked: Blocked }> {
  // One document with a skeleton: its parts are the areas. The author already
  // grouped it, and no call is spent guessing a grouping after the fact.
  const outline = activeOutline(model);
  if (outline) {
    const applied = structureFromOutline(model, outline);
    return {
      model: applied.model,
      note: `${plural(outline.partIds.length, 'part')}, taken from the document's own structure.`,
      blocked: applied.blocked,
    };
  }

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
    model: joinAreas(applied.model),
    note: `${plural(applied.model.questions.filter((q) => q.status === 'OPEN').length, 'question')} the documents do not answer.`,
    blocked: applied.blocked,
  };
}

/**
 * A guess arrives after the areas are drawn. It joins the area of the box it
 * hangs off, so it shows up with that part instead of in a row of its own.
 */
export function joinAreas(model: Model): Model {
  if (!model.clusters.length) return model;
  const clusterOf = new Map(model.concepts.map((c) => [c.id, c.clusterId]));
  const additions = new Map<string, string[]>();
  const concepts = model.concepts.map((c) => {
    if (c.clusterId || c.status === 'REJECTED' || c.absorbedInto || c.skeleton === 'MAIN') return c;
    const link = model.relationships.find(
      (r) => r.status !== 'REJECTED' && (r.from === c.id || r.to === c.id) && clusterOf.get(r.from === c.id ? r.to : r.from)
    );
    const target = link ? clusterOf.get(link.from === c.id ? link.to : link.from) : '';
    if (!target) return c;
    additions.set(target, [...(additions.get(target) ?? []), c.id]);
    return { ...c, clusterId: target };
  });
  if (!additions.size) return model;
  return {
    ...model,
    concepts,
    clusters: model.clusters.map((cl) => (additions.has(cl.id) ? { ...cl, memberIds: [...cl.memberIds, ...additions.get(cl.id)!] } : cl)),
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

      const { doc, blocked, failed, attempted, unread, parts, outlineNote } = await readSource(model, next);
      const found = visibleConcepts(doc).length;

      // R11. Every call failing is a broken key or a bad model name, not a
      // quiet document. Say so and stop, rather than looping on the same file.
      if (attempted > 0 && failed === attempted) {
        return {
          model: stamp(model, {
            stage: 'FAILED',
            failedStage: 'READING',
            failedWhy: `Every request for ${next.name} failed. Check ANTHROPIC_API_KEY and EXTRACT_MODEL in the Vercel project settings (or .env.local when running locally), then resume.`,
          }),
          note: `${next.name}: could not be read.`,
          blocked,
        };
      }

      // One object per file. A retried step overwrites its own map and never
      // duplicates it, which the old single array of maps could.
      await saveDoc(model.run!.id, doc);

      // -1 means "read, found nothing", which is different from 0, "not read
      // yet". Without that difference the stage picks the same file forever.
      const withCounts: Model = {
        ...model,
        sources: model.sources.map((s) =>
          s.id === next.id ? { ...s, conceptCount: found > 0 ? found : -1, unread } : s
        ),
      };

      const said = [
        found > 0 ? plural(found, 'concept') : 'nothing worth recording',
        parts ? plural(parts, 'part') : outlineNote,
        unread.length ? `${unread.length} ${unread.length === 1 ? 'section' : 'sections'} not read (${unread.map((u) => u.locator).join('; ')})` : '',
      ].filter(Boolean);

      return {
        model: stamp(withCounts, { currentSourceId: next.id }),
        note: `${next.name}: ${said.join(', ')}.`,
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
