'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  useStore,
  type Edge,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import ConceptNode from '../ConceptNode';
import ConceptEdge from '../ConceptEdge';
import ClusterNode from './ClusterNode';
import StoryBar from './StoryBar';
import { usePreload } from '@/lib/preloadStore';
import { visibleRelationships } from '@/lib/reducer';
import { clusterEdges, conceptsAtLevel, type Level } from '@/lib/cluster';
import { sourcesOf } from '@/lib/merge';
import { activeOutline, outlineLevel } from '@/lib/outline';
import { buildStory, revealOf, revealOfEdge, stepIndex } from '@/lib/story';
import { norm } from '@/lib/guards';
import {
  KIND_DEFAULT_SIZE,
  layoutByParts,
  layoutLeftToRight,
  pickHandles,
  routeOutlineLink,
  type HandlePick,
  type LaidOutPoint,
  type NodeSize,
  type OutlineLayout,
  type PartColumn,
} from '@/lib/layout';
import type { Concept, Model, Relationship } from '@/lib/types';

const nodeTypes = { concept: ConceptNode, cluster: ClusterNode };
const edgeTypes = { concept: ConceptEdge };

const CLUSTER_SIZE: NodeSize = { width: 240, height: 116 };

/** Room around a fitted map; the slider sits over the bottom of the canvas. */
const FIT_PADDING = { top: '56px', left: '40px', right: '40px', bottom: '150px' } as const;

/** Fixed widths on a map with a skeleton, so each column lines up. */
const WIDTH = { MAIN: 320, PART: 260, CLAIM: 240, ATTRIBUTE: 170, DEFAULT: 220 };

/*
 * The box a concept will take, estimated from its text. Labels are clamped to
 * four lines and notes to three in the stylesheet, so the estimate cannot run
 * far from what is drawn, and a column never overlaps itself.
 */
function estimate(concept: Concept, withSkeleton: boolean): NodeSize {
  const c = withSkeleton || !concept.skeleton ? concept : { ...concept, skeleton: undefined };
  if (!c.skeleton && c.kind !== 'CLAIM' && c.kind !== 'ATTRIBUTE') {
    const base = KIND_DEFAULT_SIZE[c.kind];
    const width = WIDTH.DEFAULT;
    return { width, height: Math.max(base.height, height(c, width, 7.6, 19, 0)) };
  }
  const width = c.skeleton === 'MAIN' ? WIDTH.MAIN : c.skeleton === 'PART' ? WIDTH.PART : c.kind === 'CLAIM' ? WIDTH.CLAIM : WIDTH.ATTRIBUTE;
  const [cw, lh] = c.skeleton === 'MAIN' ? [10, 25] : c.skeleton === 'PART' ? [8.8, 22] : c.kind === 'ATTRIBUTE' ? [6.2, 15] : [7.8, 20];
  return { width, height: height(c, width, cw, lh, c.skeleton ? 6 : 0) };
}

function height(c: Concept, width: number, charW: number, lineH: number, extra: number): number {
  const inner = width - 30;
  const labelLines = Math.min(4, Math.max(1, Math.ceil((c.label.length * charW) / inner)));
  const noteLines = c.note ? Math.min(3, Math.ceil((c.note.length * 6.3) / inner)) : 0;
  // A question carries an answer box; a guess carries Confirm and Reject.
  const buttons = c.kind === 'QUESTION' ? 98 : c.status === 'PROPOSED' ? 34 : 0;
  return Math.round(26 + labelLines * lineH + (noteLines ? 6 + noteLines * 15.5 : 0) + buttons + extra);
}

function writtenRank(model: Model, c: Concept, excerptOrd: Map<string, number>): number {
  let best = Infinity;
  for (const id of c.evidence) {
    const r = excerptOrd.get(id);
    if (r !== undefined && r < best) best = r;
  }
  return best;
}

