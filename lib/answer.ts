import { ANSWER_JSON_SCHEMA, AnswerPatch } from './schema';
import { ANSWER_SYSTEM, answerUser, type AnswerInput } from './prompts';
import { structured } from './llm';
import type { Usage } from './types';

/*
 * Server only. Reads one answer to one QUESTION box. The live route and the
 * Preload act route both call this, so an answer means the same in both.
 *
 * The extract model by default: an answer is short and the job is the same
 * as Call 1's, record what was said. ANSWER_MODEL overrides it when a
 * stronger reader is worth the wait.
 */
export async function analyseAnswer(
  input: AnswerInput
): Promise<{ patch: AnswerPatch; ms: number; usage: Usage | null; model: string }> {
  const model = process.env.ANSWER_MODEL || process.env.EXTRACT_MODEL || 'claude-haiku-4-5-20251001';
  const { value, ms, usage } = await structured(
    {
      model,
      system: ANSWER_SYSTEM,
      user: answerUser(input),
      schemaName: 'answer_patch',
      jsonSchema: ANSWER_JSON_SCHEMA,
      temperature: 0,
      maxTokens: 3000,
    },
    AnswerPatch
  );
  return { patch: value, ms, usage, model };
}
