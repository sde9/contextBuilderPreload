'use client';

import { create } from 'zustand';
import type { Blocked, Model, SourceRole } from './types';
import { noBlocks, normaliseModel } from './types';
import type { Level } from './cluster';
import type { StoryMode } from './story';
import { MAX_FILES, MAX_UPLOAD_BYTES, UPLOAD_LIMIT, megabytes } from './limits';

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
  /** Files sent so far while a drop is being read. Zero total when idle. */
  uploading: { done: number; total: number };

  level: Level;
  openClusters: string[];
  selectedSources: string[];
  selectedConcept: string;

  /** The slider. Null step means the whole map, no story. */
  storyMode: StoryMode;
  storyStep: number | null;
  /** The questions panel on the right. */
  questionsOpen: boolean;

  /** Ask the server whether it has somewhere to keep runs. */
  checkHealth: () => Promise<void>;
  create: (files: File[], title: string) => Promise<void>;
  open: (runId: string) => Promise<void>;
  setRole: (sourceId: string, role: SourceRole) => Promise<void>;
  build: () => Promise<void>;
  resume: () => Promise<void>;

  /** Resolves with the server's answer, or null when the action failed. */
  act: (action: Record<string, unknown>) => Promise<Record<string, any> | null>;
  /** The QUESTION box whose answer is being read, "" when none. */
  answering: string;
  answer: (conceptId: string, text: string) => Promise<{ ok: boolean; answered: boolean }>;
  confirm: (conceptId: string) => Promise<void>;
  reject: (conceptId: string) => Promise<void>;
  split: (conceptId: string, absorbedId: string) => Promise<void>;
  resolve: (conceptId: string, choice: 'KEPT_FIRST' | 'KEPT_SECOND' | 'SPLIT') => Promise<void>;

  confirmRelationship: (relationshipId: string) => Promise<void>;
  rejectRelationship: (relationshipId: string) => Promise<void>;
  saveQuestion: (questionId: string) => Promise<void>;
  unsaveQuestion: (questionId: string) => Promise<void>;
  dismissQuestion: (questionId: string) => Promise<void>;
  addQuestion: (text: string, anchorId?: string) => Promise<void>;
  saveConceptQuestion: (conceptId: string) => Promise<void>;
  downloadQuestions: () => void;
  setStoryMode: (mode: StoryMode) => void;
  setStoryStep: (step: number | null) => void;
  toggleQuestions: (open?: boolean) => void;

  setLevel: (level: Level) => void;
  toggleCluster: (clusterId: string) => void;
  toggleSource: (sourceId: string) => void;
  select: (conceptId: string) => void;
  reset: () => void;
  download: () => void;
};

/*
 * Read a response that should be JSON and might not be. A hosted function
 * that times out or gets a body that is too large answers with a plain-text
 * or HTML page from the platform, and res.json() would hide that behind
 * "Unexpected token".
 */
async function readBody(res: Response): Promise<{ error?: string } & Record<string, any>> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    if (res.status === 413) return { error: `The server refused a file over ${UPLOAD_LIMIT}.` };
    if (res.status === 504) return { error: 'The server took too long on this step. Press Resume to try it again.' };
    return { error: `The server answered ${res.status}: ${text.slice(0, 160)}` };
  }
}

/*
 * Same fix as the live store (RT-US-15): the link is attached to the page and
 * the URL revoked later, so no browser opens the file in place of the map.
 */
function saveTextFile(filename: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1500);
}

function fileBase(title: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const safe = title.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'preload';
  return `${stamp}_${safe}`;
}

/** The saved questions as a list a person can print or paste, grouped by what they are about. */
export function questionsMarkdown(model: Model): string {
  const saved = model.questions.filter((q) => q.savedAt && q.status === 'OPEN');
  const label = new Map(model.concepts.map((c) => [c.id, c.label]));
  const lines = [`# Questions: ${model.title}`, '', `${saved.length} saved, ${new Date().toLocaleDateString()}`, ''];
  saved.forEach((q, i) => {
    lines.push(`${i + 1}. ${q.text}`);
    const about = q.anchorId ? label.get(q.anchorId) : '';
    if (about) lines.push(`   About: ${about}`);
    if (q.why) lines.push(`   Why: ${q.why}`);
  });
  return lines.join('\n') + '\n';
}

