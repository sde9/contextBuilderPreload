/*
 * Offline test of the preload core. No network, no API key, no model.
 *
 * R13: every new pure function is proven here before a single call to a
 * provider exists. Run it after touching merge.ts, cluster.ts or chunk.ts:
 *
 *   npm run smoke:preload
 *
 * It builds two small document maps by hand, the way stage 1 would, and then
 * drives the merge with patches written by a person rather than a model. That
 * is the only way to know whether a bad map came from the reducer or from the
 * prompt.
 */

import { applyExtract, visibleConcepts, visibleRelationships } from '../lib/reducer';
import {
  applyMerge,
  combineSourceModels,
  corroboration,
  enforceCitations,
  resolveContest,
  shortlistPairs,
  similarity,
  sourcesOf,
  splitConcept,
} from '../lib/merge';
import { applyClusters, assignTiers, clusterEdges, conceptsAtLevel, coverage, crossingRatio } from '../lib/cluster';
import { chunkText, chooseStrategy, guessRole, PAGE_BREAK } from '../lib/chunk';
import { emptyModel, newId, type Model, type Source } from '../lib/types';
import type { ExtractPatch, MergePatch, ClusterPatch } from '../lib/schema';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, extra = '') {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? `  — ${extra}` : ''}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

// ==========================================================================
// chunking
// ==========================================================================

section('chunking and locators');

const md = `# Booking
Customers book a costume online. The booking holds the item for 48 hours.

## Deposit
A deposit of 30% is taken at booking time. The rest is due on collection.

## Cancellation
Customers may cancel up to 14 days before the hire date and receive a full refund.`;

const mdChunks = chunkText('src_a', md, { name: 'Scope v3.md', role: 'SPEC' });
check('markdown splits on headings', mdChunks.length >= 2, `got ${mdChunks.length}`);
check('heading becomes the locator', mdChunks.every((c) => c.locator.startsWith('§ ')), mdChunks.map((c) => c.locator).join(' / '));
check('every chunk keeps its source', mdChunks.every((c) => c.sourceId === 'src_a'));
check('chunks are ordered', mdChunks.every((c, i) => c.ordinal === i));

const paged = `Page one text about deposits.${PAGE_BREAK}Page two text about refunds and the cancellation window.`;
const pagedChunks = chunkText('src_b', paged, { name: 'Scope v3.pdf', role: 'SPEC' });
check('page breaks produce page locators', pagedChunks.map((c) => c.locator).join(',') === 'p.1,p.2', pagedChunks.map((c) => c.locator).join(','));

const transcript = `00:12:04 So the way it works now, the customer pays a deposit up front.
And then the rest when they pick it up.

00:14:22 We moved the cancellation to 7 days back in June because people were
booking and dropping out at the last minute, which killed us on stock.`;
const tChunks = chunkText('src_c', transcript, { name: 'Kickoff call.txt', role: 'TRANSCRIPT' });
check('transcript locators are timestamps', tChunks.some((c) => c.locator === '00:14:22'), tChunks.map((c) => c.locator).join(','));

const csv = 'sku,name,price\n1,Cape,40\n2,Hat,15\n3,Boots,60';
const csvChunks = chunkText('src_d', csv, { name: 'Pricing.csv', role: 'DATA' });
check('csv locator is a row range', csvChunks[0]?.locator.startsWith('rows '), csvChunks[0]?.locator);
check('csv keeps the header in every chunk', csvChunks.every((c) => c.text.startsWith('sku,name,price')));

check('strategy: md by heading', chooseStrategy('a.md', 'SPEC', md) === 'heading');
check('strategy: page break wins over everything', chooseStrategy('a.md', 'SPEC', paged) === 'page');
check('strategy: transcript by timestamp', chooseStrategy('call.txt', 'TRANSCRIPT', transcript) === 'timestamp');
check('empty text produces no chunks', chunkText('src_e', '   \n\n  ', { name: 'x.txt', role: 'NOTES' }).length === 0);