/*
 * Screen 3. The same canvas as real-time, with two things added: a level and
 * a story.
 *
 * Level 1 is the overview: on a document with a skeleton, its main point and
 * its parts; otherwise its areas. Level 2 adds the main concepts, level 3
 * everything. The story is the slider underneath: the map revealed step by
 * step, with the steps still to come drawn as pale outlines.
 */
function Flow() {
  const model = usePreload((s) => s.model)!;
  const level = usePreload((s) => s.level);
  const openClusters = usePreload((s) => s.openClusters);
  const toggleCluster = usePreload((s) => s.toggleCluster);
  const selectedSources = usePreload((s) => s.selectedSources);
  const select = usePreload((s) => s.select);
  const selectedConcept = usePreload((s) => s.selectedConcept);
  const confirm = usePreload((s) => s.confirm);
  const reject = usePreload((s) => s.reject);
  const confirmRel = usePreload((s) => s.confirmRelationship);
  const rejectRel = usePreload((s) => s.rejectRelationship);
  const answer = usePreload((s) => s.answer);
  const answering = usePreload((s) => s.answering);
  const storyMode = usePreload((s) => s.storyMode);
  const storyStep = usePreload((s) => s.storyStep);
  const setStoryStep = usePreload((s) => s.setStoryStep);
  const setStoryMode = usePreload((s) => s.setStoryMode);
  const { fitView, setCenter, getViewport } = useReactFlow();
  const paneW = useStore((s) => s.width);
  const paneH = useStore((s) => s.height);
  const initialised = useNodesInitialized();
  const shapeRef = useRef('');
  /*
   * Sizes are estimated for the first layout, then measured. React Flow
   * reports each box's real size; the map is laid out again with it, so a row
   * never runs into the next one. The size also goes back on every node, or
   * React Flow would forget it each time a node is rebuilt (every step of the
   * slider) and hide the box and its links until it had measured it again.
   */
  const [measured, setMeasured] = useState<Record<string, NodeSize>>({});
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const next: Record<string, NodeSize> = {};
    for (const ch of changes) {
      if (ch.type === 'dimensions' && ch.dimensions) next[ch.id] = { width: ch.dimensions.width, height: ch.dimensions.height };
    }
    if (!Object.keys(next).length) return;
    setMeasured((m) => {
      const moved = Object.entries(next).some(([id, s]) => {
        const k = m[id];
        return !k || Math.abs(k.width - s.width) > 1 || Math.abs(k.height - s.height) > 1;
      });
      return moved ? { ...m, ...next } : m;
    });
  }, []);

  const outline = useMemo(() => activeOutline(model), [model]);

  const shown = useMemo(
    () => (outline ? outlineLevel(model, level as 1 | 2 | 3, openClusters) : conceptsAtLevel(model, level as Level, openClusters)),
    [model, level, openClusters, outline]
  );

  // A collapsed area stands for its members, so the story counts them: the
  // area appears with the step that brings its first member.
  const storyConcepts = useMemo(() => {
    if (outline || level === 3) return shown;
    const collapsed = new Set(model.clusters.filter((cl) => !openClusters.includes(cl.id)).map((cl) => cl.id));
    const ids = new Set(shown.map((c) => c.id));
    return [...shown, ...model.concepts.filter((c) => collapsed.has(c.clusterId) && !ids.has(c.id))];
  }, [model, shown, level, openClusters, outline]);
  const story = useMemo(() => buildStory(model, storyMode, storyConcepts), [model, storyMode, storyConcepts]);
  const index = useMemo(() => stepIndex(story), [story]);
  const step = storyStep === null || !story.steps.length ? null : Math.min(storyStep, story.steps.length - 1);

  const dimmed = useMemo(() => dimSet(model, shown, selectedSources), [model, shown, selectedSources]);
  const savedTexts = useMemo(
    () => new Set(model.questions.filter((q) => q.savedAt && q.status === 'OPEN').map((q) => norm(q.text))),
    [model]
  );

  const { nodes, edges, boxes } = useMemo(() => {
    const shownIds = new Set(shown.map((c) => c.id));
    const rels = visibleRelationships(model).filter((r) => shownIds.has(r.from) && shownIds.has(r.to));
    const sizes: Record<string, NodeSize> = Object.fromEntries(shown.map((c) => [c.id, measured[c.id] ?? estimate(c, Boolean(outline))]));

    // Areas appear whenever something is still collapsed. A map with a
    // skeleton shows its parts instead, as boxes that open in place.
    const collapsed = outline || level === 3 ? [] : model.clusters.filter((cl) => !openClusters.includes(cl.id));
    for (const cl of collapsed) sizes[cl.id] = measured[cl.id] ?? CLUSTER_SIZE;

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

    const clusterLinks = outline || level === 3
      ? []
      : clusterEdges(model).filter((e) => collapsed.some((c) => c.id === e.from) && collapsed.some((c) => c.id === e.to));

    let laidOut: LaidOutPoint[];
    let byParts: OutlineLayout | null = null;
    if (outline) {
      const excerptOrd = new Map(model.excerpts.map((e) => [e.id, e.ord ?? e.turn]));
      const clusterOfPart = new Map<string, string>();
      for (const cl of model.clusters) for (const pid of outline.partIds) if (cl.memberIds.includes(pid)) clusterOfPart.set(pid, cl.id);
      const columns: PartColumn[] = outline.partIds.map((pid) => {
        const clusterId = clusterOfPart.get(pid) ?? '';
        const members = shown
          .filter((c) => c.id !== pid && c.id !== outline.mainId && clusterId && c.clusterId === clusterId)
          .sort((a, b) => writtenRank(model, a, excerptOrd) - writtenRank(model, b, excerptOrd));
        return { leadId: shownIds.has(pid) ? pid : null, memberIds: members.map((c) => c.id) };
      });
      const inColumns = new Set(columns.flatMap((c) => [c.leadId ?? '', ...c.memberIds]));
      const rest = shown.filter((c) => !inColumns.has(c.id) && c.id !== outline.mainId);
      if (rest.length) columns.push({ leadId: null, memberIds: rest.map((c) => c.id) });
      byParts = layoutByParts(shown, columns, shownIds.has(outline.mainId) ? outline.mainId : null, sizes);
      laidOut = byParts.points;
    } else {
      laidOut = layoutLeftToRight(
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
        sizes
      );
    }
    const at = new Map(laidOut.map((p) => [p.id, p]));
    const boxOf = (id: string) => {
      const p = at.get(id);
      const s = sizes[id] ?? { width: 220, height: 80 };
      return { x: p?.x ?? 0, y: p?.y ?? 0, width: s.width, height: s.height };
    };
    const boxes = new Map(laidOut.map((p) => [p.id, boxOf(p.id)]));

    const clusterNodes: Node[] = collapsed.map((cl) => {
      const members = model.concepts.filter((c) => c.clusterId === cl.id && !c.absorbedInto && c.status !== 'REJECTED');
      const first = Math.min(...members.map((c) => index.get(c.id) ?? Infinity));
      const reveal = step === null ? null : first < step ? 'past' : first === step ? 'current' : 'future';
      return {
        id: cl.id,
        type: 'cluster',
        position: { x: at.get(cl.id)?.x ?? 0, y: at.get(cl.id)?.y ?? 0 },
        measured: measured[cl.id],
        className: reveal ? `story-${reveal}` : '',
        data: {
          label: cl.label,
          members: members.length,
          contested: members.filter((c) => c.status === 'CONTESTED').length,
          open: false,
        },
      };
    });

    const conceptNodes: Node[] = shown.map((c) => {
      const reveal = revealOf(index, c.id, step);
      const fixed = outline ? sizes[c.id]?.width : undefined;
      return {
        id: c.id,
        type: 'concept',
        position: { x: at.get(c.id)?.x ?? c.x, y: at.get(c.id)?.y ?? c.y },
        measured: measured[c.id],
        style: fixed ? { width: fixed } : undefined,
        className: [
          dimmed.has(c.id) ? 'node-dim' : '',
          selectedConcept === c.id ? 'node-picked' : '',
          reveal ? `story-${reveal}` : '',
          fixed ? 'node-fixed' : '',
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
          // Main point and parts belong to one document's outline. With
          // several documents on one map there are several of each, so
          // they are drawn as what they are, not as the main point.
          skeleton: outline ? c.skeleton : undefined,
          order: c.order,
          reveal,
          saved: c.kind === 'QUESTION' && savedTexts.has(norm(c.label)),
          onConfirm: () => void confirm(c.id),
          onReject: () => void reject(c.id),
          ...(c.kind === 'QUESTION'
            ? {
                onAnswer: (text: string) => answer(c.id, text),
                onDismiss: () => void reject(c.id),
                answerBusy: Boolean(answering),
              }
            : {}),
        },
      };
    });

    const skeletonIds = new Set(shown.filter((c) => c.skeleton).map((c) => c.id));
    const handlesFor = (r: Relationship): HandlePick & { labelNear?: 'source' | 'target' } => {
      if (!outline) return {};
      const a = boxOf(r.from);
      const b = boxOf(r.to);
      if (skeletonIds.has(r.from) && skeletonIds.has(r.to)) {
        // The spine. Every link between the main point and a part, or between
        // two parts, runs down the gutter on the left like the lines of a
        // tree, so it never cuts through a box or through a part's details.
        if (r.from === outline.mainId) return { sourceHandle: 'sb', labelNear: 'target' };
        if (r.to === outline.mainId) return { sourceHandle: 'sl', targetHandle: 'tb', labelNear: 'source' };
        return { sourceHandle: 'sl', labelNear: 'source' };
      }
      return pickHandles(a, b);
    };

    const mainShown = outline && shownIds.has(outline.mainId) ? outline.mainId : null;
    const conceptEdges: Edge[] = rels.map((r) => {
      const spineLink = skeletonIds.has(r.from) && skeletonIds.has(r.to);
      // On an outline most links follow a fixed route, so none runs behind a box.
      const route = byParts && !spineLink ? routeOutlineLink(r.from, r.to, boxes, byParts, mainShown) : null;
      const { labelNear, ...handles } = route ? {} : handlesFor(r);
      const proposed = r.status === 'PROPOSED';
      const reveal = revealOfEdge(index, r, step);
      const spine = Boolean(r.type);
      const colour =
        reveal === 'current' ? '#2563eb' : r.type === 'CONTRADICTS' ? '#dc2626' : proposed ? '#ea7317' : spine ? '#475569' : '#94a3b8';
      return {
        id: r.id,
        source: r.from,
        target: r.to,
        ...handles,
        type: 'concept',
        label: r.label,
        className: reveal ? `story-edge-${reveal}` : '',
        data: {
          proposed,
          reveal,
          labelNear,
          route,
          onConfirm: () => void confirmRel(r.id),
          onReject: () => void rejectRel(r.id),
        },
        style: {
          stroke: colour,
          strokeWidth: spine ? 2.6 : proposed ? 1.8 : 2,
          strokeDasharray: proposed ? '6 4' : r.type === 'REFINES' ? '2 5' : undefined,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color: colour, width: 14, height: 14 },
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

    return { nodes: [...clusterNodes, ...conceptNodes], edges: [...conceptEdges, ...areaEdges], boxes };
  }, [model, shown, level, openClusters, dimmed, selectedConcept, outline, index, step, savedTexts, confirm, reject, confirmRel, rejectRel, answer, answering, measured]);

  // Refit whenever what is on screen changes shape, not on every render or step.
  const shape = `${level}|${openClusters.join(',')}|${nodes.length}|${edges.length}|${Object.keys(measured).length}`;
  useEffect(() => {
    if (!initialised) return;
    if (shapeRef.current === shape) return;
    shapeRef.current = shape;
    // Room at the bottom for the slider, which sits over the canvas.
    void fitView({ padding: FIT_PADDING, maxZoom: 0.9, duration: 300 });
  }, [shape, initialised, fitView]);

  // The camera follows the story: when the current step is off screen, pan
  // to it at the same zoom. Never zoom on a step, which would make dragging
  // the slider feel like being thrown around.
  useEffect(() => {
    if (step === null) return;
    const ids = story.steps[step]?.conceptIds ?? [];
    // A concept inside a collapsed area is found by its area's box.
    const areaOf = new Map(model.concepts.map((c) => [c.id, c.clusterId]));
    const rects = ids
      .map((id) => boxes.get(id) ?? boxes.get(areaOf.get(id) ?? ''))
      .filter((b): b is NonNullable<typeof b> => Boolean(b));
    if (!rects.length) return;
    const minX = Math.min(...rects.map((b) => b.x));
    const minY = Math.min(...rects.map((b) => b.y));
    const maxX = Math.max(...rects.map((b) => b.x + b.width));
    const maxY = Math.max(...rects.map((b) => b.y + b.height));
    const { x, y, zoom } = getViewport();
    const left = -x / zoom;
    const top = -y / zoom;
    const right = left + paneW / zoom;
    // The slider covers the bottom of the canvas.
    const bottom = top + Math.max(100, paneH - 150) / zoom;
    if (minX >= left && maxX <= right && minY >= top && maxY <= bottom) return;
    setCenter((minX + maxX) / 2, (minY + maxY) / 2 + 60 / zoom, { zoom, duration: 350 });
  }, [step, story, boxes, model, getViewport, setCenter, paneW, paneH]);

  const onNodeClick = useCallback(
    (_e: unknown, node: Node) => {
      if (node.type === 'concept') select(node.id);
    },
    [select]
  );

  const onNodeDoubleClick = useCallback(
    (_e: unknown, node: Node) => {
      if (node.type === 'cluster') {
        toggleCluster(node.id);
        return;
      }
      // On a map with a skeleton a part opens in place to show what it holds.
      const c = model.concepts.find((x) => x.id === node.id);
      if (c?.skeleton === 'PART' && c.clusterId) toggleCluster(c.clusterId);
    },
    [toggleCluster, model]
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
      fitViewOptions={{ padding: FIT_PADDING, maxZoom: 0.9 }}
      onNodesChange={onNodesChange}
      minZoom={0.1}
      maxZoom={1.5}
      defaultEdgeOptions={{ type: 'concept' }}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={28} size={1} color="#e2e8f0" />
      <Controls showInteractive={false} />
      <Panel position="top-left">
        <LevelControl hasOutline={Boolean(outline)} parts={outline?.partIds.length ?? 0} />
      </Panel>
      {story.steps.length > 0 && (
        <Panel position="bottom-center" className="story-panel">
          <StoryBar
            story={story}
            step={step}
            mode={storyMode}
            hasOutline={Boolean(outline)}
            onStep={setStoryStep}
            onMode={setStoryMode}
            onPick={select}
          />
        </Panel>
      )}
    </ReactFlow>
  );
}

function LevelControl({ hasOutline, parts }: { hasOutline: boolean; parts: number }) {
  const level = usePreload((s) => s.level);
  const setLevel = usePreload((s) => s.setLevel);
  const model = usePreload((s) => s.model);
  const open = usePreload((s) => s.openClusters);

  const labels: Record<Level, string> = { 1: hasOutline ? 'Overview' : 'Areas', 2: 'Main', 3: 'Everything' };

  return (
    <div className="level-control">
      {([1, 2, 3] as Level[]).map((l) => (
        <button key={l} className={level === l ? 'level-on' : ''} onClick={() => setLevel(l)}>
          {labels[l]}
        </button>
      ))}
      <span className="level-note">
        {level === 1
          ? hasOutline
            ? `main point and ${parts} parts${open.length ? `, ${open.length} open` : ''} · double-click a part`
            : `${model?.clusters.length ?? 0} areas${open.length ? `, ${open.length} open` : ''}`
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
