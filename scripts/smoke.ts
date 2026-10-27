/*
 * Offline smoke test for the pure core. No network, no API key, no React.
 *
 *   npm run smoke
 *
 * This is the thing to run after touching the reducer or the guards. It feeds
 * hand-written patches through the same code path the LLM uses, and checks the
 * four behaviours that would embarrass you in a live session:
 *
 *   1. green appears and orange appears, correctly labelled
 *   2. a rejected proposal never comes back
 *   3. saying something out loud lifts an earlier rejection
 *   4. duplicates merge instead of piling up
 *
 * Plus, since the shape-by-kind change: kind/belongsTo/level correctness —
 * ownership, orphan downgrade, cycle refusal, and re-parenting on reject.
 */

import { emptyModel, normaliseModel, resolveKind } from '../lib/types';
import { saidThisTurn } from '../lib/guards';
import {
  activeQuestions,
  dismissAny,
  laterQuestions,
  parkQuestion,
  unparkQuestion,
  answerPayload,
  answeredQuestions,
  applyAnswer,
  applyExtract,
  applyPropose,
  closedQuestions,
  confirmConcept,
  contextPayload,
  conversationWindow,
  dismissQuestion,
  setGoal,
  withCallMeta,
  confirmRelationship,
  rejectConcept,
  rejectRelationship,
  visibleConcepts,
  visibleRelationships,
} from '../lib/reducer';

let failures = 0;
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

let m = emptyModel('s_test');

// ---- turn 1: the speaker says something -------------------------------------
({ model: m } = applyExtract(
  m,
  {
    concepts: [
      { tempId: 'n1', label: 'Unison Choir', note: '', matchesExistingId: '', kind: 'ENTITY', belongsTo: '' },
      { tempId: 'n2', label: 'Payment Process', note: '', matchesExistingId: '', kind: 'STEP', belongsTo: '' },
    ],
    relationships: [{ from: 'n1', to: 'n2', label: 'has' }],
  },
  'I am working on the payment process for my Unison choir.'
));

check('two green concepts', visibleConcepts(m).length === 2);
check('both EXPLICIT + VALIDATED', m.concepts.every((c) => c.origin === 'EXPLICIT' && c.status === 'VALIDATED'));
check('one relationship', m.relationships.length === 1);
check('nodes are not stacked', m.concepts[0].x !== m.concepts[1].x || m.concepts[0].y !== m.concepts[1].y);
check('turn is 1', m.turn === 1);

// ---- the AI proposes ---------------------------------------------------------
const payer = m.concepts.find((c) => c.label === 'Payment Process')!;
({ model: m } = applyPropose(
  m,
  {
    concepts: [
      {
        tempId: 'p1',
        label: 'Who pays?',
        why: 'A payment process implies a payer.',
        attachTo: payer.id,
        relationLabel: 'performed by',
        kind: 'ACTOR',
        isPropertyOfTarget: false,
      },
      {
        tempId: 'p2',
        label: 'Payment method',
        why: 'Not stated.',
        attachTo: payer.id,
        relationLabel: 'uses',
        kind: 'ENTITY',
        isPropertyOfTarget: false,
      },
      {
        tempId: 'p3',
        label: 'Nowhere',
        why: 'orphan',
        attachTo: 'does_not_exist',
        relationLabel: 'x',
        kind: 'ENTITY',
        isPropertyOfTarget: false,
      },
    ],
    relationships: [],
    questions: [{ text: 'Who actually pays, the member or a parent?', usefulness: 5 }],
  },
  5
));

check('two orange concepts landed', m.concepts.filter((c) => c.status === 'PROPOSED').length === 2);
check('all proposals are INFERRED', m.concepts.filter((c) => c.status === 'PROPOSED').every((c) => c.origin === 'INFERRED'));
check('unattached proposal was dropped', !m.concepts.some((c) => c.label === 'Nowhere'));
check('one open question', m.questions.filter((q) => q.status === 'OPEN').length === 1);

// ---- the user rejects one ----------------------------------------------------
const method = m.concepts.find((c) => c.label === 'Payment method')!;
m = rejectConcept(m, method.id);

check('rejected node is hidden', !visibleConcepts(m).some((c) => c.id === method.id));
check('rejection is in the ledger', m.rejected.some((r) => r.label.includes('payment method')));

// ---- the AI tries the same thing again, in different wording ------------------
({ model: m } = applyPropose(
  m,
  {
    concepts: [
      {
        tempId: 'p4',
        label: 'The payment methods',
        why: 'still not stated',
        attachTo: payer.id,
        relationLabel: 'uses',
        kind: 'ENTITY',
        isPropertyOfTarget: false,
      },
    ],
    relationships: [],
    questions: [],
  },
  5
));

