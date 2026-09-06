import type { Kind, Model } from './types';
import { visibleConcepts, visibleRelationships } from './reducer';
import { KIND_DEFAULT_SIZE } from './layout';

/*
 * Two static, no-dependency exports of the same map, for tools this app will
 * never talk to directly.
 *
 * draw.io reads x/y straight off the model, so what you exported is what you
 * saw. Mermaid carries no coordinates at all: whatever opens the .mmd lays it
 * out itself, which is why a Miro import can look tidier than the canvas did.
 *
 * Green/orange carries over as validated/proposed styling in both formats —
 * losing status on the way out would make the export a worse map than the
 * one on screen, not just a differently-shaped one. Kind carries over as
 * shape, the same way it does on the canvas.
 */

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const DRAWIO_STYLE = {
  validated: { fill: '#f0fdf4', stroke: '#15803d', font: '#14532d' },
  proposed: { fill: '#fff7ed', stroke: '#ea7317', font: '#9a3412' },
  // Losing "two sources disagree" on the way out would make the export a
  // worse map than the one on screen, not just a differently shaped one.
  contested: { fill: '#fef2f2', stroke: '#dc2626', font: '#991b1b' },
} as const;

const DRAWIO_ACCENT: Partial<Record<Kind, string>> = {
  QUESTION: '#7c3aed',
  PROBLEM: '#dc2626',
};

/** The shape fragment of a draw.io style string. Colour and dash come separately. */
function drawioShape(kind: Kind): string {
  switch (kind) {
    case 'ACTOR':
      return 'ellipse;';
    case 'RULE':
      return 'shape=hexagon;perimeter=hexagonPerimeter2;';
    case 'STEP':
      return 'shape=step;perimeter=stepPerimeter;';
    case 'ATTRIBUTE':
      return 'rounded=0;';
    case 'QUESTION':
    case 'PROBLEM':
      return 'rounded=1;fontStyle=1;fontSize=15;';
    case 'ENTITY':
    default:
      return 'rounded=1;';
  }
}

/** draw.io / diagrams.net native XML (mxGraph). File > Open with this. */
export function toDrawioXml(model: Model): string {
  const concepts = visibleConcepts(model);
  const relationships = visibleRelationships(model);

  const cells: string[] = [];

  for (const c of concepts) {
    const s = DRAWIO_STYLE[c.status === 'PROPOSED' ? 'proposed' : c.status === 'CONTESTED' ? 'contested' : 'validated'];
    const stroke = DRAWIO_ACCENT[c.kind] ?? s.stroke;
    const value = escapeXml(c.label) + (c.note ? `&lt;br&gt;&lt;font style=&quot;font-size:10px&quot;&gt;${escapeXml(c.note)}&lt;/font&gt;` : '');
    const style =
      `whiteSpace=wrap;html=1;fillColor=${s.fill};strokeColor=${stroke};fontColor=${s.font};strokeWidth=2;` +
      drawioShape(c.kind) +
      (c.status === 'PROPOSED' ? 'dashed=1;' : '');
    const { width, height } = KIND_DEFAULT_SIZE[c.kind];
    cells.push(
      `<mxCell id="${c.id}" value="${value}" style="${style}" vertex="1" parent="1">` +
        `<mxGeometry x="${c.x}" y="${c.y}" width="${width}" height="${height}" as="geometry" /></mxCell>`
    );
  }

  for (const r of relationships) {
    const proposed = r.status === 'PROPOSED';
    const style = `edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=${proposed ? '#ea7317' : '#94a3b8'};strokeWidth=${proposed ? 1.8 : 2};${proposed ? 'dashed=1;' : ''}`;
    cells.push(
      `<mxCell id="${r.id}" value="${escapeXml(r.label)}" style="${style}" edge="1" parent="1" source="${r.from}" target="${r.to}">` +
        `<mxGeometry relative="1" as="geometry" /></mxCell>`
    );
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<mxfile host="app.diagrams.net" agent="Context Builder" version="21.0.0">\n` +
    `  <diagram name="${escapeXml(model.title)}" id="context-builder">\n` +
    `    <mxGraphModel dx="1000" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1600" pageHeight="1200" math="0" shadow="0">\n` +
    `      <root>\n` +
    `        <mxCell id="0" />\n` +
    `        <mxCell id="1" parent="0" />\n` +
    cells.map((c) => `        ${c}\n`).join('') +
    `      </root>\n` +
    `    </mxGraphModel>\n` +
    `  </diagram>\n` +
    `</mxfile>\n`
  );
}

function mermaidEscape(s: string): string {
  return s.replace(/"/g, '#quot;').replace(/\n/g, ' ');
}

/** Mermaid node brackets by kind. `[ ]` is the default shape (entity, attribute). */
function mermaidBrackets(kind: Kind): [string, string] {
  switch (kind) {
    case 'ACTOR':
      return ['(', ')'];
    case 'RULE':
      return ['{', '}'];
    case 'STEP':
      return ['[/', '/]'];
    case 'QUESTION':
    case 'PROBLEM':
      return ['[[', ']]'];
    case 'ENTITY':
    case 'ATTRIBUTE':
    default:
      return ['[', ']'];
  }
}

/** Mermaid flowchart source (.mmd). Pastes straight into a ```mermaid fence too. */
export function toMermaid(model: Model): string {
  const concepts = visibleConcepts(model);
  const relationships = visibleRelationships(model);

  const lines = ['graph LR'];

  for (const c of concepts) {
    const label = mermaidEscape(c.label) + (c.note ? `<br/>${mermaidEscape(c.note)}` : '');
    const cls = c.status === 'PROPOSED' ? 'proposed' : c.status === 'CONTESTED' ? 'contested' : 'validated';
    const [open, close] = mermaidBrackets(c.kind);
    lines.push(`  ${c.id}${open}"${label}"${close}:::${cls}`);
  }

  for (const r of relationships) {
    const arrow = r.status === 'PROPOSED' ? '-.->' : '-->';
    lines.push(`  ${r.from} ${arrow}|"${mermaidEscape(r.label)}"| ${r.to}`);
  }

  lines.push('  classDef validated fill:#f0fdf4,stroke:#15803d,color:#14532d,stroke-width:2px;');
  lines.push('  classDef proposed fill:#fff7ed,stroke:#ea7317,color:#9a3412,stroke-width:2px,stroke-dasharray:5 3;');
  lines.push('  classDef contested fill:#fef2f2,stroke:#dc2626,color:#991b1b,stroke-width:3px;');

  return lines.join('\n') + '\n';
}
