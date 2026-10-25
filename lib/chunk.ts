import type { Chunk, SourceRole } from './types';
import { newId } from './types';

/*
 * Splitting, not windowing.
 *
 * A fixed-size window cuts a sentence in half and produces a citation that
 * points at nothing a person can read. Documents already have their own
 * seams: headings, page breaks, timestamps, blank lines. Split on those, and
 * the locator falls out of the split for free.
 *
 * Pure. No network, no filesystem, no model. Everything here is exercised by
 * scripts/smoke-preload.ts with hand-written input.
 */

/** Page breaks come out of the PDF parser as form feeds. */
export const PAGE_BREAK = '\f';

const MAX_CHARS = 2400;
/** Below this a chunk is glued onto its neighbour rather than sent on its own. */
const MIN_CHARS = 220;

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
/** 00:14:22 or [00:14] or 1:02:33, at the start of a line. */
const TIMESTAMP = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–—:]?\s*/;

type Piece = { text: string; locator: string };

function squeeze(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Split a long piece on paragraph boundaries, keeping the locator. */
function splitLong(piece: Piece): Piece[] {
  if (piece.text.length <= MAX_CHARS) return [piece];
  const paras = piece.text.split(/\n\n+/);
  const out: Piece[] = [];
  let buf = '';
  let part = 1;
  const flush = () => {
    if (!buf.trim()) return;
    out.push({ text: buf.trim(), locator: part === 1 ? piece.locator : `${piece.locator} (${part})` });
    part++;
    buf = '';
  };
  for (const para of paras) {
    if (buf && buf.length + para.length > MAX_CHARS) flush();
    buf += (buf ? '\n\n' : '') + para;
  }
  flush();
  return out.length ? out : [piece];
}

/** Glue anything too small onto the piece before it. Keeps the first locator. */
function glueSmall(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    const prev = out[out.length - 1];
    if (prev && p.text.length < MIN_CHARS && prev.text.length + p.text.length <= MAX_CHARS) {
      prev.text = `${prev.text}\n\n${p.text}`;
      continue;
    }
    out.push({ ...p });
  }
  return out;
}

/** Markdown and anything with `#` headings. Locator is the heading path. */
function byHeading(text: string): Piece[] {
  const lines = text.split('\n');
  const pieces: Piece[] = [];
  let title = 'intro';
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) pieces.push({ text: body, locator: `§ ${title}` });
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(HEADING);
    if (m) {
      // A heading straight after another heading ("Chapter 5" then "5.1")
      // has no body of its own. Carry it into the next section rather than
      // sending a chunk that is nothing but a title.
      const onlyHeadings = buf.every((l) => !l.trim() || HEADING.test(l));
      if (!onlyHeadings) flush();
      title = m[2].slice(0, 60);
      buf.push(line);
      continue;
    }
    buf.push(line);
  }
  flush();
  return pieces;
}

/** PDF output. One piece per page, page number straight off the split. */
function byPage(text: string): Piece[] {
  return text
    .split(PAGE_BREAK)
    .map((t, i) => ({ text: t.trim(), locator: `p.${i + 1}` }))
    .filter((p) => p.text.length > 0);
}

/**
 * A transcript. Group consecutive lines under the last timestamp seen, so a
 * citation lands on a moment in the recording rather than a line number.
 */
function byTimestamp(text: string): Piece[] {
  const lines = text.split('\n');
  const pieces: Piece[] = [];
  let stamp = '00:00';
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join('\n').trim();
    if (body) pieces.push({ text: body, locator: stamp });
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(TIMESTAMP);
    if (m) {
      if (buf.join('').trim().length > MIN_CHARS) flush();
      stamp = m[1];
      buf.push(line.replace(TIMESTAMP, ''));
      continue;
    }
    buf.push(line);
  }
  flush();
  return pieces;
}

