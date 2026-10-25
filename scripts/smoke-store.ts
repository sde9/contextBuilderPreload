/*
 * The Preload server, end to end, with no key and no network.
 *
 * Every route handler is called the way Next calls it, against a shared run
 * store, with the Anthropic API answered by a fake. That is the shape of a
 * Vercel deployment: each request may land on a different function, and the
 * only thing they share is the store. The old /tmp store failed exactly here.
 *
 *   npm run smoke:store
 *
 * Runs twice: once on the in-memory store, once on a real folder on disk.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryStorage, useStorage, STORAGE_MISSING, RUN_MISSING, storageKind, loadRunFull } from '../lib/runStore';
import { MAX_UPLOAD_BYTES } from '../lib/limits';
import * as runRoute from '../app/api/preload/run/route';
import * as filesRoute from '../app/api/preload/run/[id]/files/route';
import * as runIdRoute from '../app/api/preload/run/[id]/route';
import * as stepRoute from '../app/api/preload/step/route';
import * as actRoute from '../app/api/preload/act/route';
import * as healthRoute from '../app/api/preload/health/route';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra = '') {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? '  ok ' : ' FAIL'}  ${name}${extra && !ok ? `  (${extra})` : ''}`);
}
function section(title: string) {
  console.log(`\n${title}`);
}

// ------------------------------------------------------------------ fake model

let calls: Record<string, number> = {};
let failExtract = false;
/** Extract calls whose text contains this fail, as an oversized section would. */
let failOn = '';

