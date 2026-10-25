import { inflateRawSync } from 'node:zlib';
import { PAGE_BREAK } from './chunk';

/*
 * File in, plain text out. Server side only.
 *
 * Two rules, both from R11.
 *
 * Nothing that fails is hidden. A file that produces no text comes back as
 * EMPTY with a reason a person can act on, and the intake screen names it.
 * Silently dropping a file is how a map ends up missing a third of the
 * project with nobody noticing.
 *
 * Page and section boundaries survive. The PDF reader inserts a form feed
 * between pages, which is what chunk.ts turns into "p.18". A parser that
 * throws away structure produces citations nobody can check.
 */

export type ParseResult = {
  text: string;
  status: 'OK' | 'EMPTY' | 'FAILED';
  note: string;
};

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|srt|vtt|html?|xml|ya?ml)$/i;

/** Strip control bytes but keep tab, newline and the page-break form feed. */
function stripControl(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000e-\u001f]/g, '');
}

function ok(text: string): ParseResult {
  const trimmed = stripControl(text).trim();
  if (!trimmed) return { text: '', status: 'EMPTY', note: 'The file has no readable text.' };
  return { text: trimmed, status: 'OK', note: '' };
}

// ---------------------------------------------------------------- docx

/**
 * A .docx is a zip. Rather than take a dependency for one file format, read
 * the central directory, inflate word/document.xml and keep the paragraph
 * breaks. About sixty lines, and one less thing to install on a Mac before a
 * meeting.
 */
function readZipEntry(buf: Buffer, wanted: string): Buffer | null {
  // End of central directory record: signature 0x06054b50, scanned backwards.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    if (name === wanted) {
      const lhNameLen = buf.readUInt16LE(localOffset + 26);
      const lhExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lhNameLen + lhExtraLen;
      const raw = buf.slice(start, start + compressedSize);
      return method === 0 ? raw : inflateRawSync(raw);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/*
 * Word keeps the author's structure, and the map needs it: headings are the
 * seams the chunker splits on and the skeleton the outline call starts from.
 * The first version flattened every paragraph to one newline, so a chapter
 * with no empty paragraphs came out as one block of 10,000+ characters, one
 * chunk, and one failed call that nobody saw (25 Oct 2026).
 *
 * So the reader walks the paragraphs. A heading style (or an outline level,
 * or a short bold numbered line typed by hand) becomes a "#" line, every
 * paragraph ends with a blank line, list items stay together, and a table
 * becomes one row per line. Only real text counts: deleted revisions and
 * field codes are skipped, and the fallback copy of a text box is dropped so
 * its words appear once.
 */

type StyleInfo = { name: string; basedOn: string; outline: number | null };

function xmlAttr(attrs: string, name: string): string {
  const m = new RegExp(`${name}="([^"]*)"`).exec(attrs);
  return m ? m[1] : '';
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function readStyles(xml: string | null): Map<string, StyleInfo> {
  const styles = new Map<string, StyleInfo>();
  if (!xml) return styles;
  const re = /<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const id = xmlAttr(m[1], 'w:styleId');
    if (!id) continue;
    const body = m[2];
    const name = /<w:name\s+w:val="([^"]*)"/.exec(body)?.[1] ?? '';
    const basedOn = /<w:basedOn\s+w:val="([^"]*)"/.exec(body)?.[1] ?? '';
    const outline = /<w:outlineLvl\s+w:val="(\d+)"/.exec(body)?.[1];
    styles.set(id, { name, basedOn, outline: outline === undefined ? null : Number(outline) });
  }
  return styles;
}

/** 1-6 for a heading style, 0 for anything else. Follows basedOn a few steps. */
function styleHeadingLevel(styles: Map<string, StyleInfo>, id: string): number {
  let cur = id;
  for (let depth = 0; cur && depth < 6; depth++) {
    const s = styles.get(cur);
    const name = (s?.name || cur).toLowerCase();
    const named = /^heading\s*([1-9])$/.exec(name);
    if (named) return Math.min(6, Number(named[1]));
    if (name === 'title') return 1;
    if (s?.outline !== null && s?.outline !== undefined && s.outline < 9) return Math.min(6, s.outline + 1);
    if (!s) return 0;
    cur = s.basedOn;
  }
  return 0;
}

