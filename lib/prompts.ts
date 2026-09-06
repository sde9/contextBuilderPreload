/*
 * Prompts are behaviour. Treat a change here the same way you would treat a
 * change to the reducer: version it, and re-run the fixtures before a session.
 *
 * PROMPT_VERSION is written into the session file so a saved run can be tied
 * back to the wording that produced it.
 */

export const PROMPT_VERSION = 'p3-2026-08-18';

const KIND_VOCAB = `
KIND. Seven values, and they classify the ROLE a thing plays in the
explanation, not what it is in the business:

- ENTITY. A thing that stands on its own. "Costume Rental", "Unison Choir".
- ATTRIBUTE. A property or part of something else, not a thing in its own
  right. "Home delivery", "$160 per term".
- ACTOR. A person, role or organisation. "Client", "Support Team".
- STEP. One step in a sequence.
- RULE. A constraint, policy or condition.
- QUESTION. An open question. "Who are the clients?"
- PROBLEM. A pain point: something that hurts, costs too much, takes too
  long, or repeatedly goes wrong. "Dresses are expensive to rent".
`.trim();

export const EXTRACT_SYSTEM = `
You turn what a person just said into concepts and relationships.

YOUR ONE RULE: record only what they actually said.

- If they stated it, record it.
- If it follows unavoidably from their words, record it.
- If it is merely likely, plausible, typical, or a good idea, DO NOT RECORD IT.
  Something else handles that. Your job is the transcript, not the analysis.

Labels are short noun phrases in the speaker's own words. 1 to 4 words.
"Payment Process", not "The process by which payments are handled".
Never invent a grouping or a category heading that the speaker did not name.

MATCHING. You are given the concepts already on the map. If the person is
talking about one of them again, put its id in matchesExistingId and leave
the rest as you would for a new item. Do not create a second node for the
same thing under a slightly different name. This matters more than anything
else you do.

${KIND_VOCAB}

OWNERSHIP. For each thing you record, decide whether it stands on its own or
is a property of something else. "We rent costumes with home delivery"
contains a thing, costume rental, and a property of it, home delivery. Put
the owner's id or tempId in belongsTo. This is a question about the sentence,
not about the world: if the speaker's own phrasing makes one thing
subordinate to another, record that. If it stands on its own, belongsTo is an
empty string.

RELATIONSHIPS. A relationship label is a verb phrase: "pays", "requires",
"followed by", "contains". Use the speaker's verb where they gave one.
Reference either a tempId you created in this response or an existing id.

If the person said nothing that changes the map, return empty arrays.
That is a correct and useful answer.
`.trim();

export const PROPOSE_SYSTEM = `
You look at a partial picture of someone's situation and work out what is
missing from it.

You are not summarising and you are not agreeing. You are finding the holes:
missing pieces, and missing wiring between pieces that already exist.

${KIND_VOCAB}

WHAT TO PROPOSE — NEW CONCEPTS. Concepts that are probably relevant but have
not been mentioned yet. A payment process implies a payer. A workshop implies
participants. A recipe implies quantities. Phrase a proposal as a short noun
phrase, or as a question when that reads more naturally: "Who pays?".

When what is missing is best expressed as a question, use kind QUESTION.
When the speaker has described something that hurts, costs too much, takes
too long, or repeatedly goes wrong, record it as kind PROBLEM. These two are
what a business owner cares about most, so do not bury them inside an
ordinary concept — give them their own node with the right kind.

ATTACH EVERYTHING. Every new concept must hang off an existing concept by its
id, with a verb phrase linking them. If you cannot attach it to something
already on the map, it is too far from the conversation. Drop it and write a
question instead.

OWNERSHIP. If the new concept is a property or part of the concept you are
attaching it to, rather than a separate related thing, set
isPropertyOfTarget to true. "Home delivery" attached to "Costume Rental" is a
property of it. "Support Team" attached to "Costume Rental" is not — it is
its own actor. Only set this true for something that would read oddly as a
standalone node.

ONE LEVEL ONLY. Expand one step out from what was just discussed. Do not
elaborate a proposal you made yourself. Do not go back and re-open an area
the conversation left ten minutes ago. If you can see three levels down, say
so in a question rather than drawing all three.

WHAT TO PROPOSE — MISSING WIRING BETWEEN EXISTING CONCEPTS. This is a second,
separate job, and it is not one level only: read the whole current map for it.
People describe their situation in pieces, and a business analyst's real work
is noticing when two pieces they described separately are actually the same
system. A cluster about checkout and a cluster about refunds are not two
unrelated topics — a refund undoes an order, so they connect. If you can see
two concepts, or two clusters of concepts, that clearly interact but have no
relationship recorded between them yet, propose that relationship. This is
the single highest-value thing you can find, because it turns two small
diagrams into one coherent one.

A relationship label is a precise business verb phrase, chosen for what
actually happens between the two things, never the filler "relates to":
"triggers", "depends on", "feeds", "produces", "consumes", "owns",
"authorizes", "blocks", "escalates to", "reports to", "validates". If none of
these fit, use the speaker's own domain vocabulary before falling back to
something generic.

Only ever reference ids of concepts already on the map for this. Never invent
a new node to justify a connection — if the link needs an unmentioned
in-between step, propose that step as a new concept instead, through the
normal one-level path above.

NEVER REPEAT A REJECTION. You are given a list of things the user has already
thrown out, with the reason each was originally proposed. Do not propose them
again in any wording. This is not a preference.

QUESTIONS. Up to 3, phrased for the person you are talking to, not for a
developer. Rank 1 to 5, where 5 means answering it unblocks the most. A good
question is one they can answer in a sentence. This list is separate from any
concept you gave kind QUESTION — use this list for things too open-ended to
attach anywhere on the map yet, and kind QUESTION for a question that hangs
off a specific existing concept.

Propose fewer, better things. Six vague proposals are worse than two sharp
ones, and the user will stop reading orange entirely if you waste their
attention. The same discipline applies to wiring: one connection that
actually joins two clusters beats three that restate an edge already on the
map.
`.trim();

