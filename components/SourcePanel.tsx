'use client';

import { useSession } from '@/lib/store';
import { conceptLineage, foldedDetails, LINEAGE_STATUS_TEXT } from '@/lib/understanding';

/*
 * "Where did this come from?" (KVIF P2, P3, P9).
 *
 * A click on a box opens this panel on the right. It keeps three things
 * apart that the map draws as one box: the person's own words, the AI's
 * reading of them, and what happened since (confirmed, changed by an answer,
 * checked in a read-back). A green box is the AI's short label for what was
 * said, so the words themselves are always one click away.
 */
const STATUS_DOT: Record<string, string> = {
  SAID: 'dot-green',
  GUESS: 'dot-orange',
  GUESS_CONFIRMED: 'dot-green',
  CONTESTED: 'dot-red',
};

const STATE_TEXT: Record<string, string> = {
  OPEN: 'on the map',
  PARKED: 'waiting in the panel',
  ANSWERED: 'answered',
  DISMISSED: 'dismissed',
  DROPPED: 'dropped at Finish',
  DONE: 'closed',
};

export default function SourcePanel() {
  const model = useSession((s) => s.model);
  const id = useSession((s) => s.selectedConceptId);
  const select = useSession((s) => s.select);
  const focusConcept = useSession((s) => s.focusConcept);
  const confirm = useSession((s) => s.confirm);
  const reject = useSession((s) => s.reject);
  const busy = useSession((s) => s.phase !== 'idle');
  const foldOn = useSession((s) => s.foldDetails);

  const lineage = id ? conceptLineage(model, id) : null;
  if (!lineage) return null;
  const c = lineage.concept;
  const gone = c.status === 'REJECTED' || Boolean(c.absorbedInto);
  // A folded detail has no box of its own: "Show on map" goes to its owner.
  const folded = foldOn && foldedDetails(model).folded.has(c.id);
  const showId = folded && c.belongsTo ? c.belongsTo : c.id;

  const Link = ({ to, children }: { to: string; children: React.ReactNode }) => (
    <button className="link-about" onClick={() => select(to)}>
      {children}
    </button>
  );

  return (
    <aside className="clarify-panel source-panel" aria-label="Where this came from">
      <div className="source-head">
        <div>
          <div className="source-kind">{c.kind.toLowerCase() === 'attribute' ? 'detail' : c.kind.toLowerCase()}</div>
          <h2 className="source-title">{c.label}</h2>
        </div>
        <button className="source-close" onClick={() => select('')} aria-label="Close" title="Close">
          ×
        </button>
      </div>

      <div className="source-status">
        <span className={`dot ${STATUS_DOT[lineage.status]}`} aria-hidden="true" />
        {gone ? 'Rejected. Not on the map' : LINEAGE_STATUS_TEXT[lineage.status]}
      </div>
      {/* A guess's note is the reason it was guessed, shown below as such. */}
      {c.note && c.origin !== 'INFERRED' && <p className="source-note">{c.note}</p>}

      {lineage.status === 'GUESS' && !gone && (
        <div className="source-actions">
          <button className="btn-yes" disabled={busy} onClick={() => confirm(c.id)}>
            Confirm
          </button>
          <button className="btn-no" disabled={busy} onClick={() => reject(c.id)}>
            Reject
          </button>
        </div>
      )}

      <section className="source-section">
        <h3>Where it came from</h3>
        {lineage.sources.length > 0 ? (
          <ul className="source-quotes">
            {lineage.sources.map((q) => (
              <li key={q.statementId}>
                <div className="quote-meta">
                  Turn {q.turn}
                  {q.answerTo && <> · answer to “{q.answerTo}”</>}
                </div>
                <blockquote>{q.text}</blockquote>
              </li>
            ))}
          </ul>
        ) : (
          <p className="source-empty">
            Nobody has said this yet. The AI guessed it
            {lineage.guessedFrom && (
              <>
                {' '}
                from <Link to={lineage.guessedFrom.id}>{lineage.guessedFrom.label}</Link>
              </>
            )}
            .
          </p>
        )}
        {lineage.why && (
          <p className="source-why">
            <strong>Why the AI guessed it:</strong> {lineage.why}
          </p>
        )}
      </section>

      {lineage.events.length > 1 && (
        <section className="source-section">
          <h3>What happened to it</h3>
          <ol className="source-events">
            {lineage.events.map((e, i) => (
              <li key={i}>
                <span className="quote-meta">Turn {e.turn}</span> {e.text}
              </li>
            ))}
          </ol>
        </section>
      )}

      {(lineage.owner || lineage.details.length > 0) && (
        <section className="source-section">
          <h3>Part of the picture</h3>
          {lineage.owner && (
            <p className="source-line">
              A detail of <Link to={lineage.owner.id}>{lineage.owner.label}</Link>
            </p>
          )}
          {lineage.details.length > 0 && (
            <ul className="source-list">
              {lineage.details.map((d) => (
                <li key={d.id}>
                  <Link to={d.id}>{d.label}</Link>
                  {d.note && <span className="source-muted"> {d.note}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {lineage.links.length > 0 && (
        <section className="source-section">
          <h3>Links</h3>
          <ul className="source-list">
            {lineage.links.map((l, i) => (
              <li key={i} className={l.proposed ? 'source-guessed' : ''}>
                {l.direction === 'out' ? (
                  <>
                    {l.label} → <Link to={l.otherId}>{l.otherLabel}</Link>
                  </>
                ) : (
                  <>
                    <Link to={l.otherId}>{l.otherLabel}</Link> → {l.label}
                  </>
                )}
                {l.proposed && <span className="source-muted"> (guess)</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {lineage.questions.length > 0 && (
        <section className="source-section">
          <h3>Questions about it</h3>
          <ul className="source-list">
            {lineage.questions.map((q) => (
              <li key={q.id}>
                {q.text} <span className="source-muted">({STATE_TEXT[q.state] ?? q.state.toLowerCase()})</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!gone && (
        <button className="source-show" onClick={() => focusConcept(showId)}>
          Show on map
        </button>
      )}
    </aside>
  );
}