section('role guessing');
check('scope filename guesses SPEC', guessRole('Scope v3.docx', '') === 'SPEC');
check('call filename guesses TRANSCRIPT', guessRole('Kickoff call 12 Aug.txt', '') === 'TRANSCRIPT');
check('csv guesses DATA', guessRole('pricing.csv', '') === 'DATA');
check('timestamps in the body guess TRANSCRIPT', guessRole('untitled.txt', '00:04:11 so anyway') === 'TRANSCRIPT');
check('nothing recognisable stays UNKNOWN', guessRole('untitled.txt', 'hello there') === 'UNKNOWN');

// ==========================================================================
// building two document maps the way stage 1 would
// ==========================================================================

section('stage 1: one map per document');

const sources: Source[] = [
  {
    id: 'src_spec',
    name: 'Scope v3.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: 41000,
    hash: 'h1',
    addedAt: new Date().toISOString(),
    role: 'SPEC',
    parse: 'OK',
    parseNote: '',
    chunkCount: 2,
    conceptCount: 0,
  },
  {
    id: 'src_call',
    name: 'Kickoff call.txt',
    mime: 'text/plain',
    bytes: 9000,
    hash: 'h2',
    addedAt: new Date().toISOString(),
    role: 'TRANSCRIPT',
    parse: 'OK',
    parseNote: '',
    chunkCount: 2,
    conceptCount: 0,
  },
];

function docModel(source: Source, passes: { quote: string; locator: string; patch: ExtractPatch }[]): Model {
  let m: Model = { ...emptyModel(newId('s')), sources: [source] };
  for (const p of passes) {
    const applied = applyExtract(m, p.patch, p.quote, {
      chunkId: newId('ch'),
      sourceId: source.id,
      locator: p.locator,
    });
    m = applied.model;
  }
  return m;
}

const specModel = docModel(sources[0], [
  {
    quote: 'Customers book a costume online. The booking holds the item for 48 hours.',
    locator: '§ Booking',
    patch: {
      concepts: [
        { tempId: 'n1', label: 'Booking', note: 'holds the item 48 hours', matchesExistingId: '', kind: 'ENTITY', belongsTo: '' },
        { tempId: 'n2', label: 'Customer', note: '', matchesExistingId: '', kind: 'ACTOR', belongsTo: '' },
      ],
      relationships: [{ from: 'n2', to: 'n1', label: 'makes' }],
    },
  },
  {
    quote: 'Customers may cancel up to 14 days before the hire date and receive a full refund.',
    locator: '§ Cancellation',
    patch: {
      concepts: [
        { tempId: 'n1', label: 'Cancellation window', note: '14 days before the hire date', matchesExistingId: '', kind: 'RULE', belongsTo: '' },
        { tempId: 'n2', label: 'Deposit', note: '30% at booking', matchesExistingId: '', kind: 'ENTITY', belongsTo: '' },
      ],
      relationships: [{ from: 'n1', to: 'n2', label: 'refunds' }],
    },
  },
]);

const callModel = docModel(sources[1], [
  {
    quote: 'We moved the cancellation to 7 days back in June.',
    locator: '00:14:22',
    patch: {
      concepts: [
        { tempId: 'n1', label: 'Cancellation window', note: '7 days since June', matchesExistingId: '', kind: 'RULE', belongsTo: '' },
        { tempId: 'n2', label: 'Hire period', note: '', matchesExistingId: '', kind: 'ENTITY', belongsTo: '' },
      ],
      relationships: [{ from: 'n1', to: 'n2', label: 'applies to' }],
    },
  },
  {
    quote: 'The client pays a deposit up front and the rest on pickup.',
    locator: '00:12:04',
    patch: {
      concepts: [
        { tempId: 'n1', label: 'Client', note: '', matchesExistingId: '', kind: 'ACTOR', belongsTo: '' },
        { tempId: 'n2', label: 'Booking', note: '', matchesExistingId: '', kind: 'ENTITY', belongsTo: '' },
      ],
      relationships: [{ from: 'n1', to: 'n2', label: 'pays for' }],
    },
  },
]);

