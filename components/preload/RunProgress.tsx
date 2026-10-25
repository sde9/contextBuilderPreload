'use client';

import { usePreload } from '@/lib/preloadStore';
import { RUN_STAGE_LABEL } from '@/lib/types';
import { visibleConcepts, visibleRelationships } from '@/lib/reducer';

/*
 * Screen 2. The build, shown honestly.
 *
 * A run takes minutes, and a spinner wastes them. Every line on this screen
 * is something that actually happened: a document that was read and what it
 * produced, a file that gave nothing, the merge count. Watching the map
 * assemble is the product, not the wait before it.
 */
export default function RunProgress() {
  const model = usePreload((s) => s.model);
  const notes = usePreload((s) => s.notes);
  const error = usePreload((s) => s.error);
  const busy = usePreload((s) => s.busy);
  const blocked = usePreload((s) => s.blocked);
  const resume = usePreload((s) => s.resume);
  const reset = usePreload((s) => s.reset);

  if (!model) return null;

  const stage = model.run?.stage ?? 'IDLE';
  const concepts = visibleConcepts(model);
  const contested = concepts.filter((c) => c.status === 'CONTESTED').length;
  const gaps = model.questions.filter((q) => q.status === 'OPEN').length;
  const readable = model.sources.filter((s) => s.parse === 'OK');
  const done = readable.filter((s) => s.conceptCount !== 0).length;

  return (
    <div className="building">
      <div className="build-counts">
        <Count label="concepts" value={concepts.length} />
        <Count label="links" value={visibleRelationships(model).length} />
        <Count label="contested" value={contested} tone={contested ? 'contested' : undefined} />
        <Count label="gaps" value={gaps} tone={gaps ? 'orange' : undefined} />
        <div className="build-stage">
          {stage === 'FAILED' ? 'stopped' : RUN_STAGE_LABEL[stage]}
          {stage === 'READING' && readable.length ? ` · ${done} of ${readable.length}` : ''}
        </div>
      </div>

      <div className="build-body">
        <section className="build-sources">
          <h2 className="rail-title">Sources</h2>
          <ul>
            {model.sources.map((s) => {
              const isCurrent = model.run?.currentSourceId === s.id;
              const state =
                s.parse !== 'OK'
                  ? s.parseNote
                  : s.conceptCount > 0
                    ? `${s.conceptCount} concepts${(s.unread ?? []).length ? `, ${(s.unread ?? []).length} not read` : ''}`
                    : s.conceptCount < 0
                      ? 'nothing found'
                      : isCurrent
                        ? 'reading…'
                        : 'queued';
              const cls =
                s.parse !== 'OK' ? 'src-failed' : s.conceptCount !== 0 ? 'src-done' : isCurrent ? 'src-active' : 'src-queued';
              return (
                <li key={s.id} className={`src-row ${cls}`}>
                  <span className="src-name">{s.name}</span>
                  <span className="src-state">{state}</span>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="build-log">
          <h2 className="rail-title">What happened</h2>
          {notes.length === 0 && !error && <p className="muted">Starting…</p>}
          <ol>
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ol>

          {busy && <p className="muted build-working">working…</p>}

          {error && (
            <div className="error build-error">
              <strong>{error}</strong>
              <p>Everything read before this point is kept. Resuming picks up from the stage that stopped.</p>
              <div className="side-actions">
                <button className="primary" onClick={() => void resume()} disabled={busy}>
                  Resume
                </button>
                <button onClick={reset} disabled={busy}>
                  Start over
                </button>
              </div>
            </div>
          )}

          {(blocked.invented > 0 || blocked.uncited > 0) && (
            <p className="build-guards">
              Guards fired: {blocked.invented} invented {blocked.invented === 1 ? 'reference' : 'references'} refused,{' '}
              {blocked.uncited} uncited {blocked.uncited === 1 ? 'concept' : 'concepts'} dropped.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: 'contested' | 'orange' }) {
  return (
    <div className={`bcount ${tone ? `bcount-${tone}` : ''}`}>
      <span className="bcount-label">{label}</span>
      <strong className="bcount-value">{value}</strong>
    </div>
  );
}
