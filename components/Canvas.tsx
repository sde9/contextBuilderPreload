'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  useViewport,
  type Edge,
  type Node,
  type NodeChange,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import ConceptNode from './ConceptNode';
import ConceptEdge from './ConceptEdge';
import { useSession } from '@/lib/store';
import { visibleConcepts, visibleRelationships } from '@/lib/reducer';
import type { NodeSize } from '@/lib/layout';
import { mapToPng } from '@/lib/snapshot';

const nodeTypes = { concept: ConceptNode };
const edgeTypes = { concept: ConceptEdge };

/**
 * Marks the top of the questions/problems band, in world coordinates
 * translated into screen space by the current pan/zoom. A DOM overlay, not a
 * React Flow node — it does not need to be selectable or draggable, just
 * anchored to the same transform everything else scrolls under.
 */
function BandDivider({ y }: { y: number }) {
  const { y: vy, zoom } = useViewport();
  return (
    <div className="band-divider" style={{ top: vy + y * zoom - 22 }}>
      <span>Questions and problems</span>
    </div>
  );
}

const LAYOUT_MS = 400;
/* Past this many nodes the tween costs more than it explains, so it is dropped. */
const ANIMATION_LIMIT = 120;

/*
 * The canvas is a projection of the model, never the model itself.
 * Positions live on the concepts, so there is nothing here to keep in sync.
 *
 * Layout runs after every turn, not only when Tidy up is pressed. The map is
 * therefore always in the shape a full-graph layout would give it, which is
 * the shape a .mmd import produces on a Miro board. What that costs is that
 * a hand-dragged node keeps its position only until the next turn.
 */
