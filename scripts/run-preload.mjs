#!/usr/bin/env node
/*
 * Drive a whole preload run from the command line.
 *
 *   npm run dev                       # in one terminal
 *   npm run preload sample-documents  # in another
 *
 * Same routes the browser uses, so this is the real pipeline and not a
 * parallel implementation. It exists because a prompt change is much easier
 * to judge from a printed map than from a canvas, and because a failing
 * stage names itself here without anyone watching a screen.
 */

import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

const BASE = process.env.PRELOAD_BASE || 'http://localhost:3000';
const folder = process.argv[2] || 'sample-documents';
const title = process.argv.slice(3).join(' ') || 'Untitled project';

const MIME = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const orange = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

async function main() {
  const names = (await readdir(folder)).filter((n) => !n.startsWith('.'));
  if (!names.length) {
    console.error(`Nothing in ${folder}`);
    process.exit(1);
  }

  // Same order as the browser: an empty run, then one file per request,
  // because a hosted function refuses a body over 4.5 MB.
  console.log(bold(`\nSTAGE 0  reading the files`));
  const created = await (
    await fetch(`${BASE}/api/preload/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    })
  ).json();
  if (created.error) {
    console.error(red(created.error));
    process.exit(1);
  }

  let model0 = created.model;
  for (const name of names) {
    const buf = await readFile(join(folder, name));
    const type = MIME[extname(name).toLowerCase()] || 'application/octet-stream';
    const form = new FormData();
    form.append('file', new File([buf], basename(name), { type }));
    const up = await fetch(`${BASE}/api/preload/run/${model0.run.id}/files`, { method: 'POST', body: form });
    const text = await up.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: `${up.status} ${text.slice(0, 120)}` };
    }
    if (body.error) {
      console.log(`   ${red('FAILED')}  ${name}  ${red(body.error)}`);
      continue;
    }
    model0 = body.model;
  }

  for (const s of model0.sources) {
    const state = s.parse === 'OK' ? green(`${s.chunkCount} sections`) : red(s.parseNote);
    console.log(`   ${s.parse === 'OK' ? green('OK') : red(s.parse)}  ${s.role.padEnd(10)} ${s.name}  ${state}`);
  }

  const runId = model0.run.id;
  console.log(dim(`   run ${runId}`));
  console.log(bold(`\nBUILDING`));

  const started = Date.now();
  let model = model0;

  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${BASE}/api/preload/step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId }),
    });
    const body = await res.json();
    if (body.error) {
      console.error(red(`   ${body.error}`));
      process.exit(1);
    }
    model = body.model;
    const stage = model.run.stage;
    if (body.note) console.log(`   ${dim(`[${stage}]`)} ${body.note} ${dim(`${(body.ms / 1000).toFixed(1)}s`)}`);
    if (stage === 'READY') break;
    if (stage === 'FAILED') {
      console.error(red(`\n   ${model.run.failedStage}: ${model.run.failedWhy}`));
      console.error(dim(`   Fix it and run again: everything read so far is kept in .runs/${runId}.json`));
      process.exit(1);
    }
  }

  report(model, Date.now() - started, runId);
}

function report(model, ms, runId) {
  const live = model.concepts.filter((c) => c.status !== 'REJECTED' && !c.absorbedInto);
  const byId = new Map(model.excerpts.map((e) => [e.id, e]));
  const sourcesOf = (c) => [...new Set(c.evidence.map((id) => byId.get(id)?.sourceId).filter(Boolean))];
  const nameOf = (id) => model.sources.find((s) => s.id === id)?.name ?? id;

  const contested = live.filter((c) => c.status === 'CONTESTED');
  const guessed = live.filter((c) => c.status === 'PROPOSED');
  const multi = live.filter((c) => sourcesOf(c).length > 1);

  console.log(bold(`\nRESULT  ${(ms / 1000).toFixed(0)}s`));
  console.log(
    `   ${live.length} concepts · ${green(`${multi.length} from 2+ sources`)} · ` +
      `${red(`${contested.length} contested`)} · ${orange(`${guessed.length} guessed`)}`
  );

  console.log(bold(`\nAREAS`));
  for (const cl of model.clusters) {
    const members = live.filter((c) => c.clusterId === cl.id);
    console.log(`   ${cl.label}  ${dim(`${members.length}`)}`);
    for (const c of members.filter((m) => m.tier === 2).slice(0, 6)) {
      const n = sourcesOf(c).length;
      const mark = c.status === 'CONTESTED' ? red('≠') : c.status === 'PROPOSED' ? orange('?') : n > 1 ? green(String(n)) : ' ';
      console.log(`      ${mark} ${c.label}`);
    }
  }

  if (contested.length) {
    console.log(bold(`\nCONTESTED`));
    for (const c of contested) {
      console.log(`   ${red('≠')} ${bold(c.label)} — ${c.contest?.why ?? ''}`);
      for (const r of c.contest?.readings ?? []) {
        const q = model.excerpts.find((e) => e.id === r.evidenceId);
        console.log(dim(`      ${nameOf(r.sourceId)} · ${q?.locator ?? '?'}`));
        console.log(`      "${(q?.quote ?? r.summary).slice(0, 150).replace(/\s+/g, ' ')}"`);
      }
    }
  }

  const open = model.questions.filter((q) => q.status === 'OPEN');
  if (open.length) {
    console.log(bold(`\nGAPS`));
    for (const q of open.slice(0, 6)) console.log(`   ${q.usefulness}  ${q.text}`);
  }

  const b = model.log.reduce(
    (acc, l) => {
      if (!l.blocked) return acc;
      acc.invented += l.blocked.invented ?? 0;
      acc.uncited += l.blocked.uncited ?? 0;
      acc.duplicates += l.blocked.duplicates ?? 0;
      return acc;
    },
    { invented: 0, uncited: 0, duplicates: 0 }
  );
  console.log(
    bold(`\nGUARDS`) +
      `\n   ${b.duplicates} duplicates merged · ${b.invented} invented references refused · ${b.uncited} uncited concepts dropped`
  );
  console.log(dim(`\n   Open it: ${BASE}/preload?run=${runId}\n`));
}

main().catch((e) => {
  console.error(red(`\n${e.message}`));
  console.error(dim('Is the dev server running? npm run dev'));
  process.exit(1);
});