check('a document pass writes an excerpt, not a statement', specModel.excerpts.length === 2 && specModel.statements.length === 0, `${specModel.excerpts.length} excerpts, ${specModel.statements.length} statements`);
check('every excerpt keeps its locator', specModel.excerpts.every((e) => e.locator.length > 0));
check('every excerpt keeps the sentence verbatim', specModel.excerpts.some((e) => e.quote.includes('14 days before the hire date')));
check('R2: every green concept can name its source', visibleConcepts(specModel).every((c) => sourcesOf(specModel, c).length === 1));
check('spec map has four concepts', visibleConcepts(specModel).length === 4, String(visibleConcepts(specModel).length));
check('call map has four concepts', visibleConcepts(callModel).length === 4, String(visibleConcepts(callModel).length));

// ==========================================================================
// combine: the exact matches merge with no model involved
// ==========================================================================

section('stage 2a: exact matches merge without a model');

const combined = combineSourceModels([specModel, callModel], sources);
const cm = combined.model;

const bookings = visibleConcepts(cm).filter((c) => c.label === 'Booking');
check('"Booking" appears once, not twice', bookings.length === 1, `${bookings.length} nodes`);
check('the survivor cites both documents', bookings[0] ? sourcesOf(cm, bookings[0]).length === 2 : false, bookings[0] ? sourcesOf(cm, bookings[0]).join(',') : 'missing');
check('the absorbed node is kept, not deleted', cm.concepts.some((c) => c.absorbedInto), 'nothing recorded as absorbed');
check('the merge is counted', combined.blocked.duplicates >= 2, `duplicates=${combined.blocked.duplicates}`);

const merged = bookings[0];
const bookingEdges = visibleRelationships(cm).filter((r) => r.from === merged?.id || r.to === merged?.id);
check('edges from both documents now reach the one node', bookingEdges.length === 2, `${bookingEdges.length} edges`);
check('the node absorbed into Booking points at the survivor', cm.concepts.some((c) => c.absorbedInto === merged?.id));

const cancels = visibleConcepts(cm).filter((c) => c.label === 'Cancellation window');
check('"Cancellation window" also merged on the exact rule', cancels.length === 1, `${cancels.length} nodes`);

// ==========================================================================
// shortlist
// ==========================================================================

section('stage 2b: the shortlist, still no model');

check('similarity: identical labels score 1', Math.abs(similarity('Deposit', 'Deposit') - 1) < 0.001);
check('similarity: unrelated labels score low', similarity('Deposit', 'Warehouse') < 0.3, String(similarity('Deposit', 'Warehouse')));
check('similarity ignores stopwords', similarity('the Deposit', 'Deposit') > 0.8, String(similarity('the Deposit', 'Deposit')));

const pairs = shortlistPairs(cm);
const hasCustomerClient = pairs.some(
  (p) =>
    [p.aId, p.bId].every((id) => {
      const c = cm.concepts.find((x) => x.id === id);
      return c?.label === 'Customer' || c?.label === 'Client';
    })
);
check('filter 3 finds "Customer" and "Client" through a shared neighbour', hasCustomerClient, `${pairs.length} pairs`);
check('pairs never come from the same document', pairs.every((p) => {
  const a = cm.concepts.find((x) => x.id === p.aId)!;
  const b = cm.concepts.find((x) => x.id === p.bId)!;
  const sa = sourcesOf(cm, a).join(',');
  const sb = sourcesOf(cm, b).join(',');
  return !sa || !sb || sa !== sb;
}));
check('pairs never mix kinds', pairs.every((p) => {
  const a = cm.concepts.find((x) => x.id === p.aId)!;
  const b = cm.concepts.find((x) => x.id === p.bId)!;
  return a.kind === b.kind;
}));
check('the shortlist is far smaller than every pair', pairs.length < (visibleConcepts(cm).length * (visibleConcepts(cm).length - 1)) / 2);

