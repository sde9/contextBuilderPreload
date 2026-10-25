'use client';

import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import { useSession } from '@/lib/store';
import { roundedPath, type Route } from '@/lib/layout';

export type ConceptEdgeData = {
  proposed: boolean;
  /** Where the slider has got to. A future link keeps its line faint and hides its label. */
  reveal?: 'past' | 'current' | 'future' | null;
  /** Preload passes its own actions; the live canvas uses its store. */
  onConfirm?: () => void;
  onReject?: () => void;
  /**
   * Put the label next to one end instead of the middle. Links that share a
   * trunk (the spine of an outline) would otherwise stack their labels on
   * the trunk, far from the box each one belongs to.
   */
  labelNear?: 'source' | 'target';
  /** Preload outline only. A fixed path and label place, worked out from the layout. */
  route?: Route | null;
};

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
  const d = data as unknown as ConceptEdgeData | undefined;
  const proposed = d?.proposed ?? false;
  const reveal = d?.reveal ?? null;
  const confirmLive = useSession((s) => s.confirmRelationship);
  const rejectLive = useSession((s) => s.rejectRelationship);
  const confirmRelationship = (edgeId: string) => (d?.onConfirm ? d.onConfirm() : confirmLive(edgeId));
  const rejectRelationship = (edgeId: string) => (d?.onReject ? d.onReject() : rejectLive(edgeId));

  const [stepPath, midX, midY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const route = d?.route;
  const edgePath = route ? roundedPath(route.points) : stepPath;
  const near = d?.labelNear;
  const labelX = route ? route.label.x : near === 'source' ? sourceX - 48 : near === 'target' ? targetX - 48 : midX;
  const labelY = route ? route.label.y : near === 'source' ? sourceY : near === 'target' ? targetY : midY;

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />
      {label && reveal !== 'future' && (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            className={`edge-label ${proposed ? 'edge-label-proposed' : ''} ${reveal === 'current' ? 'edge-label-current' : ''}`}
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
