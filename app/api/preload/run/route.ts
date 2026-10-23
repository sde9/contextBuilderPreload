import { NextResponse } from 'next/server';
import { listRuns, saveRun } from '@/lib/runStore';
import { newRunId } from '@/lib/pipeline';
import { emptyModel, type Model } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/*
 * A new, empty run. The files follow one per request, to
 * /api/preload/run/<id>/files, because a hosted function will not take a
 * request body over 4.5 MB and a folder of documents easily is.
 */

export async function GET() {
  try {
    return NextResponse.json({ runs: await listRuns() });
  } catch (e) {
    console.error('[preload:list]', (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { title?: string };
    const title = String(body.title ?? '').trim() || 'Untitled project';
    const id = newRunId();

    const model: Model = {
      ...emptyModel(id),
      title,
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
    return NextResponse.json({ model });
  } catch (e) {
    console.error('[preload:run]', (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
