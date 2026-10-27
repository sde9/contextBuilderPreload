'use client';

import { useEffect, useState } from 'react';
import { useSession } from '@/lib/store';

type Step = 'review' | 'topics' | 'export';

const STEPS: { id: Step; label: string }[] = [
  { id: 'review', label: 'Review' },
  { id: 'topics', label: 'Topics' },
  { id: 'export', label: 'Export' },
];

/*
 * Finish (RT-US-12, 13, 14). Three steps in a modal:
 *
 *   Review   every open question, unticked. Ticked ones are kept for the
 *            next conversation; the rest are dropped and never asked again.
 *   Topics   up to five topics for next time, suggested from the goal and
 *            the confirmed map. The person can remove any.
 *   Export   the report, the session file, a picture of the map.
 *
 * "Back to session" closes it at any step. Nothing changes until Continue
 * on the review step, so closing before then loses nothing.
 */
export default function FinishPanel() {
  const open = useSession((s) => s.finishOpen);
  const close = useSession((s) => s.closeFinish);
  const model = useSession((s) => s.model);
  const finishReview = useSession((s) => s.finishReview);
  const topicsPhase = useSession((s) => s.topicsPhase);
  const removeTopic = useSession((s) => s.removeTopic);
  const downloadReport = useSession((s) => s.downloadReport);
  const download = useSession((s) => s.download);
  const exportPicture = useSession((s) => s.exportPicture);

  const [step, setStep] = useState<Step>('review');
  const [kept, setKept] = useState<Set<string>>(new Set());

  const pending = model.questions.filter((q) => q.status === 'OPEN' && !q.answeredAt);
  const label = new Map(model.concepts.map((c) => [c.id, c.label]));

  // Each time the panel opens: back to the first step, questions kept last time already ticked.
  useEffect(() => {
    if (!open) return;
    setStep('review');
    setKept(new Set(useSession.getState().model.questions.filter((q) => q.kept && q.status === 'OPEN').map((q) => q.id)));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open) return null;

  const toggle = (id: string) =>
    setKept((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allTicked = pending.length > 0 && pending.every((q) => kept.has(q.id));
  const topics = model.wrapup?.topics ?? [];

  return (
    <div className="modal-backdrop" role="presentation" onClick={close}>
      <div className="modal finish" role="dialog" aria-modal="true" aria-labelledby="finish-title" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2 id="finish-title">Finish the session</h2>
          <ol className="steps" aria-label="Steps">
            {STEPS.map((s, i) => (
              <li key={s.id} className={s.id === step ? 'step-on' : ''} aria-current={s.id === step ? 'step' : undefined}>
                <span>{i + 1}</span> {s.label}
              </li>
            ))}
          </ol>
        </header>

        <div className="modal-body">
          {step === 'review' && (
            <>
              <p className="modal-lead">
                Tick the questions to keep for the next conversation. The others are dropped and will not be asked again.
              </p>
              {pending.length === 0 ? (
                <p className="modal-empty">No open questions. Everything asked was answered or closed.</p>
              ) : (
                <>
                  <label className="tick tick-all">
                    <input
                      type="checkbox"
                      checked={allTicked}
                      onChange={() => setKept(allTicked ? new Set() : new Set(pending.map((q) => q.id)))}
                    />
                    Select all ({pending.length})
                  </label>
                  <ul className="review-list">
                    {pending.map((q) => (
                      <li key={q.id}>
                        <label className="tick">
                          <input type="checkbox" checked={kept.has(q.id)} onChange={() => toggle(q.id)} />
                          <span>
                            <span className="review-q">{q.text}</span>
                            {q.anchorId && label.get(q.anchorId) && <span className="review-about">About {label.get(q.anchorId)}</span>}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}

          {step === 'topics' && (
            <>
              <p className="modal-lead">Topics for the next conversation, chosen to move the goal forward. Remove any you do not want.</p>
              {topicsPhase === 'loading' && <p className="modal-empty">Looking for topics…</p>}
              {topicsPhase !== 'loading' && topics.length === 0 && <p className="modal-empty">No topics this time.</p>}
              {topicsPhase !== 'loading' && topics.length > 0 && (
                <ol className="topic-list">
                  {topics.map((t, i) => (
                    <li key={`${t.title}-${i}`}>
                      <div>
                        <strong>{t.title}</strong>
                        {t.why && <div className="topic-why">{t.why}</div>}
                      </div>
                      <button className="btn-no" onClick={() => removeTopic(i)} title="Remove this topic">
                        Remove
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}

          {step === 'export' && (
            <>
              <p className="modal-lead">
                The report has the goal, what was covered, the questions you kept, the topics and a picture of the map. It prints to A4.
              </p>
              <div className="export-row">
                <button className="btn-primary" onClick={() => void downloadReport()}>
                  Download report
                </button>
                <button onClick={download}>Download session</button>
                <button onClick={() => void exportPicture()}>Picture</button>
              </div>
            </>
          )}
        </div>

        <footer className="modal-foot">
          <button onClick={close}>Back to session</button>
          {step === 'review' && (
            <button
              className="btn-primary"
              onClick={() => {
                setStep('topics');
                void finishReview([...kept]);
              }}
            >
              Continue
            </button>
          )}
          {step === 'topics' && (
            <button className="btn-primary" disabled={topicsPhase === 'loading'} onClick={() => setStep('export')}>
              Continue
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