function styleIsList(styles: Map<string, StyleInfo>, id: string): boolean {
  const name = (styles.get(id)?.name || id).toLowerCase();
  return /^list/.test(name);
}

/**
 * A short line numbered "5.5 ..." or a bold "1 Introduction" reads as a
 * heading even when the author typed it by hand rather than using a style.
 * A full sentence never does.
 */
export function looksLikeHeading(text: string, mostlyBold: boolean): number {
  const t = text.trim();
  if (!t || t.length > 120 || /[.:;,!?]$/.test(t)) return 0;
  const deep = /^(\d+(?:\.\d+)+)\.?\s+\S/.exec(t);
  if (deep) return Math.min(6, deep[1].split('.').length);
  if (mostlyBold && /^(\d+\.?|[IVX]+\.|chapter\s+\d+|глава\s+\d+)\s+\S/i.test(t)) return 1;
  return 0;
}

type Para = { text: string; style: string; outline: number | null; list: boolean; bold: number; plain: number; runBold: boolean };

export function docxXmlToText(documentXml: string, stylesXml: string | null): string {
  const styles = readStyles(stylesXml);
  // Word writes a text box twice, once for new readers and once as a fallback.
  const xml = documentXml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');

  const blocks: string[] = [];
  const stack: Para[] = [];
  let cur: Para | null = null;
  let tableDepth = 0;
  let rows: string[] = [];
  let row: string[] = [];
  let cell: string[] = [];

  const push = (block: string, list: boolean) => {
    const last = blocks[blocks.length - 1];
    if (list && last !== undefined && last.startsWith('- ')) blocks[blocks.length - 1] = `${last}\n${block}`;
    else blocks.push(block);
  };

  const finish = (p: Para) => {
    const text = p.text.replace(/[ \t]+\n/g, '\n').trim();
    if (!text) return;
    // A table of contents repeats the headings with page numbers. The real
    // headings follow, so the copy is noise.
    if (/^toc\b/i.test(styles.get(p.style)?.name ?? p.style)) return;
    if (tableDepth > 0) {
      cell.push(text.replace(/\s+/g, ' '));
      return;
    }
    const level =
      styleHeadingLevel(styles, p.style) ||
      (p.outline !== null && p.outline < 9 ? Math.min(6, p.outline + 1) : 0) ||
      looksLikeHeading(text, p.plain > 0 && p.bold >= p.plain * 0.8);
    if (level) {
      blocks.push(`${'#'.repeat(level)} ${text.replace(/\s+/g, ' ')}`);
      return;
    }
    if (p.list || styleIsList(styles, p.style)) {
      push(`- ${text.replace(/\n+/g, ' ')}`, true);
      return;
    }
    blocks.push(text);
  };

  const re = /<(\/?)w:(p|pStyle|outlineLvl|numPr|t|tab|br|cr|tbl|tr|tc|r|b|noBreakHyphen)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const closing = m[1] === '/';
    const tag = m[2];
    const attrs = m[3];
    const selfClosing = m[4] === '/';

    switch (tag) {
      case 'p':
        if (closing) {
          if (cur) finish(cur);
          cur = stack.pop() ?? null;
        } else if (!selfClosing) {
          if (cur) stack.push(cur);
          cur = { text: '', style: '', outline: null, list: false, bold: 0, plain: 0, runBold: false };
        }
        break;
      case 'pStyle':
        if (cur) cur.style = xmlAttr(attrs, 'w:val');
        break;
      case 'outlineLvl':
        if (cur) cur.outline = Number(xmlAttr(attrs, 'w:val'));
        break;
      case 'numPr':
        if (cur && !closing) cur.list = true;
        break;
      case 'r':
        if (cur && !closing) cur.runBold = false;
        break;
      case 'b': {
        const v = xmlAttr(attrs, 'w:val');
        if (cur && !closing) cur.runBold = !v || v === '1' || v === 'true' || v === 'on';
        break;
      }
      case 't': {
        if (closing || selfClosing) break;
        const end = xml.indexOf('</w:t>', re.lastIndex);
        if (end < 0) break;
        const text = decodeXml(xml.slice(re.lastIndex, end));
        re.lastIndex = end + 6;
        if (!cur) break;
        cur.text += text;
        if (cur.runBold) cur.bold += text.trim().length;
        cur.plain += text.trim().length;
        break;
      }
      case 'tab':
        if (cur && !closing) cur.text += '\t';
        break;
      case 'br':
      case 'cr':
        if (cur && !closing) cur.text += '\n';
        break;
      case 'noBreakHyphen':
        if (cur && !closing) cur.text += '-';
        break;
      case 'tbl':
        if (selfClosing) break;
        if (!closing) {
          tableDepth++;
          if (tableDepth === 1) rows = [];
        } else {
          if (tableDepth === 1 && rows.length) blocks.push(rows.join('\n'));
          tableDepth = Math.max(0, tableDepth - 1);
        }
        break;
      case 'tr':
        if (tableDepth !== 1 || selfClosing) break;
        if (!closing) row = [];
        else if (row.some((c) => c)) rows.push(row.join(' | '));
        break;
      case 'tc':
        if (tableDepth !== 1 || selfClosing) break;
        if (!closing) cell = [];
        else row.push(cell.join(' '));
        break;
    }
  }

  return blocks.join('\n\n');
}

