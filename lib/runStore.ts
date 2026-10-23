import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Chunk, Model } from './types';

/*
 * R4. A run is a job, not a request.
 *
 * A pile of documents takes minutes to read, and every stage is its own HTTP
 * request. So the run cannot live in the memory or on the disk of whatever
 * server answered the last request: on Vercel each route is a separate
 * function with its own temporary disk, and the step that reads the documents
 * never saw the run the upload created. That is why Preload failed there.
 *
 * Every request now reads the run from shared storage and writes it back.
 *
 * WHERE RUNS GO
 *
 *   PRELOAD_RUN_DIR set          that folder on disk (a mounted volume, or
 *                                a fixed path when self-hosting)
 *   BLOB_READ_WRITE_TOKEN set    the project's private Vercel Blob store.
 *                                Connecting a store in Vercel sets this.
 *   neither, running locally     .runs/ next to the project
 *   neither, on serverless       refuse, with a message that says what to
 *                                connect. A temporary disk would look as if
 *                                it works and then lose the run.
 *
 * LAYOUT, the same keys on disk and in Blob
 *
 *   runs/<id>/run.json               the model without chunk text
 *   runs/<id>/chunks/<sourceId>.json one file's sections, written once
 *   runs/<id>/docs/<sourceId>.json   one file's own map from stage 1
 *
 * One object per file, never one growing array, so a step only writes what it
 * produced and two files never overwrite each other's work.
 */

// ------------------------------------------------------------------ drivers

export interface RunStorage {
  readonly kind: 'blob' | 'disk' | 'memory';
  /** Parsed JSON, or null when there is nothing at that key. */
  readJson<T>(key: string): Promise<T | null>;
  writeJson(key: string, value: unknown): Promise<void>;
  /** Every key under the prefix. */
  list(prefix: string): Promise<string[]>;
}

function diskStorage(root: string): RunStorage {
  const path = (key: string) => join(root, ...key.split('/'));

  async function walk(dir: string, base: string): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const name of names) {
      const full = join(dir, name);
      const key = base ? `${base}/${name}` : name;
      if ((await stat(full)).isDirectory()) out.push(...(await walk(full, key)));
      else out.push(key);
    }
    return out;
  }

  return {
    kind: 'disk',
    async readJson<T>(key: string) {
      try {
        return JSON.parse(await readFile(path(key), 'utf8')) as T;
      } catch {
        return null;
      }
    },
    async writeJson(key, value) {
      const file = path(key);
      try {
        await mkdir(dirname(file), { recursive: true });
      } catch (e) {
        // R11. A read-only disk is a deployment problem, and saying so beats
        // a raw errno on a screen in front of a client.
        throw new Error(`Cannot write runs to ${root}: ${(e as Error).message}. Set PRELOAD_RUN_DIR to a writable path.`);
      }
      await writeFile(file, JSON.stringify(value), 'utf8');
    },
    async list(prefix) {
      const top = prefix.replace(/\/$/, '');
      return (await walk(path(top), top)).sort();
    },
  };
}

/*
 * Private blobs, read past the CDN cache. A step reads the run another
 * function wrote a moment ago, so a cached copy up to a minute old would undo
 * work. useCache: false costs a slower read and buys read-after-write.
 *
 * The SDK is imported on first use, so local runs and the smoke tests never
 * load it.
 */
function blobStorage(): RunStorage {
  const sdk = () => import('@vercel/blob');

  return {
    kind: 'blob',
    async readJson<T>(key: string) {
      const { get } = await sdk();
      const res = await get(key, { access: 'private', useCache: false });
      if (!res || res.statusCode !== 200) return null;
      return JSON.parse(await new Response(res.stream).text()) as T;
    },
    async writeJson(key, value) {
      const { put } = await sdk();
      await put(key, JSON.stringify(value), {
        access: 'private',
        allowOverwrite: true,
        addRandomSuffix: false,
        contentType: 'application/json',
      });
    },
    async list(prefix) {
      const { list } = await sdk();
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await list({ prefix, cursor, limit: 1000 });
        keys.push(...page.blobs.map((b) => b.pathname));
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return keys.sort();
    },
  };
}