// ==========================================================================
// applyMerge, driven by hand-written patches
// ==========================================================================

section('stage 2c: the four verdicts');

const customer = visibleConcepts(cm).find((c) => c.label === 'Customer')!;
const client = visibleConcepts(cm).find((c) => c.label === 'Client')!;
const deposit = visibleConcepts(cm).find((c) => c.label === 'Deposit')!;
const hire = visibleConcepts(cm).find((c) => c.label === 'Hire period')!;

const samePatch: MergePatch = {
  decisions: [{ aId: customer.id, bId: client.id, verdict: 'SAME', keepLabel: 'Customer', relationLabel: '', conflictSummary: '' }],
};
const afterSame = applyMerge(cm, samePatch);
const oneCustomer = visibleConcepts(afterSame.model).filter((c) => c.label === 'Customer' || c.label === 'Client');
check('SAME merges the pair into one node', oneCustomer.length === 1, `${oneCustomer.length} nodes`);
check('SAME keeps the spec label, not the transcript one', oneCustomer[0]?.label === 'Customer', oneCustomer[0]?.label);
check('SAME unions the evidence', oneCustomer[0] ? sourcesOf(afterSame.model, oneCustomer[0]).length === 2 : false);
check('SAME records what it absorbed', (oneCustomer[0]?.mergedFrom.length ?? 0) === 1);

const relatedPatch: MergePatch = {
  decisions: [{ aId: deposit.id, bId: hire.id, verdict: 'RELATED', keepLabel: '', relationLabel: 'is held for', conflictSummary: '' }],
};
const afterRelated = applyMerge(cm, relatedPatch);
check('RELATED keeps both nodes', visibleConcepts(afterRelated.model).length === visibleConcepts(cm).length);
const newEdge = visibleRelationships(afterRelated.model).find((r) => r.label === 'is held for');
check('RELATED adds one link', Boolean(newEdge));
check('RELATED lands orange, so it needs a yes or no', newEdge?.status === 'PROPOSED' && newEdge?.origin === 'INFERRED');

// ==========================================================================
// R7: the merge cannot invent anything
// ==========================================================================

section('R7: the merge cannot add to the map');

const invented: MergePatch = {
  decisions: [
    { aId: 'c_doesnotexist', bId: deposit.id, verdict: 'SAME', keepLabel: 'Deposit', relationLabel: '', conflictSummary: '' },
    { aId: deposit.id, bId: hire.id, verdict: 'SAME', keepLabel: 'A Totally New Name', relationLabel: '', conflictSummary: '' },
  ],
};
const afterInvented = applyMerge(cm, invented);
check('an unknown id is dropped', afterInvented.blocked.invented >= 1, `invented=${afterInvented.blocked.invented}`);
check('a label from neither input is refused', afterInvented.blocked.invented >= 2, `invented=${afterInvented.blocked.invented}`);
const survivingLabels = visibleConcepts(afterInvented.model).map((c) => c.label);
check('the invented label never reaches the map', !survivingLabels.includes('A Totally New Name'), survivingLabels.join(', '));
check('the fallback keeps a real label', survivingLabels.includes('Deposit') || survivingLabels.includes('Hire period'));
check('nothing was created by the merge', visibleConcepts(afterInvented.model).length <= visibleConcepts(cm).length);

const relatedNoVerb: MergePatch = {
  decisions: [{ aId: deposit.id, bId: hire.id, verdict: 'RELATED', keepLabel: '', relationLabel: '  ', conflictSummary: '' }],
};
check('RELATED with no verb is refused', applyMerge(cm, relatedNoVerb).blocked.invented === 1);

