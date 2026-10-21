'use client';

import { useState } from 'react';
import { useSession } from '@/lib/store';

/*
 * The goal stays in view for the whole session and can be changed at any
 * time (RT-US-01). The next proposal call picks up the new wording.
 */
export default function GoalBadge() {
  const goal = useSession((s) => s.model.goal);
  const setGoal = useSession((s) => s.setGoal);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (!goal && !editing) return null;

  if (editing) {
    return (
      <form
        className="goal-badge goal-badge-edit"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) setGoal(draft);
          setEditing(false);
        }}
      >
        <span className="goal-badge-label">Goal</span>
        <input
          autoFocus
          value={draft}
          maxLength={300}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      </form>
    );
  }

  return (
    <button
      className="goal-badge"
      title={`${goal}\n\nClick to change the goal`}
      onClick={() => {
        setDraft(goal);
        setEditing(true);
      }}
    >
      <span className="goal-badge-label">Goal</span>
      <span className="goal-badge-text">{goal}</span>
    </button>
  );
}