function docxToText(buf: Buffer): ParseResult {
  const xmlBuf = readZipEntry(buf, 'word/document.xml');
  if (!xmlBuf) return { text: '', status: 'FAILED', note: 'Not a readable .docx (no word/document.xml).' };
  const stylesBuf = readZipEntry(buf, 'word/styles.xml');
  return ok(docxXmlToText(xmlBuf.toString('utf8'), stylesBuf ? stylesBuf.toString('utf8') : null));
}

// ---------------------------------------------------------------- rtf

/*
 * RTF is plain ASCII, so it used to slip through the unknown-extension path
 * as text. Every control word then went to the model and into the quotes, and
 * the evidence panel showed `\par }\pard \ltrpar\qj` instead of a sentence
 * (seen 25 Oct 2026 on a Word-saved .rtf). Read it properly: walk the groups,
 * keep the text, drop font tables, styles, pictures and metadata.
 *
 * Word and TextEdit both write enough of the spec for this to stay small.
 * Footnotes are kept, moved to the end with a [n] mark where they were.
 * Headers and footers are dropped, as the DOCX reader drops them.
 */

/** Groups whose content is never text a person wrote in the body. */
const RTF_SKIP = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'listtable', 'listoverridetable',
  'rsidtbl', 'generator', 'xmlnstbl', 'themedata', 'colorschememapping', 'latentstyles', 'datastore',
  'fldinst', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf',
  'filetbl', 'revtbl', 'pgdsctbl', 'xe', 'tc', 'txe', 'private', 'nonshppict', 'shpinst',
  'bkmkstart', 'bkmkend', 'userprops', 'docvar', 'template', 'expandedcolortbl', 'listpicture',
  'annotation', 'atnid', 'atnauthor', 'atnref', 'atntime', 'atrfstart', 'atrfend', 'mmathPr',
]);

const BULLET = '\u2022';

/** Control words that stand for a character or a break. */
const RTF_CHAR: Record<string, string> = {
  par: '\n\n',
  sect: '\n\n',
  page: '\n\n',
  line: '\n',
  tab: '\t',
  cell: '\t',
  nestcell: '\t',
  row: '\n',
  nestrow: '\n',
  emdash: '\u2014',
  endash: '\u2013',
  bullet: '\u2022',
  lquote: '\u2018',
  rquote: '\u2019',
  ldblquote: '\u201c',
  rdblquote: '\u201d',
  emspace: ' ',
  enspace: ' ',
  qmspace: ' ',
};

const CODEPAGE_LABEL: Record<number, string> = {
  866: 'ibm866',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  10000: 'macintosh',
};

function decoderFor(codepage: number): TextDecoder {
  for (const label of [CODEPAGE_LABEL[codepage], `windows-${codepage}`]) {
    if (!label) continue;
    try {
      return new TextDecoder(label);
    } catch {
      // Unknown label in this runtime. Try the next one.
    }
  }
  return new TextDecoder('windows-1252');
}

export function looksLikeRtf(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString('latin1') === '{\\rtf';
}