/** Everything else. Paragraph groups, numbered so a citation is still checkable. */
function byParagraph(text: string): Piece[] {
  const paras = text.split(/\n\n+/).filter((p) => p.trim());
  const pieces: Piece[] = [];
  let buf: string[] = [];
  let first = 1;
  let n = 0;
  for (const para of paras) {
    n++;
    const candidate = [...buf, para].join('\n\n');
    if (buf.length && candidate.length > MAX_CHARS) {
      pieces.push({ text: buf.join('\n\n'), locator: first === n - 1 ? `¶ ${first}` : `¶ ${first}-${n - 1}` });
      buf = [para];
      first = n;
      continue;
    }
    buf.push(para);
  }
  if (buf.length) pieces.push({ text: buf.join('\n\n'), locator: first === n ? `¶ ${first}` : `¶ ${first}-${n}` });
  return pieces;
}

/** CSV and TSV. Header plus a block of rows, so a row range is the locator. */
function byRows(text: string): Piece[] {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return [];
  const header = lines[0];
  const body = lines.slice(1);
  const per = 40;
  const pieces: Piece[] = [];
  for (let i = 0; i < body.length; i += per) {
    const slice = body.slice(i, i + per);
    pieces.push({
      text: [header, ...slice].join('\n'),
      locator: `rows ${i + 1}-${i + slice.length}`,
    });
  }
  return pieces.length ? pieces : [{ text: header, locator: 'header' }];
}

export type ChunkStrategy = 'heading' | 'page' | 'timestamp' | 'rows' | 'paragraph';

/** Pick a strategy from the filename, the role and what the text looks like. */
export function chooseStrategy(name: string, role: SourceRole, text: string): ChunkStrategy {
  if (text.includes(PAGE_BREAK)) return 'page';
  if (/\.(csv|tsv)$/i.test(name)) return 'rows';
  if (role === 'TRANSCRIPT' || TIMESTAMP.test(text.split('\n').find((l) => l.trim()) ?? '')) return 'timestamp';
  if (/\.(md|markdown)$/i.test(name) || HEADING.test(text.split('\n')[0] ?? '')) return 'heading';
  // Word and PDF files now arrive with their headings marked. Two or more is
  // a document with sections, wherever the first one sits.
  if (text.split('\n').filter((l) => HEADING.test(l)).length >= 2) return 'heading';
  return 'paragraph';
}

export function chunkText(
  sourceId: string,
  raw: string,
  opts: { name: string; role: SourceRole; strategy?: ChunkStrategy }
): Chunk[] {
  const text = squeeze(raw);
  if (!text) return [];

  const strategy = opts.strategy ?? chooseStrategy(opts.name, opts.role, text);
  const first =
    strategy === 'page'
      ? byPage(text)
      : strategy === 'heading'
        ? byHeading(text)
        : strategy === 'timestamp'
          ? byTimestamp(text)
          : strategy === 'rows'
            ? byRows(text)
            : byParagraph(text);

  // Heading, page and timestamp splits exist to produce a locator a person
  // can check. Gluing two of them together would throw that away, so small
  // pieces are only glued back when the split was arbitrary to begin with.
  const structural = strategy === 'heading' || strategy === 'page' || strategy === 'timestamp';
  const split = first.flatMap(splitLong);
  const pieces = (structural ? split : glueSmall(split)).filter((p) => p.text.trim().length > 0);

  return pieces.map((p, i) => ({
    id: newId('ch'),
    sourceId,
    ordinal: i,
    text: p.text,
    locator: p.locator,
  }));
}

/**
 * Guess what a file is for (R9). The user corrects this on the intake screen,
 * and their answer is the one the merge uses.
 */
export function guessRole(name: string, text: string): SourceRole {
  const n = name.toLowerCase();
  if (/\.(csv|tsv|xlsx?|json)$/.test(n)) return 'DATA';
  if (/(transcript|call|meeting|granola|otter|recording|zoom)/.test(n)) return 'TRANSCRIPT';
  if (/(scope|spec|requirement|brief|sow|contract|proposal|brd|prd)/.test(n)) return 'SPEC';
  if (/(note|minute|kickoff|standup|summary)/.test(n)) return 'NOTES';
  if (/(readme|doc|guide|manual|schema|reference|api)/.test(n)) return 'REFERENCE';

  const head = text.slice(0, 1500);
  if (/^\s*\[?\d{1,2}:\d{2}/m.test(head)) return 'TRANSCRIPT';
  if (/\b(shall|must|the supplier|the client agrees|in scope|out of scope)\b/i.test(head)) return 'SPEC';
  return 'UNKNOWN';
}
