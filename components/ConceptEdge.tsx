'use client';

import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import { useSession } from '@/lib/store';

export type ConceptEdgeData = { proposed: boolean };

/*
 * Confirming a concept only carries its own edge along when the other end is
 * already validated (see confirmConcept). A relationship proposed on its own
 * — wiring between two things that both already exist — has no concept to
 * piggyback on, so it needs the same yes/no said directly to the edge.
 */
export default function ConceptEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  label,
  data,
}: EdgeProps) {
  const proposed = (data as unknown as ConceptEdgeData | undefined)?.proposed ?? false;
  const confirmRelationship = useSession((s) => s.confirmRelationship);
  const rejectRelationship = useSession((s) => s.rejectRelationship);

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            className={`edge-label ${proposed ? 'edge-label-proposed' : ''}`}
          >
            <span>{label}</span>
            {proposed && (
              <span className="edge-actions">
                <button className="btn-yes" onClick={() => confirmRelationship(id)} title="Yes, that's right">
                  ✓
                </button>
                <button className="btn-no" onClick={() => rejectRelationship(id)} title="No, drop this link">
                  ✕
                </button>
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