check('rejected item did not come back', !visibleConcepts(m).some((c) => /payment method/i.test(c.label)));

// ---- the user confirms a proposal --------------------------------------------
const whoPays = m.concepts.find((c) => c.label === 'Who pays?')!;
m = confirmConcept(m, whoPays.id);
const confirmed = m.concepts.find((c) => c.id === whoPays.id)!;

check('confirmed proposal is now green', confirmed.status === 'VALIDATED');
check('origin still records it was a guess', confirmed.origin === 'INFERRED');
check('its edge went green too', m.relationships.find((r) => r.to === whoPays.id)!.status === 'VALIDATED');

// ---- saying a rejected thing out loud brings it back --------------------------
({ model: m } = applyExtract(
  m,
  {
    concepts: [
      { tempId: 'n3', label: 'Payment method', note: 'bank transfer', matchesExistingId: '', kind: 'ENTITY', belongsTo: '' },
    ],
    relationships: [],
  },
  'Payment method is bank transfer.'
));

check('speech overrides an earlier rejection', visibleConcepts(m).some((c) => c.label === 'Payment method'));
check('the ledger entry was cleared', !m.rejected.some((r) => r.label.includes('payment method')));

// ---- duplicates merge --------------------------------------------------------
const before = visibleConcepts(m).length;
({ model: m } = applyExtract(
  m,
  {
    concepts: [{ tempId: 'n4', label: 'the Unison Choirs', note: '', matchesExistingId: '', kind: 'ENTITY', belongsTo: '' }],
    relationships: [],
  },
  'The Unison choir meets weekly.'
));

check('near-duplicate merged, no new node', visibleConcepts(m).length === before, `${before} -> ${visibleConcepts(m).length}`);

// ---- the cap -----------------------------------------------------------------
const anchor = m.concepts.find((c) => c.status === 'VALIDATED')!;
const many = Array.from({ length: 9 }, (_, i) => ({
  tempId: `x${i}`,
  label: `Extra thing ${i}`,
  why: 'test',
  attachTo: anchor.id,
  relationLabel: 'relates to',
  kind: 'ENTITY' as const,
  isPropertyOfTarget: false,
}));
const openBefore = m.questions.filter((q) => q.status === 'OPEN').length;
const capped = applyPropose(m, { concepts: many, relationships: [], questions: [] }, 5);

check('cap held at 5', capped.blocked.capped === 4);
check(
  'overflow became questions, nothing lost',
  capped.model.questions.filter((q) => q.status === 'OPEN').length > openBefore
);

// ---- the AI wires two existing clusters together -------------------------------
({ model: m } = applyExtract(
  m,
  {
    concepts: [
      { tempId: 's1', label: 'Support Team', note: '', matchesExistingId: '', kind: 'ACTOR', belongsTo: '' },
      { tempId: 's2', label: 'Refunds', note: '', matchesExistingId: '', kind: 'STEP', belongsTo: '' },
    ],
    relationships: [{ from: 's1', to: 's2', label: 'handles' }],
  },
  'The support team handles refunds through a separate system.'
));

const choir = m.concepts.find((c) => c.label === 'Unison Choir')!;
const refunds = m.concepts.find((c) => c.label === 'Refunds')!;
const relBefore = visibleRelationships(m).length;

({ model: m } = applyPropose(
  m,
  {
    concepts: [],
    relationships: [
      { from: choir.id, to: refunds.id, label: 'issues', why: 'A choir that takes payments also issues refunds.' },
      { from: refunds.id, to: choir.id, label: 'reverses', why: 'duplicate pair, should still cap/count separately' },
    ],
    questions: [],
  },
  5
));

const bridge = m.relationships.find((r) => r.from === choir.id && r.to === refunds.id);
check('cross-cluster link proposed', !!bridge);
check('bridge is INFERRED + PROPOSED', bridge?.origin === 'INFERRED' && bridge?.status === 'PROPOSED');
check('bridge uses the precise verb, not "relates to"', bridge?.label === 'issues');
check('two distinct edges landed, not deduped as one pair', visibleRelationships(m).length === relBefore + 2);

// ---- proposing the exact same link again is a no-op ---------------------------
const relBefore2 = m.relationships.length;
({ model: m } = applyPropose(
  m,
  {
    concepts: [],
    relationships: [{ from: choir.id, to: refunds.id, label: 'issues', why: 'restated' }],
    questions: [],
  },
  5
));
check('exact duplicate link was not re-added', m.relationships.length === relBefore2);

