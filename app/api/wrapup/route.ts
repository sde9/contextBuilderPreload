import { NextResponse } from 'next/server';
import { WRAPUP_JSON_SCHEMA, WrapupPatch } from '@/lib/schema';
import { WRAPUP_SYSTEM, wrapupUser, PROMPT_VERSION } from '@/lib/prompts';
import { LlmError, structured } from '@/lib/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/*
 * RT-US-13. Topics for the next conversation, at Finish. Real-time only.
 *
 * Text only: the answer is a short list the person can trim, and nothing in
 * it reaches the map. If the call fails, the Finish panel says "No topics
 * this time" and the person goes on to the export.
 */
export async function POST(req: Request) {
  try {
    const payload = (await req.json()) as Parameters<typeof wrapupUser>[0];
    if (!payload?.goal && !payload?.conversation?.length) {
      return NextResponse.json({ patch: { topics: [] }, ms: 0 });
    }

    const model = process.env.PROPOSE_MODEL || 'claude-sonnet-5';
    const { value, ms, usage } = await structured(
      {
        model,
        system: WRAPUP_SYSTEM,
        user: wrapupUser(payload),
        schemaName: 'wrapup_patch',
        jsonSchema: WRAPUP_JSON_SCHEMA,
        maxTokens: 4000,
      },
      WrapupPatch
    );

    // Never more than five, whatever came back.
    return NextResponse.json({ patch: { topics: value.topics.slice(0, 5) }, ms, usage, model, promptVersion: PROMPT_VERSION });
  } catch (e) {
    const err = e as LlmError;
    console.error('[wrapup]', err.message, err.detail ?? '');
    return NextResponse.json({ error: err.message ?? 'No topics this time' }, { status: 502 });
  }
}