export const usePreload = create<State>((set, get) => ({
  model: null,
  screen: 'intake',
  busy: false,
  error: '',
  notes: [],
  blocked: noBlocks(),
  uploading: { done: 0, total: 0 },

  level: 1,
  openClusters: [],
  selectedSources: [],
  selectedConcept: '',
  storyMode: 'LOGIC',
  storyStep: null,
  questionsOpen: false,
  answering: '',

  checkHealth: async () => {
    try {
      const res = await fetch('/api/preload/health');
      const body = await readBody(res);
      if (!res.ok || !body.ok) set({ error: body.error || 'The server cannot keep runs right now.' });
    } catch {
      // Offline or the route is missing. The first upload will say what is wrong.
    }
  },

  /*
   * A new run, then its files one by one. One per request because a hosted
   * function refuses a body over 4.5 MB. In turn, not side by side, because
   * each upload adds its file to the run the previous one saved.
   */
  create: async (files, title) => {
    if (!files.length || get().busy) return;

    const tooBig = files.filter((f) => f.size > MAX_UPLOAD_BYTES);
    const toSend = files.filter((f) => f.size <= MAX_UPLOAD_BYTES).slice(0, MAX_FILES);
    const skipped: string[] = [
      ...tooBig.map((f) => `${f.name} (${megabytes(f.size)}, over the ${UPLOAD_LIMIT} limit)`),
      ...files.filter((f) => f.size <= MAX_UPLOAD_BYTES).slice(MAX_FILES).map((f) => `${f.name} (over ${MAX_FILES} files)`),
    ];

    set({ busy: true, error: '', notes: [], uploading: { done: 0, total: toSend.length } });
    try {
      if (!toSend.length) throw new Error(`Nothing to upload. Skipped: ${skipped.join('; ')}.`);

      const res = await fetch('/api/preload/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      const body = await readBody(res);
      if (!res.ok) throw new Error(body.error || 'Could not start a run');

      const runId: string = body.model.run.id;
      set({ model: normaliseModel(body.model), screen: 'intake' });
      // Keep the run id in the address bar so a reload comes back here.
      if (typeof window !== 'undefined') window.history.replaceState(null, '', `?run=${runId}`);

      for (const [i, file] of toSend.entries()) {
        const form = new FormData();
        form.append('file', file);
        const up = await fetch(`/api/preload/run/${runId}/files`, { method: 'POST', body: form });
        const upBody = await readBody(up);
        if (up.ok) set({ model: normaliseModel(upBody.model) });
        else skipped.push(`${file.name} (${upBody.error || `error ${up.status}`})`);
        set({ uploading: { done: i + 1, total: toSend.length } });
      }

      if (skipped.length) set({ error: `Not added: ${skipped.join('; ')}.` });
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ busy: false, uploading: { done: 0, total: 0 } });
    }
  },

  open: async (runId) => {
    set({ busy: true, error: '' });
    try {
      const res = await fetch(`/api/preload/run/${runId}`);
      const body = await readBody(res);
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
        const body = await readBody(res);
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
      const body = await readBody(res);
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
    if (!model?.run) return null;
    try {
      const res = await fetch('/api/preload/act', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: model.run.id, action }),
      });
      const body = await readBody(res);
      if (!res.ok) throw new Error(body.error || 'That did not go through');
      set({ model: normaliseModel(body.model) });
      return body;
    } catch (e) {
      set({ error: (e as Error).message });
      return null;
    }
  },

  answer: async (conceptId, text) => {
    const trimmed = text.trim();
    if (!trimmed || get().answering) return { ok: false, answered: false };
    set({ answering: conceptId, error: '' });
    try {
      const body = await get().act({ kind: 'answer', conceptId, text: trimmed });
      if (!body) return { ok: false, answered: false };
      const answered = Boolean(body.outcome?.answered);
      if (answered && get().selectedConcept === conceptId) set({ selectedConcept: '' });
      return { ok: true, answered };
    } finally {
      set({ answering: '' });
    }
  },

  confirm: async (conceptId) => {
    await get().act({ kind: 'confirm', conceptId });
  },
  reject: async (conceptId) => {
    if (get().selectedConcept === conceptId) set({ selectedConcept: '' });
    await get().act({ kind: 'reject', conceptId });
  },
  split: async (conceptId, absorbedId) => {
    await get().act({ kind: 'split', conceptId, absorbedId });
  },
  resolve: async (conceptId, choice) => {
    await get().act({ kind: 'resolve', conceptId, choice });
  },
  confirmRelationship: async (relationshipId) => {
    await get().act({ kind: 'confirm-rel', relationshipId });
  },
  rejectRelationship: async (relationshipId) => {
    await get().act({ kind: 'reject-rel', relationshipId });
  },
  saveQuestion: async (questionId) => {
    await get().act({ kind: 'question-save', questionId });
  },
  unsaveQuestion: async (questionId) => {
    await get().act({ kind: 'question-unsave', questionId });
  },
  dismissQuestion: async (questionId) => {
    await get().act({ kind: 'question-dismiss', questionId });
  },
  addQuestion: async (text, anchorId) => {
    await get().act({ kind: 'question-add', text, anchorId: anchorId ?? '' });
  },
  saveConceptQuestion: async (conceptId) => {
    await get().act({ kind: 'question-from-concept', conceptId });
  },
  downloadQuestions: () => {
    const m = get().model;
    if (!m) return;
    saveTextFile(`${fileBase(m.title)}.questions.md`, 'text/markdown', questionsMarkdown(m));
  },
  setStoryMode: (storyMode) => set({ storyMode, storyStep: get().storyStep === null ? null : 0 }),
  setStoryStep: (storyStep) => set({ storyStep }),
  toggleQuestions: (open) =>
    set((s) => {
      const next = open ?? !s.questionsOpen;
      return { questionsOpen: next, selectedConcept: next ? '' : s.selectedConcept };
    }),

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
  select: (conceptId) =>
    set((s) => ({
      selectedConcept: s.selectedConcept === conceptId ? '' : conceptId,
      questionsOpen: s.selectedConcept === conceptId ? s.questionsOpen : false,
    })),

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
      storyStep: null,
      questionsOpen: false,
    });
  },

  download: () => {
    const m = get().model;
    if (!m) return;
    saveTextFile(`${fileBase(m.title)}.context.json`, 'application/json', JSON.stringify(m, null, 2));
  },
}));
