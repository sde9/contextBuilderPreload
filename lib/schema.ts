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
      /** RT-US-06. The concept the question is about, "" when none. Kept only when it is on the map. */
      attachTo: z.string().optional(),
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
        required: ['text', 'usefulness', 'why', 'attachTo'],
        properties: {
          ...PROPOSE_JSON_SCHEMA.properties.questions.items.properties,
          why: { type: 'string', description: 'One short line on why this matters for the goal.' },
          attachTo: {
            type: 'string',
            description: 'Id of the EXISTING concept this question is about. Empty string when it is about nothing on the map yet.',
          },
        },
      },
    },
  },
} as const;

/*
 * Real-time variant of Call 1 (RT-US-08). One more field: which open
 * questions the person's words clearly answer. It names ids only, so it
 * cannot add anything to the map. Preload keeps the shared ExtractPatch.
 */
export const ExtractPatchRT = ExtractPatch.extend({
  answersQuestionIds: z.array(z.string()).optional(),
});

export type ExtractPatchRT = z.infer<typeof ExtractPatchRT>;

export const EXTRACT_RT_JSON_SCHEMA = {
  ...EXTRACT_JSON_SCHEMA,
  required: [...EXTRACT_JSON_SCHEMA.required, 'answersQuestionIds'],
  properties: {
    ...EXTRACT_JSON_SCHEMA.properties,
    answersQuestionIds: {
      type: 'array',
      items: { type: 'string' },
      description: "Ids from OPEN QUESTIONS that the person's words clearly answer. Empty if none.",
    },
  },
} as const;

// ---------------------------------------------------------------- Finish

/*
 * WrapupPatch (RT-US-13). Topics for the next conversation, at Finish.
 * Text only: nothing here can change the map.
 */
export const WrapupPatch = z.object({
  topics: z.array(
    z.object({
      title: z.string(),
      why: z.string(),
    })
  ),
});

export type WrapupPatch = z.infer<typeof WrapupPatch>;

export const WRAPUP_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['topics'],
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'why'],
        properties: {
          title: { type: 'string', description: 'The topic in 2-8 words, in the words the person used.' },
          why: { type: 'string', description: 'One line on how talking about it moves the goal forward.' },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------- Answers

/*
 * AnswerPatch. The person answered a QUESTION box on the map, in either mode.
 *
 * The first two arrays are ExtractPatch exactly: what the answer states,
 * stamped EXPLICIT + VALIDATED by the reducer. The rest change what is
 * already there, and every one of them names an existing id, so the reducer
 * can refuse anything it does not recognise:
 *
 *   updates   the answer corrects or sharpens a concept's label or note
 *   confirms  the answer says an orange guess is right
 *   rejects   the answer says an orange guess is wrong
 *
 * A green concept is never rejected here, only corrected through updates.
 * Nothing in this schema can make a guess: there is no origin, no status and
 * no questions array, as in Call 1.
 */
export const AnswerPatch = z.object({
  /** True when the answer settles the question. False for "not sure", "later", or half an answer. */
  answersQuestion: z.boolean(),
  concepts: ExtractPatch.shape.concepts,
  relationships: ExtractPatch.shape.relationships,
  updates: z.array(
    z.object({
      id: z.string(),
      /** New label, or "" to keep it. */
      label: z.string(),
      /** New note, or "" to keep it. */
      note: z.string(),
    })
  ),
  confirms: z.array(z.string()),
  rejects: z.array(z.string()),
});

export type AnswerPatch = z.infer<typeof AnswerPatch>;

export const ANSWER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answersQuestion', 'concepts', 'relationships', 'updates', 'confirms', 'rejects'],
  properties: {
    answersQuestion: {
      type: 'boolean',
      description:
        'True when the answer settles the question. False when the person does not know, puts it off, or answers only part of it.',
    },
    concepts: EXTRACT_JSON_SCHEMA.properties.concepts,
    relationships: EXTRACT_JSON_SCHEMA.properties.relationships,
    updates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label', 'note'],
        properties: {
          id: { type: 'string', description: 'Id of a concept already on the map that the answer corrects or makes more precise.' },
          label: { type: 'string', description: 'The corrected label, 1-4 words, in the person\'s words. Empty string to keep the label.' },
          note: { type: 'string', description: 'The corrected or added detail, as the person gave it. Empty string to keep the note.' },
        },
      },
    },
    confirms: {
      type: 'array',
      items: { type: 'string' },
      description: 'Ids of [PROPOSED] guesses that the answer says are right. Empty if none.',
    },
    rejects: {
      type: 'array',
      items: { type: 'string' },
      description: 'Ids of [PROPOSED] guesses that the answer says are wrong or do not apply. Never a [VALIDATED] id. Empty if none.',
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

// ---------------------------------------------------------------- Preload

/*
 * Preload variants. The live mode keeps the shared schemas exactly as they
 * are; a document gets one more kind and a call of its own.
 */

/** CLAIM is for documents: a statement the text asserts, tests or concludes. */
const KIND_PL = [...KIND, 'CLAIM'] as const;

export const ExtractPatchPL = ExtractPatch.extend({
  concepts: z.array(
    z.object({
      tempId: z.string(),
      label: z.string(),
      note: z.string(),
      matchesExistingId: z.string(),
      kind: z.enum(KIND_PL),
      belongsTo: z.string(),
    })
  ),
});

export type ExtractPatchPL = z.infer<typeof ExtractPatchPL>;

export const EXTRACT_PL_JSON_SCHEMA = {
  ...EXTRACT_JSON_SCHEMA,
  properties: {
    ...EXTRACT_JSON_SCHEMA.properties,
    concepts: {
      ...EXTRACT_JSON_SCHEMA.properties.concepts,
      items: {
        ...EXTRACT_JSON_SCHEMA.properties.concepts.items,
        properties: {
          ...EXTRACT_JSON_SCHEMA.properties.concepts.items.properties,
          kind: { type: 'string', enum: [...KIND_PL] },
        },
      },
    },
  },
} as const;

/*
 * OutlinePatch. One call per document, before its sections are read.
 *
 * It returns the skeleton a reader needs first: the main point, the parts in
 * reading order, and how the parts connect. Every item carries a quote. The
 * server checks each quote against the document, character for character
 * after whitespace, and anything it cannot find is drawn orange as the AI's
 * reading rather than green as something written (R2).
 */

const PATTERNS = ['SEQUENCE', 'ARGUMENT', 'STRUCTURE', 'LIST'] as const;
const LINK_TYPES = ['LEADS_TO', 'DEPENDS_ON', 'SUPPORTS', 'CONTRADICTS', 'REFINES'] as const;

export const OutlinePatch = z.object({
  main: z.object({
    label: z.string(),
    note: z.string(),
    kind: z.enum(KIND_PL),
    quote: z.string(),
  }),
  parts: z.array(
    z.object({
      tempId: z.string(),
      label: z.string(),
      note: z.string(),
      kind: z.enum(KIND_PL),
      quote: z.string(),
      sectionIds: z.array(z.string()),
      pattern: z.enum(PATTERNS),
    })
  ),
  links: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      type: z.enum(LINK_TYPES),
      label: z.string(),
      quote: z.string(),
    })
  ),
});

