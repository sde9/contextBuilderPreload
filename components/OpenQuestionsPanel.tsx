'use client';

import { useSession } from '@/lib/store';
import { laterQuestions } from '@/lib/reducer';
import AnswerField from './AnswerField';

/*
 * The right panel (RT-US-09). Every open question that is not a card on the
 * map: the ones the person put off with Later, and the ones that arrived
 * while the map already showed five cards. Newest first.
 *
 * Each can be answered here (read the same way as an answer on a card, and
 * the map changes to match), sent back to the map, or dismissed for good.
 * The subject is a link: a click brings that concept into view.
 */
export default function OpenQuestionsPanel() {
  const model = useSession((s) => s.model);
  const busy = useSession((s) => s.phase !== 'idle');
  const answer = useSession((s) => s.answerQuestion);
  const dismiss = useSession((s) => s.dismiss);
  const back = useSession((s) => s.back);
  const focusConcept = useSession((s) => s.focusConcept);

  const waiting = laterQuestions(model);
  if (waiting.length === 0) return null;

  const onMap = new Map(model.concepts.filter((c) => c.status !== 'REJECTED' && !c.absorbedInto).map((c) => [c.id, c.label]));

  return (
    <aside className="clarify-panel" aria-label="Open questions">
      <div className="clarify-header later-title">Open questions ({waiting.length})</div>
      <p className="panel-hint">Waiting for an answer. The map shows up to five at a time.</p>
      <ul className="clarify-list">
        {waiting.map((q) => {
          const about = q.anchorId ? onMap.get(q.anchorId) : undefined;
          return (
            <li key={q.id} className="clarify-item later-item">
              <div className="gap-question">{q.text}</div>
              {(about || q.why) && (
                <div className="gap-why">
                  {about && (
                    <>
                      <button className="link-about" onClick={() => focusConcept(q.anchorId)} title="Show it on the map">
                        {about}
                      </button>
                      {q.why ? '. ' : ''}
                    </>
                  )}
                  {q.why}
                </div>
              )}
              <AnswerField onAnswer={(text) => answer(q.id, text)} busy={busy} compact>
                <button onClick={() => back(q.id)} title="Show it as a card on the map again">
                  Back to map
                </button>
                <button className="btn-no" onClick={() => dismiss(q.id)} title="Not useful. Don't ask it again">
                  Dismiss
                </button>
              </AnswerField>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