/** Pure. Takes the file as a latin1 string, so every byte maps to one char. */
export function rtfToText(src: string): ParseResult {
  type Frame = { skip: boolean; uc: number; note: number };
  const stack: Frame[] = [];
  let frame: Frame = { skip: false, uc: 1, note: -1 };

  let body = '';
  const notes: string[] = [];
  let bytes: number[] = [];
  let decoder = decoderFor(1252);
  /** Fallback characters still to drop after a \uN. */
  let fallback = 0;

  const write = (s: string) => {
    if (frame.skip || !s) return;
    if (frame.note >= 0) notes[frame.note] += s;
    else body += s;
  };
  const flushBytes = () => {
    if (!bytes.length) return;
    const s = decoder.decode(Uint8Array.from(bytes));
    bytes = [];
    write(s);
  };
  const put = (s: string) => {
    flushBytes();
    write(s);
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (ch === '{') {
      flushBytes();
      stack.push(frame);
      frame = { ...frame };
      fallback = 0;
      i++;
      continue;
    }
    if (ch === '}') {
      flushBytes();
      frame = stack.pop() ?? frame;
      fallback = 0;
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      i++;
      continue;
    }

    if (ch !== '\\') {
      i++;
      if (fallback > 0) {
        fallback--;
        continue;
      }
      const code = ch.charCodeAt(0);
      // A writer that puts 8-bit bytes straight in the file means the codepage.
      if (code > 127) {
        if (!frame.skip) bytes.push(code);
      } else {
        put(ch);
      }
      continue;
    }

    // A backslash: control symbol, hex byte or control word.
    const next = src[i + 1];
    if (next === undefined) break;

    if (next === "'") {
      const byte = parseInt(src.slice(i + 2, i + 4), 16);
      i += 4;
      if (fallback > 0) {
        fallback--;
        continue;
      }
      if (!Number.isNaN(byte) && !frame.skip) bytes.push(byte);
      continue;
    }

    if (!/[a-zA-Z]/.test(next)) {
      i += 2;
      if (next === '*') {
        frame.skip = true;
        continue;
      }
      if (fallback > 0) {
        fallback--;
        continue;
      }
      if (next === '\\' || next === '{' || next === '}') put(next);
      else if (next === '~') put(' ');
      else if (next === '_') put('-');
      else if (next === '\n' || next === '\r') put('\n\n');
      // \- optional hyphen, \: index subentry, \| formula: nothing to show.
      continue;
    }

    const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i, i + 48));
    if (!m) {
      i++;
      continue;
    }
    i += m[0].length;
    const word = m[1];
    const num = m[2] === undefined ? null : Number(m[2]);
    fallback = 0;

    if (word === 'bin') {
      // Raw binary follows. It is never text.
      i += Math.max(0, num ?? 0);
      continue;
    }
    if (RTF_SKIP.has(word)) {
      frame.skip = true;
      continue;
    }
    if (word === 'footnote') {
      if (frame.skip) continue;
      notes.push('');
      put(` [${notes.length}]`);
      frame.note = notes.length - 1;
      continue;
    }
    if (word === 'ansicpg' && num !== null) {
      flushBytes();
      decoder = decoderFor(num);
      continue;
    }
    if (word === 'uc' && num !== null) {
      frame.uc = Math.max(0, num);
      continue;
    }
    if (word === 'u' && num !== null) {
      const code = num < 0 ? num + 65536 : num;
      // Symbol and Wingdings bullets arrive in the private-use block
      // (LibreOffice writes \u61623 for the usual list dot) and show as
      // empty boxes anywhere else.
      put(code >= 0xf000 && code <= 0xf0ff ? BULLET : String.fromCharCode(code));
      fallback = frame.uc;
      continue;
    }
    const mapped = RTF_CHAR[word];
    if (mapped !== undefined) put(mapped);
  }
  flushBytes();

  let text = body;
  if (notes.some((n) => n.trim())) {
    text += '\n\nFootnotes\n\n' + notes.map((n, k) => `[${k + 1}] ${n.trim()}`).join('\n\n');
  }

  return ok(
    text
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n +/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
  );
}

// ---------------------------------------------------------------- pdf

