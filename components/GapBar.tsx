'use client';

import { useState } from 'react';
import { useSession } from '@/lib/store';
import { activeQuestions, laterQuestions } from '@/lib/reducer';
import AnswerField from './AnswerField';

/*
 * The right panel. Two lists:
 *
 *   Open questions   what the AI asked in the list, each with an answer field,
 *                    Later and Dismiss.
 *   Later            everything the person put off: list questions and boxes
 *                    taken off the map. Each can be answered here or sent back.
 *
 * An answer here is read the same way as an answer in a box on the map, and
 * the map changes to match it.
 */
export default function GapBar() {
  const model = useSession((s) => s.model);
  const busy = useSession((s) => s.phase !== 'idle');
  const answer = useSession((s) => s.answerQuestion);
  const dismiss = useSession((s) => s.dismiss);
  const later = useSession((s) => s.later);
  const back = useSession((s) => s.back);
  const [laterOpen, setLaterOpen] = useState(true);

  const open = activeQuestions(model);
  const parked = laterQuestions(model);
  if (open.length === 0 && parked.length === 0) return null;

  const label = new Map(model.concepts.map((c) => [c.id, c.label]));

  return (
    <aside className="clarify-panel">
      {open.length > 0 && (
        <>
          <div className="clarify-header">
            {open.length} open {open.length === 1 ? 'question' : 'questions'}
          </div>
          <ul className="clarify-list">
            {open.map((q) => (
              <li key={q.id} className="clarify-item">
                <div className="gap-question">{q.text}</div>
                {/* RT-US-03. Why this question matters for the goal, in one line. */}
                {q.why && <div className="gap-why">{q.why}</div>}
                <AnswerField onAnswer={(text) => answer(q.id, text)} busy={busy} compact>
                  <button className="btn-later" onClick={() => later(q.id)} title="Not now. Keep it in the Later list">
                    Later
                  </button>
                  <button className="btn-no" onClick={() => dismiss(q.id)} title="Not useful. Don't ask it again">
                    Dismiss
                  </button>
                </AnswerField>
              </li>
            ))}
          </ul>
        </>
      )}

      {parked.length > 0 && (
        <div className="later">
          <button className="later-header" onClick={() => setLaterOpen(!laterOpen)} aria-expanded={laterOpen}>
            <span>Later ({parked.length})</span>
            <span aria-hidden="true">{laterOpen ? '▾' : '▸'}</span>
          </button>
          {laterOpen && (
            <ul className="clarify-list">
              {parked.map((q) => (
                <li key={q.id} className="clarify-item later-item">
                  <div className="gap-question">{q.text}</div>
                  {(q.anchorId && label.get(q.anchorId)) || q.why ? (
                    <div className="gap-why">
                      {q.anchorId && label.get(q.anchorId) ? <span className="later-about">about {label.get(q.anchorId)}. </span> : null}
                      {q.why}
                    </div>
                  ) : null}
                  <AnswerField onAnswer={(text) => answer(q.id, text)} busy={busy} compact>
                    <button onClick={() => back(q.id)} title={q.box ? 'Put the box back on the map' : 'Back to the open questions'}>
                      {q.box ? 'Back to map' : 'Back'}
                    </button>
                    <button className="btn-no" onClick={() => dismiss(q.id)} title="Not useful. Don't ask it again">
                      Dismiss
                    </button>
                  </AnswerField>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}
