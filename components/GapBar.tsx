'use client';

import { useSession } from '@/lib/store';
import { openQuestions } from '@/lib/reducer';

export default function GapBar() {
  const model = useSession((s) => s.model);
  const dismiss = useSession((s) => s.dismiss);

  const open = openQuestions(model);
  if (open.length === 0) return null;

  return (
    <aside className="clarify-panel">
      <div className="clarify-header">
        {open.length} {open.length === 1 ? 'area' : 'areas'} to clarify
      </div>
      <ul className="clarify-list">
        {open.map((q) => (
          <li key={q.id} className="clarify-item">
            <div className="gap-question">{q.text}</div>
            <button
              className="gap-dismiss"
              onClick={() => dismiss(q.id)}
              title="Not useful, show me the next one"
            >
              skip
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
