'use client';

import { useEffect, useRef, useState } from 'react';
import { useSession } from '@/lib/store';

/*
 * Feed complete thoughts, not sentences. Cmd/Ctrl + Enter sends, so the
 * operator never has to move a hand to the mouse mid-conversation.
 */
export default function Composer() {
  const [text, setText] = useState('');
  const phase = useSession((s) => s.phase);
  const pending = useSession((s) => s.pending);
  const error = useSession((s) => s.error);
  const submit = useSession((s) => s.submit);
  // RT-US-01. Nothing goes in until the session has a goal.
  const noGoal = useSession((s) => !s.model.goal);
  const ref = useRef<HTMLTextAreaElement>(null);

  // A failed turn puts the words back rather than losing them.
  useEffect(() => {
    if (error && pending === '') ref.current?.focus();
  }, [error, pending]);

  const send = async () => {
    if (!text.trim() || phase !== 'idle' || noGoal) return;
    const sent = text;
    setText('');
    await submit(sent);
    if (useSession.getState().error) setText(sent);
    ref.current?.focus();
  };

  const busy = phase !== 'idle';

  return (
    <div className="composer">
      {busy && (
        <div className="pending">
          <span className="dot" />
          <span className="pending-text">{pending}</span>
          <span className="pending-phase">{phase === 'reading' ? 'reading…' : 'looking for gaps…'}</span>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <div className="composer-row">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={noGoal ? 'Set a goal first' : 'Paste what was just said, then Continue…'}
          rows={2}
          disabled={busy || noGoal}
        />
        <button className="continue" onClick={() => void send()} disabled={busy || noGoal || !text.trim()}>
          {busy ? '…' : 'Continue'}
          <kbd>⌘⏎</kbd>
        </button>
      </div>
    </div>
  );
}
