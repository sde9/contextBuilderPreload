import { NextResponse } from 'next/server';
import { RUN_MISSING, loadRun, saveChunks, saveRun } from '@/lib/runStore';
import { readIncoming } from '@/lib/intake';
import { MAX_FILES } from '@/lib/limits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/*
 * Stage 0, one file at a time. The browser sends them in turn, never side by
 * side, so each request reads the run the previous one wrote.
 *
 * The file itself is not kept. Its text is split into sections and those are
 * stored with the run, because stage 1 and the evidence panel read them.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const model = await loadRun(id);
    if (!model?.run) return NextResponse.json({ error: RUN_MISSING }, { status: 404 });
    if (model.run.stage !== 'IDLE') {
      return NextResponse.json({ error: 'Files can only be added before the map is built.' }, { status: 409 });
    }
    if (model.sources.length >= MAX_FILES) {
      return NextResponse.json({ error: `Too many files. ${MAX_FILES} is the limit.` }, { status: 400 });
    }

    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return NextResponse.json({ error: 'No file' }, { status: 400 });

    const { source, chunks } = await readIncoming(
      { name: file.name, type: file.type, buf: Buffer.from(await file.arrayBuffer()) },
      model.sources
    );

    // Sections first. If the run write then fails, an unreferenced sections
    // file is left behind, which is harmless. The other order could leave a
    // source that claims sections nobody can load.
    if (chunks.length) await saveChunks(id, source.id, chunks);

    const next = { ...model, sources: [...model.sources, source] };
    await saveRun(next);
    return NextResponse.json({ model: { ...next, chunks: [] } });
  } catch (e) {
    console.error('[preload:file]', (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
