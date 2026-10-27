import { NextResponse } from 'next/server';
import { PROMPT_VERSION, type AnswerInput } from '@/lib/prompts';
import { LlmError } from '@/lib/llm';
import { analyseAnswer } from '@/lib/answer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/*
 * Real-time. The person typed an answer into a QUESTION box on the map.
 *
 * The browser builds the input with answerPayload() and applies the patch
 * with applyAnswer(), as it does for Call 1. Preload reads answers through
 * its act route instead, because its model lives on the server.
 */
export async function POST(req: Request) {
  try {
    const input = (await req.json()) as AnswerInput;
    if (!input?.answer?.trim() || !input?.question?.id) {
      return NextResponse.json({ error: 'No answer' }, { status: 400 });
    }
    const { patch, ms, usage, model } = await analyseAnswer(input);
    return NextResponse.json({ patch, ms, usage, model, promptVersion: PROMPT_VERSION });
  } catch (e) {
    const err = e as LlmError;
    console.error('[answer]', err.message, err.detail ?? '');
    return NextResponse.json({ error: err.message ?? 'Could not read the answer' }, { status: 502 });
  }
}
