import { NextResponse } from 'next/server';
import { PROPOSE_JSON_SCHEMA, ProposePatch } from '@/lib/schema';
import { PROPOSE_SYSTEM, proposeUser, PROMPT_VERSION } from '@/lib/prompts';
import { LlmError, structured } from '@/lib/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/*
 * Call 2. Orange only.
 *
 * This route can only produce proposals. It runs after Call 1 has already been
 * applied and rendered, so the user is reading green nodes while it thinks.
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

    const { value, ms } = await structured(
      {
        model: process.env.PROPOSE_MODEL || 'claude-sonnet-5',
        system: PROPOSE_SYSTEM,
        user: proposeUser(payload),
        schemaName: 'propose_patch',
        jsonSchema: PROPOSE_JSON_SCHEMA,
        maxTokens: 2000,
      },
      ProposePatch
    );

    return NextResponse.json({ patch: value, ms, promptVersion: PROMPT_VERSION });
  } catch (e) {
    const err = e as LlmError;
    console.error('[propose]', err.message, err.detail ?? '');
    return NextResponse.json({ error: err.message ?? 'Proposal failed' }, { status: 502 });
  }
}
