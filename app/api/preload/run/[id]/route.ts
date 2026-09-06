import { NextResponse } from 'next/server';
import { RUN_MISSING, loadRun } from '@/lib/runStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Reopen a run by id. R4: a closed laptop does not lose the work. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const model = await loadRun(id);
  if (!model) return NextResponse.json({ error: RUN_MISSING }, { status: 404 });
  return NextResponse.json({ model });
}
