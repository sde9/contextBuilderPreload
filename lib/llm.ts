import type { z } from 'zod';

/*
 * One thin adapter over two providers, using plain fetch rather than an SDK.
 * Fewer dependencies, and the request shape stays visible when something goes
 * wrong at 22:00 the night before a session.
 *
 * Both paths use provider-enforced structured output:
 *   Anthropic -> tool use with a forced tool_choice
 *   OpenAI    -> response_format json_schema, strict
 *
 * Provider guarantees are good but not perfect, so every response is still
 * validated with Zod here. One retry with the validation errors fed back,
 * then fail. A bad response must never reach the reducer.
 */

export type Provider = 'anthropic' | 'openai';

export function provider(): Provider {
  return (process.env.LLM_PROVIDER as Provider) || 'anthropic';
}

export class LlmError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'LlmError';
  }
}

type CallArgs = {
  model: string;
  system: string;
  user: string;
  schemaName: string;
  jsonSchema: unknown;
  maxTokens?: number;
  temperature?: number;
};

async function callAnthropic(a: CallArgs): Promise<unknown> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new LlmError('ANTHROPIC_API_KEY is not set. Run npm run env:pull to fetch it from Vercel.');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: a.model,
      max_tokens: a.maxTokens ?? 2000,
      ...(a.temperature !== undefined ? { temperature: a.temperature } : {}),
      system: a.system,
      tools: [
        {
          name: a.schemaName,
          description: 'Return the result in this exact shape.',
          input_schema: a.jsonSchema,
        },
      ],
      tool_choice: { type: 'tool', name: a.schemaName },
      messages: [{ role: 'user', content: a.user }],
    }),
  });

  if (!res.ok) throw new LlmError(`Anthropic ${res.status}`, await res.text());

  const body = (await res.json()) as { content?: { type: string; input?: unknown }[] };
  const block = body.content?.find((c) => c.type === 'tool_use');
  if (!block?.input) throw new LlmError('Anthropic returned no tool_use block', body);
  return block.input;
}

async function callOpenAI(a: CallArgs): Promise<unknown> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new LlmError('OPENAI_API_KEY is not set. Copy .env.local.example to .env.local.');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: a.model,
      messages: [
        { role: 'system', content: a.system },
        { role: 'user', content: a.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: a.schemaName, strict: true, schema: a.jsonSchema },
      },
    }),
  });

  if (!res.ok) throw new LlmError(`OpenAI ${res.status}`, await res.text());

  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content;
  if (!text) throw new LlmError('OpenAI returned no content', body);
  try {
    return JSON.parse(text);
  } catch {
    throw new LlmError('OpenAI returned unparseable JSON', text);
  }
}

async function once(a: CallArgs): Promise<unknown> {
  return provider() === 'openai' ? callOpenAI(a) : callAnthropic(a);
}

/** Call, validate, retry once with the validation errors appended, then give up. */
export async function structured<T>(a: CallArgs, schema: z.ZodType<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();

  const first = await once(a);
  const parsed = schema.safeParse(first);
  if (parsed.success) return { value: parsed.data, ms: Date.now() - started };

  const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');

  const retry = await once({
    ...a,
    user: `${a.user}\n\nYour previous answer did not fit the required shape:\n${issues}\nReturn the same information in the correct shape.`,
  });

  const second = schema.safeParse(retry);
  if (second.success) return { value: second.data, ms: Date.now() - started };

  throw new LlmError('Response did not match the schema after one retry', second.error.issues);
}
