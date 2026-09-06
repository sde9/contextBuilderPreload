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
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import ConceptNode from '../ConceptNode';
import ConceptEdge from '../ConceptEdge';
import ClusterNode from './ClusterNode';
import { usePreload } from '@/lib/preloadStore';
import { visibleRelationships } from '@/lib/reducer';
import { clusterEdges, conceptsAtLevel, type Level } from '@/lib/cluster';
import { sourcesOf } from '@/lib/merge';
import { KIND_DEFAULT_SIZE, layoutLeftToRight, type NodeSize } from '@/lib/layout';
import type { Concept, Model } from '@/lib/types';

const nodeTypes = { concept: ConceptNode, cluster: ClusterNode };
const edgeTypes = { concept: ConceptEdge };

const CLUSTER_SIZE: NodeSize = { width: 240, height: 116 };

/*
 * Screen 3. The same canvas as real-time, with one thing added: a level.
 *
 * Level 1 draws areas. Level 2 opens them and shows the main concepts. Level
 * 3 shows everything, including attributes. Layout runs over whatever is
 * currently on screen, so a 300-node map opens as nine boxes rather than as
 * a wall (R3).
 */
function Flow() {
  const model = usePreload((s) => s.model)!;
  const level = usePreload((s) => s.level);
  const openClusters = usePreload((s) => s.openClusters);
  const toggleCluster = usePreload((s) => s.toggleCluster);
  const selectedSources = usePreload((s) => s.selectedSources);
  const select = usePreload((s) => s.select);
  const selectedConcept = usePreload((s) => s.selectedConcept);
  const { fitView } = useReactFlow();
  const initialised = useNodesInitialized();
  const shapeRef = useRef('');

  const shown = useMemo(
    () => conceptsAtLevel(model, level as Level, openClusters),
    [model, level, openClusters]
  );

  const dimmed = useMemo(() => dimSet(model, shown, selectedSources), [model, shown, selectedSources]);

  const { nodes, edges } = useMemo(() => {
    const shownIds = new Set(shown.map((c) => c.id));
    const rels = visibleRelationships(model).filter((r) => shownIds.has(r.from) && shownIds.has(r.to));

    // Areas appear whenever something is still collapsed.
    const collapsed = level === 3 ? [] : model.clusters.filter((cl) => !openClusters.includes(cl.id));

    // Layout wants concepts, so an area borrows the shape of one. It is only
    // ever a box on a canvas; nothing downstream treats it as a fact.
    const asConcepts: Concept[] = collapsed.map((cl) => ({
      id: cl.id,
      label: cl.label,
      note: '',
      origin: 'INFERRED',
      status: 'VALIDATED',
      kind: 'ENTITY',
      belongsTo: '',
      level: 0,
      evidence: [],
      turn: 0,
      x: 0,
      y: 0,
      pinned: false,
      tier: 2,
      clusterId: cl.id,
      mergedFrom: [],
      absorbedInto: '',
      contest: null,
    }));

    const clusterLinks = level === 3 ? [] : clusterEdges(model).filter(
      (e) => collapsed.some((c) => c.id === e.from) && collapsed.some((c) => c.id === e.to)
    );

    const laidOut = layoutLeftToRight(
      [...asConcepts, ...shown],
      [
        ...rels,
        ...clusterLinks.map((e, i) => ({
          id: `cl_${i}`,
          from: e.from,
          to: e.to,
          label: `${e.weight}`,
          origin: 'INFERRED' as const,
          status: 'VALIDATED' as const,
          turn: 0,
          merges: [],
        })),
      ],
      Object.fromEntries([
        ...asConcepts.map((c) => [c.id, CLUSTER_SIZE] as const),
        ...shown.map((c) => [c.id, KIND_DEFAULT_SIZE[c.kind]] as const),
      ])
    );
    const at = new Map(laidOut.map((p) => [p.id, p]));

    const clusterNodes: Node[] = collapsed.map((cl) => {
      const members = model.concepts.filter((c) => c.clusterId === cl.id && !c.absorbedInto && c.status !== 'REJECTED');
      return {
        id: cl.id,
        type: 'cluster',
        position: { x: at.get(cl.id)?.x ?? 0, y: at.get(cl.id)?.y ?? 0 },
        data: {
          label: cl.label,
          members: members.length,
          contested: members.filter((c) => c.status === 'CONTESTED').length,
          open: false,
        },
      };
    });

    const conceptNodes: Node[] = shown.map((c) => ({
      id: c.id,
      type: 'concept',
      position: { x: at.get(c.id)?.x ?? c.x, y: at.get(c.id)?.y ?? c.y },
      className: [
        dimmed.has(c.id) ? 'node-dim' : '',
        selectedConcept === c.id ? 'node-picked' : '',
      ]
        .filter(Boolean)
        .join(' '),
      data: {
        label: c.label,
        note: c.note,
        status: c.status,
        origin: c.origin,
        kind: c.kind,
        sources: sourcesOf(model, c).length,
        merged: c.mergedFrom.length,
      },
    }));

    const conceptEdges: Edge[] = rels.map((r) => {
      const proposed = r.status === 'PROPOSED';
      return {
        id: r.id,
        source: r.from,
        target: r.to,
        type: 'concept',
        label: r.label,
        data: { proposed },
        style: {
          stroke: proposed ? '#ea7317' : '#94a3b8',
          strokeWidth: proposed ? 1.8 : 2,
          strokeDasharray: proposed ? '6 4' : undefined,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color: proposed ? '#ea7317' : '#94a3b8', width: 14, height: 14 },
      };
    });

    const areaEdges: Edge[] = clusterLinks.map((e, i) => ({
      id: `cl_${i}`,
      source: e.from,
      target: e.to,
      type: 'default',
      label: `${e.weight}`,
      style: { stroke: '#94a3b8', strokeWidth: Math.min(6, 1 + e.weight * 0.6) },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8', width: 12, height: 12 },
    }));

    return { nodes: [...clusterNodes, ...conceptNodes], edges: [...conceptEdges, ...areaEdges] };
  }, [model, shown, level, openClusters, dimmed, selectedConcept]);

  // Refit whenever what is on screen changes shape, not on every render.
  const shape = `${level}|${openClusters.join(',')}|${nodes.length}|${edges.length}`;
  useEffect(() => {
    if (!initialised) return;
    if (shapeRef.current === shape) return;
    shapeRef.current = shape;
    const t = setTimeout(() => fitView({ padding: 0.25, maxZoom: 0.9, duration: 300 }), 30);
    return () => clearTimeout(t);
  }, [shape, initialised, fitView]);

  const onNodeClick = useCallback(
    (_e: unknown, node: Node) => {
      if (node.type === 'concept') select(node.id);
    },
    [select]
  );

  const onNodeDoubleClick = useCallback(
    (_e: unknown, node: Node) => {
      if (node.type === 'cluster') toggleCluster(node.id);
    },
    [toggleCluster]
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodeClick={onNodeClick}
      onNodeDoubleClick={onNodeDoubleClick}
      nodesDraggable={false}
      fitView
      fitViewOptions={{ padding: 0.3, maxZoom: 0.9 }}
      minZoom={0.1}
      maxZoom={1.5}
      defaultEdgeOptions={{ type: 'concept' }}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={28} size={1} color="#e2e8f0" />
      <Controls showInteractive={false} />
      <Panel position="top-left">
        <LevelControl />
      </Panel>
    </ReactFlow>
  );
}

