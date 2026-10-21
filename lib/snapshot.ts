'use client';

import { getViewportForBounds, type Rect } from '@xyflow/react';
import { toPng } from 'html-to-image';

/*
 * A picture of the whole map, not only the part on screen (RT-US-17).
 *
 * Follows React Flow's own download-image example: take the bounds of every
 * node, find the viewport that fits them, and render the viewport element
 * with that transform. The bounds must come from the React Flow instance
 * (useReactFlow().getNodesBounds), which knows each node's measured size;
 * the standalone helper only sees positions and crops the picture.
 * html-to-image is pinned to 1.11.11 because that is the version the
 * example pins.
 *
 * Edge labels render inside .react-flow__viewport (EdgeLabelRenderer), so
 * they come out in the picture too.
 */

/** Room around the boxes. Edges can route outside the boxes, so it is generous. */
const PADDING = 64;
const MAX_SIDE = 3000;

/** Buttons are for the screen. The picture shows the map without them. */
const SCREEN_ONLY = ['node-actions', 'edge-actions'];

export async function mapToPng(bounds: Rect, viewportEl: HTMLElement): Promise<string> {
  const scale = Math.min(1, MAX_SIDE / Math.max(bounds.width + PADDING * 2, bounds.height + PADDING * 2));
  const width = Math.max(320, Math.round((bounds.width + PADDING * 2) * scale));
  const height = Math.max(240, Math.round((bounds.height + PADDING * 2) * scale));
  // Never zoom in: at most 1:1, centred, so the padding stays on every side.
  const vp = getViewportForBounds(bounds, width, height, 0.05, 1, 0);

  return toPng(viewportEl, {
    backgroundColor: '#ffffff',
    width,
    height,
    pixelRatio: 2,
    filter: (node) => !(node instanceof HTMLElement && SCREEN_ONLY.some((c) => node.classList.contains(c))),
    style: {
      width: `${width}px`,
      height: `${height}px`,
      transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`,
    },
  });
}