// ---- the user confirms and rejects relationship proposals directly ------------
m = confirmRelationship(m, bridge!.id);
check('confirmed bridge is now VALIDATED', m.relationships.find((r) => r.id === bridge!.id)?.status === 'VALIDATED');

const reverses = m.relationships.find((r) => r.from === refunds.id && r.to === choir.id)!;
m = rejectRelationship(m, reverses.id);
check('rejected bridge is hidden', !visibleRelationships(m).some((r) => r.id === reverses.id));

// ==============================================================================
// shape-by-kind: ownership, level, downgrade, cycles, re-parenting
// ==============================================================================

// ---- attribute one level deep -------------------------------------------------
let k = emptyModel('s_kind');
({ model: k } = applyExtract(
  k,
  {
    concepts: [
      { tempId: 'r1', label: 'Costume Rental', note: '', matchesExistingId: '', kind: 'ENTITY', belongsTo: '' },
      { tempId: 'r2', label: 'Home delivery', note: '', matchesExistingId: '', kind: 'ATTRIBUTE', belongsTo: 'r1' },
    ],
    relationships: [{ from: 'r1', to: 'r2', label: 'includes' }],
  },
  'We rent costumes, with home delivery.'
));

const rental = k.concepts.find((c) => c.label === 'Costume Rental')!;
const delivery = k.concepts.find((c) => c.label === 'Home delivery')!;
check('attribute with a valid belongsTo gets level 1', delivery.belongsTo === rental.id && delivery.level === 1);
check('attribute kind survived (not downgraded)', delivery.kind === 'ATTRIBUTE');

// ---- attribute two deep ---------------------------------------------------------
({ model: k } = applyExtract(
  k,
  {
    concepts: [
      { tempId: 'r3', label: 'Overnight fee', note: '', matchesExistingId: '', kind: 'ATTRIBUTE', belongsTo: delivery.id },
    ],
    relationships: [{ from: delivery.id, to: 'r3', label: 'costs extra' }],
  },
  'Home delivery has an overnight fee.'
));
const fee = k.concepts.find((c) => c.label === 'Overnight fee')!;
check('attribute two deep gets level 2', fee.belongsTo === delivery.id && fee.level === 2);

// ---- orphan attribute is downgraded, not dropped --------------------------------
({ model: k } = applyExtract(
  k,
  {
    concepts: [
      { tempId: 'r4', label: 'Loose fee', note: '', matchesExistingId: '', kind: 'ATTRIBUTE', belongsTo: 'does_not_exist' },
    ],
    relationships: [],
  },
  'There is also a loose fee, unrelated to anything.'
));
const loose = k.concepts.find((c) => c.label === 'Loose fee')!;
check(
  'ATTRIBUTE with an unresolvable belongsTo is downgraded to ENTITY, not dropped',
  !!loose && loose.kind === 'ENTITY' && loose.belongsTo === '' && loose.level === 0
);

// ---- a belongsTo that would create a cycle is refused ---------------------------
const cyclesBefore = k.log.filter((l) => l.kind === 'extract').length;
const blockedBefore = k.log.length;
const cycleResult = applyExtract(
  k,
  {
    concepts: [
      { tempId: 'c1', label: 'Mutual A', note: '', matchesExistingId: '', kind: 'ATTRIBUTE', belongsTo: 'c2' },
      { tempId: 'c2', label: 'Mutual B', note: '', matchesExistingId: '', kind: 'ATTRIBUTE', belongsTo: 'c1' },
    ],
    relationships: [],
  },
  'Mutual A and Mutual B, each supposedly a property of the other.'
);
k = cycleResult.model;
const mutualA = k.concepts.find((c) => c.label === 'Mutual A')!;
const mutualB = k.concepts.find((c) => c.label === 'Mutual B')!;
check(
  'a belongsTo that would create a cycle is refused, concept survives with belongsTo ""',
  !!mutualA && !!mutualB && (mutualA.belongsTo === '' || mutualB.belongsTo === '')
);
check('blocked.cycles increments when that happens', cycleResult.blocked.cycles === 1);
void cyclesBefore;
void blockedBefore;

