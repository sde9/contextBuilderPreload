'use client';

import { useEffect } from 'react';
import { useSession } from '@/lib/store';

/*
 * History (KVIF P11, history that is useful, not just available).
 *
 * A slider over the turns. The map shows what existed after that turn, in
 * the colours it had then; what came later is a pale outline in its place,
 * so the whole shape stays in view. Under the slider: what was said at that
 * turn. Left and right arrow keys step through it. A new turn ends it.
 */
export default function HistoryBar() {
  const turn = useSession((s) => s.replayTurn);
  const setReplay = useSession((s) => s.setReplay);
  const model = useSession((s) => s.model);
  const last = model.turn;

  useEffect(() => {
    if (turn === null) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      if (e.key === 'ArrowLeft') setReplay(Math.max(1, turn - 1));
      if (e.key === 'ArrowRight') setReplay(Math.min(last, turn + 1));
      if (e.key === 'Escape') setReplay(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [turn, last, setReplay]);

  if (turn === null || last < 2) return null;

  const said = model.statements.filter((s) => s.turn === turn);

  return (
    <div className="history-bar" role="region" aria-label="History">
      <div className="history-row">
        <strong>History</strong>
        <input
          type="range"
          min={1}
          max={last}
          step={1}
          value={turn}
          aria-label="Turn"
          onChange={(e) => setReplay(Number(e.target.value))}
        />
        <span className="history-count">
          After turn {turn} of {last}
        </span>
        <button onClick={() => setReplay(null)}>Back to now</button>
      </div>
      <div className="history-said">
        {said.length ? said.map((s) => <p key={s.id}>“{s.text}”</p>) : <p className="source-muted">Nothing was said at this turn.</p>}
      </div>
    </div>
  );
}