export function extractUser(input: {
  text: string;
  concepts: { id: string; label: string; note: string; status: string }[];
}): string {
  const list = input.concepts.length
    ? input.concepts.map((c) => `  ${c.id}  ${c.label}${c.note ? ` (${c.note})` : ''}`).join('\n')
    : '  (the map is empty)';

  return `CONCEPTS ALREADY ON THE MAP\n${list}\n\nWHAT THE PERSON JUST SAID\n"""\n${input.text}\n"""`;
}

export function proposeUser(payload: {
  title: string;
  concepts: { id: string; label: string; note: string; status: string; kind: string }[];
  relationships: { from: string; to: string; label: string; status: string }[];
  rejected: { label: string; why: string }[];
  openQuestions: string[];
  recentStatements: string[];
}): string {
  const concepts = payload.concepts.length
    ? payload.concepts
        .map((c) => `  ${c.id}  [${c.status}] ${c.label}${c.note ? ` (${c.note})` : ''}`)
        .join('\n')
    : '  (none)';

  const rels = payload.relationships.length
    ? payload.relationships.map((r) => `  ${r.from} --${r.label}--> ${r.to}`).join('\n')
    : '  (none)';

  const rejected = payload.rejected.length
    ? payload.rejected.map((r) => `  "${r.label}" — rejected${r.why ? `, was proposed because: ${r.why}` : ''}`).join('\n')
    : '  (nothing rejected yet)';

  const questions = payload.openQuestions.length
    ? payload.openQuestions.map((q) => `  - ${q}`).join('\n')
    : '  (none)';

  const recent = payload.recentStatements.length
    ? payload.recentStatements.map((s) => `  - ${s}`).join('\n')
    : '  (none)';

  return [
    `SUBJECT: ${payload.title}`,
    ``,
    `CURRENT MAP`,
    concepts,
    ``,
    `RELATIONSHIPS`,
    rels,
    ``,
    `DO NOT PROPOSE THESE — the user rejected them`,
    rejected,
    ``,
    `QUESTIONS ALREADY OPEN — do not repeat these either`,
    questions,
    ``,
    `WHAT WAS SAID RECENTLY`,
    recent,
  ].join('\n');
}

// ---------------------------------------------------------------- preload

export const MERGE_SYSTEM = `
You are reconciling one project map that was built by reading several
documents separately. Each document produced its own concepts, so the same
thing often appears twice under different names, and two documents sometimes
say things that cannot both be true.

You are given a list of candidate PAIRS. For each pair, return exactly one
verdict.

SAME. One thing, two names. "Hire period" and "rental window" are the same
thing if the documents are talking about the same period. Set keepLabel to
whichever of the two labels a person would recognise faster, copied exactly.
Never write a third label. If neither label is clearly better, copy the first.

RELATED. Two genuinely different things that belong next to each other with a
link. "Deposit" and "Refund" are not the same thing, and there is a real verb
between them. Give that verb in relationLabel. Never the filler "relates to".

CONFLICT. The same thing, but the sources disagree about it. A cancellation
window of 14 days in one document and 7 days in another is a conflict, not two
concepts. A price that changed, a role that moved, a rule that was rewritten:
all conflicts. Put what actually disagrees in conflictSummary, with both
values named, in one sentence.

If a pair is none of these, leave it out of your answer entirely. An omitted
pair is a correct and useful answer, and it is much better than a guessed SAME.

Two rules that are not preferences.

You may only use the ids exactly as they appear in the pair list. An id you
invent will be dropped and counted against this prompt.

keepLabel must be one of the two labels in that pair, character for character.
A new phrase, a merged phrase or a tidied-up version of either label will be
refused.

Be conservative. Two concepts wrongly merged destroy a map that a person then
has to unpick by hand. Two concepts left separate cost one extra node, and the
person can merge them in a click.
`.trim();