// ---- rejecting a parent re-parents its children ---------------------------------
let re = emptyModel('s_reparent');
({ model: re } = applyExtract(
  re,
  {
    concepts: [
      { tempId: 'a', label: 'Wardrobe', note: '', matchesExistingId: '', kind: 'ENTITY', belongsTo: '' },
      { tempId: 'b', label: 'Costume rack', note: '', matchesExistingId: '', kind: 'ATTRIBUTE', belongsTo: 'a' },
    ],
    relationships: [{ from: 'a', to: 'b', label: 'has' }],
  },
  'The wardrobe has a costume rack.'
));
const wardrobe = re.concepts.find((c) => c.label === 'Wardrobe')!;
const rack = re.concepts.find((c) => c.label === 'Costume rack')!;
({ model: re } = applyExtract(
  re,
  {
    concepts: [
      { tempId: 'c', label: 'Rack wheel', note: '', matchesExistingId: '', kind: 'ATTRIBUTE', belongsTo: rack.id },
    ],
    relationships: [],
  },
  'The rack has a wheel.'
));
const wheel = re.concepts.find((c) => c.label === 'Rack wheel')!;
check('grandchild starts at level 2', wheel.level === 2);

re = rejectConcept(re, rack.id);
const wheelAfter = re.concepts.find((c) => c.id === wheel.id)!;
check(
  'rejecting a parent re-parents its children and recomputes their levels',
  wheelAfter.belongsTo === wardrobe.id && wheelAfter.level === 1
);

// ---- a QUESTION never becomes anyone's belongsTo target --------------------------
let q = emptyModel('s_question');
({ model: q } = applyExtract(
  q,
  {
    concepts: [
      { tempId: 'w1', label: 'Costume Rental', note: '', matchesExistingId: '', kind: 'ENTITY', belongsTo: '' },
    ],
    relationships: [],
  },
  'We rent costumes.'
));
const rentalQ = q.concepts.find((c) => c.label === 'Costume Rental')!;
({ model: q } = applyPropose(
  q,
  {
    concepts: [
      {
        tempId: 'qq1',
        label: 'Who are the clients?',
        why: 'Not stated who rents.',
        attachTo: rentalQ.id,
        relationLabel: 'raises',
        kind: 'QUESTION',
        isPropertyOfTarget: false,
      },
    ],
    relationships: [],
    questions: [],
  },
  5
));
const whoAreClients = q.concepts.find((c) => c.label === 'Who are the clients?')!;
({ model: q } = applyExtract(
  q,
  {
    concepts: [
      { tempId: 'w2', label: 'Delivery window', note: '', matchesExistingId: '', kind: 'ATTRIBUTE', belongsTo: whoAreClients.id },
    ],
    relationships: [],
  },
  'There is also a delivery window.'
));
const deliveryWindow = q.concepts.find((c) => c.label === 'Delivery window')!;
check(
  'a QUESTION never becomes anyone\'s belongsTo target',
  deliveryWindow.belongsTo === '' && deliveryWindow.kind === 'ENTITY'
);

// ---- a propose item with isPropertyOfTarget true lands as ATTRIBUTE --------------
let pp = emptyModel('s_property');
({ model: pp } = applyExtract(
  pp,
  {
    concepts: [
      { tempId: 'e1', label: 'Costume Rental', note: '', matchesExistingId: '', kind: 'ENTITY', belongsTo: '' },
    ],
    relationships: [],
  },
  'We rent costumes.'
));
const rentalP = pp.concepts.find((c) => c.label === 'Costume Rental')!;
({ model: pp } = applyPropose(
  pp,
  {
    concepts: [
      {
        tempId: 'pp1',
        label: 'Home delivery',
        why: 'Common add-on for a rental service.',
        attachTo: rentalP.id,
        relationLabel: 'offers',
        kind: 'ENTITY',
        isPropertyOfTarget: true,
      },
    ],
    relationships: [],
    questions: [],
  },
  5
));
const proposedDelivery = pp.concepts.find((c) => c.label === 'Home delivery')!;
check(
  'a propose item with isPropertyOfTarget true lands as ATTRIBUTE with belongsTo set',
  proposedDelivery.kind === 'ATTRIBUTE' && proposedDelivery.belongsTo === rentalP.id && proposedDelivery.level === 1
);

// ---- old-format viewHint still loads -----------------------------------------
check('an old-format concept carrying viewHint STRUCTURE loads as kind ENTITY', resolveKind({ viewHint: 'STRUCTURE' }) === 'ENTITY');
check('an old-format concept carrying viewHint FLOW loads as kind STEP', resolveKind({ viewHint: 'FLOW' }) === 'STEP');
check('a concept with neither kind nor viewHint defaults to ENTITY', resolveKind({}) === 'ENTITY');
check('a concept with a valid kind keeps it', resolveKind({ kind: 'RULE' }) === 'RULE');


// ==== Real-time refinements, Release 1 ==========================================

