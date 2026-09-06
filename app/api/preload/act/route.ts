import { NextResponse } from 'next/server';
import { loadRun, saveRun } from '@/lib/runStore';
import { confirmConcept, rejectConcept } from '@/lib/reducer';
import { resolveContest, splitConcept } from '@/lib/merge';
import type { Model, SourceRole } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/*
 * Everything a person does to a finished map, written back to the run.
 *
 * These are the same pure reducers the canvas calls, applied server side so
 * the decision survives the tab (R4) and lands in the log (R5).
 */

type Action =
  | { kind: 'confirm'; conceptId: string }
  | { kind: 'reject'; conceptId: string }
  | { kind: 'split'; conceptId: string; absorbedId: string }
  | { kind: 'resolve'; conceptId: string; choice: 'KEPT_FIRST' | 'KEPT_SECOND' | 'SPLIT' }
  | { kind: 'role'; sourceId: string; role: SourceRole }
  | { kind: 'title'; title: string };

export async function POST(req: Request) {
  try {
    const { runId, action } = (await req.json()) as { runId: string; action: Action };
    const model = await loadRun(runId);
    if (!model) return NextResponse.json({ error: 'No such run' }, { status: 404 });

    let next: Model = model;

    if (action.kind === 'confirm') next = confirmConcept(model, action.conceptId);
    if (action.kind === 'reject') next = rejectConcept(model, action.conceptId);
    if (action.kind === 'split') next = splitConcept(model, action.conceptId, action.absorbedId);
    if (action.kind === 'resolve') next = resolveContest(model, action.conceptId, action.choice);
    if (action.kind === 'title') next = { ...model, title: action.title.trim() || model.title };
    if (action.kind === 'role') {
      // R9. The user owns this answer, and the merge uses it as the tiebreaker.
      next = {
        ...model,
        sources: model.sources.map((s) => (s.id === action.sourceId ? { ...s, role: action.role } : s)),
      };
    }

    await saveRun(next);
    return NextResponse.json({ model: next });
  } catch (e) {
    console.error('[preload:act]', (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
