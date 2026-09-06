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
