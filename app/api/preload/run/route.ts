import { NextResponse } from 'next/server';
import { chunkText, guessRole } from '@/lib/chunk';
import { hashOf, parseFile } from '@/lib/parse';
import { listRuns, saveRun } from '@/lib/runStore';
import { newRunId } from '@/lib/pipeline';
import { emptyModel, newId, type Chunk, type Model, type Source } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/*
 * Stage 0. Files in, sources and chunks out. No model call anywhere here.
 *
 * The user sees the result of this before anything is spent: how many chunks
 * each file produced, what the system thinks each file is, and which files
 * gave nothing (R11). Only then do they press Build.
 */

const MAX_FILES = 40;
const MAX_BYTES = 25 * 1024 * 1024;

export async function GET() {
  return NextResponse.json({ runs: await listRuns() });
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const title = String(form.get('title') || '').trim() || 'Untitled project';
    const files = form.getAll('files').filter((f): f is File => f instanceof File);

    if (!files.length) return NextResponse.json({ error: 'No files' }, { status: 400 });
    if (files.length > MAX_FILES) {
      return NextResponse.json({ error: `Too many files. ${MAX_FILES} is the limit.` }, { status: 400 });
    }

    const id = newRunId();
    const sources: Source[] = [];
    const chunks: Chunk[] = [];
    const seen = new Set<string>();

    for (const file of files) {
      const buf = Buffer.from(await file.arrayBuffer());
      const sourceId = newId('src');

      if (buf.length > MAX_BYTES) {
        sources.push(blank(sourceId, file, '', 'FAILED', 'Bigger than 25 MB. Split it or export a smaller version.'));
        continue;
      }

      const hash = hashOf(buf);
      if (seen.has(hash)) {
        sources.push(blank(sourceId, file, hash, 'FAILED', 'The same file was added twice.'));
        continue;
      }
      seen.add(hash);

      const parsed = await parseFile(file.name, file.type, buf);
      if (parsed.status !== 'OK') {
        sources.push(blank(sourceId, file, hash, parsed.status, parsed.note));
        continue;
      }

      const role = guessRole(file.name, parsed.text);
      const fileChunks = chunkText(sourceId, parsed.text, { name: file.name, role });
      chunks.push(...fileChunks);

      sources.push({
        id: sourceId,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        bytes: buf.length,
        hash,
        addedAt: new Date().toISOString(),
        role,
        parse: fileChunks.length ? 'OK' : 'EMPTY',
        parseNote: fileChunks.length ? '' : 'Nothing left after cleaning up the text.',
        chunkCount: fileChunks.length,
        conceptCount: 0,
      });
    }

    const model: Model = {
      ...emptyModel(id),
      title,
      sources,
      chunks,
      run: {
        id,
        stage: 'IDLE',
        startedAt: new Date().toISOString(),
        finishedAt: '',
        currentSourceId: '',
        failedStage: '',
        failedWhy: '',
      },
    };

    await saveRun(model);
    return NextResponse.json({ model: { ...model, chunks: [] } });
  } catch (e) {
    console.error('[preload:run]', (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

function blank(
  id: string,
  file: File,
  hash: string,
  parse: Source['parse'],
  note: string
): Source {
  return {
    id,
    name: file.name,
    mime: file.type || 'application/octet-stream',
    bytes: file.size,
    hash,
    addedAt: new Date().toISOString(),
    role: 'UNKNOWN',
    parse,
    parseNote: note,
    chunkCount: 0,
    conceptCount: 0,
  };
}
