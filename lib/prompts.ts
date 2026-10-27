/*
 * Prompts are behaviour. Treat a change here the same way you would treat a
 * change to the reducer: version it, and re-run the fixtures before a session.
 *
 * PROMPT_VERSION is written into the session file so a saved run can be tied
 * back to the wording that produced it.
 */

export const PROMPT_VERSION = 'p8-2026-10-27';

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
  /** Real-time only (RT-US-08). Printed only when there are any, so other callers get the same prompt as before. */
  openQuestions?: { id: string; text: string }[];
}): string {
  const list = input.concepts.length
    ? input.concepts.map((c) => `  ${c.id}  ${c.label}${c.note ? ` (${c.note})` : ''}`).join('\n')
    : '  (the map is empty)';
  const open = input.openQuestions ?? [];
  const questions = open.length
    ? `\n\nOPEN QUESTIONS\n${open.map((q) => `  ${q.id}  ${q.text}`).join('\n')}`
    : '';

  return `CONCEPTS ALREADY ON THE MAP\n${list}${questions}\n\nWHAT THE PERSON JUST SAID\n"""\n${input.text}\n"""`;
}

/*
 * Real-time only. Appended to EXTRACT_SYSTEM by app/api/extract/route.ts.
 * Preload reads documents with EXTRACT_SYSTEM alone.
 */
export const EXTRACT_REALTIME_RULES = `
ANSWERS. You may be given OPEN QUESTIONS that were asked earlier in the
session. Put a question's id in answersQuestionIds only when the person's
words clearly answer it. A partial answer, a maybe, or the same topic
without an answer is not an answer: leave the id out. Whatever they said is
still recorded as concepts in the usual way. If no question is answered,
answersQuestionIds is an empty array.
`.trim();

/*
 * Real-time only. Appended to PROPOSE_SYSTEM by app/api/propose/route.ts.
 * Preload's pipeline uses PROPOSE_SYSTEM on its own, so none of this reaches
 * a document run.
 */
export const PROPOSE_REALTIME_RULES = `
LIVE SESSION RULES. These come on top of everything above and win where
they differ.

GOAL. The person told you what they want to get out of this conversation.
Everything you propose must help them reach that goal. A gap that does not
matter for the goal is not worth their attention: leave it out, however
true it is.

THE WHOLE CONVERSATION. You are given everything said so far, oldest first,
not only the last few lines. Read all of it before you propose anything.

NO ECHO. Never propose something the person already said. If it appears
anywhere in THE WHOLE CONVERSATION SO FAR, it is already on the map in their
words and does not need a yes or no from them.

QUESTIONS. At most 2 per turn in total, counting concepts of kind QUESTION
and the questions list together. Ask only what moves the goal forward. Give
each list question a "why": one short line on how answering it helps the
goal. When a question is about something already on the map, put that
concept's id in attachTo, so the question appears next to it. Use an empty
string only when it is about nothing on the map yet.

CLOSED TOPICS. Never ask again a question listed as answered or closed, in
any wording. When the person has answered or closed a topic, stop digging
into it. Go back to it only if their latest words reopen it.

FOCUS. When you are given a FOCUS list, the person has just answered a
question about those concepts. Propose only things attached to an id in that
list: new concepts whose attachTo is one of them, links with at least one end
in it, and questions whose attachTo is one of them. Anything else is dropped.
`.trim();

