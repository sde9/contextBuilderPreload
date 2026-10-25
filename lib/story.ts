import type { Concept, Excerpt, Model, Relationship } from './types';
import { activeOutline, liveId } from './outline';

/*
 * The story behind the slider: the same map, revealed step by step.
 *
 * Two orders, both built from what the map already holds, so the story never
 * says anything the map does not:
 *
 *   LOGIC    the way the document is built: its main point, then each part
 *            in reading order with what it contains. A map with no outline
 *            falls back to its areas, earliest written first.
 *   WRITTEN  the order the sentences appear in the documents, section by
 *            section, or turn by turn in a live session.
 *
 * Either way, what the AI guessed comes last, in a step of its own, so the
 * line of thought is the documents' and the guesses read as additions.
 *
 * Pure. No React. Driven by scripts/smoke-preload.ts.
 */

export type StoryMode = 'LOGIC' | 'WRITTEN';

export type StoryStep = {
  key: string;
  title: string;
  /** A sentence that grounds the step, verbatim from its evidence. "" when none. */
  quote: string;
  locator: string;
  conceptIds: string[];
};

export type Story = { mode: StoryMode; steps: StoryStep[] };

function visible(c: Concept): boolean {
  return c.status !== 'REJECTED' && !c.absorbedInto;
}

const isGuess = (c: Concept) => c.status === 'PROPOSED';

/** Where a concept first appears in the documents: source order, then section order. */
function writtenPosition(model: Model, concept: Concept, excerpts: Map<string, Excerpt>): { key: string; rank: number; excerpt: Excerpt | null; turn: number } {
  const sourceRank = new Map(model.sources.map((s, i) => [s.id, i]));
  let best: { rank: number; excerpt: Excerpt } | null = null;
  for (const id of concept.evidence) {
    const e = excerpts.get(id);
    if (!e) continue;
    const rank = (sourceRank.get(e.sourceId) ?? 99) * 100000 + (e.ord ?? e.turn);
    if (!best || rank < best.rank) best = { rank, excerpt: e };
  }
  if (best) return { key: `${best.excerpt.sourceId}|${best.excerpt.ord ?? best.excerpt.turn}`, rank: best.rank, excerpt: best.excerpt, turn: 0 };
  // A skeleton item the outline could not quote still has a place: the main
  // point opens its document, a part opens its first section.
  if (concept.skeleton) {
    for (const o of model.outlines ?? []) {
      if (liveId(model, o.mainId) === concept.id) {
        const first = [...excerpts.values()].filter((e) => e.sourceId === o.sourceId).sort((a, b) => (a.ord ?? a.turn) - (b.ord ?? b.turn))[0];
        if (first) return { key: `${first.sourceId}|${first.ord ?? first.turn}`, rank: (sourceRank.get(o.sourceId) ?? 99) * 100000 - 1, excerpt: first, turn: 0 };
      }
      const owned = Object.entries(o.sections).filter(([, partId]) => liveId(model, partId) === concept.id).map(([chunkId]) => chunkId);
      if (!owned.length) continue;
      const first = [...excerpts.values()].filter((e) => owned.includes(e.chunkId)).sort((a, b) => (a.ord ?? a.turn) - (b.ord ?? b.turn))[0];
      if (first) {
        return { key: `${first.sourceId}|${first.ord ?? first.turn}`, rank: (sourceRank.get(first.sourceId) ?? 99) * 100000 + (first.ord ?? first.turn), excerpt: first, turn: 0 };
      }
    }
  }
  // Said aloud in a live session: order by the turn it was first said.
  const statements = model.statements.filter((s) => concept.evidence.includes(s.id));
  if (statements.length) {
    const first = statements.reduce((a, b) => (a.turn <= b.turn ? a : b));
    return { key: `turn|${first.turn}`, rank: 1e9 + first.turn, excerpt: null, turn: first.turn };
  }
  return { key: '', rank: Infinity, excerpt: null, turn: 0 };
}

