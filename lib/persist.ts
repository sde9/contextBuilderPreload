'use client';

import type { Model } from './types';
import { normaliseModel } from './types';

/*
 * The live session, kept in this browser so a closed or reloaded tab does not
 * lose a meeting (RT-US-16).
 *
 * Browser storage can be missing, full or blocked (private windows, strict
 * settings), so every call is wrapped and a failure means "nothing saved",
 * never an error on screen. Each Vercel preview URL is its own origin and
 * keeps its own copy; the production URL keeps one too.
 */

const KEY = 'cb.realtime.session.v1';

export type SavedSession = { savedAt: string; model: Model };

export function saveSession(model: Model): void {
  try {
    const value: SavedSession = { savedAt: new Date().toISOString(), model };
    window.localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Storage unavailable or full. The session still runs; it just is not kept.
  }
}

export function loadSession(): SavedSession | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedSession>;
    if (!parsed?.model || !Array.isArray(parsed.model.concepts)) return null;
    return { savedAt: parsed.savedAt ?? '', model: normaliseModel(parsed.model) };
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

/**
 * Read a downloaded .context.json. Throws a short, readable message when the
 * file is not a session, so the composer can show it.
 */
export function parseSessionFile(text: string): Model {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('That file is not a session file (it is not valid JSON).');
  }
  const m = raw as Partial<Model> | null;
  if (!m || typeof m !== 'object' || !Array.isArray(m.concepts)) {
    throw new Error('That file is not a Context Builder session.');
  }
  return normaliseModel(m);
}
