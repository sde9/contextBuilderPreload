import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Model } from './types';

/*
 * R4. A run is a job, not a request.
 *
 * A pile of documents takes minutes to read. A browser tab does not survive
 * a closed laptop, a wifi drop or a reload, so the run lives on disk and the
 * client only ever asks it to take one more step.
 *
 * One JSON document per run, which is deliberately the same shape the browser
 * already downloads. A real database can replace this later without anything
 * above it changing.
 *
 * Chunk text is the bulky part and only stage 1 and the evidence panel need
 * it, so it lives in its own file. Opening a finished map does not load the
 * corpus.
 *
 * WHERE THE FILES GO
 *
 * Running locally, next to the project. On serverless hosting the deployment
 * directory is read-only and /tmp is the only writable path, so that is where
 * runs go there.
 *
 * That works, with one caveat worth knowing before a demo: /tmp belongs to one
 * instance and is wiped on a cold start. A run driven step after step almost
 * always stays on the same warm instance and completes, but a long pause in
 * the middle can lose it. Set PRELOAD_RUN_DIR to a mounted volume, or replace
 * the four functions below with a real store, to make that guarantee real.
 */

/** True on Vercel, and on the Lambda-style runtimes underneath it. */
function serverless(): boolean {
  return Boolean(
    process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT
  );
}

const ROOT =
  process.env.PRELOAD_RUN_DIR || (serverless() ? '/tmp/preload-runs' : join(process.cwd(), '.runs'));

/** Shown when a run cannot be found, which on serverless has a real cause. */
export const RUN_MISSING = serverless()
  ? 'That run is no longer on this server. Runs are kept on one instance\'s temporary disk, and it was recycled. Start the run again, or set PRELOAD_RUN_DIR to durable storage.'
  : 'No such run.';

async function ensure(): Promise<void> {
  try {
    await mkdir(ROOT, { recursive: true });
  } catch (e) {
    // R11. A read-only disk is a deployment problem, and saying so beats
    // "ENOENT mkdir /var/task/.runs" on a screen in front of a client.
    throw new Error(
      `Cannot write runs to ${ROOT}: ${(e as Error).message}. Set PRELOAD_RUN_DIR to a writable path.`
    );
  }
}

const modelPath = (id: string) => join(ROOT, `${id}.json`);
const chunkPath = (id: string) => join(ROOT, `${id}.chunks.json`);

/** Reject anything that could walk out of the run directory. */
function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(id)) throw new Error('Bad run id');
  return id;
}

export async function saveRun(model: Model): Promise<void> {
  await ensure();
  const id = safeId(model.run?.id ?? model.sessionId);
  // Chunk text is written once, at parse time, and never rewritten.
  const { chunks, ...light } = model;
  await writeFile(modelPath(id), JSON.stringify({ ...light, chunks: [] }, null, 2), 'utf8');
  if (chunks.length) {
    const existing = await loadChunks(id).catch(() => []);
    if (existing.length !== chunks.length) {
      await writeFile(chunkPath(id), JSON.stringify(chunks), 'utf8');
    }
  }
}

export async function loadChunks(id: string): Promise<Model['chunks']> {
  try {
    return JSON.parse(await readFile(chunkPath(safeId(id)), 'utf8')) as Model['chunks'];
  } catch {
    return [];
  }
}

/** The model without chunk text. Everything the map needs, and nothing more. */
export async function loadRun(id: string): Promise<Model | null> {
  try {
    return JSON.parse(await readFile(modelPath(safeId(id)), 'utf8')) as Model;
  } catch {
    return null;
  }
}

/** The model with chunk text, for the stages that read documents. */
export async function loadRunFull(id: string): Promise<Model | null> {
  const model = await loadRun(id);
  if (!model) return null;
  return { ...model, chunks: await loadChunks(id) };
}

export type RunSummary = { id: string; title: string; stage: string; startedAt: string; sources: number };

export async function listRuns(): Promise<RunSummary[]> {
  await ensure();
  const files = (await readdir(ROOT)).filter((f) => f.endsWith('.json') && !f.endsWith('.chunks.json'));
  const out: RunSummary[] = [];
  for (const f of files) {
    const model = await loadRun(f.replace(/\.json$/, ''));
    if (!model?.run) continue;
    out.push({
      id: model.run.id,
      title: model.title,
      stage: model.run.stage,
      startedAt: model.run.startedAt,
      sources: model.sources.length,
    });
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/*
 * Stage 1 produces one map per document, and stage 2 needs all of them side
 * by side. They are kept next to the run rather than inside it, because they
 * are working material: once the merge has run, the combined map is the
 * answer and these are only useful for showing what each file contributed.
 */

const docsPath = (id: string) => join(ROOT, `${id}.docs.json`);

export async function loadDocs(id: string): Promise<Model[]> {
  try {
    return JSON.parse(await readFile(docsPath(safeId(id)), 'utf8')) as Model[];
  } catch {
    return [];
  }
}

export async function saveDocs(id: string, docs: Model[]): Promise<void> {
  await ensure();
  await writeFile(docsPath(safeId(id)), JSON.stringify(docs), 'utf8');
}
