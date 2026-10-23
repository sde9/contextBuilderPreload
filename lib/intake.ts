import { chunkText, guessRole } from './chunk';
import { hashOf, parseFile } from './parse';
import { MAX_UPLOAD_BYTES, UPLOAD_LIMIT, megabytes } from './limits';
import { newId, type Chunk, type Source } from './types';

/*
 * Stage 0 for one file. No model call anywhere here.
 *
 * The user sees the result before anything is spent: how many sections the
 * file produced, what the system thinks it is, or why it gave nothing (R11).
 */

export type Incoming = { name: string; type: string; buf: Buffer };

export async function readIncoming(file: Incoming, existing: Source[]): Promise<{ source: Source; chunks: Chunk[] }> {
  const sourceId = newId('src');
  const base = {
    id: sourceId,
    name: file.name,
    mime: file.type || 'application/octet-stream',
    bytes: file.buf.length,
    addedAt: new Date().toISOString(),
    chunkCount: 0,
    conceptCount: 0,
  };
  const failed = (hash: string, parse: Source['parse'], note: string) => ({
    source: { ...base, hash, role: 'UNKNOWN' as const, parse, parseNote: note },
    chunks: [] as Chunk[],
  });

  if (file.buf.length > MAX_UPLOAD_BYTES) {
    return failed('', 'FAILED', `${megabytes(file.buf.length)}, over the ${UPLOAD_LIMIT} limit. Split it or export a smaller version.`);
  }

  const hash = hashOf(file.buf);
  if (existing.some((s) => s.hash === hash)) return failed(hash, 'FAILED', 'The same file was added twice.');

  const parsed = await parseFile(file.name, file.type, file.buf);
  if (parsed.status !== 'OK') return failed(hash, parsed.status, parsed.note);

  const role = guessRole(file.name, parsed.text);
  const chunks = chunkText(sourceId, parsed.text, { name: file.name, role });

  return {
    source: {
      ...base,
      hash,
      role,
      parse: chunks.length ? 'OK' : 'EMPTY',
      parseNote: chunks.length ? '' : 'Nothing left after cleaning up the text.',
      chunkCount: chunks.length,
    },
    chunks,
  };
}
