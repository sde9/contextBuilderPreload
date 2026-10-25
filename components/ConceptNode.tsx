'use client';

import { useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useSession } from '@/lib/store';
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
  onAnswer?: (text: string) => Promise<{ ok: boolean; answered: boolean }>;
  onDismiss?: () => void;
  /** True while an answer is being read, here or on another box. */
  answerBusy?: boolean;
};

type AnswerOutcome = '' | 'open';

/*
 * A question gets an answer, not a yes or no. The box takes the answer, the
 * answer is read against the map, and the map changes to match it: new
 * boxes, a corrected label or note, an orange guess confirmed or thrown out.
 * A question the answer settles leaves the map; one it does not stays, with
 * a line saying so.
 */
function AnswerBox({
  onAnswer,
  onDismiss,
  busy,
}: {
  onAnswer: (text: string) => Promise<{ ok: boolean; answered: boolean }>;
  onDismiss: () => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<AnswerOutcome>('');

  const send = async () => {
    const text = draft.trim();
    if (!text || busy || sending) return;
    setSending(true);
    setOutcome('');
    try {
      const r = await onAnswer(text);
      // On failure the text stays in the box, so nothing typed is lost.
      if (r.ok) {
        setDraft('');
        if (!r.answered) setOutcome('open');
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="node-actions node-answer nodrag nopan nowheel" onClick={(e) => e.stopPropagation()}>
      <textarea
        className="node-answer-input"
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
      <div className="node-answer-row">
        <button className="btn-yes" disabled={!draft.trim() || busy || sending} onClick={() => void send()} title="Answer (Cmd+Enter)">
          {sending ? 'Reading…' : 'Answer'}
        </button>
        <button className="btn-no" disabled={sending} onClick={onDismiss} title="Not relevant. Don't ask it again">
          Dismiss
        </button>
      </div>
      {outcome === 'open' && <div className="node-answer-note">Noted. The answer did not settle it, so the question stays.</div>}
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
  const dismiss = d.onDismiss ?? reject;
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
      {question && <AnswerBox onAnswer={answer} onDismiss={dismiss} busy={answerBusy} />}

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
