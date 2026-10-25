'use client';

import { usePreload } from '@/lib/preloadStore';
import { ROLE_LABEL } from '@/lib/types';
import { coverage } from '@/lib/cluster';
import { sourcesOf } from '@/lib/merge';

/*
 * The left rail. One row per document.
 *
 * Click a document and its concepts stay lit while everything else dims.
 * Select two and the map shows what they share. A file that contributed
 * nothing keeps its row, because that is worth knowing (R11).
 */
export default function SourceRail() {
  const model = usePreload((s) => s.model);
  const selected = usePreload((s) => s.selectedSources);
  const toggle = usePreload((s) => s.toggleSource);

  if (!model) return null;
  const rows = coverage(model, sourcesOf);

  return (
    <aside className="source-rail">
      <h2 className="rail-title">Sources</h2>
      <ul>
        {rows.map((row) => {
          const source = model.sources.find((s) => s.id === row.sourceId)!;
          const on = selected.includes(row.sourceId);
          const dead = source.parse !== 'OK' || row.concepts === 0;
          return (
            <li key={row.sourceId}>
              <button
                className={`src-pick ${on ? 'src-on' : ''} ${dead ? 'src-dead' : ''}`}
                onClick={() => toggle(row.sourceId)}
                title={source.parse === 'OK' ? `${row.unique} concepts only this file supports` : source.parseNote}
              >
                <span className="src-name">{source.name}</span>
                <span className="src-role">{ROLE_LABEL[source.role]}</span>
                <span className="src-count">{source.parse === 'OK' ? row.concepts : '—'}</span>
                {(source.unread ?? []).length > 0 && (
                  <span
                    className="src-warn"
                    title={(source.unread ?? []).map((u) => `${u.locator}: ${u.why}`).join('\n')}
                  >
                    {(source.unread ?? []).length} {(source.unread ?? []).length === 1 ? 'section' : 'sections'} not read:{' '}
                    {(source.unread ?? []).map((u) => u.locator).join('; ')}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {selected.length > 0 && (
        <p className="rail-note">
          {selected.length === 1
            ? 'Showing what this document contributed.'
            : 'Showing what these documents share and where they clash.'}
        </p>
      )}

      <h2 className="rail-title rail-title-gap">Where the map is thin</h2>
      <ul className="thin-list">
        {rows
          .filter((r) => r.concepts > 0)
          .sort((a, b) => b.unique - a.unique)
          .slice(0, 4)
          .map((r) => (
            <li key={r.sourceId}>
              <span>{r.name}</span>
              <span className="thin-value">{r.unique} alone</span>
            </li>
          ))}
      </ul>
      <p className="rail-note">
        &ldquo;Alone&rdquo; means no other document backs those concepts up. Not wrong, but worth checking before
        anyone quotes it as settled.
      </p>
    </aside>
  );
}
