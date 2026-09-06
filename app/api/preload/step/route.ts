import { NextResponse } from 'next/server';
import { loadRunFull, saveRun } from '@/lib/runStore';
import { retry, step } from '@/lib/pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/*
 * One unit of work per call.
 *
 * The client loops on this until stage is READY. Splitting the run this way
 * is what makes the progress screen honest: every returned note is something
 * that actually happened, not an animation.
 */
export async function POST(req: Request) {
  try {
    const { runId, resume } = (await req.json()) as { runId: string; resume?: boolean };
    const loaded = await loadRunFull(runId);
    if (!loaded) return NextResponse.json({ error: 'No such run' }, { status: 404 });

    const started = Date.now();
    const out = await step(resume ? retry(loaded) : loaded);
    await saveRun(out.model);

    return NextResponse.json({
      model: { ...out.model, chunks: [] },
      note: out.note,
      blocked: out.blocked,
      ms: Date.now() - started,
    });
  } catch (e) {
    console.error('[preload:step]', (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
