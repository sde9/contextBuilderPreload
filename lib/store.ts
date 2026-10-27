'use client';

import { create } from 'zustand';
import type { Blocked, Model } from './types';
import { addBlocks, emptyModel, newId, noBlocks } from './types';
import {
  answerPayload,
  applyAnswer,
  applyAutoLayout,
  applyExtract,
  applyPropose,
  confirmConcept,
  confirmRelationship,
  contextPayload,
  dismissQuestion,
  moveConcept,
  rejectConcept,
  rejectRelationship,
  setGoal,
  withCallMeta,
} from './reducer';
import { AnswerPatch, ExtractPatch, ProposePatchRT } from './schema';
import type { NodeSize } from './layout';
import { toDrawioXml, toMermaid } from './export';
import { saveDataUrl, saveText } from './download';
import { clearSession, parseSessionFile } from './persist';

/** Most new questions per turn in a live session (RT-US-03). */
const QUESTION_CAP = Number(process.env.NEXT_PUBLIC_QUESTION_CAP) || 2;

export type Phase = 'idle' | 'reading' | 'thinking';

type State = {
  model: Model;
  phase: Phase;
  pending: string; // the statement being processed, shown greyed
  error: string;
  /** Off means Call 2 never fires. The escape hatch if proposals go bad live. */
  suggestions: boolean;
  /** Off means the map only re-arranges when Tidy up is pressed. */
  autoTidy: boolean;
  lastMs: { extract: number; propose: number };
  blocked: Blocked;

  submit: (text: string) => Promise<void>;
  /**
   * Answer a QUESTION box on the map. The answer is read, the map changes to
   * match it, and then the usual proposal call runs. Resolves false when the
   * answer could not be read, so the box keeps what was typed.
   */
  answerQuestion: (questionId: string, text: string) => Promise<{ ok: boolean; answered: boolean }>;
  setGoal: (text: string) => void;
  /** Replace the session with one restored from this browser or from a file. */
  restore: (model: Model) => void;
  openFile: (file: File) => Promise<void>;
  /** Set by the canvas, which is the only place that can draw the map. */
  capture: (() => Promise<string>) | null;
  registerCapture: (fn: (() => Promise<string>) | null) => void;
  exportPicture: () => Promise<void>;
  confirm: (id: string) => void;
  reject: (id: string) => void;
  confirmRelationship: (id: string) => void;
  rejectRelationship: (id: string) => void;
  move: (id: string, x: number, y: number) => void;
  autoLayout: (sizes?: Record<string, NodeSize>) => void;
  /** Same layout, animated. Resolves once every node has landed. */
  layoutTo: (sizes?: Record<string, NodeSize>, ms?: number) => Promise<void>;
  dismiss: (id: string) => void;
  toggleSuggestions: () => void;
  toggleAutoTidy: () => void;
  reset: () => void;
  download: () => void;
  exportDrawio: () => void;
  exportMermaid: () => void;
};

function filenameBase(m: Model): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const safe = m.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'session';
  return `${stamp}_${safe}`;
}

type CallBody = { ms?: number; usage?: { input: number; output: number } | null; model?: string };

const metaOf = (body: CallBody) => ({ model: body.model ?? '', ms: body.ms ?? 0, usage: body.usage ?? null });

/*
 * One animation at a time. A second layout request cancels the first rather
 * than interleaving with it, so a fast turn cannot leave nodes half-way.
 */
let frame: number | null = null;

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

