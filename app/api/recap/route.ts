import { NextResponse } from 'next/server';
import { RECAP_JSON_SCHEMA, RecapPatch } from '@/lib/schema';
import { RECAP_SYSTEM, recapUser, PROMPT_VERSION } from '@/lib/prompts';
import { LlmError, structured } from '@/lib/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/*
 * KVIF P7. "Did I get this right?": a short read-back of the live map.
 * Real-time only. The browser decides each line's kind from the map
 * (addRecap); this route only words the lines. If it fails, no card appears.
 */
export async function POST(req: Request) {
  try {
    const payload = (await req.json()) as Parameters<typeof recapUser>[0];
    if (!payload?.concepts?.length) {
      return NextResponse.json({ patch: { lines: [] }, ms: 0 });
    }
    const model = process.env.PROPOSE_MODEL || 'claude-sonnet-5';
    const { value, ms, usage } = await structured(
      {
        model,
        system: RECAP_SYSTEM,
        user: recapUser(payload),
        schemaName: 'recap_patch',
        jsonSchema: RECAP_JSON_SCHEMA,
        maxTokens: 4000,
      },
      RecapPatch
    );
    return NextResponse.json({ patch: value, ms, usage, model, promptVersion: PROMPT_VERSION });
  } catch (e) {
    const err = e as LlmError;
    console.error('[recap]', err.message, err.detail ?? '');
    return NextResponse.json({ error: err.message ?? 'No read-back this time' }, { status: 502 });
  }
}
