'use client';

import { usePreload } from '@/lib/preloadStore';
import { ROLE_LABEL } from '@/lib/types';

/*
 * The right panel. What a node is, and where it came from.
 *
 * R2: a green node has to be able to name its sentence, and this is where a
 * person checks that. A contested node shows both quotes with their file and
 * location, and three buttons. None of them delete anything (R8).
 */
export default function EvidencePanel() {
  const model = usePreload((s) => s.model);
  const selectedId = usePreload((s) => s.selectedConcept);
  const select = usePreload((s) => s.select);
  const confirm = usePreload((s) => s.confirm);
  const reject = usePreload((s) => s.reject);
  const split = usePreload((s) => s.split);
  const resolve = usePreload((s) => s.resolve);

  if (!model || !selectedId) return null;
  const concept = model.concepts.find((c) => c.id === selectedId);
  if (!concept) return null;

  const excerpts = concept.evidence
    .map((id) => model.excerpts.find((e) => e.id === id))
    .filter((e): e is NonNullable<typeof e> => Boolean(e));
  const statements = concept.evidence
    .map((id) => model.statements.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));

  const nameOf = (sourceId: string) => model.sources.find((s) => s.id === sourceId)?.name ?? 'unknown file';
  const roleOf = (sourceId: string) => {
    const role = model.sources.find((s) => s.id === sourceId)?.role;
    return role ? ROLE_LABEL[role] : '';
  };

  const contested = concept.status === 'CONTESTED' && concept.contest;
  const absorbed = concept.mergedFrom[concept.mergedFrom.length - 1];

  return (
    <aside className="evidence">
      <div className="ev-head">
        <span className={`ev-tag ev-${concept.status.toLowerCase()}`}>
          {concept.status === 'CONTESTED'
            ? `contested · ${concept.contest?.readings.length ?? 2} sources`
            : concept.status === 'PROPOSED'
              ? 'guessed by the AI'
              : `written down · ${excerpts.length || statements.length} ${excerpts.length === 1 ? 'citation' : 'citations'}`}
        </span>
        <button className="ev-close" onClick={() => select(selectedId)} aria-label="Close">
          ✕
        </button>
      </div>

      <h2 className="ev-label">{concept.label}</h2>
      {concept.note && <p className="ev-note">{concept.note}</p>}

      {contested && (
        <>
          <p className="ev-why">{concept.contest!.why}</p>
          {concept.contest!.readings.map((r, i) => {
            const quote = model.excerpts.find((e) => e.id === r.evidenceId);
            return (
              <div key={i} className="quote quote-contested">
                <div className="quote-meta">
                  {nameOf(r.sourceId)} · {quote?.locator ?? '—'} · {roleOf(r.sourceId)}
                </div>
                <blockquote>{quote?.quote ?? r.summary}</blockquote>
                <div className="quote-label">reads as: {r.label}</div>
              </div>
            );
          })}
          <div className="ev-actions">
            <button onClick={() => void resolve(concept.id, 'KEPT_FIRST')}>Keep the first</button>
            <button onClick={() => void resolve(concept.id, 'KEPT_SECOND')}>Keep the second</button>
            <button onClick={() => void resolve(concept.id, 'SPLIT')}>Keep both, split</button>
          </div>
          <p className="ev-fine">Whatever you choose is recorded. The other reading stays in the file.</p>
        </>
      )}

      {!contested && (excerpts.length > 0 || statements.length > 0) && (
        <>
          {excerpts.map((e) => (
            <div key={e.id} className="quote">
              <div className="quote-meta">
                {nameOf(e.sourceId)} · {e.locator} · {roleOf(e.sourceId)}
              </div>
              <blockquote>{e.quote.length > 420 ? `${e.quote.slice(0, 420)}…` : e.quote}</blockquote>
            </div>
          ))}
          {statements.map((s) => (
            <div key={s.id} className="quote">
              <div className="quote-meta">said in the session</div>
              <blockquote>{s.text}</blockquote>
            </div>
          ))}
        </>
      )}

      {!contested && concept.status === 'PROPOSED' && (
        <>
          <p className="ev-fine">No document says this. The AI thinks it is missing.</p>
          <div className="ev-actions">
            <button className="btn-yes" onClick={() => void confirm(concept.id)}>
              Confirm
            </button>
            <button className="btn-no" onClick={() => void reject(concept.id)}>
              Reject
            </button>
          </div>
        </>
      )}

      {absorbed && concept.status !== 'CONTESTED' && (
        <div className="ev-merged">
          <p>
            Merged from {concept.mergedFrom.length + 1} concepts found in different documents.
          </p>
          <button onClick={() => void split(concept.id, absorbed)}>Split the last merge</button>
        </div>
      )}
    </aside>
  );
}