export const useSession = create<State>((set, get) => {
  /*
   * Phase 2 of a turn, shared by the composer and by an answer on the map:
   * what is missing, given what the map now holds. Silent on failure.
   */
  const proposeAfter = async (after: Model, latest: string): Promise<void> => {
    if (!get().suggestions) {
      set({ phase: 'idle', pending: '' });
      return;
    }
    set({ phase: 'thinking' });
    try {
      const res = await fetch('/api/propose', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(contextPayload(after)),
      });

      const body = await res.json();
      if (res.ok && body.patch) {
        const patch = ProposePatchRT.parse(body.patch);
        const applied = applyPropose(get().model, patch, Number(process.env.NEXT_PUBLIC_PROPOSAL_CAP) || 5, {
          questionCap: QUESTION_CAP,
          latestStatement: latest,
        });
        set((s) => ({
          model: withCallMeta(applied.model, 'propose', metaOf(body)),
          blocked: addBlocks(s.blocked, applied.blocked),
          lastMs: { ...s.lastMs, propose: body.ms ?? 0 },
        }));
      }
    } catch {
      // Deliberately silent. No orange this turn, and nobody in the room notices.
    } finally {
      set({ phase: 'idle', pending: '' });
    }
  };

  return {
  model: emptyModel(newId('s')),
  phase: 'idle',
  pending: '',
  error: '',
  suggestions: true,
  autoTidy: true,
  lastMs: { extract: 0, propose: 0 },
  blocked: noBlocks(),
  capture: null,

  /*
   * The two-phase turn.
   *
   *   t+0     the statement appears greyed, composer clears
   *   t+~1s   Call 1 returns, green nodes land          <- this sells the tool
   *   t+~3s   Call 2 returns, orange nodes land
   *
   * Perceived latency is phase one only. The user is already reading their own
   * words as structure while the AI is still thinking about what is missing.
   */
  submit: async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || get().phase !== 'idle') return;

    set({ phase: 'reading', pending: trimmed, error: '' });

    // ---- Phase 1: what was said
    let afterExtract: Model;
    try {
      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: trimmed,
          concepts: contextPayload(get().model).concepts,
        }),
      });

      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Extract failed (${res.status})`);

      const patch = ExtractPatch.parse(body.patch);
      const applied = applyExtract(get().model, patch, trimmed);
      afterExtract = withCallMeta(applied.model, 'extract', metaOf(body));

      set((s) => ({
        model: afterExtract,
        blocked: applied.blocked,
        lastMs: { ...s.lastMs, extract: body.ms ?? 0 },
      }));
    } catch (e) {
      // The input is never lost. It goes back in the composer.
      set({ phase: 'idle', pending: '', error: (e as Error).message });
      return;
    }

    await proposeAfter(afterExtract, trimmed);
  },

  answerQuestion: async (questionId, text) => {
    const trimmed = text.trim();
    if (!trimmed || get().phase !== 'idle') return { ok: false, answered: false };
    const input = answerPayload(get().model, questionId, trimmed);
    if (!input) return { ok: false, answered: false };

    set({ phase: 'reading', pending: trimmed, error: '' });

    let afterAnswer: Model;
    let answered = false;
    try {
      const res = await fetch('/api/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Could not read the answer (${res.status})`);

      const patch = AnswerPatch.parse(body.patch);
      const applied = applyAnswer(get().model, questionId, trimmed, patch);
      afterAnswer = withCallMeta(applied.model, 'answer', metaOf(body));
      answered = applied.answered;
      set((s) => ({
        model: afterAnswer,
        blocked: applied.blocked,
        lastMs: { ...s.lastMs, extract: body.ms ?? 0 },
      }));
    } catch (e) {
      set({ phase: 'idle', pending: '', error: (e as Error).message });
      return { ok: false, answered: false };
    }

    await proposeAfter(afterAnswer, trimmed);
    return { ok: true, answered };
  },

  confirm: (id) => set((s) => ({ model: confirmConcept(s.model, id) })),
  reject: (id) => set((s) => ({ model: rejectConcept(s.model, id) })),
  confirmRelationship: (id) => set((s) => ({ model: confirmRelationship(s.model, id) })),
  rejectRelationship: (id) => set((s) => ({ model: rejectRelationship(s.model, id) })),
  move: (id, x, y) => set((s) => ({ model: moveConcept(s.model, id, x, y) })),
  autoLayout: (sizes) => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    set((s) => ({ model: applyAutoLayout(s.model, sizes) }));
  },

  /*
   * The whole map moves at once, so the movement has to be readable. Nodes
   * are tweened in the model rather than in React Flow's store, which keeps
   * the canvas a pure projection (see Canvas.tsx) and means edges follow the
   * boxes instead of snapping to the end state.
   *
   * Targets are captured once, up front. If a node arrives mid-flight it is
   * simply left where placement put it and picked up by the next layout.
   */
  layoutTo: (sizes, ms = 400) => {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }

    const start = new Map(get().model.concepts.map((c) => [c.id, { x: c.x, y: c.y }]));
    const target = applyAutoLayout(get().model, sizes);
    const end = new Map(target.concepts.map((c) => [c.id, { x: c.x, y: c.y }]));

    const settle = () =>
      set((s) => ({
        model: {
          ...s.model,
          concepts: s.model.concepts.map((c) => {
            const to = end.get(c.id);
            return to ? { ...c, x: to.x, y: to.y, pinned: false } : c;
          }),
        },
      }));

    const moved = [...end].some(([id, to]) => {
      const from = start.get(id);
      return !from || Math.abs(from.x - to.x) > 1 || Math.abs(from.y - to.y) > 1;
    });

    if (!moved || ms <= 0 || typeof window === 'undefined' || prefersReducedMotion()) {
      settle();
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / ms);
        if (t >= 1) {
          frame = null;
          settle();
          resolve();
          return;
        }
        const e = easeOutCubic(t);
        set((s) => ({
          model: {
            ...s.model,
            concepts: s.model.concepts.map((c) => {
              const from = start.get(c.id);
              const to = end.get(c.id);
              if (!from || !to) return c;
              return {
                ...c,
                x: Math.round(from.x + (to.x - from.x) * e),
                y: Math.round(from.y + (to.y - from.y) * e),
                pinned: false,
              };
            }),
          },
        }));
        frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    });
  },
  dismiss: (id) => set((s) => ({ model: dismissQuestion(s.model, id) })),
  toggleSuggestions: () => set((s) => ({ suggestions: !s.suggestions })),
  toggleAutoTidy: () => set((s) => ({ autoTidy: !s.autoTidy })),
  reset: () => {
    clearSession();
    set({ model: emptyModel(newId('s')), phase: 'idle', pending: '', error: '', blocked: noBlocks() });
  },

  setGoal: (text) => set((s) => ({ model: setGoal(s.model, text) })),

  restore: (model) => set({ model, phase: 'idle', pending: '', error: '', blocked: noBlocks() }),

  openFile: async (file) => {
    try {
      const model = parseSessionFile(await file.text());
      set({ model, phase: 'idle', pending: '', error: '', blocked: noBlocks() });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  registerCapture: (fn) => set({ capture: fn }),

  exportPicture: async () => {
    const capture = get().capture;
    if (!capture) return;
    try {
      const dataUrl = await capture();
      saveDataUrl(`${filenameBase(get().model)}.png`, dataUrl);
    } catch {
      set({ error: 'Could not make a picture of the map. Try again after Tidy up.' });
    }
  },

  download: () => {
    const m = get().model;
    saveText(`${filenameBase(m)}.context.json`, 'application/json', JSON.stringify(m, null, 2));
  },

  exportDrawio: () => {
    const m = get().model;
    saveText(`${filenameBase(m)}.drawio`, 'application/xml', toDrawioXml(m));
  },

  exportMermaid: () => {
    const m = get().model;
    saveText(`${filenameBase(m)}.mmd`, 'text/plain', toMermaid(m));
  },
};
});
