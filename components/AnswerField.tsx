'use client';

import { useState, type ReactNode } from 'react';

export type AnswerOutcome = { ok: boolean; answered: boolean };

/*
 * One answer field for every question, wherever it is shown: a box on the
 * map, the open questions on the right, the Later list, the questions panel
 * in Preload. The answer is read and the map changes to match it. A failed
 * read keeps the text in the field, so nothing typed is lost; an answer that
 * does not settle the question says so and leaves the question where it is.
 *
 * Other buttons (Later, Back, Dismiss) are passed in as children and sit in
 * the same row as Answer.
 */
export default function AnswerField({
  onAnswer,
  busy,
  children,
  compact = false,
}: {
  onAnswer: (text: string) => Promise<AnswerOutcome>;
  busy: boolean;
  children?: ReactNode;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [stays, setStays] = useState(false);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy || sending) return;
    setSending(true);
    setStays(false);
    try {
      const r = await onAnswer(text);
      if (r.ok) {
        setDraft('');
        if (!r.answered) setStays(true);
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className={`answer-field nodrag nopan nowheel${compact ? ' answer-compact' : ''}`}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <textarea
        className="answer-input"
        rows={2}
        value={draft}
        disabled={busy || sending}
        placeholder="Type the answer…"
        aria-label="Answer to this question"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="answer-row">
        <button className="btn-yes" disabled={!draft.trim() || busy || sending} onClick={() => void send()} title="Answer (Cmd+Enter)">
          {sending ? 'Reading…' : 'Answer'}
        </button>
        {children}
      </div>
      {stays && <div className="answer-note">Noted. The answer did not settle it, so the question stays.</div>}
    </div>
  );
}