function LevelControl() {
  const level = usePreload((s) => s.level);
  const setLevel = usePreload((s) => s.setLevel);
  const model = usePreload((s) => s.model);
  const open = usePreload((s) => s.openClusters);

  const labels: Record<Level, string> = { 1: 'Areas', 2: 'Main', 3: 'Everything' };

  return (
    <div className="level-control">
      {([1, 2, 3] as Level[]).map((l) => (
        <button key={l} className={level === l ? 'level-on' : ''} onClick={() => setLevel(l)}>
          {labels[l]}
        </button>
      ))}
      <span className="level-note">
        {level === 1
          ? `${model?.clusters.length ?? 0} areas${open.length ? `, ${open.length} open` : ''}`
          : level === 2
            ? 'main concepts'
            : 'including detail'}
      </span>
    </div>
  );
}

/** Everything not backed by the picked documents fades. Nothing is hidden. */
function dimSet(model: Model, shown: Concept[], picked: string[]): Set<string> {
  if (!picked.length) return new Set();
  const out = new Set<string>();
  for (const c of shown) {
    const ids = sourcesOf(model, c);
    if (!ids.some((id) => picked.includes(id))) out.add(c.id);
  }
  return out;
}

export default function PreloadCanvas() {
  return (
    <ReactFlowProvider>
      <Flow />
    </ReactFlowProvider>
  );
}
