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

function docxToText(buf: Buffer): ParseResult {
  const xmlBuf = readZipEntry(buf, 'word/document.xml');
  if (!xmlBuf) return { text: '', status: 'FAILED', note: 'Not a readable .docx (no word/document.xml).' };

  const xml = xmlBuf.toString('utf8');
  const text = xml
    // A tab and a line break are content, not markup.
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    // Paragraph and table row ends are the only structure worth keeping.
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');

  return ok(text);
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
        return content.items.map((i) => i.str).join(' ') + PAGE_BREAK;
      },
    });

    const result = ok(out.text);
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
