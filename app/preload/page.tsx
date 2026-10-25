'use client';

import { Suspense, useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import Intake from '@/components/preload/Intake';
import RunProgress from '@/components/preload/RunProgress';
import SourceRail from '@/components/preload/SourceRail';
import EvidencePanel from '@/components/preload/EvidencePanel';
import QuestionsPanel from '@/components/preload/QuestionsPanel';
import ShapeLegend from '@/components/ShapeLegend';
import PreloadCanvas from '@/components/preload/PreloadCanvas';
import { usePreload } from '@/lib/preloadStore';
import { visibleConcepts } from '@/lib/reducer';
import { corroboration } from '@/lib/merge';

/*
 * Preload mode.
 *
 * Three screens over one run: drop the files, watch them being read, then
 * work with the map. The map itself is the same canvas the live session uses
 * (R10), so anything learned here carries straight into the interview.
 */
function Preload() {
  const model = usePreload((s) => s.model);
  const screen = usePreload((s) => s.screen);
  const busy = usePreload((s) => s.busy);
  const open = usePreload((s) => s.open);
  const reset = usePreload((s) => s.reset);
  const download = usePreload((s) => s.download);
  const checkHealth = usePreload((s) => s.checkHealth);
  const questionsOpen = usePreload((s) => s.questionsOpen);
  const toggleQuestions = usePreload((s) => s.toggleQuestions);
  const params = useSearchParams();
  const runId = params.get('run');

  // A deployment with no run store says so before any file goes up.
  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  // R4. A reload comes back to the same run rather than an empty screen.
  useEffect(() => {
    if (runId && !model) void open(runId);
  }, [runId, model, open]);

  const concepts = model ? visibleConcepts(model) : [];
  const corr = model ? corroboration(model) : { multi: 0, single: 0, uncited: 0 };
  const contested = concepts.filter((c) => c.status === 'CONTESTED').length;
  const saved = model?.questions.filter((q) => q.status === 'OPEN' && q.savedAt).length ?? 0;
  const gaps =
    (model?.questions.filter((q) => q.status === 'OPEN' && !q.savedAt).length ?? 0) +
    concepts.filter((c) => c.kind === 'QUESTION').length;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <strong>Context Builder</strong>
          <span className="sub">Preload · read the documents first</span>
        </div>

        <nav className="mode-switch">
          <span className="mode-on">Preload</span>
          <Link className="mode-off" href="/">
            Real-time
          </Link>
        </nav>

        {screen === 'map' && model && (
          <div className="counts">
            <span className="pill pill-plain">{concepts.length} concepts</span>
            <span className="pill pill-green">{corr.multi} from 2+ sources</span>
            <span className={`pill ${contested ? 'pill-contested' : 'pill-plain'}`}>{contested} contested</span>
            <button
              className={`pill pill-button ${questionsOpen ? 'pill-on' : gaps ? 'pill-orange' : 'pill-plain'}`}
              onClick={() => toggleQuestions()}
              title="The questions to take into the interview"
            >
              {gaps} open {gaps === 1 ? 'question' : 'questions'}
              {saved > 0 ? ` · ${saved} saved` : ''}
            </button>
          </div>
        )}

        <div className="tools">
          {model && screen === 'map' && (
            <>
              <button onClick={download}>Download</button>
              <Link className="btn-link" href="/" title="Continue this map in a live session">
                Start a session with this map
              </Link>
            </>
          )}
          {model && <button onClick={reset} disabled={busy}>New</button>}
        </div>
      </header>

      {screen === 'intake' && <Intake />}
      {screen === 'building' && <RunProgress />}
      {screen === 'map' && model && (
        <div className="map-screen">
          <SourceRail />
          <section className="canvas">
            <PreloadCanvas />
          </section>
          <EvidencePanel />
          <QuestionsPanel />
        </div>
      )}

      {screen === 'map' && (
        <footer className="bottom bottom-preload">
          <div className="legend">
            <span className="k-green">■</span> written in a document &nbsp;
            <span className="k-orange">■</span> guessed by the AI &nbsp;
            <span className="k-contested">■</span> sources disagree
          </div>
          <ShapeLegend />
          <div className="legend legend-right">Click a box to see the sentence it came from.</div>
        </footer>
      )}
    </main>
  );
}

export default function PreloadPage() {
  return (
    <Suspense fallback={<main className="shell" />}>
      <Preload />
    </Suspense>
  );
}