// ---- RT-US-01: the goal ------------------------------------------------------
{
  let g = emptyModel('s_goal');
  check('a new model has an empty goal', g.goal === '');
  g = setGoal(g, '  Plan the 12 December concert and fair  ');
  check('setGoal trims and stores the goal', g.goal === 'Plan the 12 December concert and fair');
  check('the goal becomes the title while the title is the default', g.title === 'Plan the 12 December concert and fair');
  check('setGoal writes a goal entry to the log', g.log.at(-1)?.kind === 'goal');
  const titled = setGoal({ ...g, title: 'My own title' }, 'Something else');
  check('a changed goal never overwrites a title the session already has', titled.title === 'My own title' && titled.goal === 'Something else');
  check('the goal is in the proposal payload', contextPayload(g).goal === 'Plan the 12 December concert and fair');
  check('a file saved before the goal existed loads with an empty goal', normaliseModel({ ...emptyModel('old'), goal: undefined as unknown as string }).goal === '');
}

// ---- RT-US-02: the whole conversation ---------------------------------------
{
  let c = setGoal(emptyModel('s_conv'), 'Understand the onboarding');
  for (let i = 1; i <= 10; i++) {
    ({ model: c } = applyExtract(c, { concepts: [], relationships: [] }, `statement number ${i}`));
  }
  const p = contextPayload(c);
  check('a 10-turn session sends all 10 statements, oldest first', p.conversation.length === 10 && p.conversation[0] === 'T1: statement number 1' && p.conversation[9] === 'T10: statement number 10');
  check('nothing is cut from a short conversation', p.omittedStatements === 0);
  check('recentStatements is still there for Preload', p.recentStatements.length === 3);
  const w = conversationWindow(c, 70);
  check('over the limit, the newest statements stay and the oldest are cut', w.lines.at(-1) === 'T10: statement number 10' && w.omitted > 0 && w.lines.length + w.omitted === 10);
}

// ---- RT-US-03: question cap, why, closed topics -----------------------------
{
  let q = emptyModel('s_q');
  ({ model: q } = applyExtract(
    q,
    { concepts: [{ tempId: 'a', label: 'Donations', note: '', matchesExistingId: '', kind: 'ENTITY', belongsTo: '' }], relationships: [] },
    'We collect donations at the concert.'
  ));
  const anchor = q.concepts[0];
  const four = {
    concepts: [],
    relationships: [],
    questions: [
      { text: 'Who counts the money?', usefulness: 2, why: 'Someone has to own it.' },
      { text: 'Where will the donations go?', usefulness: 5, why: 'Decides the message on the night.' },
      { text: 'Is there a card reader?', usefulness: 4, why: 'Many people carry no cash.' },
      { text: 'Who designs the poster?', usefulness: 1, why: '' },
    ],
  };
  const capped = applyPropose(q, four, 5, { questionCap: 2 });
  const added = capped.model.questions;
  check('with a cap of 2, four proposed questions become 2', added.length === 2);
  check('the 2 kept are the most useful', added.some((x) => x.text === 'Where will the donations go?') && added.some((x) => x.text === 'Is there a card reader?'));
  check('the dropped ones are counted as capped', capped.blocked.capped === 2);
  check('a question keeps its why', added.find((x) => x.text === 'Where will the donations go?')?.why === 'Decides the message on the night.');

  const uncapped = applyPropose(q, four, 5);
  check('without options, all four questions are added as before', uncapped.model.questions.length === 4);

  const qConcepts = applyPropose(
    q,
    {
      concepts: [
        { tempId: 'x1', label: 'Who handles cash?', why: '', attachTo: anchor.id, relationLabel: 'raises', kind: 'QUESTION', isPropertyOfTarget: false },
        { tempId: 'x2', label: 'Who signs off?', why: '', attachTo: anchor.id, relationLabel: 'raises', kind: 'QUESTION', isPropertyOfTarget: false },
        { tempId: 'x3', label: 'Who keeps receipts?', why: '', attachTo: anchor.id, relationLabel: 'raises', kind: 'QUESTION', isPropertyOfTarget: false },
      ],
      relationships: [],
      questions: [{ text: 'Is there a target amount?', usefulness: 5, why: '' }],
    },
    5,
    { questionCap: 2 }
  );
  const qBoxes = visibleConcepts(qConcepts.model).filter((c) => c.kind === 'QUESTION');
  check('question boxes count against the same cap, and use it first', qBoxes.length === 2 && qConcepts.model.questions.length === 0);

  const firstId = added.find((x) => x.text === 'Where will the donations go?')!.id;
  const dismissed = dismissQuestion(capped.model, firstId, '2026-10-21T00:00:00.000Z');
  check('a dismissed question records when', dismissed.questions.find((x) => x.id === firstId)?.dismissedAt === '2026-10-21T00:00:00.000Z');
  check('a dismissed question is a closed topic in the payload', contextPayload(dismissed).closedQuestions.includes('Where will the donations go?'));
  check('a question retired by the open-list cap is not a closed topic', closedQuestions({ ...dismissed, questions: dismissed.questions.map((x) => ({ ...x, status: 'DONE' as const })) }).length === 1);
  const again = applyPropose(dismissed, { concepts: [], relationships: [], questions: [{ text: 'Where will the donations go?', usefulness: 5, why: '' }] }, 5, { questionCap: 2 });
  check('a dismissed question asked again in the same words is not re-added', again.model.questions.filter((x) => x.text === 'Where will the donations go?').length === 1);
}

