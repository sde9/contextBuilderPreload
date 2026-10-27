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
import QuestionNode from './QuestionNode';
import { useSession } from '@/lib/store';
import { cardQuestions, parkedCountByAnchor, visibleConcepts, visibleRelationships } from '@/lib/reducer';
import { foldedDetails, replayAt, turnChanges } from '@/lib/understanding';
import { KIND_DEFAULT_SIZE, type NodeSize } from '@/lib/layout';
import { mapToPng } from '@/lib/snapshot';

const nodeTypes = { concept: ConceptNode, question: QuestionNode };
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

/* RT-US-06. The question cards' band, as layout.ts places QUESTION and PROBLEM boxes. */
const BAND_GAP = 90;
const CARD_WIDTH = 260;
const CARD_GAP = 36;
const QUESTION_COLOR = '#7c3aed';
const BANDED = new Set(['QUESTION', 'PROBLEM']);
/** How long a concept found from the open questions panel stays highlighted. */
const HIGHLIGHT_MS = 2000;
/** KVIF P5. How long the rest of the map steps back after a turn, so the new boxes stand out. */
const FLASH_MS = 5000;

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
  const showLinks = useSession((s) => s.showLinks);
  const focusConceptId = useSession((s) => s.focusConceptId);
  const clearFocus = useSession((s) => s.clearFocus);
  const foldOn = useSession((s) => s.foldDetails);
  const selectedId = useSession((s) => s.selectedConceptId);
  const select = useSession((s) => s.select);
  const replayTurn = useSession((s) => s.replayTurn);
  const setReplay = useSession((s) => s.setReplay);
  const { getNodes, getNodesBounds, fitView, getNode, setCenter, getZoom } = useReactFlow();
  const [highlight, setHighlight] = useState('');
  const highlightTimer = useRef<number | undefined>(undefined);
  const wrapper = useRef<HTMLDivElement>(null);

  /*
   * Measured box sizes, kept here and handed back on every node object.
   *
   * This canvas is controlled. React Flow measures each box and reports the
   * size as a "dimensions" change; a controlled flow has to carry it back on
   * the node, or React Flow treats the next node object it is given (every
   * model change makes new ones) as unmeasured: it hides the box until it is
   * measured again, and nodesInitialized stays false. Until 27 Oct 2026 the
   * sizes were dropped, so the layout effect below never passed its checks:
   * the map was not re-laid out after a turn, and Tidy up ranked every box at
   * its default size.
   */
  const [measured, setMeasured] = useState<Map<string, NodeSize>>(() => new Map());
  const sizesKey = useMemo(
    () => [...measured].map(([id, d]) => `${id}:${d.width}x${d.height}`).join(';'),
    [measured]
  );

  /** True once the user has panned or zoomed by hand. Stops auto-fit stealing the view. */
  const viewportMoved = useRef(false);
  /** The topology the current positions were computed for. */
  const laidOutFor = useRef('');

  /*
   * KVIF P1, P6: preserve more than you display. Green details whose only
   * link is their owner sit inside it as chips (foldedDetails). They stay in
   * the model and in every export; they just take no box of their own.
   */
  const fold = useMemo(
    () => (foldOn ? foldedDetails(model) : { folded: new Set<string>(), byOwner: new Map() }),
    [model, foldOn]
  );
  const concepts = visibleConcepts(model).filter((c) => !fold.folded.has(c.id));
  const relationships = visibleRelationships(model).filter((r) => !fold.folded.has(r.from) && !fold.folded.has(r.to));

  /* KVIF P5. What this turn added or touched, and a few seconds in which the rest steps back. */
  const changed = useMemo(() => turnChanges(model), [model]);
  const [flash, setFlash] = useState(false);
  const flashedTurn = useRef(model.turn);
  const flashTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (model.turn === flashedTurn.current) return;
    // Only an ordinary next turn. Opening or restoring a session jumps several
    // turns at once, and nothing in it is new to the person.
    const step = model.turn === flashedTurn.current + 1;
    flashedTurn.current = model.turn;
    if (!step || changed.size === 0) return;
    setFlash(true);
    // A ref, not a cleanup: the model changes on every layout frame, and a
    // cleanup would cancel the timer before it fires.
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(false), FLASH_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.turn]);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  /* KVIF P11. The history slider: the map as it stood after an earlier turn. */
  const replaying = replayTurn !== null && replayTurn < model.turn;
  const frame = useMemo(() => (replaying ? replayAt(model, replayTurn!) : null), [model, replaying, replayTurn]);
  // A new turn ends the replay: the map is live again.
  const liveTurn = useRef(model.turn);
  useEffect(() => {
    if (model.turn !== liveTurn.current) {
      liveTurn.current = model.turn;
      if (replayTurn !== null) setReplay(null);
    }
  }, [model.turn, replayTurn, setReplay]);

  // Question cards are the present, not the history: off while replaying.
  const cards = replaying ? [] : cardQuestions(model);
  const waiting = parkedCountByAnchor(model);

  /*
   * RT-US-06. Question cards sit in the band under the map, left to right in
   * the order they were asked, after any PROBLEM boxes already there. They
   * are not concepts, so dagre never sees them; they follow the map instead.
   */
  const sizeOf = (id: string, kind: keyof typeof KIND_DEFAULT_SIZE) => measured.get(id) ?? KIND_DEFAULT_SIZE[kind];
  const mapped = concepts.filter((c) => !BANDED.has(c.kind));
  const banded = concepts.filter((c) => BANDED.has(c.kind));
  const mapBottom = mapped.length ? Math.max(...mapped.map((c) => c.y + sizeOf(c.id, c.kind).height)) : 0;
  const mapLeft = concepts.length ? Math.min(...concepts.map((c) => c.x)) : 0;
  const bandY = banded.length ? Math.min(...banded.map((c) => c.y)) : mapped.length ? mapBottom + BAND_GAP : 0;
  const cardsLeft = banded.length ? Math.max(...banded.map((c) => c.x + sizeOf(c.id, c.kind).width)) + CARD_GAP : mapLeft;
  const bandTop = banded.length || cards.length ? bandY : null;

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
    [model, fold]
  );

  /*
   * Cards change the canvas but never the layout, so they are tracked apart
   * from the topology the layout effect watches.
   */
  const cardTopology = cards.map((q) => `${q.id}:${q.anchorId ?? ''}`).join(',');

  /*
   * Concept nodes are rebuilt only when the model or the highlight changes.
   * They must not depend on the band position: that depends on measured
   * sizes, and a new node object drops React Flow's measurement, which would
   * hide the node and change the sizes again, round and round.
   */
  const conceptNodes: Node[] = useMemo(
    () =>
      concepts.map((c) => {
        const then = frame ? frame.concepts.get(c.id) : c.status;
        const classes = [
          highlight === c.id ? 'node-focus' : '',
          selectedId === c.id ? 'node-picked' : '',
          !frame && changed.has(c.id) ? 'node-new' : '',
          frame && !then ? 'node-future' : '',
        ].filter(Boolean);
        return {
          id: c.id,
          type: 'concept',
          position: { x: c.x, y: c.y },
          className: classes.length ? classes.join(' ') : undefined,
          measured: measured.get(c.id),
          data: {
            label: c.label,
            note: c.note,
            status: then ?? c.status,
            origin: c.origin,
            kind: c.kind,
            parkedQuestions: frame ? 0 : waiting.get(c.id) ?? 0,
            details: (fold.byOwner.get(c.id) ?? [])
              .filter((x: { id: string }) => !frame || frame.concepts.has(x.id))
              .map((x: { id: string; label: string; note: string }) => ({ id: x.id, label: x.label, note: x.note })),
          },
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, highlight, sizesKey, fold, selectedId, changed, frame]
  );

  const cardNodes: Node[] = useMemo(
    () => {
      const label = new Map(concepts.map((c) => [c.id, c.label]));
      return cards.map((q, i) => ({
        id: q.id,
        type: 'question',
        position: { x: cardsLeft + i * (CARD_WIDTH + CARD_GAP), y: bandY },
        draggable: false,
        selectable: false,
        // A node that can be neither dragged nor selected gets pointer-events:
        // none from React Flow, and clicks fall through to the canvas. The
        // card has an answer field and buttons, so it must take them.
        style: { pointerEvents: 'all' },
        measured: measured.get(q.id),
        data: { questionId: q.id, text: q.text, why: q.why, about: (q.anchorId && label.get(q.anchorId)) || '' },
      }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cardTopology, model.questions, bandY, cardsLeft, sizesKey]
  );

  const nodes = useMemo(() => [...conceptNodes, ...cardNodes], [conceptNodes, cardNodes]);

  // Rebuilt on topology change only. Edge geometry comes from React Flow's own
  // node store, so these objects do not need to change while nodes are moving.
  const edges: Edge[] = useMemo(
    () =>
      relationships.map((r) => {
        const then = frame ? frame.relationships.get(r.id) : r.status;
        const proposed = (then ?? r.status) === 'PROPOSED';
        const future = Boolean(frame && !then);
        return {
          className: future ? 'edge-future' : undefined,
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
    [topology, frame]
  );

  // RT-US-06. A dashed line from the concept a question is about to its card.
  // Not a Relationship: no label, no buttons, not in the file.
  const connectors: Edge[] = useMemo(
    () => {
      const onMap = new Set(concepts.map((c) => c.id));
      return cards
        .filter((q) => q.anchorId && onMap.has(q.anchorId))
        .map((q) => ({
          id: `qa_${q.id}`,
          source: q.anchorId!,
          sourceHandle: 'sb',
          target: q.id,
          type: 'default',
          selectable: false,
          focusable: false,
          style: { stroke: QUESTION_COLOR, strokeWidth: 1.4, strokeDasharray: '4 4', opacity: 0.7 },
        }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cardTopology, topology]
  );

  // RT-US-19. Links off hides them on screen only. Layout reads the model.
  const shownEdges = useMemo(() => (showLinks ? [...edges, ...connectors] : connectors), [showLinks, edges, connectors]);

  // Only drags of concepts are written back. Everything else the canvas wants to do is ignored.
  const conceptIds = new Set(concepts.map((c) => c.id));
  const onNodesChange = (changes: NodeChange[]) => {
    // Sizes first: keep every new measurement, so the next node objects carry it.
    let next: Map<string, NodeSize> | null = null;
    for (const ch of changes) {
      if (ch.type !== 'dimensions' || !ch.dimensions) continue;
      const width = Math.round(ch.dimensions.width);
      const height = Math.round(ch.dimensions.height);
      const had = (next ?? measured).get(ch.id);
      if (had && had.width === width && had.height === height) continue;
      next = next ?? new Map(measured);
      next.set(ch.id, { width, height });
    }
    if (next) setMeasured(next);

    for (const ch of changes) {
      if (ch.type === 'position' && ch.dragging === false && ch.position && conceptIds.has(ch.id)) {
        move(ch.id, ch.position.x, ch.position.y);
      }
    }
  };

  const onMoveEnd = useCallback((event: MouseEvent | TouchEvent | null, _viewport: Viewport) => {
    // A programmatic fitView reports a null event. Only a real gesture counts.
    if (event) viewportMoved.current = true;
  }, []);

  /** Concept sizes for dagre. Question cards are not concepts; their sizes would only confuse it. */
  const measuredSizes = useCallback((): Record<string, NodeSize> => {
    const sizes: Record<string, NodeSize> = {};
    for (const c of concepts) {
      const d = measured.get(c.id);
      if (d) sizes[c.id] = d;
    }
    return sizes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizesKey, topology]);

  // Fall back to the CSS default (layout.ts) for anything not painted yet.
  const runLayout = useCallback(
    async (ms: number, fit: boolean) => {
      await layoutTo(measuredSizes(), ms, fold.folded);
      if (fit) fitView({ padding: 0.25, maxZoom: 0.85, duration: 320 });
    },
    [measuredSizes, layoutTo, fitView, fold]
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
    // Every concept box measured. Question cards are on the canvas too and
    // are left out: counting them would mean this never passes.
    if (Object.keys(measuredSizes()).length !== concepts.length) return;

    laidOutFor.current = topology;
    void runLayout(concepts.length > ANIMATION_LIMIT ? 0 : LAYOUT_MS, !viewportMoved.current);
  }, [autoTidy, topology, concepts.length, measuredSizes, runLayout]);

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

  /*
   * RT-US-09. A click on a question's subject in the open questions panel
   * brings that concept into view and highlights it for a moment.
   */
  useEffect(() => {
    if (!focusConceptId) return;
    const node = getNode(focusConceptId);
    clearFocus();
    if (!node) return;
    const size = measured.get(focusConceptId);
    const w = size?.width ?? 220;
    const h = size?.height ?? 80;
    viewportMoved.current = true;
    void setCenter(node.position.x + w / 2, node.position.y + h / 2, { zoom: Math.max(getZoom(), 0.9), duration: 400 });
    setHighlight(focusConceptId);
    // A ref, not the effect's cleanup: clearFocus above re-runs this effect
    // at once, and a cleanup would cancel the timer before it fires.
    window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlight(''), HIGHLIGHT_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusConceptId, getNode, setCenter, getZoom, clearFocus]);

  useEffect(() => () => window.clearTimeout(highlightTimer.current), []);

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
      edges={shownEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onMoveEnd={onMoveEnd}
      // KVIF P9. A click on a box shows where it came from; a click on empty space closes it.
      onNodeClick={(_, node) => {
        if (node.type === 'concept') select(node.id);
      }}
      onPaneClick={() => select('')}
      className={[flash && !frame ? 'turn-flash' : '', frame ? 'replaying' : ''].filter(Boolean).join(' ')}
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
        <button
          className={`btn-tidy${replayTurn !== null ? ' btn-on' : ''}`}
          onClick={() => setReplay(replayTurn === null ? Math.max(1, model.turn - 1) : null)}
          disabled={model.turn < 2}
          title="Replay how the map grew, turn by turn"
        >
          History
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
