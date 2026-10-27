import { NextResponse } from 'next/server';
import { EXTRACT_RT_JSON_SCHEMA, ExtractPatchRT } from '@/lib/schema';
import { EXTRACT_REALTIME_RULES, EXTRACT_SYSTEM, extractUser, PROMPT_VERSION } from '@/lib/prompts';
import { LlmError, structured } from '@/lib/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/*
 * Call 1. Green only. Real-time mode.
 *
 * The schema this route enforces has no origin field and no status field, so
 * the model has no way to mark anything as inferred. Everything that comes
 * back is stamped EXPLICIT + VALIDATED by the reducer.
 *
 * Live sessions also send the open questions (RT-US-08). The model may name
 * the ones the person's words clearly answer, by id. That field can only
 * close a question; it cannot add anything to the map. Preload reads
 * documents with the shared ExtractPatch and EXTRACT_SYSTEM alone.
 */
export async function POST(req: Request) {
  try {
    const { text, concepts, openQuestions } = (await req.json()) as {
      text: string;
      concepts: { id: string; label: string; note: string; status: string }[];
      openQuestions?: { id: string; text: string }[];
    };

    if (!text?.trim()) {
      return NextResponse.json({ error: 'No text' }, { status: 400 });
    }

    const model = process.env.EXTRACT_MODEL || 'claude-haiku-4-5-20251001';
    const { value, ms, usage } = await structured(
      {
        model,
        system: `${EXTRACT_SYSTEM}\n\n${EXTRACT_REALTIME_RULES}`,
        user: extractUser({ text, concepts: concepts ?? [], openQuestions: openQuestions ?? [] }),
        schemaName: 'extract_patch',
        jsonSchema: EXTRACT_RT_JSON_SCHEMA,
        temperature: 0,
        maxTokens: 2000,
      },
      ExtractPatchRT
    );

    return NextResponse.json({ patch: value, ms, usage, model, promptVersion: PROMPT_VERSION });
  } catch (e) {
    const err = e as LlmError;
    console.error('[extract]', err.message, err.detail ?? '');
    return NextResponse.json({ error: err.message ?? 'Interpretation failed' }, { status: 502 });
  }
}