/** An in-memory store with the same contract, for the offline tests. */
export function memoryStorage(): RunStorage {
  const data = new Map<string, string>();
  return {
    kind: 'memory',
    async readJson<T>(key: string) {
      const raw = data.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    async writeJson(key, value) {
      data.set(key, JSON.stringify(value));
    },
    async list(prefix) {
      return [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
  };
}

/** True on Vercel, and on the Lambda-style runtimes underneath it. */
function serverless(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);
}

export const STORAGE_MISSING =
  'Preload has nowhere to keep runs on this deployment. In Vercel, open the project, go to Storage, create a private Blob store and connect it to this environment, then redeploy.';

let storage: RunStorage | null = null;

function pickStorage(): RunStorage {
  if (process.env.PRELOAD_RUN_DIR) return diskStorage(process.env.PRELOAD_RUN_DIR);
  if (process.env.BLOB_READ_WRITE_TOKEN) return blobStorage();
  if (serverless()) throw new Error(STORAGE_MISSING);
  return diskStorage(join(process.cwd(), '.runs'));
}

function store(): RunStorage {
  if (!storage) storage = pickStorage();
  return storage;
}

/** Tests swap in memoryStorage(). Passing null goes back to the default. */
export function useStorage(next: RunStorage | null): void {
  storage = next;
}

/** Which driver is answering. Shown by the health check. */
export function storageKind(): RunStorage['kind'] {
  return store().kind;
}

// ------------------------------------------------------------------ keys

/** Reject anything that could walk out of the run's folder. */
function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(id)) throw new Error('Bad run id');
  return id;
}

const runKey = (id: string) => `runs/${safeId(id)}/run.json`;
const chunkKey = (id: string, sourceId: string) => `runs/${safeId(id)}/chunks/${safeId(sourceId)}.json`;
const docKey = (id: string, sourceId: string) => `runs/${safeId(id)}/docs/${safeId(sourceId)}.json`;

export const RUN_MISSING = 'No such run. It may have been started on another deployment, or deleted.';

// ------------------------------------------------------------------ runs

/**
 * The model, without chunk text. Chunks are written once per file by
 * saveChunks and never travel with the model again.
 */
export async function saveRun(model: Model): Promise<void> {
  const id = model.run?.id ?? model.sessionId;
  await store().writeJson(runKey(id), { ...model, chunks: [] });
}

/** The model without chunk text. Everything the map needs, and nothing more. */
export async function loadRun(id: string): Promise<Model | null> {
  return store().readJson<Model>(runKey(id));
}

export async function saveChunks(id: string, sourceId: string, chunks: Chunk[]): Promise<void> {
  await store().writeJson(chunkKey(id, sourceId), chunks);
}

/** Every readable file's sections, in the order the files were added. */
export async function loadChunks(model: Model): Promise<Chunk[]> {
  const id = model.run?.id ?? model.sessionId;
  const readable = model.sources.filter((s) => s.parse === 'OK' && s.chunkCount > 0);
  const parts = await Promise.all(readable.map((s) => store().readJson<Chunk[]>(chunkKey(id, s.id))));
  return parts.flatMap((p) => p ?? []);
}

/** The model with chunk text, for the stages that read documents. */
export async function loadRunFull(id: string): Promise<Model | null> {
  const model = await loadRun(id);
  if (!model) return null;
  return { ...model, chunks: await loadChunks(model) };
}

export type RunSummary = { id: string; title: string; stage: string; startedAt: string; sources: number };

export async function listRuns(): Promise<RunSummary[]> {
  const keys = (await store().list('runs/')).filter((k) => k.endsWith('/run.json'));
  const models = await Promise.all(keys.map((k) => store().readJson<Model>(k)));
  return models
    .filter((m): m is Model => Boolean(m?.run))
    .map((m) => ({
      id: m.run!.id,
      title: m.title,
      stage: m.run!.stage,
      startedAt: m.run!.startedAt,
      sources: m.sources.length,
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

// ------------------------------------------------------------------ health

const PROBE_KEY = 'health/probe.json';

export async function writeProbe(token: string): Promise<void> {
  await store().writeJson(PROBE_KEY, { token, at: new Date().toISOString() });
}

export async function readProbe(): Promise<string | null> {
  return (await store().readJson<{ token: string }>(PROBE_KEY))?.token ?? null;
}

// ------------------------------------------------------------------ stage 1 maps

/*
 * Stage 1 produces one map per document, and stage 2 needs all of them side
 * by side. They are kept next to the run rather than inside it, because they
 * are working material: once the merge has run, the combined map is the
 * answer and these only show what each file contributed.
 */

export async function saveDoc(id: string, doc: Model): Promise<void> {
  const sourceId = doc.sources[0]?.id;
  if (!sourceId) throw new Error('A per-file map must carry its source.');
  await store().writeJson(docKey(id, sourceId), doc);
}

/** The per-file maps, in the order of sourceIds. Files not read yet are skipped. */
export async function loadDocs(id: string, sourceIds: string[]): Promise<Model[]> {
  const docs = await Promise.all(sourceIds.map((sid) => store().readJson<Model>(docKey(id, sid))));
  return docs.filter((d): d is Model => Boolean(d));
}