function Flow() {
  const model = useSession((s) => s.model);
  const autoTidy = useSession((s) => s.autoTidy);
  const move = useSession((s) => s.move);
  const layoutTo = useSession((s) => s.layoutTo);
  const registerCapture = useSession((s) => s.registerCapture);
  const exportPicture = useSession((s) => s.exportPicture);
  const { getNodes, getNodesBounds, fitView } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const nodesInitialized = useNodesInitialized();

  /** True once the user has panned or zoomed by hand. Stops auto-fit stealing the view. */
  const viewportMoved = useRef(false);
  /** The topology the current positions were computed for. */
  const laidOutFor = useRef('');

  const concepts = visibleConcepts(model);
  const relationships = visibleRelationships(model);

  const bandTop = useMemo(() => {
    const banded = concepts.filter((c) => c.kind === 'QUESTION' || c.kind === 'PROBLEM');
    return banded.length ? Math.min(...banded.map((c) => c.y)) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  /*
   * Topology only. Positions are deliberately left out: they change on every
   * animation frame, and re-running layout because layout moved something
   * would never terminate.
   */
  const topology = useMemo(
    () =>
      concepts.map((c) => `${c.id}:${c.status}`).join(',') +
      '|' +
      relationships.map((r) => `${r.id}:${r.status}:${r.label}`).join(','),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model]
  );

  const nodes: Node[] = useMemo(
    () =>
      concepts.map((c) => ({
        id: c.id,
        type: 'concept',
        position: { x: c.x, y: c.y },
        data: { label: c.label, note: c.note, status: c.status, origin: c.origin, kind: c.kind },
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model]
  );

  // Rebuilt on topology change only. Edge geometry comes from React Flow's own
  // node store, so these objects do not need to change while nodes are moving.
  const edges: Edge[] = useMemo(
    () =>
      relationships.map((r) => {
        const proposed = r.status === 'PROPOSED';
        return {
          id: r.id,
          source: r.from,
          target: r.to,
          type: 'concept',
          label: r.label,
          data: { proposed },
          animated: false,
          style: {
            stroke: proposed ? '#ea7317' : '#94a3b8',
            strokeWidth: proposed ? 1.8 : 2,
            strokeDasharray: proposed ? '6 4' : undefined,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: proposed ? '#ea7317' : '#94a3b8', width: 14, height: 14 },
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [topology]
  );

  // Only drags are written back. Everything else the canvas wants to do is ignored.
  const onNodesChange = (changes: NodeChange[]) => {
    for (const ch of changes) {
      if (ch.type === 'position' && ch.dragging === false && ch.position) {
        move(ch.id, ch.position.x, ch.position.y);
      }
    }
  };

  const onMoveEnd = useCallback((event: MouseEvent | TouchEvent | null, _viewport: Viewport) => {
    // A programmatic fitView reports a null event. Only a real gesture counts.
    if (event) viewportMoved.current = true;
  }, []);

  // Rendered nodes carry real measured dimensions; fall back to the CSS
  // default (place.ts / layout.ts) for anything not painted yet.
  const runLayout = useCallback(
    async (ms: number, fit: boolean) => {
      const sizes: Record<string, NodeSize> = {};
      for (const n of getNodes()) {
        if (n.measured?.width && n.measured?.height) {
          sizes[n.id] = { width: n.measured.width, height: n.measured.height };
        }
      }
      await layoutTo(sizes, ms);
      if (fit) fitView({ padding: 0.25, maxZoom: 0.85, duration: 320 });
    },
    [getNodes, layoutTo, fitView]
  );

  /*
   * Wait for React Flow to measure before laying out. A node that has not been
   * painted yet reports no size, and dagre would then rank it as a 220x80 box
   * whatever it really is — which is how overlapping boxes get through.
   */
  useEffect(() => {
    if (!autoTidy) return;
    if (topology === laidOutFor.current) return;
    if (concepts.length === 0) {
      laidOutFor.current = topology;
      return;
    }
    if (!nodesInitialized) return;

    const painted = getNodes();
    if (painted.length !== concepts.length) return;
    if (painted.some((n) => !n.measured?.width || !n.measured?.height)) return;

    laidOutFor.current = topology;
    void runLayout(concepts.length > ANIMATION_LIMIT ? 0 : LAYOUT_MS, !viewportMoved.current);
  }, [autoTidy, nodesInitialized, topology, concepts.length, getNodes, runLayout]);

  // RT-US-17. The header and other panels sit outside the React Flow provider,
  // so the canvas hands the store a way to draw the whole map as a PNG.
  useEffect(() => {
    registerCapture(async () => {
      const el = wrapper.current?.querySelector<HTMLElement>('.react-flow__viewport');
      if (!el) throw new Error('The map is not on screen.');
      return mapToPng(getNodesBounds(getNodes()), el);
    });
    return () => registerCapture(null);
  }, [registerCapture, getNodes, getNodesBounds]);

  const tidyUp = useCallback(() => {
    // An explicit Tidy up is also a request to see the whole thing again.
    viewportMoved.current = false;
    laidOutFor.current = topology;
    void runLayout(concepts.length > ANIMATION_LIMIT ? 0 : LAYOUT_MS, true);
  }, [runLayout, topology, concepts.length]);

  return (
    <ReactFlow
      ref={wrapper}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onMoveEnd={onMoveEnd}
      fitView
      fitViewOptions={{ padding: 0.45, maxZoom: 0.85 }}
      minZoom={0.15}
      maxZoom={1.4}
      defaultEdgeOptions={{ type: 'concept' }}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={28} size={1} color="#e2e8f0" />
      <Controls showInteractive={false} />
      {bandTop !== null && <BandDivider y={bandTop} />}
      <Panel position="top-right">
        <button
          className="btn-tidy"
          onClick={tidyUp}
          disabled={nodes.length === 0}
          title={autoTidy ? 'Re-arrange now and fit the whole map on screen' : 'Re-arrange left to right, no overlaps'}
        >
          Tidy up
        </button>
        <button
          className="btn-tidy btn-picture"
          onClick={() => void exportPicture()}
          disabled={nodes.length === 0}
          title="Save the whole map as a PNG picture"
        >
          Picture
        </button>
      </Panel>
    </ReactFlow>
  );
}

export default function Canvas() {
  return (
    <ReactFlowProvider>
      <Flow />
    </ReactFlowProvider>
  );
}