/*
 * pdf.js hands back positioned text runs, not lines. The first version joined
 * every run on a page with a space, so a page became one long line: no
 * paragraphs, no headings, nothing for the chunker or the outline to hold.
 *
 * Runs on the same baseline are one line. A larger vertical gap starts a new
 * paragraph. A line set noticeably bigger than the body text, short and
 * without a full stop, is a heading and gets a "#". Wrapped lines rejoin with
 * a space, and a word broken by a hyphen at the end of a line is mended.
 */

export type PdfItem = { str: string; transform?: number[]; width?: number; height?: number };

const PRIVATE_USE = new RegExp('[' + String.fromCharCode(0xf000) + '-' + String.fromCharCode(0xf0ff) + ']', 'g');
const BULLET_START = /^([•▪◦‣\-–—*]|\(?\d{1,2}[.)])\s/;

type PdfLine = { text: string; size: number; y: number };

export function pdfItemsToText(items: PdfItem[]): string {
  const lines: PdfLine[] = [];
  let cur: (PdfLine & { endX: number; weight: number; sizeSum: number }) | null = null;

  for (const it of items) {
    const raw = (it.str ?? '').replace(PRIVATE_USE, '•');
    const t = it.transform;
    if (!t || t.length < 6) {
      if (!raw.trim()) continue;
      if (!cur) cur = { text: '', size: 10, y: 0, endX: 0, weight: 0, sizeSum: 0 };
      cur.text += (cur.text && !/\s$/.test(cur.text) ? ' ' : '') + raw;
      continue;
    }
    const size = Math.max(1, Math.hypot(t[2], t[3]) || it.height || 10);
    const x = t[4];
    const y = t[5];
    const sameLine = cur !== null && Math.abs(y - cur.y) <= Math.max(1.5, Math.min(size, cur.size) * 0.45);
    if (!sameLine) {
      if (cur && cur.text.trim()) lines.push({ text: cur.text.trim(), size: cur.size, y: cur.y });
      cur = { text: '', size, y, endX: x, weight: 0, sizeSum: 0 };
    }
    const line = cur!;
    if (raw) {
      const gap = x - line.endX;
      if (line.text && !/\s$/.test(line.text) && !/^\s/.test(raw) && gap > size * 0.15) line.text += ' ';
      line.text += raw;
      const len = raw.trim().length;
      if (len) {
        line.sizeSum += size * len;
        line.weight += len;
        line.size = line.sizeSum / line.weight;
      }
    }
    line.endX = x + (it.width ?? raw.length * size * 0.5);
  }
  if (cur && cur.text.trim()) lines.push({ text: cur.text.trim(), size: cur.size, y: cur.y });
  if (!lines.length) return '';

  // Body size: the size most of the characters on the page are set in.
  const bySize = new Map<number, number>();
  for (const l of lines) bySize.set(Math.round(l.size), (bySize.get(Math.round(l.size)) ?? 0) + l.text.length);
  const body = [...bySize.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const blocks: string[] = [];
  let para = '';
  let prev: PdfLine | null = null;
  const flush = () => {
    if (para.trim()) blocks.push(para.trim());
    para = '';
  };

  for (const l of lines) {
    const heading =
      l.size >= body * 1.18 && l.text.length <= 120 && !/[.:;,!?]$/.test(l.text) && /[^\d\W]/.test(l.text);
    if (heading) {
      flush();
      blocks.push(`${l.size >= body * 1.45 ? '#' : '##'} ${l.text.replace(/\s+/g, ' ')}`);
      prev = l;
      continue;
    }
    const gap = prev ? prev.y - l.y : 0;
    const newParagraph = !prev || gap < 0 || gap > Math.max(l.size, prev.size) * 1.6 || blocks.length === 0 && !para;
    if (newParagraph) {
      flush();
      para = l.text;
    } else if (BULLET_START.test(l.text)) {
      para += `\n${l.text}`;
    } else if (/[A-Za-zА-Яа-яЁё]-$/.test(para) && /^[a-zа-яё]/.test(l.text)) {
      para = para.slice(0, -1) + l.text;
    } else {
      para += ` ${l.text}`;
    }
    prev = l;
  }
  flush();
  return blocks.join('\n\n');
}

/**
 * Running headers, footers and page numbers repeat on most pages and say
 * nothing. A first or last line that recurs, digits aside, on at least half
 * of three or more pages is dropped.
 */
export function dropRunningLines(pages: string[]): string[] {
  if (pages.length < 3) return pages;
  const key = (line: string) => line.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
  const counts = new Map<string, number>();
  for (const page of pages) {
    const lines = page.split('\n').filter((l) => l.trim());
    const edge = new Set([lines[0], lines[lines.length - 1]].filter(Boolean).map((l) => key(l!)));
    for (const k of edge) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const running = new Set([...counts].filter(([k, n]) => k && n >= Math.max(3, pages.length / 2)).map(([k]) => k));
  if (!running.size) return pages;
  return pages.map((page) => {
    const lines = page.split('\n');
    const first = lines.findIndex((l) => l.trim());
    if (first >= 0 && running.has(key(lines[first]))) lines.splice(first, 1);
    let last = lines.length - 1;
    while (last >= 0 && !lines[last].trim()) last--;
    if (last >= 0 && running.has(key(lines[last]))) lines.splice(last, 1);
    return lines.join('\n').trim();
  });
}

async function pdfToText(buf: Buffer): Promise<ParseResult> {
  try {
    // Imported lazily, and from the library file rather than the package
    // entry: pdf-parse's index.js runs a self-test on import that reads a
    // file which is not shipped, so the entry point throws before it parses
    // anything.
    const { default: pdf } = await import('pdf-parse/lib/pdf-parse.js');

    const out = await pdf(buf, {
      // One form feed per page, so a citation can say "p.18" and mean it.
      pagerender: async (page) => {
        const content = await page.getTextContent();
        return pdfItemsToText(content.items) + PAGE_BREAK;
      },
    });

    const pages = out.text.split(PAGE_BREAK);
    const tail = pages.length > 1 && !pages[pages.length - 1].trim() ? pages.pop() : undefined;
    const cleaned = dropRunningLines(pages).join(PAGE_BREAK) + (tail !== undefined ? PAGE_BREAK : '');

    const result = ok(cleaned);
    if (result.status === 'EMPTY') {
      return {
        text: '',
        status: 'EMPTY',
        note: 'No text layer. This looks like a scan, and OCR is not in this version.',
      };
    }
    return result;
  } catch (e) {
    return { text: '', status: 'FAILED', note: `Could not read the PDF: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------- entry

export async function parseFile(name: string, mime: string, buf: Buffer): Promise<ParseResult> {
  try {
    // Before the text check: browsers send .rtf as text/rtf, and an old .doc
    // is often RTF under the wrong name.
    if (/\.rtf$/i.test(name) || /\brtf\b/i.test(mime) || looksLikeRtf(buf)) return rtfToText(buf.toString('latin1'));
    if (/\.docx$/i.test(name) || mime.includes('wordprocessingml')) return docxToText(buf);
    if (/\.pdf$/i.test(name) || mime === 'application/pdf') return pdfToText(buf);
    if (TEXT_EXT.test(name) || mime.startsWith('text/') || mime === 'application/json') {
      return ok(buf.toString('utf8'));
    }
    if (/\.(doc|pages|key|numbers|xlsx?|pptx?)$/i.test(name)) {
      return {
        text: '',
        status: 'FAILED',
        note: 'This format is not readable in this version. Export it to PDF, DOCX or TXT first.',
      };
    }
    if (/\.(png|jpe?g|gif|heic|webp|mp4|mov|zip)$/i.test(name)) {
      return { text: '', status: 'FAILED', note: 'Images and media are not read in this version.' };
    }

    // Unknown extension. Try it as text rather than refusing outright: plenty
    // of useful files have no extension at all.
    const asText = buf.toString('utf8');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000e-\u001f]/.test(asText.slice(0, 2000))) {
      return { text: '', status: 'FAILED', note: 'This looks like a binary file, not a document.' };
    }
    return ok(asText);
  } catch (e) {
    return { text: '', status: 'FAILED', note: (e as Error).message };
  }
}

/** Cheap content hash, so the same file dropped twice is caught. */
export function hashOf(buf: Buffer): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < buf.length; i++) {
    h1 = ((h1 ^ buf[i]) * 0x01000193) >>> 0;
    if (i % 3 === 0) h2 = ((h2 + buf[i]) * 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}${buf.length.toString(36)}`;
}