// ---- RT-US-04: no echo -------------------------------------------------------
{
  check('every word said means an echo', saidThisTurn('School donations', 'Donations go to the school'));
  check('a word nobody said means a real guess', !saidThisTurn('Ticket price', 'tickets are 20 dollars'));
  check('an empty label is never an echo', !saidThisTurn('', 'anything'));

  let e = emptyModel('s_echo');
  ({ model: e } = applyExtract(
    e,
    { concepts: [{ tempId: 'a', label: 'Concert', note: '', matchesExistingId: '', kind: 'ENTITY', belongsTo: '' }], relationships: [] },
    'Donations go to the school after the concert.'
  ));
  const concert = e.concepts[0];
  const echoPatch = {
    concepts: [
      { tempId: 'p1', label: 'School donations', why: '', attachTo: concert.id, relationLabel: 'raises', kind: 'ENTITY' as const, isPropertyOfTarget: false },
      { tempId: 'p2', label: 'Ticket price', why: '', attachTo: concert.id, relationLabel: 'has', kind: 'ATTRIBUTE' as const, isPropertyOfTarget: true },
    ],
    relationships: [],
    questions: [],
  };
  const echoed = applyPropose(e, echoPatch, 5, { latestStatement: 'Donations go to the school after the concert.' });
  const labels = visibleConcepts(echoed.model).map((c) => c.label);
  check('a proposal that only repeats the statement is dropped', !labels.includes('School donations'));
  check('a real guess in the same turn still lands', labels.includes('Ticket price'));
  check('the echo is counted as a duplicate', echoed.blocked.duplicates === 1);
  const preloadLike = applyPropose(e, echoPatch, 5);
  check('without a latest statement (Preload), nothing is dropped as an echo', visibleConcepts(preloadLike.model).some((c) => c.label === 'School donations'));
}


