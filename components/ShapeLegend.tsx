'use client';

/*
 * What the shapes mean. One legend for both canvases, because both draw their
 * boxes with ConceptNode and its tags use the same plain words.
 */
type ShapeKind = 'entity' | 'attribute' | 'actor' | 'step' | 'rule' | 'claim' | 'question' | 'problem';

const LABEL: Record<ShapeKind, string> = {
  entity: 'thing',
  attribute: 'detail',
  actor: 'who',
  step: 'step',
  rule: 'rule',
  claim: 'claim',
  question: 'question',
  problem: 'problem',
};

/** The live session never makes a claim; a document does. */
export const LIVE_SHAPES: ShapeKind[] = ['entity', 'attribute', 'actor', 'step', 'rule', 'question', 'problem'];
export const DOCUMENT_SHAPES: ShapeKind[] = ['entity', 'attribute', 'actor', 'step', 'rule', 'claim', 'question', 'problem'];

export default function ShapeLegend({
  kinds = DOCUMENT_SHAPES,
  sizeNote = true,
}: {
  kinds?: ShapeKind[];
  /** Preload sizes the main point and the parts up; the live canvas does not. */
  sizeNote?: boolean;
}) {
  return (
    <div className="legend shape-legend" aria-label="What the shapes mean">
      {kinds.map((kind) => (
        <span key={kind} className="shape-key">
          <span className={`shape-chip chip-${kind}`} aria-hidden="true">
            {kind === 'step' && (
              <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                <path d="M1,1 H80 L99,50 L80,99 H1 L14,50 Z" vectorEffect="non-scaling-stroke" />
              </svg>
            )}
            {kind === 'rule' && (
              <svg viewBox="0 0 100 100" preserveAspectRatio="none">
                <path d="M14,1 H86 L99,24 V76 L86,99 H14 L1,76 V24 Z" vectorEffect="non-scaling-stroke" />
              </svg>
            )}
          </span>
          {LABEL[kind]}
        </span>
      ))}
      {sizeNote && (
        <span className="shape-key">
          <span className="shape-size" aria-hidden="true" /> bigger box = more central
        </span>
      )}
    </div>
  );
}