const firstLine = (text: string, max = 180) => {
  const line = text.split('\n').find((l) => l.trim() && !/^#{1,6}\s/.test(l)) ?? text.split('\n')[0] ?? '';
  const clean = line.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

function guessesStep(guesses: Concept[]): StoryStep[] {
  if (!guesses.length) return [];
  return [
    {
      key: 'guesses',
      title: 'What the AI thinks is missing',
      quote: '',
      locator: '',
      conceptIds: guesses.map((c) => c.id),
    },
  ];
}

function writtenStory(model: Model, shown: Concept[]): StoryStep[] {
  const excerpts = new Map(model.excerpts.map((e) => [e.id, e]));
  const groups = new Map<string, { rank: number; excerpt: Excerpt | null; turn: number; ids: string[] }>();
  const guesses: Concept[] = [];
  const multiSource = model.sources.length > 1;

  for (const c of shown) {
    const pos = writtenPosition(model, c, excerpts);
    if (!pos.key || (isGuess(c) && !pos.excerpt && !pos.turn)) {
      guesses.push(c);
      continue;
    }
    const g = groups.get(pos.key) ?? { rank: pos.rank, excerpt: pos.excerpt, turn: pos.turn, ids: [] };
    g.ids.push(c.id);
    groups.set(pos.key, g);
  }

  const nameOf = new Map(model.sources.map((s) => [s.id, s.name]));
  const steps = [...groups.entries()]
    .sort((a, b) => a[1].rank - b[1].rank)
    .map(([key, g]) => {
      if (g.excerpt) {
        const where = g.excerpt.locator || 'section';
        return {
          key,
          title: multiSource ? `${nameOf.get(g.excerpt.sourceId) ?? ''} · ${where}` : where,
          quote: firstLine(g.excerpt.quote),
          locator: g.excerpt.locator,
          conceptIds: g.ids,
        };
      }
      const said = model.statements.find((s) => s.turn === g.turn);
      return { key, title: `Turn ${g.turn}`, quote: said ? firstLine(said.text) : '', locator: '', conceptIds: g.ids };
    });

  return [...steps, ...guessesStep(guesses)];
}

/** The sentence a skeleton concept cites, when it cites one. */
function citedLine(model: Model, concept: Concept | undefined): { quote: string; locator: string } {
  if (!concept) return { quote: '', locator: '' };
  const e = model.excerpts.find((x) => concept.evidence.includes(x.id));
  return e ? { quote: firstLine(e.quote), locator: e.locator } : { quote: concept.note, locator: '' };
}

function logicStory(model: Model, shown: Concept[]): StoryStep[] {
  const shownIds = new Set(shown.map((c) => c.id));
  const byId = new Map(model.concepts.map((c) => [c.id, c]));
  const outline = activeOutline(model);
  const guesses = shown.filter((c) => isGuess(c) && !c.skeleton);
  const used = new Set<string>(guesses.map((c) => c.id));
  const steps: StoryStep[] = [];

  if (outline) {
    const main = outline.mainId ? byId.get(outline.mainId) : undefined;
    if (main && shownIds.has(main.id)) {
      steps.push({ key: `main`, title: 'Main point', ...citedLine(model, main), conceptIds: [main.id] });
      used.add(main.id);
    }
    const clusterOfPart = new Map<string, string>();
    for (const cl of model.clusters) {
      for (const pid of outline.partIds) if (cl.memberIds.includes(pid)) clusterOfPart.set(pid, cl.id);
    }
    outline.partIds.forEach((pid, i) => {
      const part = byId.get(pid);
      if (!part) return;
      const clusterId = clusterOfPart.get(pid) ?? part.clusterId;
      const ids = [pid, ...shown.filter((c) => c.id !== pid && c.clusterId && c.clusterId === clusterId).map((c) => c.id)].filter(
        (id) => shownIds.has(id) && !used.has(id)
      );
      if (!ids.length) return;
      ids.forEach((id) => used.add(id));
      steps.push({ key: `part|${pid}`, title: `${i + 1}. ${part.label}`, ...citedLine(model, part), conceptIds: ids });
    });
  } else {
    // No skeleton: the areas, earliest written first, as the line of thought.
    const excerpts = new Map(model.excerpts.map((e) => [e.id, e]));
    const areas = model.clusters
      .map((cl) => {
        const members = shown.filter((c) => c.clusterId === cl.id && !used.has(c.id));
        const rank = Math.min(...members.map((c) => writtenPosition(model, c, excerpts).rank), Infinity);
        return { cl, members, rank };
      })
      .filter((a) => a.members.length)
      .sort((a, b) => a.rank - b.rank);
    for (const a of areas) {
      a.members.forEach((c) => used.add(c.id));
      const lead = a.members.find((c) => c.tier === 2) ?? a.members[0];
      steps.push({ key: `area|${a.cl.id}`, title: a.cl.label, ...citedLine(model, lead), conceptIds: a.members.map((c) => c.id) });
    }
  }

  // Anything not placed yet, in written order, before the guesses.
  const rest = shown.filter((c) => !used.has(c.id));
  if (rest.length) {
    const tail = writtenStory(model, rest).filter((s) => s.key !== 'guesses');
    steps.push(...tail);
  }
  return [...steps, ...guessesStep(guesses)];
}

export function buildStory(model: Model, mode: StoryMode, shown?: Concept[]): Story {
  const live = (shown ?? model.concepts).filter(visible);
  return { mode, steps: mode === 'LOGIC' ? logicStory(model, live) : writtenStory(model, live) };
}

/** Concept id -> step index (0-based). */
export function stepIndex(story: Story): Map<string, number> {
  const out = new Map<string, number>();
  story.steps.forEach((s, i) => {
    for (const id of s.conceptIds) if (!out.has(id)) out.set(id, i);
  });
  return out;
}

export type Reveal = 'past' | 'current' | 'future';

/** How a concept is drawn at a step. Null step means the story is off. */
export function revealOf(index: Map<string, number>, id: string, step: number | null): Reveal | null {
  if (step === null) return null;
  const i = index.get(id);
  if (i === undefined) return 'past';
  return i < step ? 'past' : i === step ? 'current' : 'future';
}

/** An edge appears when both its ends have; it is current when it arrives with this step. */
export function revealOfEdge(index: Map<string, number>, r: Pick<Relationship, 'from' | 'to'>, step: number | null): Reveal | null {
  if (step === null) return null;
  const a = index.get(r.from) ?? -1;
  const b = index.get(r.to) ?? -1;
  const at = Math.max(a, b);
  return at < step ? 'past' : at === step ? 'current' : 'future';
}

/** Re-export for callers that only need to resolve merged skeleton ids. */
export { liveId };