// ---- answers on the map (both modes) ----------------------------------------
{
  let a = emptyModel('s_answer');
  ({ model: a } = applyExtract(
    a,
    {
      concepts: [
        { tempId: 'n1', label: 'Costume Rental', note: '', matchesExistingId: '', kind: 'ENTITY', belongsTo: '' },
        { tempId: 'n2', label: 'Cancellation window', note: '14 days', matchesExistingId: '', kind: 'RULE', belongsTo: '' },
      ],
      relationships: [{ from: 'n1', to: 'n2', label: 'has' }],
    },
    'We rent costumes. You can cancel within 14 days.'
  ));
  const rental = a.concepts.find((c) => c.label === 'Costume Rental')!;
  const window = a.concepts.find((c) => c.label === 'Cancellation window')!;
  ({ model: a } = applyPropose(
    a,
    {
      concepts: [
        { tempId: 'p1', label: 'Who pays delivery?', why: 'Delivery cost is open', attachTo: rental.id, relationLabel: 'raises', kind: 'QUESTION', isPropertyOfTarget: false },
        { tempId: 'p2', label: 'Deposit', why: 'Rentals usually take one', attachTo: rental.id, relationLabel: 'requires', kind: 'ENTITY', isPropertyOfTarget: false },
        { tempId: 'p3', label: 'Late fee', why: 'Returns can be late', attachTo: rental.id, relationLabel: 'charges', kind: 'RULE', isPropertyOfTarget: false },
      ],
      relationships: [],
      questions: [],
    }
  ));
  const q = a.concepts.find((c) => c.kind === 'QUESTION')!;
  const deposit = a.concepts.find((c) => c.label === 'Deposit')!;
  const lateFee = a.concepts.find((c) => c.label === 'Late fee')!;

  const input = answerPayload(a, q.id, '  The client pays delivery, $15. ');
  check('the answer call knows what the question is about', input?.anchor?.id === rental.id);
  check('the question box itself is not offered as something to change', !input?.concepts.some((c) => c.id === q.id));
  check('no payload for a concept that is not a question', answerPayload(a, rental.id, 'x') === null);

  const text = 'The client pays delivery, $15. We do take a deposit, no late fee, and cancellation is 7 days.';
  const r = applyAnswer(a, q.id, text, {
    answersQuestion: true,
    concepts: [
      { tempId: 'n1', label: 'Delivery fee', note: '$15, paid by the client', matchesExistingId: '', kind: 'ATTRIBUTE', belongsTo: rental.id },
      { tempId: 'n2', label: 'Client', note: '', matchesExistingId: '', kind: 'ACTOR', belongsTo: '' },
    ],
    relationships: [],
    updates: [
      { id: window.id, label: '', note: '7 days' },
      { id: 'c_made_up', label: 'Nope', note: '' },
    ],
    confirms: [deposit.id],
    rejects: [lateFee.id, rental.id],
  });
  const b = r.model;
  const fee = b.concepts.find((c) => c.label === 'Delivery fee')!;
  const client = b.concepts.find((c) => c.label === 'Client')!;
  const st = b.statements.at(-1)!;

  check('an answered question leaves the map', !visibleConcepts(b).some((c) => c.id === q.id));
  check('it keeps its answer in the file', b.concepts.find((c) => c.id === q.id)?.answer === text.trim());
  check('the answer is a statement tied to the question', st.text === text && st.questionId === q.id);
  check('what the answer states is green and cites the answer', fee.status === 'VALIDATED' && fee.origin === 'EXPLICIT' && fee.evidence.includes(st.id));
  check('a property in the answer belongs to what it is about', fee.belongsTo === rental.id);
  check('a loose new box is tied to the question\'s concept', b.relationships.some((x) => x.from === rental.id && x.to === client.id && x.status === 'VALIDATED' && x.origin === 'USER'));
  check('a correction changes the note, keeps the label', b.concepts.find((c) => c.id === window.id)?.note === '7 days' && b.concepts.find((c) => c.id === window.id)?.label === 'Cancellation window');
  check('the corrected concept cites the answer', b.concepts.find((c) => c.id === window.id)!.evidence.includes(st.id));
  check('the old wording is in the log', JSON.stringify(b.log.at(-1)?.payload).includes('14 days'));
  check('an unknown id is refused and counted', r.blocked.invented === 1 && !b.concepts.some((c) => c.label === 'Nope'));
  check('a guess the answer confirms turns green', b.concepts.find((c) => c.id === deposit.id)?.status === 'VALIDATED');
  check('a guess the answer denies is rejected and remembered', !visibleConcepts(b).some((c) => c.id === lateFee.id) && b.rejected.some((x) => x.label.includes('late fee')));
  check('a green concept is never rejected by an answer', b.concepts.find((c) => c.id === rental.id)?.status === 'VALIDATED');
  check('the counts add up', r.added === 2 && r.changed === 1 && r.confirmed === 1 && r.rejected === 1);
  check('later proposals hear the answer', answeredQuestions(b).some((x) => x.text === q.label && x.answer.includes('$15')));
  check('the conversation shows what was answered', conversationWindow(b).lines.at(-1)!.includes(`answer to "${q.label}"`));
  check('the answer is logged', b.log.at(-1)?.kind === 'answer');

  const partial = applyAnswer(a, q.id, 'Not sure yet, maybe the client.', {
    answersQuestion: false,
    concepts: [],
    relationships: [],
    updates: [],
    confirms: [],
    rejects: [],
  });
  check('an answer that does not settle it leaves the question on the map', visibleConcepts(partial.model).some((c) => c.id === q.id) && !partial.answered);
  check('what was said is still recorded', partial.model.statements.at(-1)?.questionId === q.id);

  const gone = applyAnswer(b, q.id, 'again', { answersQuestion: true, concepts: [], relationships: [], updates: [], confirms: [], rejects: [] });
  check('a question already answered cannot be answered again', gone.model === b);
}


