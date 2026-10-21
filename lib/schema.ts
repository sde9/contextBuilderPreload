import { z } from 'zod';

/*
 * The two schemas are the most important code in this build.
 *
 * ExtractPatch has NO origin field, NO status field and NO questions array.
 * The model answering it is structurally incapable of marking something as
 * inferred, because there is nowhere to put that. The server stamps every
 * item EXPLICIT + VALIDATED.
 *
 * ProposePatch can only produce proposals. The server stamps every item
 * INFERRED + PROPOSED.
 *
 * Origin correctness is therefore a property of the system, not a prompt
 * instruction the model may or may not follow.
 *
 * JSON Schema is hand-written next to each Zod schema rather than generated.
 * Duplication is deliberate: it removes a version-compatibility dependency on
 * the night before a demo, and it keeps the wire format inside the provider
 * intersection (flat objects, explicit enums, no unions, no optionals, no
 * nesting past two levels, empty string instead of null).
 */

const KIND = ['ENTITY', 'ATTRIBUTE', 'ACTOR', 'STEP', 'RULE', 'QUESTION', 'PROBLEM'] as const;

// ---------------------------------------------------------------- Call 1

export const ExtractPatch = z.object({
  concepts: z.array(
    z.object({
      tempId: z.string(),
      label: z.string(),
      note: z.string(),
      /** Existing concept id when this restates something already known, else "". */
      matchesExistingId: z.string(),
      kind: z.enum(KIND),
      /** tempId from this turn, or an existing concept id, or "" when it stands alone. */
      belongsTo: z.string(),
    })
  ),
  relationships: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      label: z.string(),
    })
  ),
});

export type ExtractPatch = z.infer<typeof ExtractPatch>;

export const EXTRACT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['concepts', 'relationships'],
  properties: {
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tempId', 'label', 'note', 'matchesExistingId', 'kind', 'belongsTo'],
        properties: {
          tempId: { type: 'string', description: 'Local handle for this turn, e.g. "n1".' },
          label: { type: 'string', description: 'Short noun phrase, 1-4 words, as the speaker would say it.' },
          note: { type: 'string', description: 'Detail or value the speaker gave. Empty string if none.' },
          matchesExistingId: {
            type: 'string',
            description:
              'If this restates a concept already in the model, put its existing id here and the app will merge. Otherwise empty string.',
          },
          kind: { type: 'string', enum: [...KIND] },
          belongsTo: {
            type: 'string',
            description:
              "If this is a property or part of something else, put that thing's id or tempId here. If it stands on its own, use an empty string.",
          },
        },
      },
    },
    relationships: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to', 'label'],
        properties: {
          from: { type: 'string', description: 'A tempId from this turn, or an existing concept id.' },
          to: { type: 'string', description: 'A tempId from this turn, or an existing concept id.' },
          label: { type: 'string', description: 'Verb phrase, e.g. "pays", "requires", "followed by".' },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------- Call 2

export const ProposePatch = z.object({
  concepts: z.array(
    z.object({
      tempId: z.string(),
      label: z.string(),
      why: z.string(),
      /** Existing concept id. Required: no orphan proposals, and no wandering. */
      attachTo: z.string(),
      relationLabel: z.string(),
      kind: z.enum(KIND),
      /** True when this is a property of attachTo rather than a plain related concept. */
      isPropertyOfTarget: z.boolean(),
    })
  ),
  /** Links between two concepts that already both exist. No new nodes. */
  relationships: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      label: z.string(),
      why: z.string(),
    })
  ),
  questions: z.array(
    z.object({
      text: z.string(),
      usefulness: z.number(),
    })
  ),
});

export type ProposePatch = z.infer<typeof ProposePatch>;

export const PROPOSE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['concepts', 'relationships', 'questions'],
  properties: {
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tempId', 'label', 'why', 'attachTo', 'relationLabel', 'kind', 'isPropertyOfTarget'],
        properties: {
          tempId: { type: 'string' },
          label: {
            type: 'string',
            description: 'Short noun phrase for the missing thing. May be phrased as a question, e.g. "Who pays?".',
          },
          why: { type: 'string', description: 'One short sentence on why you think this is missing.' },
          attachTo: { type: 'string', description: 'Id of an EXISTING concept this hangs off. Required.' },
          relationLabel: { type: 'string', description: 'Verb phrase linking the existing concept to this one.' },
          kind: { type: 'string', enum: [...KIND] },
          isPropertyOfTarget: {
            type: 'boolean',
            description: 'True if this is a property or part of attachTo, rather than a separate related concept.',
          },
        },
      },
    },
    relationships: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to', 'label', 'why'],
        properties: {
          from: { type: 'string', description: 'Id of an EXISTING concept. Never a tempId — no new nodes here.' },
          to: { type: 'string', description: 'Id of an EXISTING concept, different from "from".' },
          label: {
            type: 'string',
            description:
              'Precise business verb phrase: "triggers", "depends on", "feeds", "owns", "authorizes", "blocks" — not the generic "relates to".',
          },
          why: { type: 'string', description: 'One short sentence on why these two are connected.' },
        },
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'usefulness'],
        properties: {
          text: { type: 'string', description: 'A question phrased for the speaker, not for a developer.' },
          usefulness: { type: 'number', description: '1 to 5. 5 = answering this unblocks the most.' },
        },
      },
    },
  },
} as const;