// ==========================================================================
// conflict
// ==========================================================================

section('R8: conflicts wait for a person');

const specCancel = cm.concepts.find((c) => c.label === 'Cancellation window' && !c.absorbedInto)!;
// Build a fresh pair to contest: re-run the combine without the exact rule
// firing, by giving the two documents differently worded labels.
const callModel2 = docModel(sources[1], [
  {
    quote: 'We moved the cancellation to 7 days back in June.',
    locator: '00:14:22',
    patch: {
      concepts: [{ tempId: 'n1', label: 'Cancellation period', note: '7 days since June', matchesExistingId: '', kind: 'RULE', belongsTo: '' }],
      relationships: [],
    },
  },
]);
const cm2 = combineSourceModels([specModel, callModel2], sources).model;
const a2 = visibleConcepts(cm2).find((c) => c.label === 'Cancellation window')!;
const b2 = visibleConcepts(cm2).find((c) => c.label === 'Cancellation period')!;

const conflictPatch: MergePatch = {
  decisions: [
    {
      aId: a2.id,
      bId: b2.id,
      verdict: 'CONFLICT',
      keepLabel: 'Cancellation window',
      relationLabel: '',
      conflictSummary: '14 days in the spec, 7 days in the call.',
    },
  ],
};
const afterConflict = applyMerge(cm2, conflictPatch);
const contested = visibleConcepts(afterConflict.model).find((c) => c.status === 'CONTESTED');
check('CONFLICT produces one contested node', Boolean(contested));
check('the contested node holds both readings', contested?.contest?.readings.length === 2);
check('both readings carry a citation', contested?.contest?.readings.every((r) => r.evidenceId && r.sourceId) ?? false);
check('the spec reading is listed first', contested?.contest?.readings[0]?.sourceId === 'src_spec', contested?.contest?.readings[0]?.sourceId);
check('the disagreement is written down', (contested?.contest?.why ?? '').includes('14 days'));
check('no value was chosen', contested?.contest?.resolved === 'NONE');
check('conflicts are counted', afterConflict.blocked.conflicts === 1);
check('the losing quote is still readable', afterConflict.model.excerpts.some((e) => e.id === contested?.contest?.readings[1]?.evidenceId));

section('resolving a conflict never deletes the other reading');

const keptFirst = resolveContest(afterConflict.model, contested!.id, 'KEPT_FIRST');
const kf = keptFirst.concepts.find((c) => c.id === contested!.id)!;
check('KEPT_FIRST turns the node green', kf.status === 'VALIDATED');
check('KEPT_FIRST takes the first label', kf.label === contested!.contest!.readings[0].label);
check('R5: a resolved node records that a person decided', kf.origin === 'USER');
check('the rejected reading is still on the record', kf.contest?.readings.length === 2 && kf.contest.resolved === 'KEPT_FIRST');

const keptSecond = resolveContest(afterConflict.model, contested!.id, 'KEPT_SECOND');
const ks = keptSecond.concepts.find((c) => c.id === contested!.id)!;
check('KEPT_SECOND takes the other label', ks.label === contested!.contest!.readings[1].label, ks.label);

const splitOut = resolveContest(afterConflict.model, contested!.id, 'SPLIT');
const bothBack = visibleConcepts(splitOut).filter((c) => c.label.startsWith('Cancellation'));
check('SPLIT brings both concepts back', bothBack.length === 2, `${bothBack.length} nodes`);
check('SPLIT clears the contest', bothBack.every((c) => c.status === 'VALIDATED'));

// ==========================================================================
// R1: any judged merge is reversible
// ==========================================================================

section('R1: split restores exactly what was merged');

const beforeIds = visibleConcepts(afterSame.model).map((c) => c.id).sort();
const keeper = visibleConcepts(afterSame.model).find((c) => c.mergedFrom.length > 0)!;
const absorbedId = keeper.mergedFrom[keeper.mergedFrom.length - 1];
const unmerged = splitConcept(afterSame.model, keeper.id, absorbedId);
const afterIds = visibleConcepts(unmerged).map((c) => c.id).sort();

