'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';

export type ClusterNodeData = {
  label: string;
  members: number;
  contested: number;
  open: boolean;
};

/*
 * R6. An area is drawn as a container, never as a concept.
 *
 * It carries no citation because nobody wrote it down, so it must not look
 * like something a document said. Square corners, a dashed outline and a
 * count: it reads as a folder, not as a fact.
 */
export default function ClusterNode({ data }: NodeProps) {
  const d = data as unknown as ClusterNodeData;
  return (
    <div className={`cluster-node ${d.open ? 'cluster-open' : ''}`}>
      <Handle type="target" position={Position.Left} className="handle" />
      <span className="cluster-kicker">area</span>
      <div className="cluster-label">{d.label}</div>
      <div className="cluster-meta">
        {d.members} {d.members === 1 ? 'concept' : 'concepts'}
        {d.contested > 0 && <span className="cluster-contested">{d.contested} contested</span>}
      </div>
      <div className="cluster-hint">double-click to open</div>
      <Handle type="source" position={Position.Right} className="handle" />
    </div>
  );
}