/*
 * Real-time variant of Call 2. Preload's pipeline calls the propose model
 * with ProposePatch directly, so fields the live mode needs are added here
 * instead of on the shared schema. Each question carries a one-line reason
 * tied to the session goal.
 */
export const ProposePatchRT = ProposePatch.extend({
  questions: z.array(
    z.object({
      text: z.string(),
      usefulness: z.number(),
      why: z.string().optional(),
    })
  ),
});

export type ProposePatchRT = z.infer<typeof ProposePatchRT>;

export const PROPOSE_RT_JSON_SCHEMA = {
  ...PROPOSE_JSON_SCHEMA,
  properties: {
    ...PROPOSE_JSON_SCHEMA.properties,
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'usefulness', 'why'],
        properties: {
          ...PROPOSE_JSON_SCHEMA.properties.questions.items.properties,
          why: { type: 'string', description: 'One short line on why this matters for the goal.' },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------- Call 3

/*
 * MergePatch. The same trick as ExtractPatch, applied a third time.
 *
 * There is no tempId, no concepts array and no free-text label. Every field
 * either names something already on the map or picks between two labels that
 * already exist. The merge call is therefore structurally incapable of adding
 * anything to the map (R7), and the reducer enforces that rather than trusting
 * it: an unknown id is dropped and `invented` goes up.
 */

export const MergePatch = z.object({
  decisions: z.array(
    z.object({
      /** Existing concept id. */
      aId: z.string(),
      /** Existing concept id, different from aId. */
      bId: z.string(),
      verdict: z.enum(['SAME', 'RELATED', 'CONFLICT']),
      /** Must equal aId's label or bId's label. Anything else is refused. */
      keepLabel: z.string(),
      /** Verb phrase when RELATED, else "". */
      relationLabel: z.string(),
      /** What the two sources disagree about, when CONFLICT, else "". */
      conflictSummary: z.string(),
    })
  ),
});

export type MergePatch = z.infer<typeof MergePatch>;

export const MERGE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decisions'],
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['aId', 'bId', 'verdict', 'keepLabel', 'relationLabel', 'conflictSummary'],
        properties: {
          aId: { type: 'string', description: 'Id of the first concept, exactly as given in the pair list.' },
          bId: { type: 'string', description: 'Id of the second concept, exactly as given in the pair list.' },
          verdict: {
            type: 'string',
            enum: ['SAME', 'RELATED', 'CONFLICT'],
            description:
              'SAME = one thing under two names. RELATED = two different things that should be linked. CONFLICT = the same thing, but the two sources say incompatible things about it.',
          },
          keepLabel: {
            type: 'string',
            description:
              "For SAME or CONFLICT, the better of the two labels, copied EXACTLY from one of them. Never a new phrase. Empty string for RELATED.",
          },
          relationLabel: {
            type: 'string',
            description: 'For RELATED, a precise verb phrase: "triggers", "depends on", "owns". Empty string otherwise.',
          },
          conflictSummary: {
            type: 'string',
            description:
              'For CONFLICT, one sentence naming what actually disagrees, e.g. "14 days in the spec, 7 days in the call". Empty string otherwise.',
          },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------- Call 4

/*
 * ClusterPatch. Grouping only. Every member id has to already be on the map,
 * and an area is never a concept (R6), so there is nothing here that can
 * introduce a fact.
 */

export const ClusterPatch = z.object({
  areas: z.array(
    z.object({
      label: z.string(),
      memberIds: z.array(z.string()),
    })
  ),
});

export type ClusterPatch = z.infer<typeof ClusterPatch>;

export const CLUSTER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['areas'],
  properties: {
    areas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'memberIds'],
        properties: {
          label: {
            type: 'string',
            description: 'Short name for the area, 1-3 words, in the vocabulary the documents use.',
          },
          memberIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids of concepts in this area. Every id must come from the list you were given.',
          },
        },
      },
    },
  },
} as const;