// ---- later, and answers to list questions -----------------------------------
{
  let l = emptyModel('s_later');
  ({ model: l } = applyExtract(
    l,
    { concepts: [{ tempId: 'n1', label: 'Concert', note: '', matchesExistingId: '', kind: 'ENTITY', belongsTo: '' }], relationships: [] },
    'The concert is on 12 December.'
  ));
  const concert = l.concepts[0];
  ({ model: l } = applyPropose(l, {
    concepts: [{ tempId: 'p1', label: 'Who plays?', why: 'Musicians left', attachTo: concert.id, relationLabel: 'raises', kind: 'QUESTION', isPropertyOfTarget: false }],
    relationships: [],
    questions: [
      { text: 'How many tickets will you sell?', usefulness: 4 },
      { text: 'Who runs the fair?', usefulness: 3 },
    ],
  }));
  const box = l.concepts.find((c) => c.kind === 'QUESTION')!;
  const tickets = l.questions.find((q) => q.text.startsWith('How many'))!;
  const fair = l.questions.find((q) => q.text.startsWith('Who runs'))!;

  l = parkQuestion(l, tickets.id);
  l = parkQuestion(l, box.id);
  check('a list question put off leaves the open list', !activeQuestions(l).some((q) => q.id === tickets.id));
  check('a box put off leaves the map', !visibleConcepts(l).some((c) => c.id === box.id));
  check('its link leaves the map with it', !visibleRelationships(l).some((r) => r.to === box.id || r.from === box.id));
  check('both are in the Later list', laterQuestions(l).length === 2);
  check('the Later box still knows what it is about', laterQuestions(l).find((q) => q.id === box.id)?.anchorId === concert.id);
  check('a question put off is still sent to the AI as open, so it is not asked again', contextPayload(l).openQuestions.includes(tickets.text));

  // The open-list cap never retires a question the person kept for later.
  let full = l;
  ({ model: full } = applyPropose(full, {
    concepts: [],
    relationships: [],
    questions: Array.from({ length: 12 }, (_, i) => ({ text: `Filler question ${i}?`, usefulness: 5 })),
  }));
  check('the cap never retires a Later question', full.questions.find((q) => q.id === tickets.id)?.status === 'OPEN');

  const back = unparkQuestion(l, box.id);
  check('Back to map puts the box back', visibleConcepts(back).some((c) => c.id === box.id));

  const r = applyAnswer(l, tickets.id, 'About 200 tickets at $15.', {
    answersQuestion: true,
    concepts: [{ tempId: 'a1', label: 'Tickets', note: 'about 200 at $15', matchesExistingId: '', kind: 'ATTRIBUTE', belongsTo: concert.id }],
    relationships: [],
    updates: [],
    confirms: [],
    rejects: [],
  });
  check('a Later list question can be answered', r.answered && r.model.questions.find((q) => q.id === tickets.id)?.status === 'DONE');
  check('its answer is kept and it leaves Later', r.model.questions.find((q) => q.id === tickets.id)?.answer === 'About 200 tickets at $15.' && !laterQuestions(r.model).some((q) => q.id === tickets.id));
  check('what it says lands on the map', visibleConcepts(r.model).some((c) => c.label === 'Tickets' && c.belongsTo === concert.id));
  check('the AI hears the list answer', contextPayload(r.model).answeredQuestions.some((a) => a.text === tickets.text));

  const rb = applyAnswer(l, box.id, 'Sam and Lee will play.', {
    answersQuestion: true,
    concepts: [{ tempId: 'a1', label: 'Sam and Lee', note: '', matchesExistingId: '', kind: 'ACTOR', belongsTo: '' }],
    relationships: [],
    updates: [],
    confirms: [],
    rejects: [],
  });
  check('a box put off can be answered from the Later list', rb.answered && !laterQuestions(rb.model).some((q) => q.id === box.id));
  check('and its answer is tied to what it was about', rb.model.relationships.some((x) => x.from === concert.id && x.status === 'VALIDATED' && rb.model.concepts.find((c) => c.id === x.to)?.label === 'Sam and Lee'));

  const open = applyAnswer(l, fair.id, 'The PTA runs it.', { answersQuestion: true, concepts: [], relationships: [], updates: [], confirms: [], rejects: [] });
  check('an open list question can be answered too', open.model.questions.find((q) => q.id === fair.id)?.status === 'DONE');

  const gone = dismissAny(l, box.id);
  check('Dismiss on a Later box closes it for good', !laterQuestions(gone).some((q) => q.id === box.id) && closedQuestions(gone).includes(box.label));
  const goneList = dismissAny(l, tickets.id);
  check('Dismiss on a Later list question closes it for good', !laterQuestions(goneList).some((q) => q.id === tickets.id) && closedQuestions(goneList).includes(tickets.text));
}

// ---- call meta ---------------------------------------------------------------
{
  let t = emptyModel('s_meta');
  ({ model: t } = applyExtract(t, { concepts: [], relationships: [] }, 'hello'));
  t = withCallMeta(t, 'extract', { model: 'claude-haiku-4-5-20251001', ms: 900, usage: { input: 120, output: 40 } });
  check('the extract log entry carries model, time and tokens', t.log.at(-1)?.meta?.usage?.input === 120 && t.log.at(-1)?.meta?.model === 'claude-haiku-4-5-20251001');
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