export function proposeUser(payload: {
  title: string;
  concepts: { id: string; label: string; note: string; status: string; kind: string }[];
  relationships: { from: string; to: string; label: string; status: string }[];
  rejected: { label: string; why: string }[];
  openQuestions: string[];
  recentStatements: string[];
  // Real-time only. Each block below prints only when it has content, so a
  // Preload payload, which leaves them empty, produces the same prompt as before.
  goal?: string;
  conversation?: string[];
  omittedStatements?: number;
  answeredQuestions?: { text: string; answer: string }[];
  closedQuestions?: string[];
  /** RT-US-07. After an answer on a card: the ids every proposal must attach to. */
  focusIds?: string[];
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

  const goal = (payload.goal ?? '').trim();
  const conversation = payload.conversation ?? [];
  const answered = payload.answeredQuestions ?? [];
  const closed = payload.closedQuestions ?? [];

  const said = conversation.length
    ? [
        `THE WHOLE CONVERSATION SO FAR, oldest first`,
        ...(payload.omittedStatements
          ? [`  (${payload.omittedStatements} earlier statements left out for length)`]
          : []),
        conversation.map((s) => `  ${s}`).join('\n'),
      ]
    : [`WHAT WAS SAID RECENTLY`, recent];

  return [
    ...(goal ? [`GOAL OF THIS SESSION: ${goal}`, ``] : []),
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
    ...(answered.length
      ? [``, `QUESTIONS ALREADY ANSWERED — never ask these again`, answered.map((q) => `  - ${q.text} Answer: ${q.answer}`).join('\n')]
      : []),
    ...(closed.length
      ? [``, `QUESTIONS THE PERSON CLOSED — never ask these again, in any wording`, closed.map((q) => `  - ${q}`).join('\n')]
      : []),
    ``,
    ...said,
    ...(payload.focusIds?.length
      ? [``, `FOCUS: only propose things attached to these ids: ${payload.focusIds.join(', ')}`]
      : []),
  ].join('\n');
}

// ---------------------------------------------------------------- Finish

/*
 * RT-US-13. At Finish, after the person has reviewed the open questions:
 * what to talk about next time. Text only, nothing reaches the map.
 */
export const WRAPUP_SYSTEM = `
A live session has ended. You are given its goal, everything that was said,
the map the person confirmed, the questions they kept for next time, and the
topics they answered or closed.

Suggest up to 5 topics for the NEXT conversation, each one a step towards the
goal. A topic is 2 to 8 words in the person's own vocabulary. Its "why" is
one line on how talking about it moves the goal forward.

Never suggest a topic the person closed or already answered, in any wording.
A kept question may become a topic when several of them belong together.
Prefer what is missing for the goal over what is already well covered.

Fewer is better. If the session left nothing worth continuing, return an
empty list.
`.trim();

export function wrapupUser(payload: {
  goal: string;
  conversation: string[];
  omittedStatements: number;
  concepts: { id: string; label: string; note: string; kind: string }[];
  relationships: { from: string; to: string; label: string }[];
  keptQuestions: string[];
  answeredQuestions: { text: string; answer: string }[];
  closedQuestions: string[];
}): string {
  const lines = (items: string[], empty = '  (none)') => (items.length ? items.map((s) => `  - ${s}`).join('\n') : empty);
  return [
    `GOAL OF THE SESSION: ${payload.goal.trim() || '(not set)'}`,
    ``,
    `WHAT WAS SAID, oldest first`,
    ...(payload.omittedStatements ? [`  (${payload.omittedStatements} earlier statements left out for length)`] : []),
    lines(payload.conversation),
    ``,
    `THE MAP THE PERSON CONFIRMED`,
    lines(payload.concepts.map((c) => `[${c.kind}] ${c.label}${c.note ? ` (${c.note})` : ''}`)),
    ``,
    `LINKS`,
    lines(payload.relationships.map((r) => `${r.from} --${r.label}--> ${r.to}`)),
    ``,
    `QUESTIONS KEPT FOR NEXT TIME`,
    lines(payload.keptQuestions),
    ``,
    `ANSWERED — do not suggest these`,
    lines(payload.answeredQuestions.map((q) => `${q.text} Answer: ${q.answer}`)),
    ``,
    `CLOSED BY THE PERSON — never suggest these`,
    lines(payload.closedQuestions),
  ].join('\n');
}

// ---------------------------------------------------------------- answers

/*
 * A person answered a QUESTION box on the map. Both modes use this call: the
 * live session from the box on its canvas, Preload from the box on its map.
 * It is Call 1 with a question attached, plus the one thing Call 1 cannot do:
 * change what is already on the map when the answer says it is wrong.
 */
export const ANSWER_SYSTEM = `
A question was shown on a map of someone's situation, and the person has
answered it. You turn the answer into changes to the map.

YOUR ONE RULE: record only what the answer says. Nothing it merely suggests.

NEW THINGS. Anything the answer states that is not on the map yet goes in
concepts, exactly as you would record it from speech: short labels in the
person's words, a note for the detail or value they gave, the right kind.
If the answer talks about something already on the map, put its id in
matchesExistingId instead of making a second box.

CONNECT IT. The question is about one concept, named below. Connect what the
answer says to that concept with a relationship in the person's own verb, or
make it a property of that concept with belongsTo. Use ids or tempIds.

CHANGES TO WHAT IS THERE. When the answer corrects or sharpens something
already on the map, put it in updates: its id, the corrected label or the
corrected note, and an empty string for whichever stays the same. "It is 7
days, not 14" changes the note of the cancellation window. A new detail
about an existing thing is a note update, not a new box.

GUESSES. Items marked [PROPOSED] are the AI's guesses. If the answer says a
guess is right, put its id in confirms. If the answer says a guess is wrong
or does not apply, put its id in rejects. Never reject an item marked
[VALIDATED]: if the answer contradicts it, correct it through updates.

DID IT ANSWER. answersQuestion is true when the answer settles the question.
It is false when the person does not know, puts it off, or answers only part
of it. What they did say is still recorded either way.

Use only ids from the map below. An empty answer in every array is correct
when the person said nothing that changes the map.

${KIND_VOCAB}
`.trim();

export type AnswerInput = {
  goal: string;
  question: { id: string; text: string; why: string };
  anchor: { id: string; label: string; note: string } | null;
  concepts: { id: string; label: string; note: string; status: string; kind: string }[];
  relationships: { from: string; to: string; label: string }[];
  answer: string;
};

export function answerUser(input: AnswerInput): string {
  const concepts = input.concepts.length
    ? input.concepts.map((c) => `  ${c.id}  [${c.status}] ${c.label}${c.note ? ` (${c.note})` : ''}`).join('\n')
    : '  (the map is empty)';
  const rels = input.relationships.length
    ? input.relationships.map((r) => `  ${r.from} --${r.label}--> ${r.to}`).join('\n')
    : '  (none)';
  const about = input.anchor
    ? `It is about "${input.anchor.label}" (${input.anchor.id})${input.anchor.note ? `: ${input.anchor.note}` : ''}.`
    : 'It is not attached to any concept.';

  return [
    ...(input.goal.trim() ? [`GOAL OF THIS SESSION: ${input.goal.trim()}`, ``] : []),
    `CURRENT MAP`,
    concepts,
    ``,
    `RELATIONSHIPS`,
    rels,
    ``,
    `THE QUESTION (${input.question.id}): ${input.question.text}`,
    ...(input.question.why ? [`Why it was asked: ${input.question.why}`] : []),
    about,
    ``,
    `THE PERSON'S ANSWER`,
    `"""`,
    input.answer,
    `"""`,
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
 *
 * When the document has a skeleton, each section is read knowing it: the
 * main point and the parts are listed as concepts already recorded, so a
 * section that talks about one of them says so through matchesExistingId
 * instead of creating a second box, and its links can reach across sections.
 */
export function extractDocumentUser(input: {
  sourceName: string;
  role: string;
  locator: string;
  text: string;
  concepts: { id: string; label: string; note: string; status: string }[];
  /** The part of the skeleton this section belongs to, when there is one. */
  part?: { id: string; label: string } | null;
}): string {
  const list = input.concepts.length
    ? input.concepts.map((c) => `  ${c.id}  ${c.label}${c.note ? ` (${c.note})` : ''}`).join('\n')
    : '  (nothing recorded from this document yet)';

  return [
    `CONCEPTS ALREADY RECORDED FROM THIS DOCUMENT`,
    list,
    ``,
    `THIS IS AN EXTRACT FROM A ${input.role} DOCUMENT: ${input.sourceName} (${input.locator})`,
    input.part ? `It belongs to the part "${input.part.label}" (${input.part.id}).` : '',
    `Treat it exactly as you would treat something a person said out loud.`,
    `Record what it states. Record nothing it merely implies.`,
    ``,
    DOCUMENT_KIND_NOTE,
    input.part
      ? `When the extract itself connects what it says to "${input.part.label}" or to another concept above, record that relationship with its id. Do not invent a link the text does not make.`
      : '',
    ``,
    `"""`,
    input.text,
    `"""`,
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n');
}

/** Documents argue as well as describe. One extra kind, offered in the user message only. */
const DOCUMENT_KIND_NOTE = `
ONE MORE KIND FOR DOCUMENTS: CLAIM. A statement the document asserts, tests or
concludes, labelled as a short statement: "Benefit matters more than ease of
use", "Confidence acts as a filter". When the document gives a verdict on it
(supported, partly supported, not supported, rejected), start the note with
that verdict. Use CLAIM for what the document argues; keep ENTITY for things.
`.trim();

export const OUTLINE_SYSTEM = `
You read one whole document and return its skeleton: what a person needs to
see first to understand how the document is built and where it is going.

MAIN. The one thing the document is about, or the one point it reaches. A
report, thesis or proposal usually reaches a point: give it as a CLAIM. A
specification, manual or price list is usually about something: give that
thing with the kind that fits it.

PARTS. The document's parts in the order it presents them. Use its own
headings when it has them; a part may cover several sections, and every
section belongs to exactly one part. Three to nine parts for a long document,
fewer for a short one. A label is 1-6 words in the document's vocabulary. The
note is one sentence on what the part says, not what it is about: "Owners'
confidence decides how they read each condition", not "Discussion of
confidence". When a part tests a claim, start the note with the verdict.

LINKS. How the parts connect to each other and to MAIN, as the document
connects them, through what it says or through its order. Up to twelve.
Prefer the links a reader most needs to follow the line of thought.

QUOTES. Every item has a quote: one sentence copied from the document
character for character that states it, or a heading copied exactly. If no
sentence states it, the quote is an empty string. A quote that cannot be found
in the document is thrown away and the item is shown as your reading, not as
something the document says. Never shorten, tidy or paraphrase a quote.

Record what the document says. Do not judge it, improve it, or add parts it
does not have.
`.trim();

/**
 * The whole document when it fits, otherwise each section's opening, so even
 * a long report gets one look at its shape before any section is read alone.
 */
export function outlineUser(input: {
  sourceName: string;
  role: string;
  title: string;
  sections: { id: string; locator: string; text: string }[];
  budget?: number;
}): string {
  const budget = input.budget ?? 60000;
  const total = input.sections.reduce((n, s) => n + s.text.length, 0);
  const per = total <= budget ? Infinity : Math.max(300, Math.floor(budget / Math.max(1, input.sections.length)));
  const body = input.sections
    .map((s) => {
      const text = s.text.length > per ? `${s.text.slice(0, per)} [...]` : s.text;
      return `[${s.id}] ${s.locator}\n${text}`;
    })
    .join('\n\n');

  return [
    `DOCUMENT: ${input.sourceName} (${input.role})`,
    input.title && !/^untitled/i.test(input.title) ? `THE PERSON CALLED THIS PROJECT: ${input.title}` : '',
    total > budget ? `Long document: each section below is cut to its opening.` : '',
    ``,
    `SECTIONS`,
    body,
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n');
}

// ---------------------------------------------------------------- read-back

/*
 * KVIF P7, grounding. Every few turns, the live session reads the map back to
 * the person in a few plain lines and asks "Did I get this right?". A yes
 * confirms the guesses a line rests on; a correction is sent as an ordinary
 * turn. Text only: this call cannot add anything to the map.
 */
export const RECAP_SYSTEM = `
You read a live map back to the person, so they can tell you whether you
understood them. Write up to 4 short lines, in their own words, about what
matters most for their goal.

Each line is one sentence a person could answer with "yes" or "not quite".
Name the ids of the concepts each line rests on in conceptIds.

Cover what is most useful to check, not everything. Include the guesses
(items marked [PROPOSED]) that matter most for the goal: those are the ones
worth a yes or no. When something important is still unknown, one line may
say so, with kind OPEN.

kind is CONFIRMED only when every concept a line rests on is [VALIDATED].
A line that rests on any [PROPOSED] item is a GUESS. Never word a guess as
if it were settled.

Do not add anything that is not on the map or in the conversation.
`.trim();

export function recapUser(payload: {
  goal: string;
  conversation: string[];
  omittedStatements: number;
  concepts: { id: string; label: string; note: string; status: string; kind: string }[];
  relationships: { from: string; to: string; label: string; status: string }[];
  openQuestions: string[];
}): string {
  const lines = (items: string[]) => (items.length ? items.map((s) => `  ${s}`).join('\n') : '  (none)');
  return [
    `GOAL OF THIS SESSION: ${payload.goal.trim() || '(not set)'}`,
    ``,
    `CURRENT MAP`,
    lines(payload.concepts.map((c) => `${c.id}  [${c.status}] ${c.label}${c.note ? ` (${c.note})` : ''}`)),
    ``,
    `RELATIONSHIPS`,
    lines(payload.relationships.map((r) => `${r.from} --${r.label}--> ${r.to}${r.status === 'PROPOSED' ? ' [PROPOSED]' : ''}`)),
    ``,
    `OPEN QUESTIONS`,
    lines(payload.openQuestions.map((q) => `- ${q}`)),
    ``,
    `WHAT WAS SAID, oldest first`,
    ...(payload.omittedStatements ? [`  (${payload.omittedStatements} earlier statements left out for length)`] : []),
    lines(payload.conversation),
  ].join('\n');
}