check('the absorbed node comes back', afterIds.includes(absorbedId), absorbedId);
check('exactly one node returns', afterIds.length === beforeIds.length + 1, `${beforeIds.length} → ${afterIds.length}`);
const restored = unmerged.concepts.find((c) => c.id === absorbedId)!;
check('the restored node keeps its own citation', sourcesOf(unmerged, restored).length === 1, sourcesOf(unmerged, restored).join(','));
check('the keeper keeps its own citation', sourcesOf(unmerged, unmerged.concepts.find((c) => c.id === keeper.id)!).length === 1);
check('the keeper no longer claims the absorbed node', !unmerged.concepts.find((c) => c.id === keeper.id)!.mergedFrom.includes(absorbedId));
const restoredEdges = visibleRelationships(unmerged).filter((r) => r.from === absorbedId || r.to === absorbedId);
check('the restored node gets its edges back', restoredEdges.length >= 1, `${restoredEdges.length} edges`);
check('split is written to the log', unmerged.log.some((l) => l.kind === 'split'));

// ==========================================================================
// R2: a green node with no citation is refused
// ==========================================================================

section('R2: green has to be able to cite a sentence');

const forged: Model = {
  ...cm,
  concepts: [
    ...cm.concepts,
    {
      id: 'c_forged',
      label: 'Warehouse',
      note: '',
      origin: 'EXPLICIT',
      status: 'VALIDATED',
      kind: 'ENTITY',
      belongsTo: '',
      level: 0,
      evidence: [],
      turn: 1,
      x: 0,
      y: 0,
      pinned: false,
      tier: 2,
      clusterId: '',
      mergedFrom: [],
      absorbedInto: '',
      contest: null,
    },
  ],
};
const cited = enforceCitations(forged);
check('an uncited green node is refused', !visibleConcepts(cited.model).some((c) => c.id === 'c_forged'));
check('the refusal is counted', cited.blocked.uncited === 1, `uncited=${cited.blocked.uncited}`);
check('honest nodes are untouched', visibleConcepts(cited.model).length === visibleConcepts(cm).length);
check('an evidence id pointing at nothing is stripped', (() => {
  const ghost: Model = {
    ...cm,
    concepts: cm.concepts.map((c) => (c.id === deposit.id ? { ...c, evidence: [...c.evidence, 'ex_ghost'] } : c)),
  };
  const out = enforceCitations(ghost);
  return !out.model.concepts.find((c) => c.id === deposit.id)!.evidence.includes('ex_ghost');
})());

// ==========================================================================
// clusters and tiers
// ==========================================================================

section('R3 and R6: areas and levels');

const live = visibleConcepts(cm);
const clusterPatch: ClusterPatch = {
  areas: [
    { label: 'Booking', memberIds: live.filter((c) => /booking|customer|client|hire/i.test(c.label)).map((c) => c.id) },
    { label: 'Money', memberIds: live.filter((c) => /deposit|cancellation/i.test(c.label)).map((c) => c.id) },
  ],
};
const clustered = applyClusters(cm, clusterPatch);
check('every concept lands in an area', visibleConcepts(clustered.model).every((c) => c.clusterId), 'some concept has no cluster');
check('areas are clusters, never concepts', visibleConcepts(clustered.model).every((c) => !['Booking area', 'Money'].includes(c.label) || c.evidence.length > 0));
check('two areas were created', clustered.model.clusters.length === 2, String(clustered.model.clusters.length));

const withGhost = applyClusters(cm, {
  areas: [{ label: 'Booking', memberIds: [...live.slice(0, 2).map((c) => c.id), 'c_nope'] }],
});
check('an unknown member id is dropped and counted', withGhost.blocked.invented === 1, `invented=${withGhost.blocked.invented}`);
check('what the model forgot is grouped honestly, not lost', withGhost.model.clusters.some((cl) => cl.label === 'Not yet grouped'));
check('nothing is silently dropped from the map', visibleConcepts(withGhost.model).every((c) => c.clusterId));

