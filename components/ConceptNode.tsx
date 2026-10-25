'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useSession } from '@/lib/store';
import type { Kind, Origin, Status } from '@/lib/types';

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
};

const KIND_TAG: Record<Kind, string> = {
  ENTITY: 'entity',
  ATTRIBUTE: 'attr',
  ACTOR: 'actor',
  STEP: 'step',
  RULE: 'rule',
  QUESTION: 'question',
  PROBLEM: 'problem',
  CLAIM: 'claim',
};

/*
 * Green and orange must be separable from across a room, and also by someone
 * who cannot tell the two colours apart. So the difference is carried three
 * ways: fill, a dashed border, and a "?" badge.
 *
 * Kind is a second, independent axis — shape, not colour. A node is always
 * both a status (validated/proposed) and a kind (entity/attribute/actor/...),
 * and the two never substitute for each other.
 */
export default function ConceptNode({ id, data }: NodeProps) {
  const d = data as unknown as ConceptNodeData;
  const proposed = d.status === 'PROPOSED';
  const contested = d.status === 'CONTESTED';
  const sources = d.sources ?? 0;
  const confirm = useSession((s) => s.confirm);
  const reject = useSession((s) => s.reject);

  const statusClass = contested ? 'node-contested' : proposed ? 'node-proposed' : 'node-validated';

  return (
    <div className={`node node-${d.kind.toLowerCase()} ${statusClass} ${sources > 1 ? 'node-corroborated' : ''}`}>
      <span className="kind-tag">{KIND_TAG[d.kind]}</span>
      <Handle type="target" position={Position.Left} className="handle" />

      <div className="node-label">
        {d.label}
        {proposed && <span className="badge">?</span>}
        {contested && <span className="badge badge-contested">≠</span>}
        {!proposed && !contested && sources > 1 && <span className="badge badge-sources">{sources}</span>}
      </div>

      {d.note && <div className="node-note">{d.note}</div>}

      {proposed && (
        <div className="node-actions">
          <button className="btn-yes" onClick={() => confirm(id)} title="Yes, that's right">
            Confirm
          </button>
          <button className="btn-no" onClick={() => reject(id)} title="No, and don't suggest it again">
            Reject
          </button>
        </div>
      )}

      <Handle type="source" position={Position.Right} className="handle" />
    </div>
  );
}