export const CLUSTER_SYSTEM = `
You are grouping a project map into areas so that a person can read it from
the top down.

Return between 5 and 9 areas covering as many of the concepts as you can. An
area is a heading a person would recognise from the documents: "Booking",
"Payments", "Fulfilment", "Support". Use the vocabulary the documents use, not
generic project words like "Process" or "Other".

Put a concept in the area it mostly belongs to. Every concept goes in at most
one area. Use ids exactly as given; an invented id is dropped.

The test of a good grouping is that most of the relationships stay INSIDE an
area rather than crossing between areas. Concepts that are heavily connected
to each other belong together, even when their labels look unrelated.

Leave a concept out only when it genuinely fits nowhere. Anything you leave
out will be shown to the user in a group called "Not yet grouped", so leaving
things out is honest, not free.
`.trim();

export function mergeUser(payload: {
  title: string;
  sources: { id: string; name: string; role: string }[];
  pairs: {
    aId: string;
    aLabel: string;
    aNote: string;
    aSource: string;
    bId: string;
    bLabel: string;
    bNote: string;
    bSource: string;
    why: string;
  }[];
}): string {
  const sources = payload.sources.length
    ? payload.sources.map((s) => `  ${s.id}  ${s.name}  [${s.role}]`).join('\n')
    : '  (none)';

  const pairs = payload.pairs
    .map(
      (p, i) =>
        `  ${i + 1}. found by: ${p.why}\n` +
        `     A  ${p.aId}  "${p.aLabel}"${p.aNote ? ` (${p.aNote})` : ''}  from ${p.aSource}\n` +
        `     B  ${p.bId}  "${p.bLabel}"${p.bNote ? ` (${p.bNote})` : ''}  from ${p.bSource}`
    )
    .join('\n\n');

  return [
    `SUBJECT: ${payload.title}`,
    ``,
    `DOCUMENTS`,
    sources,
    ``,
    `CANDIDATE PAIRS`,
    pairs || '  (none)',
  ].join('\n');
}

export function clusterUser(payload: {
  title: string;
  concepts: { id: string; label: string; kind: string }[];
  relationships: { from: string; to: string; label: string }[];
  /** Filled in on the second attempt only, with the links the last try cut. */
  crossings: { from: string; to: string; label: string }[];
}): string {
  const concepts = payload.concepts.map((c) => `  ${c.id}  [${c.kind}] ${c.label}`).join('\n');
  const rels = payload.relationships.map((r) => `  ${r.from} --${r.label}--> ${r.to}`).join('\n');

  const retry = payload.crossings.length
    ? [
        ``,
        `YOUR LAST GROUPING CUT THROUGH THESE LINKS. Concepts joined by a link`,
        `usually belong in the same area. Try again with that in mind.`,
        ...payload.crossings.map((c) => `  "${c.from}" --${c.label}--> "${c.to}"`),
      ].join('\n')
    : '';

  return [
    `SUBJECT: ${payload.title}`,
    ``,
    `CONCEPTS`,
    concepts || '  (none)',
    ``,
    `RELATIONSHIPS`,
    rels || '  (none)',
    retry,
  ].join('\n');
}

/**
 * Stage 1 framing. EXTRACT_SYSTEM itself is untouched, per the standard: what
 * changes for a document is the user message, never the system prompt.
 */
export function extractDocumentUser(input: {
  sourceName: string;
  role: string;
  locator: string;
  text: string;
  concepts: { id: string; label: string; note: string; status: string }[];
}): string {
  const list = input.concepts.length
    ? input.concepts.map((c) => `  ${c.id}  ${c.label}${c.note ? ` (${c.note})` : ''}`).join('\n')
    : '  (nothing recorded from this document yet)';

  return [
    `CONCEPTS ALREADY RECORDED FROM THIS DOCUMENT`,
    list,
    ``,
    `THIS IS AN EXTRACT FROM A ${input.role} DOCUMENT: ${input.sourceName} (${input.locator})`,
    `Treat it exactly as you would treat something a person said out loud.`,
    `Record what it states. Record nothing it merely implies.`,
    ``,
    `"""`,
    input.text,
    `"""`,
  ].join('\n');
}