const twice = applyClusters(cm, {
  areas: [
    { label: 'A', memberIds: [live[0].id] },
    { label: 'B', memberIds: [live[0].id] },
  ],
});
check('a concept in two areas is only counted once', twice.blocked.duplicates === 1);

check('crossing ratio is between 0 and 1', (() => {
  const r = crossingRatio(clustered.model);
  return r >= 0 && r <= 1;
})());
check('one area for everything means nothing crosses', (() => {
  const all = applyClusters(cm, { areas: [{ label: 'Everything', memberIds: live.map((c) => c.id) }] });
  return crossingRatio(all.model) === 0;
})());

const tiered = assignTiers(clustered.model);
check('an attribute is always detail', tiered.concepts.filter((c) => c.kind === 'ATTRIBUTE').every((c) => c.tier === 3));
check('anything owned by something else is detail', tiered.concepts.filter((c) => c.belongsTo).every((c) => c.tier === 3));

check('level 1 draws areas, not concepts', conceptsAtLevel(tiered, 1).length === 0);
check('opening one area shows only that area', (() => {
  const first = tiered.clusters[0];
  const shown = conceptsAtLevel(tiered, 1, [first.id]);
  return shown.length === first.memberIds.length && shown.every((c) => c.clusterId === first.id);
})());
check('level 3 shows everything', conceptsAtLevel(tiered, 3).length === visibleConcepts(tiered).length);
check('level 2 is between the two', (() => {
  const n = conceptsAtLevel(tiered, 2).length;
  return n > 0 && n <= visibleConcepts(tiered).length;
})());
check('cluster edges aggregate, one line per pair', (() => {
  const edges = clusterEdges(clustered.model);
  const keys = new Set(edges.map((e) => `${e.from}|${e.to}`));
  return keys.size === edges.length && edges.every((e) => e.weight >= 1);
})());

// ==========================================================================
// coverage
// ==========================================================================

section('coverage: where the map is thin');

const cov = coverage(cm, sourcesOf);
check('every document gets a row, including one that gave nothing', cov.length === sources.length);
check('the spec contributed concepts', (cov.find((c) => c.sourceId === 'src_spec')?.concepts ?? 0) > 0);
check('unique never exceeds total', cov.every((c) => c.unique <= c.concepts));

const corr = corroboration(cm);
check('at least one node is backed by two documents', corr.multi >= 1, `multi=${corr.multi}`);
check('the counts add up', corr.multi + corr.single + corr.uncited === visibleConcepts(cm).length);

// ==========================================================================
// R10: real-time still works on a preload map
// ==========================================================================

section('R10: one model, two modes');

const spoken = applyExtract(cm, {
  concepts: [{ tempId: 'n1', label: 'Late fee', note: '$20 a day', matchesExistingId: '', kind: 'RULE', belongsTo: '' }],
  relationships: [],
}, 'There is a late fee of twenty dollars a day.');
check('speech lands on a preload map', visibleConcepts(spoken.model).some((c) => c.label === 'Late fee'));
check('speech writes a statement, not an excerpt', spoken.model.statements.length === 1 && spoken.model.excerpts.length === cm.excerpts.length);
check('the documents are untouched by the conversation', spoken.model.sources.length === 2);
const lateFee = visibleConcepts(spoken.model).find((c) => c.label === 'Late fee')!;
check('a spoken concept cites its statement', lateFee.evidence.length === 1 && spoken.model.statements.some((s) => s.id === lateFee.evidence[0]));

// ==========================================================================

console.log(`\n${pass} passed, ${fail} failed.\n`);
if (fail > 0) process.exit(1);
console.log('All checks passed.');