/** A plausible outline: one part per section (up to three), quoted from each section's first line. */
function fakeOutline(user: string) {
  const doc = /^DOCUMENT: (.+?) \(/m.exec(user)?.[1] ?? 'doc';
  const sections = [...user.matchAll(/^\[(s\d+)\] [^\n]*\n([^\n]*)/gm)].map((m) => ({ id: m[1], first: m[2] }));
  const sentence = (t: string) => (t.replace(/^#+\s*/, '').split(/(?<=\.)\s/)[0] ?? '').trim();
  const parts = sections.slice(0, 3).map((sec, i) => ({
    tempId: `p${i + 1}`,
    label: `Part ${i + 1} of ${doc}`,
    note: '',
    kind: 'ENTITY',
    quote: sentence(sec.first),
    sectionIds: [sec.id],
    pattern: 'STRUCTURE',
  }));
  return {
    main: { label: `Main point of ${doc}`, note: '', kind: 'CLAIM', quote: '' },
    parts,
    links: parts.length > 1 ? [{ from: 'p1', to: 'p2', type: 'LEADS_TO', label: 'leads to', quote: '' }] : [],
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith('https://api.anthropic.com/')) return realFetch(input, init);

  const body = JSON.parse(String(init?.body ?? '{}'));
  const tool: string = body.tools?.[0]?.name ?? '';
  const user: string = body.messages?.[0]?.content ?? '';
  calls[tool] = (calls[tool] ?? 0) + 1;

  let input2: unknown = {};
  if (tool === 'outline_patch') {
    if (failExtract) return new Response('{"error":"overloaded"}', { status: 529 });
    input2 = fakeOutline(user);
  } else if (tool === 'extract_patch') {
    if (failExtract) return new Response('{"error":"overloaded"}', { status: 529 });
    if (failOn && user.includes(failOn)) return new Response('{"error":"too long"}', { status: 400 });
    // Every document mentions a booking, so the merge has something to match.
    input2 = {
      concepts: [
        { tempId: 't1', label: 'Booking', note: '', matchesExistingId: '', kind: 'ENTITY', belongsTo: '' },
        { tempId: 't2', label: `Section ${calls[tool]}`, note: '', matchesExistingId: '', kind: 'ENTITY', belongsTo: '' },
      ],
      relationships: [{ from: 't1', to: 't2', label: 'includes' }],
    };
  } else if (tool === 'merge_patch') {
    input2 = { decisions: [] };
  } else if (tool === 'cluster_patch') {
    const ids = [...new Set(user.match(/\bc_[a-z0-9]+\b/g) ?? [])];
    const half = Math.ceil(ids.length / 2);
    input2 = {
      areas: [
        { label: 'Bookings', memberIds: ids.slice(0, half) },
        { label: 'Everything else', memberIds: ids.slice(half) },
      ],
    };
  } else if (tool === 'propose_patch') {
    input2 = { concepts: [], relationships: [], questions: [{ text: 'Who approves a refund?', usefulness: 4 }] };
  }

  return new Response(
    JSON.stringify({
      content: [{ type: 'tool_use', name: tool, input: input2 }],
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}) as typeof fetch;

process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.LLM_PROVIDER = 'anthropic';

// ------------------------------------------------------------------ helpers

const json = (data: unknown) =>
  new Request('http://local/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

function upload(name: string, text: string, type = 'text/markdown') {
  const form = new FormData();
  form.append('file', new File([text], name, { type }));
  return new Request('http://local/api', { method: 'POST', body: form });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function body(res: Response) {
  return { status: res.status, ...(await res.json()) } as { status: number; [k: string]: any };
}

async function sampleDocs(): Promise<{ name: string; text: string }[]> {
  const names = ['Scope v3.md', 'Kickoff call 12 Aug.txt', 'Pricing.csv', 'Legacy schema.md'];
  return Promise.all(
    names.map(async (name) => ({ name, text: await readFile(join(process.cwd(), 'sample-documents', name), 'utf8') }))
  );
}

// ------------------------------------------------------------------ the run

async function fullRun(label: string) {
  section(`${label}: health`);
  const health = await body(await healthRoute.GET(new Request('http://local/api/preload/health?probe=1')));
  check('health answers ok with a round trip', health.status === 200 && health.ok === true && health.roundTrip === true, JSON.stringify(health));
  check(`health names the ${storageKind()} store`, health.storage === storageKind());

  section(`${label}: stage 0, one file per request`);
  const created = await body(await runRoute.POST(json({ title: 'Costume rental' })));
  check('a new run starts empty and idle', created.status === 200 && created.model.sources.length === 0 && created.model.run.stage === 'IDLE');
  const id: string = created.model.run.id;

  const docs = await sampleDocs();
  let last: any = null;
  for (const d of docs) {
    last = await body(await filesRoute.POST(upload(d.name, d.text), params(id)));
  }
  check('every sample file lands in the run', last.status === 200 && last.model.sources.length === docs.length, JSON.stringify(last.error ?? ''));
  check('the response carries no chunk text', last.model.chunks.length === 0);
  check('each readable file reports its sections', last.model.sources.every((s: any) => s.parse === 'OK' && s.chunkCount > 0));

  const dup = await body(await filesRoute.POST(upload(docs[0].name, docs[0].text), params(id)));
  check('the same file twice is recorded as a failure, not read twice', dup.model.sources.at(-1).parse === 'FAILED' && /twice/.test(dup.model.sources.at(-1).parseNote));

  const big = await body(await filesRoute.POST(upload('huge.txt', 'x'.repeat(MAX_UPLOAD_BYTES + 10), 'text/plain'), params(id)));
  check('a file over the limit is named and skipped', big.model.sources.at(-1).parse === 'FAILED' && /limit/.test(big.model.sources.at(-1).parseNote));

  // A .rtf is plain ASCII, so it once went in through the unknown-file path
  // and every control word reached the map. Its own run, so the build below
  // keeps the four sample files.
  const rtfRun = await body(await runRoute.POST(json({ title: 'RTF' })));
  const rtfSrc = ['{|rtf1|ansi|ansicpg1252{|fonttbl{|f0 Times;}}{|*|generator Word;}', '|pard|plain {|insrsid1 AI Code of Honour}|par ', 'I promise to follow the code of honour.|par }'].join('').replaceAll('|', String.fromCharCode(92));
  const rtfUp = await body(await filesRoute.POST(upload('Cover V2.rtf', rtfSrc, 'text/rtf'), params(rtfRun.model.run.id)));
  check('a .rtf upload is read', rtfUp.model?.sources.at(-1)?.parse === 'OK', rtfUp.model?.sources.at(-1)?.parseNote);
  const rtfText = ((await loadRunFull(rtfRun.model.run.id))?.chunks ?? []).map((c) => c.text).join(' ');
  check('its sections hold the words, not the RTF codes', rtfText.includes('I promise to follow the code of honour.') && !rtfText.includes(String.fromCharCode(92)) && !rtfText.includes('Times'), rtfText.slice(0, 80));

  const reopened = await body(await runIdRoute.GET(new Request('http://local'), params(id)));
  check('another request reopens the run by id', reopened.status === 200 && reopened.model.run.id === id);

  const title = await body(await actRoute.POST(json({ runId: id, action: { kind: 'title', title: 'Costume rental, new booking flow' } })));
  check('an action before the build is saved', title.model.title === 'Costume rental, new booking flow');

  section(`${label}: building, step by step`);
  calls = {};
  const stages: string[] = [];
  let model: any = null;
  for (let i = 0; i < 40; i++) {
    const res = await body(await stepRoute.POST(json({ runId: id })));
    if (res.status !== 200) {
      check('every step answers 200', false, `${res.status} ${res.error}`);
      return;
    }
    model = res.model;
    stages.push(model.run.stage);
    if (model.run.stage === 'READY' || model.run.stage === 'FAILED') break;
  }
  check('the run reaches READY', model.run.stage === 'READY', `${model.run.stage} ${model.run.failedStage}: ${model.run.failedWhy}`);
  check('it passes through every stage in order', ['READING', 'MERGING', 'STRUCTURING', 'PROBING', 'READY'].every((s) => stages.includes(s)), stages.join(' > '));
  check('stage 1 read every section of every readable file', calls.extract_patch === model.sources.filter((s: any) => s.parse === 'OK').reduce((n: number, s: any) => n + Math.min(s.chunkCount, 40), 0), String(calls.extract_patch));
  check('every readable file was marked as read', model.sources.filter((s: any) => s.parse === 'OK').every((s: any) => s.conceptCount !== 0));
  check('Booking from four files became one node', model.concepts.filter((c: any) => c.label === 'Booking' && !c.absorbedInto && c.status !== 'REJECTED').length === 1);
  check('the map has areas', model.clusters.length >= 1);
  check('the gap question came back', model.questions.some((q: any) => q.text === 'Who approves a refund?'));
  check('the map cites the documents', model.excerpts.length > 0);

  section(`${label}: one document, read top down`);
  calls = {};
  const one = await body(await runRoute.POST(json({ title: 'Chapter' })));
  const oneId: string = one.model.run.id;
  const longPara = 'Owners read every condition through their own confidence and that shapes their use. '.repeat(8);
  const chapterText = [
    '# Chapter 5 Discussion',
    '',
    'The chapter reads the findings against four expectations.',
    '',
    '## 5.1 Benefit',
    '',
    'Benefit matters more than ease of use for owners who start.',
    '',
    '## 5.2 Policy',
    '',
    'Personal checking takes the place of a written policy for owners.',
    '',
    `FAILME ${longPara}`,
    '',
    longPara,
  ].join('\n');
  await filesRoute.POST(upload('Chapter 5.md', chapterText), params(oneId));
  failOn = 'FAILME';
  let oneModel: any = null;
  const oneNotes: string[] = [];
  for (let i = 0; i < 20; i++) {
    const res = await body(await stepRoute.POST(json({ runId: oneId })));
    oneModel = res.model;
    if (res.note) oneNotes.push(res.note);
    if (oneModel.run.stage === 'READY' || oneModel.run.stage === 'FAILED') break;
  }
  failOn = '';
  check('a one-document run reaches READY', oneModel.run.stage === 'READY', `${oneModel.run.failedStage} ${oneModel.run.failedWhy}`);
  check('one outline call for the document', calls.outline_patch === 1);
  check('its areas are its parts, in reading order', oneModel.clusters.slice(0, 3).map((c: any) => c.label).join(' | ') === 'Part 1 of Chapter 5.md | Part 2 of Chapter 5.md | Part 3 of Chapter 5.md', oneModel.clusters.map((c: any) => c.label).join(' | '));
  check('no grouping call was spent on it', !calls.cluster_patch);
  check('the outline is saved with the run', oneModel.outlines.length === 1 && oneModel.outlines[0].partIds.length === 3);
  check('a part quoted from its heading is green', oneModel.concepts.some((c: any) => c.skeleton === 'PART' && c.status === 'VALIDATED'));
  check('a main point with no quote is an orange guess', oneModel.concepts.some((c: any) => c.skeleton === 'MAIN' && c.status === 'PROPOSED'));
  const src1 = oneModel.sources[0];
  check('a failing section is halved and only the failing half is reported', (src1.unread ?? []).length === 1 && /first half/.test(src1.unread[0].locator), JSON.stringify(src1.unread));
  check('the progress note names the hole', oneNotes.some((n) => /1 section not read/.test(n)), oneNotes.join(' / '));

  section(`${label}: after the build`);
  const after = await body(await filesRoute.POST(upload('late.md', '# Late\nA late file.'), params(id)));
  check('files cannot be added once the map is built', after.status === 409);

  const target = model.concepts.find((c: any) => c.label.startsWith('Section'));
  const rejected = await body(await actRoute.POST(json({ runId: id, action: { kind: 'reject', conceptId: target.id } })));
  check('a decision on the finished map is saved', rejected.model.concepts.find((c: any) => c.id === target.id).status === 'REJECTED');
  const again = await body(await runIdRoute.GET(new Request('http://local'), params(id)));
  check('and is still there when the run is reopened', again.model.concepts.find((c: any) => c.id === target.id).status === 'REJECTED');

  const raised = again.model.questions.find((q: any) => q.status === 'OPEN');
  const savedRes = await body(await actRoute.POST(json({ runId: id, action: { kind: 'question-save', questionId: raised.id } })));
  check('a question the map raised is saved to the run', Boolean(savedRes.model.questions.find((q: any) => q.id === raised.id).savedAt));
  const addedRes = await body(await actRoute.POST(json({ runId: id, action: { kind: 'question-add', text: 'Who signs off a refund over $500?' } })));
  check('a question in your own words is saved to the run', addedRes.model.questions.some((q: any) => q.text === 'Who signs off a refund over $500?' && q.savedAt));
  const longRes = await body(await actRoute.POST(json({ runId: id, action: { kind: 'question-add', text: 'x'.repeat(2000) } })));
  check('a very long question is cut to 500 characters', longRes.model.questions.at(-1).text.length === 500);
  await actRoute.POST(json({ runId: id, action: { kind: 'question-unsave', questionId: raised.id } }));
  const dismissed = await body(await actRoute.POST(json({ runId: id, action: { kind: 'question-dismiss', questionId: raised.id } })));
  check('a raised question can be dismissed', dismissed.model.questions.find((q: any) => q.id === raised.id).status === 'DONE');
  const reread = await body(await runIdRoute.GET(new Request('http://local'), params(id)));
  check('the saved list survives reopening the run', reread.model.questions.filter((q: any) => q.savedAt && q.status === 'OPEN').length === 2);

  const list = await body(await runRoute.GET());
  check('the run is listed', list.runs.some((r: any) => r.id === id && r.stage === 'READY'));

  section(`${label}: a failing model, then resume`);
  const c2 = await body(await runRoute.POST(json({ title: 'Broken key' })));
  await filesRoute.POST(upload(docs[0].name, docs[0].text), params(c2.model.run.id));
  failExtract = true;
  let broken: any = null;
  for (let i = 0; i < 5; i++) {
    broken = (await body(await stepRoute.POST(json({ runId: c2.model.run.id })))).model;
    if (broken.run.stage === 'FAILED') break;
  }
  check('every call failing stops the run and names the stage', broken.run.stage === 'FAILED' && broken.run.failedStage === 'READING');
  failExtract = false;
  let resumed = (await body(await stepRoute.POST(json({ runId: c2.model.run.id, resume: true })))).model;
  for (let i = 0; i < 10 && resumed.run.stage !== 'READY'; i++) {
    resumed = (await body(await stepRoute.POST(json({ runId: c2.model.run.id })))).model;
  }
  check('resume finishes the same run', resumed.run.stage === 'READY');

  section(`${label}: bad input`);
  const missing = await body(await runIdRoute.GET(new Request('http://local'), params('run_doesnotexist')));
  check('an unknown run is a 404 that says so', missing.status === 404 && missing.error === RUN_MISSING);
  const bad = await body(await stepRoute.POST(json({ runId: '../../etc' })));
  check('a run id that walks out of the folder is refused', bad.status === 500 && /Bad run id/.test(bad.error));
}

async function main() {
  useStorage(memoryStorage());
  await fullRun('memory');

  const dir = await mkdtemp(join(tmpdir(), 'cb-runs-'));
  process.env.PRELOAD_RUN_DIR = dir;
  useStorage(null);
  try {
    await fullRun('disk');
  } finally {
    delete process.env.PRELOAD_RUN_DIR;
    await rm(dir, { recursive: true, force: true });
  }

  section('serverless with no store');
  process.env.VERCEL = '1';
  delete process.env.BLOB_READ_WRITE_TOKEN;
  useStorage(null);
  const health = await body(await healthRoute.GET(new Request('http://local/api/preload/health')));
  check('health says there is nowhere to keep runs', health.status === 503 && health.error === STORAGE_MISSING);
  const created = await body(await runRoute.POST(json({ title: 'x' })));
  check('starting a run says what to connect, instead of using a temporary disk', created.status === 500 && created.error === STORAGE_MISSING);
  delete process.env.VERCEL;

  console.log(`\n${pass} passed, ${fail} failed.\n`);
  if (fail > 0) process.exit(1);
  console.log('All checks passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
