'use client';

import { useState } from 'react';
import { useSession } from '@/lib/store';
import { openRecap } from '@/lib/reducer';
import type { RecapKind } from '@/lib/types';

/*
 * "Did I get this right?" (KVIF P7, grounding).
 *
 * Every few turns, or when asked, the map is read back in a few plain lines.
 * Right confirms the guesses a line rests on. Not quite asks what is right
 * and sends it as an ordinary turn, so it lands green from the person's own
 * words. The tag on each line comes from the map, not from the AI, so a
 * line resting on a guess always says so (KVIF P3).
 */
const KIND_TAG: Record<RecapKind, { text: string; cls: string }> = {
  CONFIRMED: { text: 'said', cls: 'tag-green' },
  GUESS: { text: 'guess', cls: 'tag-orange' },
  OPEN: { text: 'open', cls: 'tag-question' },
};

function Line({
  recapId,
  index,
  text,
  kind,
  verdict,
  correction,
}: {
  recapId: string;
  index: number;
  text: string;
  kind: RecapKind;
  verdict: '' | 'RIGHT' | 'WRONG';
  correction: string;
}) {
  const answer = useSession((s) => s.answerRecap);
  const busy = useSession((s) => s.phase !== 'idle');
  const [fixing, setFixing] = useState(false);
  const [draft, setDraft] = useState('');
  const tag = KIND_TAG[kind];

  const send = () => {
    const t = draft.trim();
    if (!t || busy) return;
    setFixing(false);
    void answer(recapId, index, 'WRONG', t);
  };

  return (
    <li className={`recap-line${verdict ? ' recap-done' : ''}`}>
      <div className="recap-text">
        <span className={`recap-tag ${tag.cls}`}>{tag.text}</span> {text}
      </div>
      {verdict === 'RIGHT' && <div className="recap-verdict">✓ Right</div>}
      {verdict === 'WRONG' && <div className="recap-verdict">Corrected: “{correction}”</div>}
      {!verdict && !fixing && (
        <div className="recap-buttons">
          <button className="btn-yes" disabled={busy} onClick={() => void answer(recapId, index, 'RIGHT')}>
            Right
          </button>
          <button disabled={busy} onClick={() => setFixing(true)}>
            Not quite
          </button>
        </div>
      )}
      {!verdict && fixing && (
        <div className="recap-fix">
          <input
            autoFocus
            value={draft}
            placeholder="What is right?"
            aria-label="What is right"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send();
              if (e.key === 'Escape') setFixing(false);
            }}
          />
          <button className="btn-yes" disabled={!draft.trim() || busy} onClick={send}>
            Send
          </button>
        </div>
      )}
    </li>
  );
}

export default function RecapCard() {
  const recap = useSession((s) => openRecap(s.model));
  const loading = useSession((s) => s.recapPhase === 'loading');
  const dismiss = useSession((s) => s.dismissRecap);

  if (!recap && !loading) return null;

  return (
    <div className="recap-card" role="region" aria-label="Did I get this right?">
      <div className="recap-head">
        <strong>Did I get this right?</strong>
        {recap && (
          <button className="source-close" onClick={() => dismiss(recap.id)} aria-label="Close" title="Close">
            ×
          </button>
        )}
      </div>
      {!recap && <p className="recap-wait">Reading the map back…</p>}
      {recap && (
        <ul className="recap-lines">
          {recap.lines.map((l, i) => (
            <Line key={i} recapId={recap.id} index={i} {...l} />
          ))}
        </ul>
      )}
    </div>
  );
}