export type OutlinePatch = z.infer<typeof OutlinePatch>;

const QUOTE_DESCRIPTION =
  'One sentence copied from the document character for character that states this, or a heading copied exactly. Empty string if no sentence states it.';

export const OUTLINE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['main', 'parts', 'links'],
  properties: {
    main: {
      type: 'object',
      additionalProperties: false,
      required: ['label', 'note', 'kind', 'quote'],
      properties: {
        label: { type: 'string', description: 'The main point or subject in 2-8 words, in the document\'s own vocabulary.' },
        note: { type: 'string', description: 'One sentence a newcomer could repeat.' },
        kind: { type: 'string', enum: [...KIND_PL] },
        quote: { type: 'string', description: QUOTE_DESCRIPTION },
      },
    },
    parts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tempId', 'label', 'note', 'kind', 'quote', 'sectionIds', 'pattern'],
        properties: {
          tempId: { type: 'string', description: 'Local handle, "p1", "p2", in reading order.' },
          label: { type: 'string', description: 'Short name, 1-6 words, from the document\'s headings or words.' },
          note: {
            type: 'string',
            description: 'One sentence on what this part says. For a claim that is tested, start with its verdict.',
          },
          kind: { type: 'string', enum: [...KIND_PL] },
          quote: { type: 'string', description: QUOTE_DESCRIPTION },
          sectionIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids from the SECTIONS list that this part covers, in order. Every section belongs to one part.',
          },
          pattern: {
            type: 'string',
            enum: [...PATTERNS],
            description:
              'How the inside of this part is organised. SEQUENCE = steps or events in order. ARGUMENT = claims, evidence, verdicts. STRUCTURE = components, roles, rules. LIST = items of the same kind.',
          },
        },
      },
    },
    links: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to', 'type', 'label', 'quote'],
        properties: {
          from: { type: 'string', description: 'A part tempId, or "main".' },
          to: { type: 'string', description: 'A part tempId, or "main". Different from "from".' },
          type: {
            type: 'string',
            enum: [...LINK_TYPES],
            description:
              'LEADS_TO = produces, causes or comes before. DEPENDS_ON = needs. SUPPORTS = gives evidence for. CONTRADICTS = is in tension with. REFINES = narrows, qualifies or gives an example of.',
          },
          label: { type: 'string', description: 'Short verb phrase in the document\'s words, e.g. "acts through".' },
          quote: { type: 'string', description: QUOTE_DESCRIPTION },
        },
      },
    },
  },
} as const;
