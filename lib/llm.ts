import type { z } from 'zod';
import type { Usage } from './types';

/*
 * One thin adapter over two providers, using plain fetch rather than an SDK.
 * Fewer dependencies, and the request shape stays visible when something goes
 * wrong at 22:00 the night before a session.
 *
 * Both providers use provider-enforced structured output:
 *   Anthropic -> tool use with a forced tool_choice, or, for the models that
 *                refuse a forced tool (Opus 5.5, Sonnet 5.5, Fable, Mythos),
 *                output_config.format json_schema (RT-US-05)
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

export type OutputMode = 'tool' | 'json';

/** Models that reject a forced tool_choice and need structured outputs instead. */
const JSON_ONLY_MODELS = /(opus|sonnet)-5-5|fable|mythos/i;

/**
 * How to ask an Anthropic model for structured output. ANTHROPIC_OUTPUT_MODE
 * sets it for every model (tool or json, default tool); a model that refuses
 * a forced tool always gets json, whatever the setting, because tool would
 * fail every call.
 */
export function outputModeFor(model: string, setting = process.env.ANTHROPIC_OUTPUT_MODE): OutputMode {
  if (JSON_ONLY_MODELS.test(model)) return 'json';
  return setting === 'json' ? 'json' : 'tool';
}

async function callAnthropic(a: CallArgs): Promise<Answer> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new LlmError('ANTHROPIC_API_KEY is not set. Run npm run env:pull to fetch it from Vercel.');
  if (outputModeFor(a.model) === 'json') return callAnthropicJson(a, key);

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

  const body = (await res.json()) as {
    content?: { type: string; input?: unknown }[];
    usage?: { input_tokens?: number; output_tokens?: number };
    stop_reason?: string;
  };
  const usage = body.usage ? { input: body.usage.input_tokens ?? 0, output: body.usage.output_tokens ?? 0 } : null;
  // A cut-off answer is a size problem, not a shape problem. Say so, so the
  // caller asks again with more room instead of feeding back schema errors.
  if (body.stop_reason === 'max_tokens') return { value: null, usage, truncated: true };
  const block = body.content?.find((c) => c.type === 'tool_use');
  if (!block?.input) throw new LlmError('Anthropic returned no tool_use block', body);
  return { value: block.input, usage };
}

/*
 * RT-US-05. Structured outputs: the schema goes in output_config.format, with
 * no tools and no tool_choice, and the answer is JSON in the first text
 * block. The Zod check and the one retry in structured() still apply.
 */
async function callAnthropicJson(a: CallArgs, key: string): Promise<Answer> {
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
      output_config: { format: { type: 'json_schema', schema: a.jsonSchema } },
      messages: [{ role: 'user', content: a.user }],
    }),
  });

  if (!res.ok) throw new LlmError(`Anthropic ${res.status}`, await res.text());

  const body = (await res.json()) as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
    stop_reason?: string;
  };
  const usage = body.usage ? { input: body.usage.input_tokens ?? 0, output: body.usage.output_tokens ?? 0 } : null;
  if (body.stop_reason === 'max_tokens') return { value: null, usage, truncated: true };
  if (body.stop_reason === 'refusal') throw new LlmError('The model declined to answer this request.', body);
  const text = body.content?.find((c) => c.type === 'text')?.text;
  if (!text) throw new LlmError('Anthropic returned no text block', body);
  try {
    return { value: JSON.parse(text), usage };
  } catch {
    throw new LlmError('Anthropic returned unparseable JSON', text);
  }
}

async function callOpenAI(a: CallArgs): Promise<Answer> {
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

  const body = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const usage = body.usage ? { input: body.usage.prompt_tokens ?? 0, output: body.usage.completion_tokens ?? 0 } : null;
  // The same size check as the Anthropic path: a cut-off answer is retried bigger, not fed schema errors.
  if (body.choices?.[0]?.finish_reason === 'length') return { value: null, usage, truncated: true };
  const text = body.choices?.[0]?.message?.content;
  if (!text) throw new LlmError('OpenAI returned no content', body);
  try {
    return { value: JSON.parse(text), usage };
  } catch {
    throw new LlmError('OpenAI returned unparseable JSON', text);
  }
}

/** One provider answer, before validation. Usage is null when the provider sent none. */
type Answer = { value: unknown; usage: Usage | null; truncated?: boolean };

/** Ceiling for the one bigger retry after a cut-off answer. */
const MAX_TOKENS_CEILING = 16000;

async function once(a: CallArgs): Promise<Answer> {
  return provider() === 'openai' ? callOpenAI(a) : callAnthropic(a);
}

function addUsage(a: Usage | null, b: Usage | null): Usage | null {
  if (!a) return b;
  if (!b) return a;
  return { input: a.input + b.input, output: a.output + b.output };
}

/**
 * Call, validate, retry once with the validation errors appended, then give up.
 * Usage covers both attempts when a retry happened, because both were paid for.
 */
export async function structured<T>(
  a: CallArgs,
  schema: z.ZodType<T>
): Promise<{ value: T; ms: number; usage: Usage | null }> {
  const started = Date.now();

  let first = await once(a);
  if (first.truncated) {
    const before = a.maxTokens ?? 2000;
    const bigger = Math.min(before * 2, MAX_TOKENS_CEILING);
    if (bigger <= before) throw new LlmError(`The answer was cut off at ${before} tokens. The request is too big for one call.`);
    a = { ...a, maxTokens: bigger };
    const again = await once(a);
    if (again.truncated) {
      throw new LlmError(`The answer was cut off twice (${before}, then ${bigger} tokens). The request is too big for one call.`);
    }
    first = { ...again, usage: addUsage(first.usage, again.usage) };
  }
  const parsed = schema.safeParse(first.value);
  if (parsed.success) return { value: parsed.data, ms: Date.now() - started, usage: first.usage };

  const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');

  const retry = await once({
    ...a,
    user: `${a.user}\n\nYour previous answer did not fit the required shape:\n${issues}\nReturn the same information in the correct shape.`,
  });

  if (retry.truncated) throw new LlmError(`The answer was cut off at ${a.maxTokens ?? 2000} tokens on the retry.`);
  const second = schema.safeParse(retry.value);
  if (second.success) return { value: second.data, ms: Date.now() - started, usage: addUsage(first.usage, retry.usage) };

  throw new LlmError('Response did not match the schema after one retry', second.error.issues);
}
