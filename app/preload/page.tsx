'use client';

import { Suspense, useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import Intake from '@/components/preload/Intake';
import RunProgress from '@/components/preload/RunProgress';
import SourceRail from '@/components/preload/SourceRail';
import EvidencePanel from '@/components/preload/EvidencePanel';
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
  const params = useSearchParams();
  const runId = params.get('run');

  // R4. A reload comes back to the same run rather than an empty screen.
  useEffect(() => {
    if (runId && !model) void open(runId);
  }, [runId, model, open]);

  const concepts = model ? visibleConcepts(model) : [];
  const corr = model ? corroboration(model) : { multi: 0, single: 0, uncited: 0 };
  const contested = concepts.filter((c) => c.status === 'CONTESTED').length;
  const gaps = model?.questions.filter((q) => q.status === 'OPEN').length ?? 0;

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
            <span className={`pill ${gaps ? 'pill-orange' : 'pill-plain'}`}>{gaps} gaps</span>
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
        </div>
      )}

      {screen === 'map' && (
        <footer className="bottom bottom-preload">
          <div className="legend">
            <span className="k-green">■</span> written in a document &nbsp;
            <span className="k-orange">■</span> guessed by the AI &nbsp;
            <span className="k-contested">■</span> sources disagree
          </div>
          <div className="legend legend-right">Click a node to see the sentence it came from.</div>
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
