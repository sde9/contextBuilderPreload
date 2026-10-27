import type { Concept, Kind, Model } from './types';
import { answeredQuestions, keptQuestions, visibleConcepts } from './reducer';

/*
 * RT-US-14. The report a person takes away from a live session: one
 * self-contained HTML file, readable on screen and printable to A4.
 *
 * "What we covered" is built from the data, never written by the AI: the
 * confirmed concepts grouped by kind, each with its note, and one line of
 * counts. Nothing the person rejected appears anywhere, only its count.
 *
 * Every piece of text from the session is escaped. The map arrives as a PNG
 * data URL from the canvas (lib/snapshot.ts); without it the section says so.
 */

const GROUPS: { kind: Kind; title: string }[] = [
  { kind: 'ENTITY', title: 'Things' },
  { kind: 'ACTOR', title: 'People and roles' },
  { kind: 'STEP', title: 'Steps' },
  { kind: 'RULE', title: 'Rules' },
  { kind: 'ATTRIBUTE', title: 'Details' },
  { kind: 'PROBLEM', title: 'Problems' },
  { kind: 'CLAIM', title: 'Claims' },
];

export function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export type ReportCounts = { said: number; confirmed: number; rejected: number; answered: number; kept: number };

/** The count line under "What we covered". Exported for the smoke checks. */
export function reportCounts(m: Model): ReportCounts {
  const confirmed = visibleConcepts(m).filter((c) => c.status === 'VALIDATED');
  return {
    said: confirmed.filter((c) => c.origin !== 'INFERRED').length,
    confirmed: confirmed.filter((c) => c.origin === 'INFERRED').length,
    rejected: m.concepts.filter((c) => c.status === 'REJECTED' && c.kind !== 'QUESTION').length,
    answered: answeredQuestions(m).length,
    kept: keptQuestions(m).length,
  };
}

function coveredHtml(m: Model): string {
  const confirmed = visibleConcepts(m).filter((c) => c.status === 'VALIDATED' && c.kind !== 'QUESTION');
  const label = new Map(m.concepts.map((c) => [c.id, c.label]));
  const item = (c: Concept) => {
    const owner = c.belongsTo && label.get(c.belongsTo) ? ` <span class="of">of ${escapeHtml(label.get(c.belongsTo)!)}</span>` : '';
    const note = c.note ? `<div class="note">${escapeHtml(c.note)}</div>` : '';
    return `<li><strong>${escapeHtml(c.label)}</strong>${owner}${note}</li>`;
  };
  const groups = GROUPS.map(({ kind, title }) => {
    const items = confirmed.filter((c) => c.kind === kind);
    if (!items.length) return '';
    return `<h3>${title}</h3><ul class="covered">${items.map(item).join('')}</ul>`;
  }).join('');

  const n = reportCounts(m);
  const counts = [
    plural(n.said, 'thing said', 'things said'),
    plural(n.confirmed, 'guess confirmed', 'guesses confirmed'),
    `${n.rejected} rejected`,
    plural(n.answered, 'question answered', 'questions answered'),
    plural(n.kept, 'question kept', 'questions kept'),
  ].join(' · ');

  return `${groups || '<p class="empty">Nothing was confirmed in this session.</p>'}<p class="counts">${escapeHtml(counts)}</p>`;
}

function openQuestionsHtml(m: Model): string {
  const label = new Map(m.concepts.map((c) => [c.id, c.label]));
  const kept = keptQuestions(m);
  if (!kept.length) return '<p class="empty">No questions were kept for next time.</p>';
  const rows = kept
    .map((q) => {
      const about = q.anchorId && label.get(q.anchorId) ? escapeHtml(label.get(q.anchorId)!) : '';
      return `<tr><td>${escapeHtml(q.text)}${q.why ? `<div class="note">${escapeHtml(q.why)}</div>` : ''}</td><td>${about}</td></tr>`;
    })
    .join('');
  return `<table><thead><tr><th>Question</th><th>About</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function topicsHtml(m: Model): string {
  const topics = m.wrapup?.topics ?? [];
  if (!topics.length) return '<p class="empty">No topics this time.</p>';
  return `<ol class="topics">${topics
    .map((t) => `<li><strong>${escapeHtml(t.title)}</strong>${t.why ? `<div class="note">${escapeHtml(t.why)}</div>` : ''}</li>`)
    .join('')}</ol>`;
}

function mapHtml(png: string): string {
  // Only a PNG data URL goes into the src, so nothing else can be injected there.
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(png)) return '<p class="empty">The picture of the map could not be made.</p>';
  return `<img class="map" src="${png}" alt="The map at the end of the session" />`;
}

export function toReportHtml(m: Model, png: string, now = new Date()): string {
  const title = m.title && m.title !== 'Untitled session' ? m.title : 'Session report';
  const date = now.toISOString().slice(0, 10);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --green: #15803d; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 16px; font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: #fff; }
  main { max-width: 820px; margin: 0 auto; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  .meta { color: var(--muted); font-size: 13px; margin-bottom: 28px; }
  h2 { font-size: 18px; margin: 32px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  h3 { font-size: 14px; margin: 18px 0 6px; color: var(--green); text-transform: uppercase; letter-spacing: 0.04em; }
  .goal { font-size: 17px; margin: 0; }
  ul.covered, ol.topics { margin: 0; padding-left: 20px; }
  ul.covered li, ol.topics li { margin: 4px 0; }
  .of { color: var(--muted); font-weight: 400; }
  .note { color: var(--muted); font-size: 13.5px; }
  .counts { margin-top: 16px; font-size: 13px; color: var(--muted); }
  .empty { color: var(--muted); font-style: italic; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  td:last-child { width: 30%; color: var(--muted); }
  img.map { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 8px; }
  @page { size: A4; margin: 16mm; }
  @media print {
    body { padding: 0; font-size: 12.5px; }
    h2 { break-after: avoid; }
    tr, li { break-inside: avoid; }
    img.map { break-inside: avoid; max-height: 240mm; object-fit: contain; }
  }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">Context Builder · ${date} · ${plural(m.turn, 'turn', 'turns')}</div>

  <h2>Goal</h2>
  <p class="goal">${m.goal ? escapeHtml(m.goal) : '<span class="empty">No goal was set.</span>'}</p>

  <h2>What we covered</h2>
  ${coveredHtml(m)}

  <h2>Open questions</h2>
  ${openQuestionsHtml(m)}

  <h2>Topics to continue</h2>
  ${topicsHtml(m)}

  <h2>Map</h2>
  ${mapHtml(png)}
</main>
</body>
</html>
`;
}
