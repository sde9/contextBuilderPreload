'use client';

import { useState } from 'react';
import { useSession } from '@/lib/store';

/*
 * The goal comes first (RT-US-01). Without it the AI only follows the words
 * and has no way to tell a useful question from a curious one.
 */

const EXAMPLES = ['Understand how Stef onboards a new client', 'Plan the 12 December concert and fair'];

export default function GoalStart() {
  const setGoal = useSession((s) => s.setGoal);
  const [text, setText] = useState('');

  const start = () => {
    if (text.trim()) setGoal(text);
  };

  return (
    <form
      className="goal-start"
      onSubmit={(e) => {
        e.preventDefault();
        start();
      }}
    >
      <label htmlFor="goal-input" className="goal-label">
        What do you want to get out of this conversation?
      </label>
      <div className="goal-row">
        <input
          id="goal-input"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="One sentence is enough"
          maxLength={300}
        />
        <button type="submit" className="continue" disabled={!text.trim()}>
          Start
        </button>
      </div>
      <div className="goal-examples">
        <span>For example:</span>
        {EXAMPLES.map((ex) => (
          <button type="button" key={ex} className="goal-example" onClick={() => setText(ex)}>
            {ex}
          </button>
        ))}
      </div>
    </form>
  );
}
