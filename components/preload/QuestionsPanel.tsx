'use client';

import { useState } from 'react';
import { questionsMarkdown, usePreload } from '@/lib/preloadStore';
import { norm } from '@/lib/guards';
import { onMap as isOnMap } from '@/lib/types';
import AnswerField from '../AnswerField';

/*
 * The questions to take into the interview.
 *
 * The map raises questions two ways: as items in the gap list, and as
 * QUESTION boxes on the canvas. Both land here. A person keeps the ones worth
 * asking, drops the rest, and adds their own; the kept list survives the tab
 * (it is saved in the run) and leaves as Markdown or on the clipboard.
 */
export default function QuestionsPanel() {
  const model = usePreload((s) => s.model);
  const open = usePreload((s) => s.questionsOpen);
  const toggle = usePreload((s) => s.toggleQuestions);
  const select = usePreload((s) => s.select);
  const save = usePreload((s) => s.saveQuestion);
  const unsave = usePreload((s) => s.unsaveQuestion);
  const dismiss = usePreload((s) => s.dismissQuestion);
  const add = usePreload((s) => s.addQuestion);
  const fromConcept = usePreload((s) => s.saveConceptQuestion);
  const rejectConcept = usePreload((s) => s.reject);
  const download = usePreload((s) => s.downloadQuestions);
  const answer = usePreload((s) => s.answer);
  const busy = usePreload((s) => Boolean(s.answering));
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);

  if (!model || !open) return null;

  const label = new Map(model.concepts.map((c) => [c.id, c.label]));
  const saved = model.questions.filter((q) => q.savedAt && q.status === 'OPEN');
  const savedTexts = new Set(saved.map((q) => norm(q.text)));
  const openQs = model.questions.filter((q) => q.status === 'OPEN' && !q.savedAt);
  const onMap = model.concepts.filter(
    (c) => c.kind === 'QUESTION' && isOnMap(c) && !savedTexts.has(norm(c.label))
  );
  const answered = [
    ...model.concepts.filter((c) => c.kind === 'QUESTION' && c.answeredAt && c.status !== 'REJECTED').map((c) => ({ id: c.id, text: c.label, answer: c.answer })),
    ...model.questions.filter((q) => q.answeredAt).map((q) => ({ id: q.id, text: q.text, answer: q.answer })),
  ].filter((a, i, all) => all.findIndex((b) => norm(b.text) === norm(a.text)) === i);
  const anchorOf = (conceptId: string) => {
    const r = model.relationships.find((x) => x.status !== 'REJECTED' && (x.from === conceptId || x.to === conceptId));
    return r ? (r.from === conceptId ? r.to : r.from) : '';
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(questionsMarkdown(model));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      download();
    }
  };

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    void add(text);
    setDraft('');
  };

  return (
    <aside className="evidence questions">
      <div className="ev-head">
        <span className="ev-tag">questions to ask</span>
        <button className="ev-close" onClick={() => toggle(false)} aria-label="Close">
          ✕
        </button>
      </div>

      <h2 className="q-title">Saved for the interview ({saved.length})</h2>
      {saved.length === 0 && <p className="ev-fine">Nothing kept yet. Save a question below, or write your own.</p>}
      <ol className="q-list q-saved">
        {saved.map((q) => (
          <li key={q.id}>
            <div className="q-text">{q.text}</div>
            {(q.anchorId && label.get(q.anchorId)) || q.why ? (
              <div className="q-meta">
                {q.anchorId && label.get(q.anchorId) && (
                  <button className="q-anchor" onClick={() => select(q.anchorId!)}>
                    {label.get(q.anchorId)}
                  </button>
                )}
                {q.why && <span>{q.why}</span>}
              </div>
            ) : null}
            <AnswerField onAnswer={(text) => answer(q.id, text)} busy={busy} compact>
              <button onClick={() => void unsave(q.id)}>Remove</button>
            </AnswerField>
          </li>
        ))}
      </ol>
      {saved.length > 0 && (
        <div className="ev-actions">
          <button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy list'}</button>
          <button onClick={download}>Download .md</button>
        </div>
      )}

      <form
        className="q-add"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Who approves a refund over $500?"
          aria-label="Your own question"
        />
        <button type="submit" disabled={!draft.trim()}>
          Add
        </button>
      </form>

      <h2 className="q-title q-title-gap">Raised by the map ({openQs.length + onMap.length})</h2>
      {openQs.length + onMap.length === 0 && <p className="ev-fine">No open questions left.</p>}
      <ul className="q-list">
        {openQs.map((q) => (
          <li key={q.id}>
            <div className="q-text">{q.text}</div>
            {q.why && <div className="q-meta">{q.why}</div>}
            <AnswerField onAnswer={(text) => answer(q.id, text)} busy={busy} compact>
              <button className="btn-later" onClick={() => void save(q.id)} title="Keep it in the questions to ask">
                Save
              </button>
              <button className="btn-no" onClick={() => void dismiss(q.id)}>
                Dismiss
              </button>
            </AnswerField>
          </li>
        ))}
        {onMap.map((c) => {
          const anchor = anchorOf(c.id);
          return (
            <li key={c.id}>
              <div className="q-text">{c.label}</div>
              <div className="q-meta">
                <button className="q-anchor" onClick={() => select(c.id)}>
                  on the map{anchor && label.get(anchor) ? `, at ${label.get(anchor)}` : ''}
                </button>
                {c.note && <span>{c.note}</span>}
              </div>
              <AnswerField onAnswer={(text) => answer(c.id, text)} busy={busy} compact>
                <button className="btn-later" onClick={() => void fromConcept(c.id)} title="Keep it in the questions to ask">
                  Save
                </button>
                <button className="btn-no" onClick={() => void rejectConcept(c.id)}>
                  Dismiss
                </button>
              </AnswerField>
            </li>
          );
        })}
      </ul>

      {answered.length > 0 && (
        <>
          <h2 className="q-title q-title-gap">Answered on the map ({answered.length})</h2>
          <ul className="q-list">
            {answered.map((a) => (
              <li key={a.id}>
                <div className="q-text">{a.text}</div>
                <div className="q-meta">{a.answer}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}
