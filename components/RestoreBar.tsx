'use client';

import { useEffect, useState } from 'react';
import { useSession } from '@/lib/store';
import { clearSession, loadSession, type SavedSession } from '@/lib/persist';

/*
 * Offered once, on load, when this browser holds a session with at least one
 * turn (RT-US-16). It goes away as soon as the user starts something new.
 */

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'earlier';
  return d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
}

export default function RestoreBar() {
  const restore = useSession((s) => s.restore);
  const fresh = useSession((s) => s.model.turn === 0 && s.model.goal === '');
  const [saved, setSaved] = useState<SavedSession | null>(null);

  useEffect(() => {
    const s = loadSession();
    if (s && s.model.turn > 0) setSaved(s);
  }, []);

  if (!saved || !fresh) return null;

  const label = saved.model.goal || saved.model.title;

  return (
    <div className="restore-bar" role="status">
      <span>
        A session from <strong>{when(saved.savedAt)}</strong> is saved in this browser
        {label ? <>: &ldquo;{label}&rdquo;</> : null}, {saved.model.turn} {saved.model.turn === 1 ? 'turn' : 'turns'}.
      </span>
      <button className="continue" onClick={() => restore(saved.model)}>
        Restore
      </button>
      <button
        onClick={() => {
          clearSession();
          setSaved(null);
        }}
      >
        Discard
      </button>
    </div>
  );
}
