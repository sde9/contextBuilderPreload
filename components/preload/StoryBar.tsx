'use client';

import { useEffect, useRef, useState } from 'react';
import type { Story, StoryMode } from '@/lib/story';

/*
 * The slider. Drag it and the map builds up step by step: what has been shown
 * stays, the current step is lit, and what is still to come waits as a pale
 * outline, so the shape of the whole map is visible from the first step.
 *
 * At rest the slider sits at the end and the map is whole, exactly as it was
 * before the slider existed. "Show all" puts it back there.
 */

const PLAY_EVERY_MS = 1800;

export default function StoryBar({
  story,
  step,
  mode,
  hasOutline,
  onStep,
  onMode,
  onPick,
}: {
  story: Story;
  step: number | null;
  mode: StoryMode;
  hasOutline: boolean;
  onStep: (step: number | null) => void;
  onMode: (mode: StoryMode) => void;
  onPick: (conceptId: string) => void;
}) {
  const n = story.steps.length;
  const [playing, setPlaying] = useState(false);
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      const cur = stepRef.current;
      if (cur === null || cur >= n - 1) {
        setPlaying(false);
        return;
      }
      onStep(cur + 1);
    }, PLAY_EVERY_MS);
    return () => clearInterval(t);
  }, [playing, n, onStep]);

  if (n === 0) return null;

  const at = step === null ? n - 1 : Math.min(step, n - 1);
  const current = step === null ? null : story.steps[at];

  const go = (next: number) => {
    setPlaying(false);
    onStep(Math.max(0, Math.min(n - 1, next)));
  };

  const play = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (step === null || step >= n - 1) onStep(0);
    setPlaying(true);
  };

  return (
    <div className="story-bar" onMouseDown={(e) => e.stopPropagation()}>
      <div className="story-row">
        <div className="story-modes" role="group" aria-label="Order of the steps">
          <button
            className={mode === 'LOGIC' ? 'story-mode-on' : ''}
            onClick={() => onMode('LOGIC')}
            title={hasOutline ? 'Main point first, then each part in order' : 'Area by area, earliest written first'}
          >
            Logic
          </button>
          <button
            className={mode === 'WRITTEN' ? 'story-mode-on' : ''}
            onClick={() => onMode('WRITTEN')}
            title="In the order the documents say it"
          >
            As written
          </button>
        </div>

        <button className="story-btn" onClick={() => go(at - 1)} disabled={step === 0} aria-label="Previous step">
          ‹
        </button>
        <input
          className="story-range"
          type="range"
          min={0}
          max={n - 1}
          step={1}
          value={at}
          onChange={(e) => go(Number(e.target.value))}
          aria-label="Step of the story"
          aria-valuetext={story.steps[at]?.title}
        />
        <button className="story-btn" onClick={() => go(step === null ? n - 1 : at + 1)} disabled={step !== null && at >= n - 1} aria-label="Next step">
          ›
        </button>
        <button className="story-btn story-play" onClick={play} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="story-count">{step === null ? `${n} steps` : `${at + 1} / ${n}`}</span>
        {step !== null && (
          <button
            className="story-all"
            onClick={() => {
              setPlaying(false);
              onStep(null);
            }}
          >
            Show all
          </button>
        )}
      </div>

      {current && (
        <button className="story-caption" onClick={() => current.conceptIds[0] && onPick(current.conceptIds[0])} title="Open the evidence">
          <strong>{current.title}</strong>
          {current.quote && <span className="story-quote">&ldquo;{current.quote}&rdquo;</span>}
        </button>
      )}
    </div>
  );
}
