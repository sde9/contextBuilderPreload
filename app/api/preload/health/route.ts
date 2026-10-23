import { NextResponse } from 'next/server';
import { readProbe, storageKind, writeProbe } from '@/lib/runStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/*
 * Is there somewhere to keep runs? The intake screen asks before the first
 * upload, so a deployment with no store says so up front instead of failing
 * after the files are in.
 *
 * ?probe=1 also writes a small object and reads it back, which proves the
 * store end to end. That is a paid write, so the screen does not use it.
 */
export async function GET(req: Request) {
  try {
    const kind = storageKind();
    if (new URL(req.url).searchParams.get('probe') !== '1') return NextResponse.json({ ok: true, storage: kind });

    const token = Math.random().toString(36).slice(2);
    await writeProbe(token);
    const back = await readProbe();
    return NextResponse.json({ ok: back === token, storage: kind, roundTrip: back === token });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 503 });
  }
}
