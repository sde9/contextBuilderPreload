'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useSession } from '@/lib/store';
import AnswerField from './AnswerField';

export type QuestionNodeData = {
  /** The question record's id. */
  questionId: string;
  text: string;
  why: string;
  /** The label of the concept the question is about, "" when none. */
  about: string;
};

/*
 * RT-US-06. A question card under the live map. It is not a concept: it has
 * no Confirm and no Reject, and dagre never sees it. Three ways out:
 *
 *   Answer   the answer is read against the map, the map changes to match,
 *            and the next proposals stay with what the question was about
 *   Later    the card leaves the map for the open questions panel
 *   Dismiss  closed for good; the AI never asks it again
 *
 * The answer field keeps what was typed if reading it fails, and is disabled
 * while any turn runs.
 */
export default function QuestionNode({ data }: NodeProps) {
  const d = data as unknown as QuestionNodeData;
  const answer = useSession((s) => s.answerQuestion);
  const later = useSession((s) => s.later);
  const dismiss = useSession((s) => s.dismiss);
  const busy = useSession((s) => s.phase !== 'idle');

  return (
    <div className="node node-question node-validated question-card">
      <span className="kind-tag">question</span>
      <Handle type="target" position={Position.Top} className="handle" />
      <div className="node-label">{d.text}</div>
      {(d.why || d.about) && (
        <div className="node-note">
          {d.about && <span className="card-about">About {d.about}. </span>}
          {d.why}
        </div>
      )}
      <div className="node-actions node-answer">
        <AnswerField onAnswer={(text) => answer(d.questionId, text)} busy={busy}>
          <button className="btn-later" onClick={() => later(d.questionId)} title="Not now. Move it to the open questions on the right">
            Later
          </button>
          <button className="btn-no" onClick={() => dismiss(d.questionId)} title="Not relevant. Don't ask it again">
            Dismiss
          </button>
        </AnswerField>
      </div>
    </div>
  );
}
