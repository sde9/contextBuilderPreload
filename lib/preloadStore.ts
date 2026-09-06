'use client';

import { create } from 'zustand';
import type { Blocked, Model, SourceRole } from './types';
import { noBlocks, normaliseModel } from './types';
import type { Level } from './cluster';

/*
 * The preload client.
 *
 * It holds no model logic. Every change goes to the server, which runs the
 * same pure reducers the offline test drives, and the answer comes back as a
 * whole model. That is slower per click than mutating locally, and it is the
 * only way a decision survives a reload (R4).
 */

export type Screen = 'intake' | 'building' | 'map';

type State = {
  model: Model | null;
  screen: Screen;
  busy: boolean;
  error: string;
  /** Every note the run has produced, newest last. The progress screen. */
  notes: string[];
  blocked: Blocked;

  level: Level;
  openClusters: string[];
  selectedSources: string[];
  selectedConcept: string;

  create: (files: File[], title: string) => Promise<void>;
  open: (runId: string) => Promise<void>;
  setRole: (sourceId: string, role: SourceRole) => Promise<void>;
  build: () => Promise<void>;
  resume: () => Promise<void>;

  act: (action: Record<string, unknown>) => Promise<void>;
  confirm: (conceptId: string) => Promise<void>;
  reject: (conceptId: string) => Promise<void>;
  split: (conceptId: string, absorbedId: string) => Promise<void>;
  resolve: (conceptId: string, choice: 'KEPT_FIRST' | 'KEPT_SECOND' | 'SPLIT') => Promise<void>;

  setLevel: (level: Level) => void;
  toggleCluster: (clusterId: string) => void;
  toggleSource: (sourceId: string) => void;
  select: (conceptId: string) => void;
  reset: () => void;
  download: () => void;
};

function saveTextFile(filename: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export const usePreload = create<State>((set, get) => ({
  model: null,
  screen: 'intake',
  busy: false,
  error: '',
  notes: [],
  blocked: noBlocks(),

  level: 1,
  openClusters: [],
  selectedSources: [],
  selectedConcept: '',

  create: async (files, title) => {
    if (!files.length || get().busy) return;
    set({ busy: true, error: '', notes: [] });
    try {
      const form = new FormData();
      form.append('title', title);
      for (const f of files) form.append('files', f);

      const res = await fetch('/api/preload/run', { method: 'POST', body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not read the files');

      set({ model: normaliseModel(body.model), screen: 'intake' });
      // Keep the run id in the address bar so a reload comes back here.
      if (typeof window !== 'undefined' && body.model?.run?.id) {
        window.history.replaceState(null, '', `?run=${body.model.run.id}`);
      }
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  open: async (runId) => {
    set({ busy: true, error: '' });
    try {
      const res = await fetch(`/api/preload/run/${runId}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not open that run');
      const model = normaliseModel(body.model);
      const stage = model.run?.stage ?? 'IDLE';
      set({
        model,
        screen: stage === 'READY' ? 'map' : stage === 'IDLE' ? 'intake' : 'building',
      });
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  setRole: async (sourceId, role) => {
    const model = get().model;
    if (!model?.run) return;
    // Optimistic: this is the user's own answer, not the model's.
    set({
      model: {
        ...model,
        sources: model.sources.map((s) => (s.id === sourceId ? { ...s, role } : s)),
      },
    });
    await get().act({ kind: 'role', sourceId, role });
  },

  /*
   * The loop. One request per unit of work, so the screen can say what is
   * happening rather than showing a bar that means nothing.
   */
  build: async () => {
    const model = get().model;
    if (!model?.run || get().busy) return;
    set({ screen: 'building', busy: true, error: '', notes: [] });

    const runId = model.run.id;
    let guard = 0;

    try {
      for (;;) {
        if (guard++ > 120) throw new Error('The run took too many steps and was stopped.');

        const res = await fetch('/api/preload/step', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runId }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'A step failed');

        const next = normaliseModel(body.model);
        set((s) => ({
          model: next,
          notes: body.note ? [...s.notes, body.note] : s.notes,
          blocked: body.blocked ?? s.blocked,
        }));

        const stage = next.run?.stage;
        if (stage === 'READY') {
          set({ screen: 'map', level: 1 });
          return;
        }
        if (stage === 'FAILED') {
          set({ error: `${next.run?.failedStage}: ${next.run?.failedWhy}` });
          return;
        }
      }
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  resume: async () => {
    const model = get().model;
    if (!model?.run) return;
    set({ busy: true, error: '' });
    try {
      const res = await fetch('/api/preload/step', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: model.run.id, resume: true }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not resume');
      set({ model: normaliseModel(body.model) });
    } catch (e) {
      set({ error: (e as Error).message });
      return;
    } finally {
      set({ busy: false });
    }
    await get().build();
  },

  act: async (action) => {
    const model = get().model;
    if (!model?.run) return;
    try {
      const res = await fetch('/api/preload/act', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: model.run.id, action }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'That did not go through');
      set({ model: normaliseModel(body.model) });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  confirm: async (conceptId) => get().act({ kind: 'confirm', conceptId }),
  reject: async (conceptId) => {
    if (get().selectedConcept === conceptId) set({ selectedConcept: '' });
    await get().act({ kind: 'reject', conceptId });
  },
  split: async (conceptId, absorbedId) => get().act({ kind: 'split', conceptId, absorbedId }),
  resolve: async (conceptId, choice) => get().act({ kind: 'resolve', conceptId, choice }),

  setLevel: (level) => set({ level, openClusters: level === 3 ? [] : get().openClusters }),
  toggleCluster: (clusterId) =>
    set((s) => ({
      openClusters: s.openClusters.includes(clusterId)
        ? s.openClusters.filter((c) => c !== clusterId)
        : [...s.openClusters, clusterId],
    })),
  toggleSource: (sourceId) =>
    set((s) => ({
      selectedSources: s.selectedSources.includes(sourceId)
        ? s.selectedSources.filter((c) => c !== sourceId)
        : [...s.selectedSources, sourceId],
    })),
  select: (conceptId) => set((s) => ({ selectedConcept: s.selectedConcept === conceptId ? '' : conceptId })),

  reset: () => {
    if (typeof window !== 'undefined') window.history.replaceState(null, '', window.location.pathname);
    set({
      model: null,
      screen: 'intake',
      notes: [],
      error: '',
      blocked: noBlocks(),
      level: 1,
      openClusters: [],
      selectedSources: [],
      selectedConcept: '',
    });
  },

  download: () => {
    const m = get().model;
    if (!m) return;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const safe = m.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'preload';
    saveTextFile(`${stamp}_${safe}.context.json`, 'application/json', JSON.stringify(m, null, 2));
  },
}));
