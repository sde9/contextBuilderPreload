'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useSession } from '@/lib/store';
import AnswerField, { type AnswerOutcome } from './AnswerField';
import type { Kind, Origin, Status } from '@/lib/types';
import type { Reveal } from '@/lib/story';

export type ConceptNodeData = {
  label: string;
  note: string;
  status: Status;
  origin: Origin;
  kind: Kind;
  /** Preload only. How many documents back this up. 0 in a live session. */
  sources?: number;
  /** Preload only. How many concepts were folded into this one. */
  merged?: number;
  /** Preload only. The document's main point, or one of its parts. */
  skeleton?: 'MAIN' | 'PART';
  order?: number;
  /** Where the slider has got to. Absent when the story is off. */
  reveal?: Reveal | null;
  /** Preload passes its own actions; the live canvas uses its store. */
  onConfirm?: () => void;
  onReject?: () => void;
  /** A QUESTION box already kept in the list of questions to ask. */
  saved?: boolean;
  /** Preload passes its own answer and dismiss; the live canvas uses its store. */
  onAnswer?: (text: string) => Promise<AnswerOutcome>;
  onDismiss?: () => void;
  /** Put the question off for later. Preload keeps it in the questions to ask. */
  onLater?: () => void;
  laterLabel?: string;
  /** True while an answer is being read, here or on another box. */
  answerBusy?: boolean;
};

/*
 * A question gets an answer, not a yes or no. Three ways out of a question
 * box: answer it (the map changes to match), put it off for later (it moves
 * to the Later list on the right, from where it can be answered or brought
 * back), or dismiss it as not relevant.
 */
function QuestionActions({
  onAnswer,
  onLater,
  laterLabel,
  onDismiss,
  busy,
}: {
  onAnswer: (text: string) => Promise<AnswerOutcome>;
  onLater: () => void;
  laterLabel: string;
  onDismiss: () => void;
  busy: boolean;
}) {
  return (
    <div className="node-actions node-answer">
      <AnswerField onAnswer={onAnswer} busy={busy}>
        <button className="btn-later" onClick={onLater} title={laterLabel}>
          Later
        </button>
        <button className="btn-no" onClick={onDismiss} title="Not relevant. Don't ask it again">
          Dismiss
        </button>
      </AnswerField>
    </div>
  );
}

/** Plain words, because a tag is read by someone who has never seen the legend. */
const KIND_TAG: Record<Kind, string> = {
  ENTITY: 'thing',
  ATTRIBUTE: 'detail',
  ACTOR: 'who',
  STEP: 'step',
  RULE: 'rule',
  QUESTION: 'question',
  PROBLEM: 'problem',
  CLAIM: 'claim',
};

/*
 * Two shapes CSS cannot draw with a border intact: a step is an arrow, a rule
 * is a plate with cut corners. They are drawn as an outline behind the text,
 * stretched to the box. The old rule used clip-path, which cut its side
 * borders off and left two loose lines.
 */
const SHAPE_PATH: Partial<Record<Kind, string>> = {
  STEP: 'M1,1 H86 L99,50 L86,99 H1 L10,50 Z',
  RULE: 'M8,1 H92 L99,16 V84 L92,99 H8 L1,84 V16 Z',
};

/*
 * Three axes, one visual channel each, never substituting for one another:
 *
 *   status      colour, border style and a badge: green solid is written,
 *               orange dashed with "?" is guessed, red with "≠" is contested.
 *               Separable across a room and by someone who cannot tell the
 *               two colours apart.
 *   kind        silhouette: a thing is a box, a person a pill, a step an
 *               arrow, a rule a plate, a claim a box with a bar, a question
 *               a speech bubble, a problem a box with a red top.
 *   importance  size: the main point is largest, a part next, then the
 *               details, then the small detail chips.
 */
export default function ConceptNode({ id, data }: NodeProps) {
  const d = data as unknown as ConceptNodeData;
  const proposed = d.status === 'PROPOSED';
  const contested = d.status === 'CONTESTED';
  const sources = d.sources ?? 0;
  const confirmLive = useSession((s) => s.confirm);
  const rejectLive = useSession((s) => s.reject);
  const answerLive = useSession((s) => s.answerQuestion);
  const liveBusy = useSession((s) => s.phase !== 'idle');
  const confirm = d.onConfirm ?? (() => confirmLive(id));
  const reject = d.onReject ?? (() => rejectLive(id));
  const question = d.kind === 'QUESTION' && !contested;
  const answer = d.onAnswer ?? ((text: string) => answerLive(id, text));
  const dismissLive = useSession((s) => s.dismiss);
  const laterLive = useSession((s) => s.later);
  const dismiss = d.onDismiss ?? (() => dismissLive(id));
  const later = d.onLater ?? (() => laterLive(id));
  const laterLabel = d.laterLabel ?? 'Not now. Keep it in the Later list on the right';
  const answerBusy = d.onAnswer ? Boolean(d.answerBusy) : liveBusy;
  const shape = SHAPE_PATH[d.kind];

  const statusClass = contested ? 'node-contested' : proposed ? 'node-proposed' : 'node-validated';
  const classes = [
    'node',
    `node-${d.kind.toLowerCase()}`,
    statusClass,
    sources > 1 ? 'node-corroborated' : '',
    d.skeleton === 'MAIN' ? 'node-main' : '',
    d.skeleton === 'PART' ? 'node-part' : '',
    shape ? 'node-shaped' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const tag = d.skeleton === 'MAIN' ? 'main point' : d.skeleton === 'PART' ? `part ${(d.order ?? 0) + 1}` : KIND_TAG[d.kind];

  return (
    <div className={classes}>
      {shape && (
        <svg className="node-shape" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <path d={shape} vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      <span className="kind-tag">{tag}</span>
      {/* Default handles first: an edge that names no handle uses these. */}
      <Handle type="target" position={Position.Left} className="handle" />
      <Handle type="source" position={Position.Right} className="handle" />
      <Handle type="source" id="sb" position={Position.Bottom} className="handle" />
      <Handle type="target" id="tt" position={Position.Top} className="handle" />
      <Handle type="source" id="st" position={Position.Top} className="handle" />
      <Handle type="target" id="tb" position={Position.Bottom} className="handle" />
      <Handle type="source" id="sl" position={Position.Left} className="handle" />
      <Handle type="target" id="tr" position={Position.Right} className="handle" />

      <div className="node-label">
        {d.label}
        {proposed && <span className="badge">?</span>}
        {contested && <span className="badge badge-contested">≠</span>}
        {!proposed && !contested && sources > 1 && <span className="badge badge-sources">{sources}</span>}
        {d.saved && (
          <span className="badge badge-saved" title="Kept in the questions to ask">
            ✓
          </span>
        )}
      </div>

      {d.note && <div className="node-note">{d.note}</div>}

      {/* Always rendered, so a box keeps its size when the slider passes it;
          the stylesheet hides it on a step still to come. */}
      {question && <QuestionActions onAnswer={answer} onLater={later} laterLabel={laterLabel} onDismiss={dismiss} busy={answerBusy} />}

      {proposed && !question && (
        <div className="node-actions">
          <button
            className="btn-yes"
            onClick={(e) => {
              e.stopPropagation();
              confirm();
            }}
            title="Yes, that's right"
          >
            Confirm
          </button>
          <button
            className="btn-no"
            onClick={(e) => {
              e.stopPropagation();
              reject();
            }}
            title="No, and don't suggest it again"
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
