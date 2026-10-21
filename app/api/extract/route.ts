import { NextResponse } from 'next/server';
import { EXTRACT_JSON_SCHEMA, ExtractPatch } from '@/lib/schema';
import { EXTRACT_SYSTEM, extractUser, PROMPT_VERSION } from '@/lib/prompts';
import { LlmError, structured } from '@/lib/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/*
 * Call 1. Green only.
 *
 * The schema this route enforces has no origin field and no status field, so
 * the model has no way to mark anything as inferred. Everything that comes
 * back is stamped EXPLICIT + VALIDATED by the reducer.
 */
export async function POST(req: Request) {
  try {
    const { text, concepts } = (await req.json()) as {
      text: string;
      concepts: { id: string; label: string; note: string; status: string }[];
    };

    if (!text?.trim()) {
      return NextResponse.json({ error: 'No text' }, { status: 400 });
    }

    const model = process.env.EXTRACT_MODEL || 'claude-haiku-4-5-20251001';
    const { value, ms, usage } = await structured(
      {
        model,
        system: EXTRACT_SYSTEM,
        user: extractUser({ text, concepts: concepts ?? [] }),
        schemaName: 'extract_patch',
        jsonSchema: EXTRACT_JSON_SCHEMA,
        temperature: 0,
        maxTokens: 2000,
      },
      ExtractPatch
    );

    return NextResponse.json({ patch: value, ms, usage, model, promptVersion: PROMPT_VERSION });
  } catch (e) {
    const err = e as LlmError;
    console.error('[extract]', err.message, err.detail ?? '');
    return NextResponse.json({ error: err.message ?? 'Interpretation failed' }, { status: 502 });
  }
}
