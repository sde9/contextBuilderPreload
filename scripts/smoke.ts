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

import { emptyModel, resolveKind } from '../lib/types';
import {
  applyExtract,
  applyPropose,
  confirmConcept,
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

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
