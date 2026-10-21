import { NextResponse } from 'next/server';
import { PROPOSE_RT_JSON_SCHEMA, ProposePatchRT } from '@/lib/schema';
import { PROPOSE_REALTIME_RULES, PROPOSE_SYSTEM, proposeUser, PROMPT_VERSION } from '@/lib/prompts';
import { LlmError, structured } from '@/lib/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/*
 * Call 2. Orange only. Real-time mode.
 *
 * This route can only produce proposals. It runs after Call 1 has already been
 * applied and rendered, so the user is reading green nodes while it thinks.
 *
 * It gets the session goal and the whole conversation, and the live-session
 * rules on top of the shared system prompt. Preload's pipeline calls the
 * model directly with PROPOSE_SYSTEM alone, so nothing here changes a
 * document run.
 *
 * If it fails, the client says nothing and shows nothing. A missing suggestion
 * is invisible. An error message in the middle of a live conversation is not.
 */
export async function POST(req: Request) {
  try {
    const payload = (await req.json()) as Parameters<typeof proposeUser>[0];

    if (!payload?.concepts?.length) {
      return NextResponse.json({ patch: { concepts: [], relationships: [], questions: [] }, ms: 0 });
    }

    const model = process.env.PROPOSE_MODEL || 'claude-sonnet-5';
    const { value, ms, usage } = await structured(
      {
        model,
        system: `${PROPOSE_SYSTEM}\n\n${PROPOSE_REALTIME_RULES}`,
        user: proposeUser(payload),
        schemaName: 'propose_patch',
        jsonSchema: PROPOSE_RT_JSON_SCHEMA,
        // The default model thinks before it answers, and the input now holds
        // the whole conversation. 2000 tokens could cut the answer off, which
        // fails the schema check and silently loses the turn's orange.
        maxTokens: 8000,
      },
      ProposePatchRT
    );

    return NextResponse.json({ patch: value, ms, usage, model, promptVersion: PROMPT_VERSION });
  } catch (e) {
    const err = e as LlmError;
    console.error('[propose]', err.message, err.detail ?? '');
    return NextResponse.json({ error: err.message ?? 'Proposal failed' }, { status: 502 });
  }
}
